/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ALERT_REPEAT_MS,
  alertDue,
  alertOnce,
  alertResolved,
  memoryReportTail,
  memoryReportsEnabled,
  memoryReportsOffNotice,
  noticeLang,
  noticeOnce,
  noticeTranslator,
  type Translate,
} from "./notices.ts";
import { sendTelegramHtml } from "./telegram-send.ts";

const EN: Translate = (english) => english;
const RU: Translate = (_english, russian) => russian;

function dataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-notices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Report: тумблер ──────────────────────────────────────────────────────────────────────
test("memory reports stay off for anything that is not an explicit true", () => {
  for (const settings of [
    undefined,
    null,
    42,
    "on",
    [],
    {},
    { memoryReports: null },
    { memoryReports: "on" },
    { memoryReports: [] },
    { memoryReports: {} },
    { memoryReports: { enabled: "true" } },
    { memoryReports: { enabled: 1 } },
    { memoryReports: { enabled: false } },
  ])
    assert.equal(
      memoryReportsEnabled(settings),
      false,
      `${JSON.stringify(settings)} must not switch reports on`,
    );

  assert.equal(
    memoryReportsEnabled({ memoryReports: { enabled: true } }),
    true,
  );
  assert.equal(
    memoryReportsEnabled({ language: "en", memoryReports: { enabled: true } }),
    true,
  );
});

// ── Report: язык и форма ночного отчёта ──────────────────────────────────────────────────
test("the report tail names the language and forbids self-delivery", () => {
  const en = memoryReportTail(EN);
  const ru = memoryReportTail(RU);
  assert.match(en, /written in English/);
  assert.match(ru, /written in Russian/);
  for (const tail of [en, ru]) {
    assert.match(tail, /first person/);
    assert.match(tail, /3-5 short lines/);
    assert.match(tail, /Do not send it anywhere yourself/);
    assert.match(tail, /no rich messages, no digest chat/);
  }
  // Инструкция «без внутренних терминов» — единственное место, где они названы.
  assert.equal(en.split("ADD").length - 1, 1);
});

// ── Notice: язык берётся у резолвера, без дерева — у env ──────────────────────────────────
test("notice language comes from the tree, and falls back to the env without it", async () => {
  const broken = () => Promise.reject(new Error("no authored tree"));
  assert.equal(await noticeLang({}, broken), "ru");
  assert.equal(await noticeLang({ AGENT_LANGUAGE: "ru" }, broken), "ru");
  assert.equal(await noticeLang({ AGENT_LANGUAGE: "en" }, broken), "en");
  assert.equal(await noticeLang({ AGENT_LANGUAGE: "de" }, broken), "ru");
  // Дерево есть — его ответ важнее env.
  assert.equal(
    await noticeLang({ AGENT_LANGUAGE: "ru" }, () =>
      Promise.resolve({ getLang: () => "en" as const }),
    ),
    "en",
  );
  const tr = await noticeTranslator({ AGENT_LANGUAGE: "en" }, broken);
  assert.equal(tr("EN", "RU"), "EN");
});

// ── Notice: одноразовое сообщение ────────────────────────────────────────────────────────
test("a one-time notice is said once, whatever the runs do next", async (t) => {
  const dir = dataDir(t);
  let said = 0;
  const send = () => {
    said += 1;
    return Promise.resolve(true);
  };

  assert.equal(await noticeOnce(dir, "memory-reports-off", send), "sent");
  assert.equal(await noticeOnce(dir, "memory-reports-off", send), "already");
  assert.equal(await noticeOnce(dir, "memory-reports-off", send), "already");
  assert.equal(said, 1);

  const marker = join(dir, "notice-memory-reports-off.json");
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  const stored: unknown = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(
    typeof (stored as { notifiedAt?: unknown }).notifiedAt,
    "string",
  );
});

test("two rollups claiming the same notice at once leave one of them silent", async (t) => {
  const dir = dataDir(t);
  let said = 0;
  const send = async () => {
    // Обе свёртки уже внутри отправки: заявка решает спор до неё, а не после.
    await new Promise((resolve) => setTimeout(resolve, 5));
    said += 1;
    return true;
  };

  const outcomes = await Promise.all([
    noticeOnce(dir, "memory-reports-off", send),
    noticeOnce(dir, "memory-reports-off", send),
  ]);

  assert.deepEqual([...outcomes].sort(), ["already", "sent"]);
  assert.equal(said, 1);
});

test("a notice that could not be delivered is said by the next run", async (t) => {
  const dir = dataDir(t);
  const marker = join(dir, "notice-memory-reports-off.json");

  assert.equal(
    await noticeOnce(dir, "memory-reports-off", () => Promise.resolve(false)),
    "failed",
  );
  assert.equal(existsSync(marker), false, "the claim is given back");

  let said = 0;
  assert.equal(
    await noticeOnce(dir, "memory-reports-off", () => {
      said += 1;
      return Promise.resolve(true);
    }),
    "sent",
  );
  assert.equal(said, 1);
  assert.equal(existsSync(marker), true);
});

test("the reports-off notice reaches Telegram once, in the owner's language", async (t) => {
  const dir = dataDir(t);
  const calls: Array<{ method: string; text: string }> = [];
  const mutable = globalThis as unknown as { fetch: unknown };
  const previous = mutable.fetch;
  t.after(() => {
    mutable.fetch = previous;
  });
  mutable.fetch = (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { text?: string };
    calls.push({ method: url.split("/").at(-1) ?? "", text: body.text ?? "" });
    return Promise.resolve({ ok: true, status: 200, text: () => "" });
  };

  const say = () =>
    noticeOnce(dir, "memory-reports-off", async () => {
      const sent = await sendTelegramHtml(
        "token",
        "42",
        memoryReportsOffNotice(RU),
      );
      return sent.ok;
    });

  assert.equal(await say(), "sent");
  assert.equal(await say(), "already");

  assert.equal(calls.length, 1, "one message, not one per run");
  assert.equal(calls[0].method, "sendMessage");
  assert.match(calls[0].text, /Утренние отчёты памяти теперь выключены/);
  assert.match(calls[0].text, /\/menu → 🔔 Уведомления/);
  assert.doesNotMatch(calls[0].text, /Morning memory reports/);
});

// ── Alert: дроссель ──────────────────────────────────────────────────────────────────────
function alertState(dir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, "alert-state.json"), "utf8"),
  ) as Record<string, unknown>;
}

test("an alert speaks once, then keeps quiet for a week", async (t) => {
  const dir = dataDir(t);
  let sent = 0;
  const send = () => {
    sent += 1;
    return Promise.resolve(true);
  };

  assert.equal(await alertOnce(dir, "vault-remote", "missing", send), "sent");
  assert.equal(
    await alertOnce(dir, "vault-remote", "missing", send),
    "throttled",
  );
  assert.equal(sent, 1);

  // Шесть дней спустя — ещё рано; семь — уже пора.
  const stored = alertState(dir);
  const record = stored["vault-remote"] as { lastSentAt: number };
  const sixDays = record.lastSentAt - 6 * 24 * 60 * 60 * 1000;
  writeFileSync(
    join(dir, "alert-state.json"),
    JSON.stringify({
      "vault-remote": { essence: "missing", lastSentAt: sixDays },
    }),
  );
  assert.equal(
    await alertOnce(dir, "vault-remote", "missing", send),
    "throttled",
  );

  writeFileSync(
    join(dir, "alert-state.json"),
    JSON.stringify({
      "vault-remote": {
        essence: "missing",
        lastSentAt: Date.now() - ALERT_REPEAT_MS,
      },
    }),
  );
  assert.equal(await alertOnce(dir, "vault-remote", "missing", send), "sent");
  assert.equal(sent, 2);
});

test("a different problem under the same key speaks at once", async (t) => {
  const dir = dataDir(t);
  const sent: string[] = [];
  const send = (essence: string) => () => {
    sent.push(essence);
    return Promise.resolve(true);
  };

  await alertOnce(dir, "maintenance", "enforce", send("enforce"));
  assert.equal(
    await alertOnce(dir, "maintenance", "enforce", send("enforce")),
    "throttled",
  );
  assert.equal(
    await alertOnce(dir, "maintenance", "enforce,decay", send("enforce,decay")),
    "sent",
  );
  assert.deepEqual(sent, ["enforce", "enforce,decay"]);
});

test("a problem that came back after the fix speaks at once", async (t) => {
  const dir = dataDir(t);
  let sent = 0;
  const send = () => {
    sent += 1;
    return Promise.resolve(true);
  };

  await alertOnce(dir, "health-drop", "dropping", send);
  await alertResolved(dir, "health-drop");
  assert.deepEqual(alertState(dir), {});
  assert.equal(await alertOnce(dir, "health-drop", "dropping", send), "sent");
  assert.equal(sent, 2);

  // Нечего забывать — файл не трогаем и не падаем.
  await alertResolved(dir, "never-seen");
  assert.equal(Object.keys(alertState(dir)).length, 1);
});

test("an alert that never left does not silence the next run", async (t) => {
  const dir = dataDir(t);
  assert.equal(
    await alertOnce(dir, "backup-push", "auth", () => Promise.resolve(false)),
    "failed",
  );
  assert.equal(existsSync(join(dir, "alert-state.json")), false);
  assert.equal(
    await alertOnce(dir, "backup-push", "auth", () => Promise.resolve(true)),
    "sent",
  );
});

test("unreadable, half-written or foreign alert state means speak", (t) => {
  const dir = dataDir(t);
  const path = join(dir, "alert-state.json");
  const cases = [
    "",
    "{ not json",
    '{"vault-remote":{"essence":"missing"',
    "null",
    "[]",
    '"string"',
    '{"vault-remote":null}',
    '{"vault-remote":{"essence":"missing"}}',
    '{"vault-remote":{"essence":"missing","lastSentAt":"today"}}',
    `{"vault-remote":{"essence":"missing","lastSentAt":${Number.MAX_VALUE * 2}}}`,
  ];
  for (const text of cases) {
    writeFileSync(path, text);
    assert.equal(
      alertDue(dir, "vault-remote", "missing"),
      true,
      `state ${text} must fail open`,
    );
  }

  // Файла нет вовсе — тоже говорим.
  rmSync(path, { force: true });
  assert.equal(alertDue(dir, "vault-remote", "missing"), true);
});

test("a clock that jumped back cannot mute an alert forever", (t) => {
  const dir = dataDir(t);
  const now = Date.now();
  writeFileSync(
    join(dir, "alert-state.json"),
    JSON.stringify({
      "vault-remote": { essence: "missing", lastSentAt: now + ALERT_REPEAT_MS },
    }),
  );
  assert.equal(alertDue(dir, "vault-remote", "missing", now), true);
});

test("the alert state is written atomically and stays private", async (t) => {
  const dir = dataDir(t);
  await alertOnce(dir, "core-cap", "clamped", () => Promise.resolve(true));
  const path = join(dir, "alert-state.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(
    readFileSync(path, "utf8").trim().slice(0, 1),
    "{",
    "the whole file, never half of it",
  );
  assert.equal(
    typeof (alertState(dir)["core-cap"] as { lastSentAt?: unknown }).lastSentAt,
    "number",
  );
});

// ── Язык живой установки: settings.language побеждает env ────────────────────────────────
// getLang кэширует язык на ~2с и читает settings.json от cwd, поэтому каждый сценарий —
// свежий процесс со своим data-каталогом (тот же приём, что в agent/lib/i18n.test.ts).
const PROBE = `
const notices = await import(process.env.__NOTICES_URL);
const tr = await notices.noticeTranslator();
process.stdout.write(JSON.stringify({
  lang: await notices.noticeLang(),
  tail: notices.memoryReportTail(tr),
  migration: notices.memoryReportsOffNotice(tr),
}));
`;

function probe(settingsLanguage: string | null, agentLanguage: string) {
  const dir = mkdtempSync(join(tmpdir(), "iva-notices-lang-"));
  if (settingsLanguage !== null)
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ language: settingsLanguage }),
    );
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", PROBE],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        __NOTICES_URL: pathToFileURL(join(import.meta.dirname, "notices.ts"))
          .href,
        ASSISTANT_DATA_DIR: dir,
        AGENT_LANGUAGE: agentLanguage,
      },
    },
  );
  rmSync(dir, { recursive: true, force: true });
  return JSON.parse(output) as {
    lang: string;
    tail: string;
    migration: string;
  };
}

test("the switch in /menu decides the language of every notice, not the env", () => {
  const english = probe("en", "ru");
  assert.equal(english.lang, "en");
  assert.match(english.tail, /written in English/);
  assert.match(english.migration, /Morning memory reports are now off/);

  const russian = probe("ru", "en");
  assert.equal(russian.lang, "ru");
  assert.match(russian.tail, /written in Russian/);
  assert.match(russian.migration, /Утренние отчёты памяти теперь выключены/);

  // Настроек нет — остаётся env, потом дефолт.
  assert.equal(probe(null, "en").lang, "en");
  assert.equal(probe(null, "").lang, "ru");
});
