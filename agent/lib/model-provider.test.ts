/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Выбор провайдера обязан быть ОДНИМ решением: имя, модель и reasoning уезжают дальше
// вместе или не уезжают вовсе. Здесь проверяется и сам резолвер, и то, что рантайм с
// учётом расхода берут из него одну и ту же правду (issue #161 родился как раз из двух
// независимых чтений одного MODEL_PROVIDER).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODEL_PROVIDER_NAMES,
  invalidModelProviderMessage,
  resolveModelProvider,
} from "./model-provider.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// Запускает node в корне репозитория: агент стартует так же — целым процессом, а не вызовом.
function runInRepo(script: string, env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: ROOT,
      encoding: "utf8",
      // agent/** импортирует соседей как "./x.js" — см. scripts/lib/ts-esm-hooks.ts.
      env: { ...process.env, ...env },
    },
  );
}

test("model provider selection defaults to Ollama", () => {
  assert.deepEqual(resolveModelProvider({}), {
    name: "ollama",
    model: "deepseek-v4-pro",
    compatibleReasoning: true,
  });
});

test("model provider selection preserves each supported provider identity", () => {
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "ollama",
      OLLAMA_MODEL: "ollama-model",
    }),
    { name: "ollama", model: "ollama-model", compatibleReasoning: true },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/opencode-model",
    }),
    { name: "opencode", model: "opencode-model", compatibleReasoning: true },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "openrouter",
      OPENROUTER_MODEL: "vendor/router-model",
    }),
    {
      name: "openrouter",
      model: "vendor/router-model",
      compatibleReasoning: false,
    },
  );
  assert.deepEqual(
    resolveModelProvider({
      MODEL_PROVIDER: "codex",
      CODEX_MODEL: "codex-model",
    }),
    { name: "codex", model: "codex-model", compatibleReasoning: false },
  );
});

test("every supported provider keeps its own default model", () => {
  assert.deepEqual(
    MODEL_PROVIDER_NAMES.map(
      (name) => resolveModelProvider({ MODEL_PROVIDER: name }).model,
    ),
    ["deepseek-v4-pro", "deepseek-v4-pro", "gpt-5.5", "openai/gpt-5.1"],
  );
});

// Префикс "opencode-go/" — внутренний UI-идентификатор мастера; эндпоинт Go ждёт bare-ID.
// Слаг openrouter тоже содержит "/", и срезать у него ничего нельзя.
test("only OpenCode loses the wizard prefix from a configured model", () => {
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/glm-5.2",
    }).model,
    "glm-5.2",
  );
  assert.equal(
    resolveModelProvider({
      MODEL_PROVIDER: "openrouter",
      OPENROUTER_MODEL: "opencode-go/glm-5.2",
    }).model,
    "opencode-go/glm-5.2",
  );
});

test("model provider selection rejects values that would split runtime identity", () => {
  assert.deepEqual(
    [...MODEL_PROVIDER_NAMES],
    ["ollama", "opencode", "codex", "openrouter"],
  );
  const garbage = [
    "ollmaa", // опечатка из issue #161
    " ollama", // ведущий пробел из ручного .env
    "ollama ", // хвостовой пробел
    "ollama\n", // перевод строки, доехавший из копипасты
    " ollama", // неразрывный пробел
    "ollama​", // zero-width space — глазом не отличить от валидного
    "OLLAMA", // другой регистр
    "Ollama",
    "", // MODEL_PROVIDER= без значения
    "оllama", // кириллическая «о» в первом символе
    "ollama,opencode", // попытка задать двух сразу
    "__proto__", // мусор, который на прототипе объекта «нашёлся» бы
    "constructor",
    "toString",
  ];
  for (const value of garbage) {
    assert.throws(
      () => resolveModelProvider({ MODEL_PROVIDER: value }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, invalidModelProviderMessage(value));
        return true;
      },
      value,
    );
  }
});

// Отказ читает человек в journalctl или в выводе `iva doctor`: он обязан увидеть и то,
// что задал сам, и все имена, из которых можно выбрать, и чем это чинится.
test("the refusal names the bad value, every accepted name and the fix", () => {
  const message = invalidModelProviderMessage("ollmaa");
  assert.equal(
    message,
    'Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, openrouter — run: iva config',
  );
  for (const name of MODEL_PROVIDER_NAMES)
    assert.match(message, new RegExp(name));
});

test("runtime configuration and usage share the resolved provider identity", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-provider-usage-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = runInRepo(
    `
    await import("./scripts/lib/ts-esm-hooks.ts");
    const provider = await import("./agent/provider.ts");
    const usage = (await import("./agent/hooks/usage.ts")).default;
    usage.events["step.completed"](
      { data: { stepIndex: 1, turnId: "turn_1", usage: { inputTokens: 2, outputTokens: 3 } } },
      { session: { id: "session_1" }, channel: { kind: "test" } },
    );
    console.log(JSON.stringify({
      name: provider.providerName,
      model: provider.providerConfig.textModel,
      effort: provider.compatibleThinkingEffort,
    }));
  `,
    {
      ASSISTANT_DATA_DIR: dataDir,
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/test-model",
      THINKING_EFFORT: "high",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    name: "opencode",
    model: "test-model",
    effort: "high",
  });
  const usage: unknown = JSON.parse(
    readFileSync(join(dataDir, "usage.jsonl"), "utf8"),
  );
  assert.equal(isRecord(usage), true);
  if (!isRecord(usage)) return;
  assert.equal(usage.provider, "opencode");
  assert.equal(usage.model, "test-model");
});

// Обе точки входа рантайма читают MODEL_PROVIDER на загрузке модуля — падать они обязаны
// обе, иначе учёт расхода пережил бы отказ конфигурации и писал бы под чужим именем.
test("runtime startup rejects an invalid provider before choosing a config", () => {
  for (const module of ["./agent/provider.ts", "./agent/hooks/usage.ts"]) {
    const result = runInRepo(
      `await import("./scripts/lib/ts-esm-hooks.ts"); await import(${JSON.stringify(module)});`,
      { MODEL_PROVIDER: "ollmaa" },
    );

    assert.notEqual(result.status, 0, module);
    assert.match(
      result.stderr,
      /Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, openrouter — run: iva config/,
      module,
    );
  }
});
