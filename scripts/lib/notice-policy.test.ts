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
  deliverMemoryReport,
  memoryReportTail,
  memoryReportsEnabled,
  memoryReportsOffNotice,
  noticeLang,
  noticeTranslator,
  settleReportsOffNotice,
  type ReportsOffNotice,
  type Translate,
} from "./notice-policy.ts";
import { sendTelegramHtml } from "./telegram-send.ts";

const EN: Translate = (english) => english;
const RU: Translate = (_english, russian) => russian;

function dataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-notice-policy-"));
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

// ── Миграция: решение принимается один раз, на первой же ночи ────────────────────────────
// Ночь свёртки воспроизводится в том же порядке, что в rollup.ts: сначала читается, гонялась
// ли эта свёртка раньше (курсор сессии на диске), потом прогон СОХРАНЯЕТ курсор, и только
// в конце решается судьба Notice. Без записанного решения вторая ночь свежей установки
// выглядит как старая — ровно та регрессия, ради которой это поведение и проверяется.
type Night = { outcome: ReportsOffNotice; said: number };

async function night(dir: string, sent: string[]): Promise<Night> {
  const cursor = join(dir, "rollup-session-daily.json");
  const ranBefore = existsSync(cursor);
  writeFileSync(cursor, JSON.stringify({ state: {}, createdAt: Date.now() }));
  const outcome = await settleReportsOffNotice({
    dataDir: dir,
    ranBefore,
    send: () => {
      sent.push("notice");
      return Promise.resolve(true);
    },
  });
  return { outcome, said: sent.length };
}

test("a fresh installation is never told about a report it never had", async (t) => {
  const dir = dataDir(t);
  const sent: string[] = [];

  const first = await night(dir, sent);
  const second = await night(dir, sent);
  const third = await night(dir, sent);

  assert.deepEqual(
    [first.outcome, second.outcome, third.outcome],
    ["not-needed", "settled", "settled"],
    "the answer is decided on night one and never revisited",
  );
  assert.equal(sent.length, 0, "not a single morning message");
  const marker: unknown = JSON.parse(
    readFileSync(join(dir, "notice-memory-reports-off.json"), "utf8"),
  );
  assert.equal((marker as { decision?: string }).decision, "not-needed");
});

test("an installation that had the report hears once, then never again", async (t) => {
  const dir = dataDir(t);
  const sent: string[] = [];
  // Свёртка уже гонялась до апдейта: её курсор лежит в data/.
  writeFileSync(join(dir, "rollup-session-daily.json"), "{}");

  const first = await night(dir, sent);
  const second = await night(dir, sent);

  assert.deepEqual([first.outcome, second.outcome], ["sent", "settled"]);
  assert.equal(sent.length, 1, "one message, not one per night");
});

test("daily and weekly on the same night say it once between them", async (t) => {
  const dir = dataDir(t);
  let said = 0;
  const send = async () => {
    // Обе свёртки уже внутри отправки: заявку разрешает файловая система, а не порядок.
    await new Promise((resolve) => setTimeout(resolve, 5));
    said += 1;
    return true;
  };

  const outcomes = await Promise.all([
    settleReportsOffNotice({ dataDir: dir, ranBefore: true, send }),
    settleReportsOffNotice({ dataDir: dir, ranBefore: true, send }),
  ]);

  assert.deepEqual([...outcomes].sort(), ["sent", "settled"]);
  assert.equal(said, 1);
});

test("a notice that could not be delivered is said by the next night", async (t) => {
  const dir = dataDir(t);
  const marker = join(dir, "notice-memory-reports-off.json");

  assert.equal(
    await settleReportsOffNotice({
      dataDir: dir,
      ranBefore: true,
      send: () => Promise.resolve(false),
    }),
    "failed",
  );
  assert.equal(existsSync(marker), false, "the claim is given back");

  let said = 0;
  assert.equal(
    await settleReportsOffNotice({
      dataDir: dir,
      ranBefore: true,
      send: () => {
        said += 1;
        return Promise.resolve(true);
      },
    }),
    "sent",
  );
  assert.equal(said, 1);
  assert.equal(statSync(marker).mode & 0o777, 0o600);
});

// ── Что уходит в чат по итогам прогона: ровно одно сообщение или ни одного ───────────────
// Транспорт настоящий (sendTelegramHtml → Outbox → Bot API), поймана только сеть: так видно
// и число сообщений, и их текст — то, что увидел бы владелец.
function telegramCalls(
  t: TestContext,
): Array<{ method: string; text: string }> {
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
  return calls;
}

function delivery(dir: string, settings: unknown, ranBefore: boolean) {
  return deliverMemoryReport({
    dataDir: dir,
    settings,
    ranBefore,
    report: "Запомнила три вещи про проект.",
    tr: RU,
    sendReport: (text) => sendTelegramHtml("token", "42", text),
    sendNotice: (text) => sendTelegramHtml("token", "42", text),
  });
}

test("a switched-on report goes out exactly once per run", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  const result = await delivery(
    dir,
    { memoryReports: { enabled: true } },
    true,
  );

  assert.equal(result.status, "sent");
  assert.equal(result.notice, "not-asked");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.match(calls[0].text, /Запомнила три вещи про проект/);
  assert.equal(existsSync(join(dir, "notice-memory-reports-off.json")), false);
});

test("a switched-off report on a fresh installation sends nothing at all", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  const first = await delivery(dir, {}, false);
  const second = await delivery(dir, {}, true); // вторая ночь: курсор уже есть

  assert.equal(first.status, "off");
  assert.equal(first.notice, "not-needed");
  assert.equal(second.notice, "settled");
  assert.deepEqual(calls, [], "a fresh install says nothing in the morning");
});

test("a switched-off report on an old installation sends the notice, once", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  const first = await delivery(
    dir,
    { memoryReports: { enabled: false } },
    true,
  );
  const second = await delivery(dir, {}, true);

  assert.equal(first.notice, "sent");
  assert.equal(second.notice, "settled");
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Утренние отчёты памяти теперь выключены/);
  assert.match(calls[0].text, /\/menu → 🔔 Уведомления/);
  assert.doesNotMatch(calls[0].text, /Запомнила три вещи/);
});

test("a report carrying a secret is redacted on the way out", async (t) => {
  // Ночной отчёт пишет модель по чужому дню, поэтому он такой же рантайм-текст, как
  // алерты brain: доставка обязана идти через outbound-Gate (ADR-0005), а не мимо.
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  await deliverMemoryReport({
    dataDir: dir,
    settings: { memoryReports: { enabled: true } },
    ranBefore: true,
    report: "Разобрала день. Ключ password=hunter2hunter лежал в заметке.",
    tr: RU,
    sendReport: (text) => sendTelegramHtml("token", "42", text),
    sendNotice: (text) => sendTelegramHtml("token", "42", text),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Разобрала день/);
  assert.doesNotMatch(calls[0].text, /hunter2hunter/);
  assert.match(calls[0].text, /REDACTED/);
});

test("settings that are junk keep the report in the vault, not in the chat", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  for (const settings of [
    undefined,
    null,
    "on",
    42,
    [],
    { memoryReports: 1 },
  ]) {
    const result = await delivery(dir, settings, false);
    assert.equal(result.status, "off", `${JSON.stringify(settings)} is not on`);
  }
  assert.deepEqual(calls, []);
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

test("the backup alerts forget the problem once the backup works again", async (t) => {
  const dir = dataDir(t);
  const sent: string[] = [];
  const send = (key: string) => () => {
    sent.push(key);
    return Promise.resolve(true);
  };

  for (const key of ["backup-scan", "backup-oversize"]) {
    await alertOnce(dir, key, "unreadable", send(key));
    assert.equal(
      await alertOnce(dir, key, "unreadable", send(key)),
      "throttled",
    );
    // Ночь, когда бэкап прошёл: проблема забыта.
    await alertResolved(dir, key);
    // Назавтра сломалось снова — говорим сразу, а не через неделю.
    assert.equal(await alertOnce(dir, key, "unreadable", send(key)), "sent");
  }

  assert.deepEqual(sent, [
    "backup-scan",
    "backup-scan",
    "backup-oversize",
    "backup-oversize",
  ]);
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
const policy = await import(process.env.__POLICY_URL);
const tr = await policy.noticeTranslator();
process.stdout.write(JSON.stringify({
  lang: await policy.noticeLang(),
  tail: policy.memoryReportTail(tr),
  migration: policy.memoryReportsOffNotice(tr),
}));
`;

function probe(settingsLanguage: string | null, agentLanguage: string) {
  const dir = mkdtempSync(join(tmpdir(), "iva-notice-lang-"));
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
        __POLICY_URL: pathToFileURL(
          join(import.meta.dirname, "notice-policy.ts"),
        ).href,
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
