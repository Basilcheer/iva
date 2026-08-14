import { test } from "node:test";
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import assert from "node:assert/strict";
import {
  MODEL_PROVIDER_NAMES,
  MODEL_PROVIDERS,
  resolveModelProvider,
} from "#lib/model-provider.ts";
import {
  CATALOG,
  catalogProvider,
  providerEnvKeys,
  FALLBACK_EFFORTS,
  ModelCatalogError,
  fetchModelOptions,
} from "./model-catalog.ts";

// Каталог — вторая половина шва: по нему строятся кнопки /model, мастер и `iva doctor`
// (они грузятся на инсталле, где agent/ может не быть, ADR-0003), а принимает значение
// authored-резолвер. Разъедься перечни — мастер предложил бы провайдера, на котором
// рантайм откажется стартовать, или доктор объявил бы .env здоровым перед отказом.
// Порядок тоже общий: он же задаёт порядок имён в сообщении об отказе.
test("both trees accept exactly the same provider names, in the same order", () => {
  assert.deepEqual(Object.keys(CATALOG), [...MODEL_PROVIDER_NAMES]);
});

// Имён мало — разъехаться могут и значения. Каталог показывает дефолтную модель в мастере
// и в /menu, а берёт её рантайм из своей половины: разойдись они, пользователь согласился
// бы с одной моделью, а работала бы другая — тот же раскол, что и с именем провайдера.
test("both trees name the same model variable and the same default model", () => {
  for (const name of MODEL_PROVIDER_NAMES) {
    const catalog = CATALOG[name];
    const authored = MODEL_PROVIDERS[name];
    assert.equal(catalog.modelVar, authored.modelVar, name);
    assert.equal(catalog.def, authored.defaultModel, name);
    // И то же самое с другого конца: пустой env обязан дать ровно дефолт каталога.
    assert.equal(
      resolveModelProvider({ MODEL_PROVIDER: name }).model,
      catalog.def,
      name,
    );
  }
});

test("the catalog lookup takes exact names only", () => {
  for (const name of MODEL_PROVIDER_NAMES)
    assert.equal(catalogProvider(name), CATALOG[name]);
  for (const value of [
    "ollmaa",
    " ollama",
    "OLLAMA",
    "",
    "__proto__",
    "constructor",
    undefined,
  ])
    assert.equal(catalogProvider(value), undefined, JSON.stringify(value));
});

test("Codex catalog failure cannot create selectable fallback models", async () => {
  await assert.rejects(
    fetchModelOptions("codex", undefined, {
      listCodexCatalog: async () => {
        throw new Error("offline");
      },
    }),
    (error) =>
      error instanceof ModelCatalogError &&
      error.code === "catalog_unavailable",
  );
});

test("Ollama Cloud and OpenCode Go expose their OpenAI-compatible reasoning contract", async () => {
  for (const provider of ["ollama", "opencode"]) {
    const options = await fetchModelOptions(provider, "test", {
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "reasoning-model" }],
          }),
          { status: 200 },
        ),
    });
    assert.deepEqual(options, [
      {
        id: "reasoning-model",
        reasoningLevels: [...FALLBACK_EFFORTS],
      },
    ]);
  }
});

test("heterogeneous OpenRouter catalog does not invent reasoning choices", async () => {
  const options = await fetchModelOptions("openrouter", "unused");
  assert.ok(options.length > 0);
  assert.ok(options.every((option) => option.reasoningLevels.length === 0));
});

// Один список обязательных ключей на доктора и мастера. Разъедься они — мастер объявил бы
// .env настроенным, а доктор на том же файле ругался бы (или наоборот, и никто бы не понял).
test("required env keys cover the key and the model, and codex asks for neither key", () => {
  assert.deepEqual(providerEnvKeys(CATALOG.ollama), [
    "OLLAMA_API_KEY",
    "OLLAMA_MODEL",
  ]);
  assert.deepEqual(providerEnvKeys(CATALOG.opencode), [
    "OPENCODE_API_KEY",
    "OPENCODE_MODEL",
  ]);
  assert.deepEqual(providerEnvKeys(CATALOG.openrouter), [
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
  ]);
  // codex входит по OAuth — ключа в .env нет вовсе.
  assert.deepEqual(providerEnvKeys(CATALOG.codex), ["CODEX_MODEL"]);
  for (const name of MODEL_PROVIDER_NAMES) {
    const keys = providerEnvKeys(CATALOG[name]);
    assert.equal(keys.includes(CATALOG[name].modelVar), true, name);
    assert.equal(keys.includes(""), false, name);
  }
});
