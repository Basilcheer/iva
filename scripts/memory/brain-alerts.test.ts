/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Ночной brain целиком, живым процессом: единственный способ увидеть, на каком языке он
// говорит и что именно говорит. Телеграма в тесте нет — без токена brain печатает готовый
// текст тревоги в stderr, и это ровно та строка, которую увидел бы владелец.
//
// PATH пуст намеренно: без uv, git и gh прогон останавливается на проверке размеров перед
// бэкапом и НИКОГДА не доходит до `gh repo create` — тест не имеет права ничего создать в
// чужом GitHub-аккаунте.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_CAP } from "#lib/core-cap.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Run = { code: number | null; stderr: string; dataDir: string };

/** Установка, где ничего внешнего нет: раздутый CORE.md, карточка с открытым фенсом. */
function runBrain(
  t: TestContext,
  language: string | null,
  agentLanguage: string,
): Run {
  const home = mkdtempSync(join(tmpdir(), "iva-brain-alerts-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const vault = join(home, "vault");
  const dataDir = join(home, "data");
  mkdirSync(join(vault, "cards"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(vault, "CORE.md"),
    `# CORE\n\n${"факт. ".repeat(CORE_CAP)}`,
  );
  writeFileSync(
    join(vault, "cards", "broken.md"),
    "---\ntype: note\n---\n\n# Broken\n\nfacts\n\n```bash\nnever closed\n",
  );
  if (language !== null)
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ language }));

  const result = spawnSync(process.execPath, ["scripts/memory/brain.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: "", // ни uv, ни git, ни gh — наружу этот прогон не выйдет
      HOME: home,
      ASSISTANT_VAULT_DIR: vault,
      ASSISTANT_DATA_DIR: dataDir,
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: agentLanguage,
    },
  });
  return { code: result.status, stderr: result.stderr, dataDir };
}

test("brain speaks Russian, says what broke and what to do", (t) => {
  const run = runBrain(t, null, "ru");

  assert.equal(run.code, 1);
  // 1. Механическое обслуживание не прошло: что сломалось → чем грозит → что сделать.
  assert.match(
    run.stderr,
    /Ночной уход за памятью не прошёл на шагах: cleanup/,
  );
  assert.match(run.stderr, /Карточки остаются вне схемы/);
  assert.match(run.stderr, /установлены uv и Python/);
  // 2. CORE.md ужат.
  assert.match(
    run.stderr,
    new RegExp(`CORE\\.md вырос за лимит в ${CORE_CAP} знаков`),
  );
  assert.match(run.stderr, /Открой CORE\.md и проверь/);
  // 3. Карточка с незакрытым фенсом — с путём к ней.
  assert.match(run.stderr, /Карточек с незакрытым ```: 1\./);
  assert.match(run.stderr, /cards\/broken\.md/);
  // 4. Бэкап отложен.
  assert.match(run.stderr, /Проверка размеров файлов перед бэкапом не прошла/);
  assert.match(run.stderr, /память ещё не сохранена вне сервера/);
  // Ни одной английской строки из прежних алертов.
  assert.doesNotMatch(run.stderr, /vault maintenance partially failed/);
  assert.doesNotMatch(run.stderr, /Vault health dropped/);
});

test("brain speaks English when the owner picked English", (t) => {
  const run = runBrain(t, "en", "ru");

  assert.equal(run.code, 1);
  assert.match(run.stderr, /Nightly memory care failed at: cleanup/);
  assert.match(run.stderr, /Cards stay off-schema/);
  assert.match(run.stderr, /uv and Python are installed/);
  assert.match(
    run.stderr,
    new RegExp(`CORE\\.md grew past its ${CORE_CAP}-character cap`),
  );
  assert.match(run.stderr, /Cards with an unclosed ``` fence: 1\./);
  assert.match(run.stderr, /The file-size check before the backup failed/);
  // Русского в английском прогоне нет вовсе.
  assert.doesNotMatch(run.stderr, /Ночной уход/);
  assert.doesNotMatch(run.stderr, /Бэкап памяти/);
});

test("settings.language beats the environment, both ways", (t) => {
  assert.match(
    runBrain(t, "ru", "en").stderr,
    /Ночной уход за памятью не прошёл/,
  );
  assert.match(runBrain(t, "en", "ru").stderr, /Nightly memory care failed/);
});

test("an alert that never reached Telegram does not silence the next night", (t) => {
  const first = runBrain(t, null, "ru");
  assert.equal(
    existsSync(join(first.dataDir, "alert-state.json")),
    false,
    "nothing was delivered, so nothing may be recorded as delivered",
  );
});

// Дроссель и текст живут в разных местах, поэтому здесь — только контракт brain.ts: каждая
// тревога уходит через alert() (то есть через дроссель) и несёт пару локалей.
test("every brain alert goes through the throttle and carries both locales", () => {
  const source = readFileSync(join(ROOT, "scripts/memory/brain.ts"), "utf8");

  const keys = [...source.matchAll(/await alert\(\s*"([a-z-]+)"/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual([...keys].sort(), [
    "authored-tree",
    "backup-oversize",
    "backup-push",
    "backup-scan",
    "core-cap",
    "health-drop",
    "maintenance",
    "unclosed-fence",
    "vault-remote",
  ]);
  assert.equal(new Set(keys).size, keys.length, "one key per problem");

  // Единственный прямой вызов транспорта — внутри alert(); всё остальное дросселируется.
  assert.equal(source.split("telegram(message)").length - 1, 1);
  assert.doesNotMatch(source, /await telegram\(/u);

  // Каждая проблема умеет и «ушла»: рецидив после починки говорит сразу.
  const cleared = [...source.matchAll(/await cleared\("([a-z-]+)"\)/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...cleared].sort(),
    [...keys].sort(),
    "every problem that can be alerted must also be forgettable, or a relapse waits a week",
  );

  // Эталонный алерт: обе локали говорят, что сломалось, чем грозит и что сделать.
  assert.match(
    source,
    /Memory is not backed up: the vault has no git remote\./u,
  );
  assert.match(source, /Память не бэкапится: у vault нет git remote\./u);
  assert.match(source, /"\(repo scope\)\. The nightly brain then creates/u);
  assert.match(source, /"\(scope repo\)\. Ночной brain сам создаст/u);
});
