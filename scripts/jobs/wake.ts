// Точка входа пробуждения после запуска расписания:
// `node --env-file-if-exists=.env scripts/jobs/wake.ts <name> <startedAt>`.
// Запускает её schedule-runner (agent/lib/schedule-runner.ts) после каждого запуска.
// Ход агента идёт через тот же шлюз, что у напоминаний (scripts/lib/reminder-turn.ts),
// а ответ уходит владельцу кодом только если он непустой.
import { join } from "node:path";
import { dataDir } from "#lib/data-dir.ts";
import { jobFactsFile } from "#lib/job-facts.ts";
import { failureWaitsForBrief, parseProactive } from "#lib/proactive-config.ts";
import { readSettings } from "#lib/settings.ts";
import { zonedParts } from "#lib/zoned-time.ts";
import { resolveTimeZone } from "../lib/timezone.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import { runJobWake } from "../lib/job-wake.ts";
import {
  reminderClientOptions,
  runReminderTurn,
} from "../lib/reminder-turn.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

async function main(): Promise<void> {
  const name = (process.argv[2] ?? "").trim();
  const startedAt = Number.parseInt(process.argv[3] ?? "", 10);
  if (name === "" || !Number.isSafeInteger(startedAt)) {
    console.error("usage: wake.ts <name> <startedAt>");
    process.exit(2);
  }
  const token = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = notificationChat(process.env);
  const config = parseProactive(readSettings(join(dataDir(), "settings.json")));
  const timeZone = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);
  const status = await runJobWake(name, startedAt, {
    factsFile: jobFactsFile(dataDir()),
    quiet: (now) => failureWaitsForBrief(config, zonedParts(now, timeZone).hh),
    tr: await noticeTranslator(process.env),
    runTurn: (prompt) =>
      runReminderTurn(prompt, reminderClientOptions(process.env), { log }),
    send: async (text) => {
      if (!token || !chat)
        throw new Error(
          "TELEGRAM_BOT_TOKEN or the owner chat is missing — run: iva doctor",
        );
      // rich: кнопка «Починить» доходит кнопкой, а не текстом (без неё sendTelegramHtml шлёт HTML).
      const result = await sendTelegramHtml(token, chat, text, { rich: true });
      return result.ok;
    },
  });
  console.log(`wake: ${name} ${status}`);
  process.exit(status === "failed" ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(
    `wake: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
