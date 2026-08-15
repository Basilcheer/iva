/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import character from "./character.ts";
import search from "./search.ts";
// gws.ts импортируем ДИНАМИЧЕСКИ в своём тесте: он считает SECRET_PATH от homedir() при
// загрузке, поэтому HOME переопределяем ДО импорта, чтобы не тронуть реальный ~/.config/gws.

type Button = { text: string; callback_data: string };
type View = { text: string; rows: Button[][] };
type AwaitText = {
  kind: string;
  secret: boolean;
  data: Record<string, unknown>;
};
type Quiz = { i: number; answers: number[]; code: string | null };
type MenuState = {
  flow: string;
  chatId: number;
  userId: string;
  screen: string;
  page: number;
  awaitText: AwaitText | null;
  data: { quiz?: Quiz };
  msgId: number;
  _last?: View;
};
type MenuContext = {
  deps: Record<string, unknown>;
  flows: {
    screen: (state: MenuState, text: string, rows: Button[][]) => Promise<void>;
    end: (state: MenuState, text: string, rows: Button[][]) => Promise<void>;
  };
  tr: (english: string, russian: string) => string;
  getLang: () => string;
  btn: (text: string, data: string) => Button;
  backRow: (screen: string) => Button[];
  show: (state: MenuState, screen: string) => Promise<void>;
};
type Screen = {
  render: (state: MenuState, context: MenuContext) => View | Promise<View>;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
  texts?: Record<
    string,
    (
      text: unknown,
      message: unknown,
      state: MenuState,
      context: MenuContext,
    ) => Promise<void>
  >;
};

const characterScreen = character as unknown as Screen;
const searchScreen = search as unknown as Screen;

// ── лёгкий стенд ctx по контракту движка (index.ts), но без самого движка ───────────────
// flows.screen/end пишут в st._last и накапливают рендеры; ctx.show зовёт render модуля из
// переданного реестра. Хватает, чтобы гонять render/on/texts экранов в изоляции.
function makeCtx({
  lang = "ru",
  deps = {},
  screens = {},
}: {
  lang?: string;
  deps?: Record<string, unknown>;
  screens?: Record<string, Screen>;
} = {}) {
  const rendered: Array<{
    kind: "screen" | "end";
    text: string;
    rows: Button[][];
  }> = [];
  const harness: {
    ctx: MenuContext;
    rendered: typeof rendered;
    st: MenuState | null;
  } = {
    ctx: undefined as unknown as MenuContext,
    rendered,
    st: null,
  };
  const flows = {
    screen: (st: MenuState, text: string, rows: Button[][]) => {
      st.msgId ??= 1;
      st._last = { text, rows };
      rendered.push({ kind: "screen", text, rows });
      return Promise.resolve();
    },
    end: (st: MenuState, text: string, rows: Button[][]) => {
      st._last = { text, rows };
      rendered.push({ kind: "end", text, rows });
      return Promise.resolve();
    },
    touch: () => {},
  };
  const ctx = {
    deps,
    flows,
    lang,
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
    getLang: () => lang,
    btn: (text: string, data: string) => ({ text, callback_data: data }),
    backRow: (sid: string) => [
      {
        text: sid === "r" ? "‹ Меню" : "‹ Назад",
        callback_data: `iva_menu:${sid}:o`,
      },
    ],
    show: async (st: MenuState, sid: string) => {
      st.screen = sid;
      const mod = screens[sid];
      if (mod) {
        const v = await mod.render(st, ctx);
        if (v) await flows.screen(st, v.text, v.rows);
      }
    },
  };
  harness.ctx = ctx;
  return harness;
}

const newState = (over: Partial<MenuState> = {}): MenuState => ({
  flow: "menu",
  chatId: 10,
  userId: "20",
  screen: "r",
  page: 0,
  awaitText: null,
  data: {},
  msgId: 1,
  ...over,
});

// ── 1. character: полный проход 10 ответов через scoreQuiz + apply пишет PERSONA.md ─────
test("character: 10 ответов скорятся через scoreQuiz, apply пишет PERSONA.md", async () => {
  const vault = mkdtempSync(join(tmpdir(), "iva-vault-"));
  process.env.ASSISTANT_VAULT_DIR = vault;
  const h = makeCtx({ lang: "ru", screens: { chr: characterScreen } });
  const st = newState({ screen: "chr" });
  h.st = st;

  // Интро (verb o) — предупреждение + [Начать].
  const intro = characterScreen.render(st, h.ctx) as View;
  assert.match(intro.text, /Характер/);
  assert.ok(intro.rows.some((r) => r[0].callback_data === "iva_menu:chr:go"));

  // Старт квиза.
  await characterScreen.on("go", [], st, h.ctx);
  assert.equal(st.data.quiz?.i, 0);

  // Гард протухшего даблтапа: ответ не на текущий вопрос игнорируется, i не двигается.
  await characterScreen.on("q", ["5", "0"], st, h.ctx);
  assert.equal(st.data.quiz?.i, 0);

  // Все 10 ответов «да» (индекс 0 = +2) → детерминированно WVPF (Старшая сестра).
  for (let i = 0; i < 10; i++)
    await characterScreen.on("q", [String(i), "0"], st, h.ctx);
  assert.equal(st.data.quiz?.i, 10);
  assert.equal(st.data.quiz?.code, "WVPF");

  // Последний рендер — портрет с именем архетипа и кнопками Принять/Заново.
  assert.match(st._last?.text ?? "", /Старшая сестра/);
  assert.ok(
    (st._last?.rows ?? []).some((r) =>
      r.some((b) => b.callback_data === "iva_menu:chr:apply"),
    ),
  );

  // apply пишет vault/PERSONA.md: <=800 симв., самодостаточная инструкция с кодом.
  await characterScreen.on("apply", [], st, h.ctx);
  const persona = readFileSync(join(vault, "PERSONA.md"), "utf8");
  assert.ok(persona.length <= 800, `persona ${persona.length} > 800`);
  assert.match(persona, /^# /);
  assert.match(persona, /WVPF/);
  assert.match(st._last?.text ?? "", /со следующего сообщения/);
});

test("character: другой набор ответов даёт другой код (интеграция scoreQuiz)", async () => {
  const h = makeCtx({ lang: "ru", screens: { chr: characterScreen } });
  const st = newState({ screen: "chr" });
  h.st = st;
  await characterScreen.on("go", [], st, h.ctx);
  // Все «нет» (индекс 3 = -2): с реверс-вопросами → DVRF (Эксперт), не зеркало WVPF.
  for (let i = 0; i < 10; i++)
    await characterScreen.on("q", [String(i), "3"], st, h.ctx);
  assert.equal(st.data.quiz?.code, "DVRF");
});

// ── 2. search: render помечает ✓ текущий провайдер и 🔑 провайдеров с ключом ────────────
test("search: render ✓ текущий провайдер и 🔑 наличие ключа на фикстурном .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-"));
  const envPath = join(dir, ".env");
  // brave — текущий (без ключа); tavily — ключ есть, но не текущий.
  writeFileSync(
    envPath,
    "SEARCH_PROVIDER=brave\nTAVILY_API_KEY=tvly-abc12345\n",
  );
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { srch: searchScreen },
  });
  const st = newState({ screen: "srch" });
  h.st = st;

  const view = await searchScreen.render(st, h.ctx);
  const labelOf = (id: string) =>
    view.rows
      .map((r) => r[0])
      .find((b) => b.callback_data === `iva_menu:srch:set:${id}`)?.text;

  const brave = labelOf("brave");
  const tavily = labelOf("tavily");
  const exa = labelOf("exa");
  assert.ok(brave?.startsWith("✓ "), `brave текущий: ${brave}`);
  assert.ok(!brave?.includes("🔑"), `у brave ключа нет: ${brave}`);
  assert.ok(tavily?.includes("🔑"), `у tavily ключ есть: ${tavily}`);
  assert.ok(!tavily?.startsWith("✓"), `tavily не текущий: ${tavily}`);
  assert.ok(
    exa && !exa.includes("🔑") && !exa.startsWith("✓"),
    `exa без бейджей: ${exa}`,
  );
  // «Сменить ключ» указывает на текущего провайдера.
  assert.ok(
    view.rows.some((r) => r[0].callback_data === "iva_menu:srch:key:brave"),
  );
  // Значения ключей нигде в тексте/кнопках.
  assert.ok(!JSON.stringify(view).includes("tvly-abc12345"));
});

test("search: тап по провайдеру без ключа ставит секретный awaitText (в личке)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env2-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "SEARCH_PROVIDER=tavily\n");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { srch: searchScreen },
  });
  const st = newState({ screen: "srch", chatId: 555 }); // положительный chatId = личка
  h.st = st;
  await searchScreen.on("set", ["brave"], st, h.ctx);
  assert.ok(st.awaitText, "awaitText поставлен");
  assert.equal(st.awaitText.kind, "apikey");
  assert.equal(st.awaitText.secret, true);
  assert.equal(st.awaitText.data.provider, "brave");
});

test("search: inherited property names are never accepted as providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-provider-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "SEARCH_PROVIDER=toString\n");
  const h = makeCtx({
    lang: "en",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { srch: searchScreen },
  });
  const st = newState({ screen: "srch", chatId: 555 });
  h.st = st;

  const view = await searchScreen.render(st, h.ctx);
  const tavily = view.rows
    .flat()
    .find((button) => button.callback_data === "iva_menu:srch:set:tavily");
  assert.ok(tavily?.text.startsWith("✓ "));

  await searchScreen.on("set", ["toString"], st, h.ctx);
  assert.equal(st.awaitText, null);

  st.awaitText = {
    kind: "apikey",
    secret: true,
    data: { provider: "toString" },
  };
  await searchScreen.texts?.apikey("abcdefgh", null, st, h.ctx);
  assert.equal(st.awaitText, null);
  assert.match(st._last?.text ?? "", /doesn't look like a key/);
  assert.equal(readFileSync(envPath, "utf8"), "SEARCH_PROVIDER=toString\n");
});

// ── 3. gws: валидация shape client_secret.json (bad JSON / неверная форма / успех 0600) ──
test("gws.gwsjson: bad JSON и неверная форма отвергаются, валидный секрет пишется 0600", async () => {
  const home = mkdtempSync(join(tmpdir(), "iva-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // до импорта — SECRET_PATH возьмёт этот homedir
  const gws = (await import("./gws.ts")).default as unknown as Screen;
  const h = makeCtx({ lang: "ru", screens: { gws } });
  const st = newState({
    screen: "gws",
    awaitText: { kind: "gwsjson", secret: true, data: {} },
  });
  h.st = st;
  const fakeMsg = (id: number) => ({ chat: { id: 10 }, message_id: id });

  // Невалидный JSON → повтор-приглашение, awaitText не снят, файла нет.
  await gws.texts?.gwsjson("не json {", fakeMsg(1), st, h.ctx);
  assert.ok(st.awaitText, "awaitText сохранён после битого JSON");
  assert.match(st._last?.text ?? "", /JSON/i);

  // JSON-примитив синтаксически валиден, но не проходит отдельную проверку формы.
  await gws.texts?.gwsjson("null", fakeMsg(2), st, h.ctx);
  assert.ok(st.awaitText, "awaitText сохранён после JSON-примитива");
  assert.match(st._last?.text ?? "", /client_secret/);

  // Валидный JSON, но не client_secret (нет installed/web с client_id).
  await gws.texts?.gwsjson(JSON.stringify({ foo: 1 }), fakeMsg(3), st, h.ctx);
  assert.ok(st.awaitText, "awaitText сохранён после неверной формы");
  assert.match(st._last?.text ?? "", /client_secret/);

  // Корректный client_secret.json (Desktop app: installed + client_id).
  const secret = JSON.stringify({
    installed: {
      client_id: "abc.apps.googleusercontent.com",
      client_secret: "shhh",
      redirect_uris: ["http://localhost"],
    },
  });
  await gws.texts?.gwsjson(secret, fakeMsg(4), st, h.ctx);
  assert.equal(st.awaitText, null, "awaitText снят при успехе");
  const path = join(home, ".config/gws/client_secret.json");
  assert.ok(existsSync(path), "client_secret.json записан");
  assert.equal(statSync(path).mode & 0o777, 0o600, "права 0600");
  assert.equal(readFileSync(path, "utf8"), secret);

  chmodSync(path, 0o644);
  const replacement = JSON.stringify({
    installed: { client_id: "replacement.apps.googleusercontent.com" },
  });
  st.awaitText = { kind: "gwsjson", secret: true, data: {} };
  await gws.texts?.gwsjson(replacement, fakeMsg(5), st, h.ctx);
  assert.equal(readFileSync(path, "utf8"), replacement);
  assert.equal(
    statSync(path).mode & 0o777,
    0o600,
    "replacement restores strict mode before publishing",
  );

  process.env.HOME = prevHome;
});
