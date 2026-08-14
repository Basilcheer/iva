/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Ночная сборка сайдкар-индекса эмбеддингов инкрементальна: платный вызов делается только
// за новые и изменившиеся карточки, записи удалённых уходят, а смена модели пересчитывает
// всё (векторы разных моделей несравнимы). Эндпоинт подменяем локальным сервером через
// MEMORY_EMBED_URL — в сеть тест не ходит.

import "../lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "embed-index.ts");

interface Stub {
  readonly url: string;
  /** Тексты каждого запроса — по ним видно, за что реально заплатили. */
  readonly embedded: string[][];
  close(): Promise<void>;
}

// drop — сколько ПОСЛЕДНИХ векторов ответа «потерять»: провайдер вправе вернуть меньше,
// чем спросили, и такая карточка не должна попасть в индекс помеченной как готовая.
async function embedStub(drop = 0): Promise<Stub> {
  const embedded: string[][] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const input = (JSON.parse(raw) as { input: string[] }).input;
      embedded.push(input);
      const returned = drop
        ? input.slice(0, Math.max(0, input.length - drop))
        : input;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: returned.map((text) => ({ embedding: [text.length, 1, 0, 0] })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/embeddings`,
    embedded,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface IndexFile {
  model: string;
  embedModel: string;
  count: number;
  vectors: Record<string, number[]>;
  hashes: Record<string, string>;
}

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "iva-embed-index-"));
  mkdirSync(join(vault, "cards"), { recursive: true });
  process.on("exit", () => rmSync(vault, { recursive: true, force: true }));
  return vault;
}

const card = (name: string, body: string): string =>
  `---\ntype: contact\nname: ${name}\nstatus: active\n---\n\n# ${name}\n\n${body}\n`;

// Только асинхронный запуск: сервер-заглушка живёт в ЭТОМ процессе, и spawnSync намертво
// заблокировал бы цикл событий, не дав ответить на запрос эмбеддингов.
const run = promisify(execFile);

async function runIndex(
  vault: string,
  url: string,
  model?: string,
): Promise<string> {
  const { stdout } = await run(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      ASSISTANT_VAULT_DIR: vault,
      MEMORY_EMBED_URL: url,
      ...(model ? { MEMORY_EMBED_MODEL: model } : {}),
    },
  });
  return stdout;
}

const readIndex = (vault: string): IndexFile =>
  JSON.parse(
    readFileSync(join(vault, ".index", "embeddings.json"), "utf8"),
  ) as IndexFile;

test("второй прогон без правок не эмбеддит ничего", async () => {
  const stub = await embedStub();
  const vault = makeVault();
  try {
    writeFileSync(join(vault, "cards", "ivan.md"), card("Иван", "Монтажёр."));
    writeFileSync(join(vault, "cards", "olga.md"), card("Ольга", "Продюсер."));

    await runIndex(vault, stub.url);
    assert.equal(stub.embedded.flat().length, 2);
    const first = readIndex(vault);
    assert.equal(Object.keys(first.vectors).length, 2);
    assert.equal(Object.keys(first.hashes).length, 2);

    await runIndex(vault, stub.url);
    assert.equal(
      stub.embedded.flat().length,
      2,
      "неизменившиеся карточки заново не считаются",
    );
    assert.deepEqual(readIndex(vault).vectors, first.vectors);
  } finally {
    await stub.close();
  }
});

test("считаются только новая и изменившаяся; удалённая уходит из индекса", async () => {
  const stub = await embedStub();
  const vault = makeVault();
  try {
    writeFileSync(join(vault, "cards", "ivan.md"), card("Иван", "Монтажёр."));
    writeFileSync(join(vault, "cards", "olga.md"), card("Ольга", "Продюсер."));
    writeFileSync(join(vault, "cards", "pavel.md"), card("Павел", "Оператор."));
    await runIndex(vault, stub.url);
    const paid = stub.embedded.flat().length;

    writeFileSync(
      join(vault, "cards", "ivan.md"),
      card("Иван", "Теперь колорист."),
    );
    writeFileSync(join(vault, "cards", "nina.md"), card("Нина", "Сценарист."));
    rmSync(join(vault, "cards", "pavel.md"));
    await runIndex(vault, stub.url);

    const now = stub.embedded.flat().slice(paid);
    assert.equal(
      now.length,
      2,
      "правка плюс новая карточка — ровно два вызова",
    );
    assert.ok(now.some((text) => text.includes("колорист")));
    assert.ok(now.some((text) => text.includes("Нина")));

    const index = readIndex(vault);
    assert.deepEqual(Object.keys(index.vectors).sort(), [
      "cards/ivan.md",
      "cards/nina.md",
      "cards/olga.md",
    ]);
    assert.equal(index.hashes["cards/pavel.md"], undefined);
    assert.equal(index.count, 3);
  } finally {
    await stub.close();
  }
});

// Провайдер вернул вектор не на каждую карточку. Непосчитанная НЕ помечается готовой —
// иначе её хэш остался бы в индексе, и следующая ночь считала бы её уже сделанной, а
// вектора у неё нет никогда.
test("карточка без вектора не помечается готовой и доэмбеддится в следующий прогон", async () => {
  const lossy = await embedStub(1);
  const vault = makeVault();
  try {
    writeFileSync(join(vault, "cards", "ivan.md"), card("Иван", "Монтажёр."));
    writeFileSync(join(vault, "cards", "olga.md"), card("Ольга", "Продюсер."));
    writeFileSync(join(vault, "cards", "pavel.md"), card("Павел", "Оператор."));

    await runIndex(vault, lossy.url);
    const partial = readIndex(vault);
    const missing = Object.keys(partial.hashes).filter(
      (path) => !(path in partial.vectors),
    );
    assert.equal(Object.keys(partial.vectors).length, 2);
    assert.deepEqual(missing, [], "без вектора — без хэша");
    assert.equal(Object.keys(partial.hashes).length, 2);
    await lossy.close();

    // Следующая ночь с исправным провайдером досчитывает ровно её.
    const healthy = await embedStub();
    try {
      await runIndex(vault, healthy.url);
      assert.deepEqual(
        healthy.embedded.flat().map((text) => text.includes("Оператор")),
        [true],
        "доэмбеддить надо ровно непосчитанную карточку",
      );
      assert.equal(Object.keys(readIndex(vault).vectors).length, 3);
    } finally {
      await healthy.close();
    }
  } finally {
    await lossy.close();
  }
});

test("смена модели пересчитывает индекс целиком", async () => {
  const stub = await embedStub();
  const vault = makeVault();
  try {
    writeFileSync(join(vault, "cards", "ivan.md"), card("Иван", "Монтажёр."));
    writeFileSync(join(vault, "cards", "olga.md"), card("Ольга", "Продюсер."));
    await runIndex(vault, stub.url, "model-a");
    assert.equal(stub.embedded.flat().length, 2);

    await runIndex(vault, stub.url, "model-b");
    assert.equal(
      stub.embedded.flat().length,
      4,
      "векторы чужой модели переиспользовать нельзя",
    );
    assert.equal(readIndex(vault).embedModel, "model-b");
  } finally {
    await stub.close();
  }
});

test("индекс прошлой версии (без hashes) не ломает прогон", async () => {
  const stub = await embedStub();
  const vault = makeVault();
  try {
    writeFileSync(join(vault, "cards", "ivan.md"), card("Иван", "Монтажёр."));
    mkdirSync(join(vault, ".index"), { recursive: true });
    writeFileSync(
      join(vault, ".index", "embeddings.json"),
      JSON.stringify({
        model: "deepinfra",
        count: 1,
        vectors: { "cards/ivan.md": [9, 9, 9, 9] },
      }),
    );

    await runIndex(vault, stub.url);
    assert.equal(stub.embedded.flat().length, 1);
    const index = readIndex(vault);
    assert.deepEqual(index.vectors["cards/ivan.md"].slice(1), [1, 0, 0]);
    assert.ok(index.hashes["cards/ivan.md"]);
  } finally {
    await stub.close();
  }
});

test("битый индекс переживается, временный файл за собой не остаётся", async () => {
  const stub = await embedStub();
  const vault = makeVault();
  try {
    writeFileSync(join(vault, "cards", "ivan.md"), card("Иван", "Монтажёр."));
    mkdirSync(join(vault, ".index"), { recursive: true });
    writeFileSync(join(vault, ".index", "embeddings.json"), '{"vectors":');

    await runIndex(vault, stub.url);
    assert.equal(Object.keys(readIndex(vault).vectors).length, 1);
    assert.deepEqual(
      readdirSync(join(vault, ".index")).filter((name) =>
        name.endsWith(".tmp"),
      ),
      [],
    );
    assert.ok(existsSync(join(vault, ".index", "embeddings.json")));
  } finally {
    await stub.close();
  }
});
