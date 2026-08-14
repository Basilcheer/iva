/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; the async request double preserves the wizard boundary. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import { CATALOG } from "../lib/model-catalog.ts";
import {
  currentConfig,
  flows,
  getWizard,
  handleThinkCmd,
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
  // Через живой .env сюда приходит то, что оставил парсер scripts/lib/env-file.ts: он
  // срезает обрамляющие пробелы, поэтому в списке их нет. Это правило ИМЕННО этого
  // парсера — у мастера установки свой, и их поведение на пробелах не сверяется. Здесь
  // readEnv подставлен, так что проверяется предикат, а не парсер.
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

type SentCall = { method: string; text: string };
type MockResponse = { ok: boolean; status: number; json(): Promise<unknown> };
const mutableGlobal = globalThis as unknown as {
  fetch: (url: string, init?: { body?: string }) => Promise<MockResponse>;
};

/** Ловит всё, что визард действительно отправляет: путь в Telegram у моста ровно один. */
function telegramSpy(t: TestContext): SentCall[] {
  const sent: SentCall[] = [];
  const previous = mutableGlobal.fetch;
  t.after(() => {
    mutableGlobal.fetch = previous;
  });
  mutableGlobal.fetch = (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    if (url.includes("api.telegram.org")) {
      const body = JSON.parse(init?.body ?? "{}") as { text?: string };
      sent.push({ method, text: body.text ?? "" });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { message_id: 7 } }),
      });
    }
    // Каталог моделей провайдера — только для контрольного случая.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [{ id: "deepseek-v4-pro" }] }),
    });
  };
  return sent;
}

// Гвард в /think до этого не вызывал ни один тест: удали его — и весь сьют оставался
// зелёным, пока живой визард рисовал уровни ollama поверх сломанной конфигурации.
test("/think refuses an invalid provider and sends the user to /model", async (t) => {
  const sent = telegramSpy(t);

  await handleThinkCmd(4102033, "9104204", {
    readEnv: async () => ({
      MODEL_PROVIDER: "ollmaa",
      THINKING_EFFORT: "high",
    }),
  });

  const texts = sent.map((call) => call.text).join("\n");
  assert.match(
    texts,
    /MODEL_PROVIDER is (now )?invalid \(ollmaa\)|invalid \(ollmaa\)/u,
  );
  assert.match(texts, /\/model/u);
  // Ни экрана загрузки уровней, ни самих уровней: настраивать нечего.
  assert.doesNotMatch(texts, /Loading thinking levels/u);
  assert.doesNotMatch(texts, /reply_markup.*eff:/u);
});

test("/think still works on a provider the runtime accepts", async (t) => {
  const sent = telegramSpy(t);

  await handleThinkCmd(4102034, "9104205", {
    readEnv: async () => ({
      MODEL_PROVIDER: "ollama",
      OLLAMA_API_KEY: "key",
      OLLAMA_MODEL: "deepseek-v4-pro",
    }),
  });

  const texts = sent.map((call) => call.text).join("\n");
  assert.doesNotMatch(texts, /invalid \(/u);
  assert.match(texts, /Loading thinking levels|deepseek-v4-pro/u);
});
