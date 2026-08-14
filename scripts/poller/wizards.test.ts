/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; the async request double preserves the wizard boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import { CATALOG } from "../lib/model-catalog.ts";
import {
  currentConfig,
  flows,
  getWizard,
  isStaleWizard,
  runWizardRequest,
  selectWizardEffort,
  selectWizardModel,
  selectableWizardOptions,
  wizardActionAllowed,
} from "./wizards.ts";

// Визард — путь починки: он открывается ИМЕННО тогда, когда MODEL_PROVIDER набран с
// опечаткой и агент не стартует. Назови он такую конфигурацию «ollama» — пользователь
// увидел бы здоровую строку и ушёл искать причину в другом месте.
test("the model wizard shows the configured provider, valid or not", async () => {
  for (const name of MODEL_PROVIDER_NAMES) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: name }),
    });
    assert.equal(config.providerLabel, name);
    assert.equal(config.provider, name);
    assert.equal(config.model, CATALOG[name].def);
  }
  // Пробелы вокруг значения парсер .env срезает сам (scripts/lib/env-file.ts), поэтому
  // сюда доезжает то, что он оставляет: опечатка, регистр, пустое значение, мусор.
  for (const value of ["ollmaa", "OLLAMA", "", "__proto__"]) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: value }),
    });
    assert.equal(config.providerLabel, `invalid (${value})`, value);
    // Кнопки всё же надо чем-то нарисовать — визард встаёт на дефолтном провайдере.
    assert.equal(config.provider, "ollama", value);
  }
  // Переменной нет — это не опечатка, а дефолт: он и остаётся ollama.
  const missing = await currentConfig({ readEnv: async () => ({}) });
  assert.equal(missing.provider, "ollama");
  assert.equal(missing.providerIsValid, true);
});

// /think и /model читают одно и то же состояние. Раньше /think видел схлопнутую в ollama
// подмену и рисовал уровни, как будто всё в порядке, — настройка уезжала в .env, а агент
// всё равно не стартовал. Флаг тот же, что рисует метку в /model.
test("the thinking wizard sees the same invalid provider the model wizard shows", async () => {
  for (const value of ["ollmaa", "OLLAMA", ""]) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: value, THINKING_EFFORT: "high" }),
    });
    assert.equal(config.providerIsValid, false, value);
    assert.equal(config.providerLabel, `invalid (${value})`, value);
  }
  for (const name of MODEL_PROVIDER_NAMES) {
    const config = await currentConfig({
      readEnv: async () => ({ MODEL_PROVIDER: name }),
    });
    assert.equal(config.providerIsValid, true, name);
  }
});

test("wizard lookup preserves Telegram's string user ID", () => {
  const chatId = 4_102_033;
  const userId = "9_104_204";
  const state = flows.start(chatId, userId, "model");

  assert.equal(getWizard(chatId, userId), state);
});

test("wizard action guards, model selection and effort selection preserve the state machine", () => {
  const state: {
    step: string;
    modelOptions: { id: string; reasoningLevels: string[] }[];
    efforts?: string[];
    effort?: string | null;
    model?: string;
  } = {
    step: "models",
    modelOptions: [
      { id: "first", reasoningLevels: ["low", "high"] },
      { id: "second", reasoningLevels: [] },
    ],
  };
  assert.equal(wizardActionAllowed(state, "m:0"), true);
  assert.equal(wizardActionAllowed(state, "eff:low"), false);
  assert.equal(wizardActionAllowed({ step: "intro" }, "chg"), true);
  assert.equal(wizardActionAllowed(null, "cancel"), false);
  assert.equal(isStaleWizard({ msgId: 10 }, 11), true);
  assert.equal(isStaleWizard({ msgId: 10 }, 10), false);

  const selected = selectWizardModel(state, "0");
  assert.ok(selected);
  assert.equal(selected.id, "first");
  assert.deepEqual(state.efforts, ["low", "high"]);
  assert.equal(selectWizardModel(state, "01"), null);
  assert.equal(selectWizardEffort(state, "high"), true);
  assert.equal(state.effort, "high");
  assert.equal(selectWizardEffort(state, "unset"), true);
  assert.equal(state.effort, null);
});

test("wizard options prioritize the configured model and async results are dropped when stale", async () => {
  const options = [
    { id: "a", reasoningLevels: [] },
    { id: "b", reasoningLevels: [] },
    { id: "c", reasoningLevels: [] },
  ];
  assert.deepEqual(
    selectableWizardOptions(options, "c", 2).map((option) => option.id),
    ["c", "a"],
  );
  const state = {};
  assert.deepEqual(
    await runWizardRequest(
      state,
      async () => "result",
      () => false,
    ),
    { stale: true },
  );
});
