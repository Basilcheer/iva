import { defineHook } from "eve/hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Двусторонний транскрипт: финальный ответ Iva дозаписывается в ТОТ ЖЕ дневной файл
// vault, что и реплики юзера (agent/channels/telegram.ts).
//
// Хелпер appendDaily намеренно продублирован из telegram.ts — выносить в общий модуль
// не стали из-за тривиальности (пара fs-вызовов), а НЕ из-за бандла: относительный
// импорт из scripts/lib в бандл работает (см. scripts/lib/telegram-format.mjs, который
// импортируется в telegram.ts). Формат d_brain: `## HH:MM [type]` + контент.
function appendDaily(type: string, content: string): void {
  const tz = process.env.ASSISTANT_TIMEZONE || undefined;
  const now = new Date();
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const dir = join(process.env.ASSISTANT_VAULT_DIR || "vault", "daily");
  mkdirSync(dir, { recursive: true });
  // Append-only: существующие записи никогда не переписываются.
  appendFileSync(
    join(dir, `${localDate}.md`),
    `\n## ${hhmm} ${type}\n${content}\n`,
    "utf8",
  );
}

export default defineHook({
  events: {
    // message.completed несёт видимый текст одного завершённого шага ассистента.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы; пропускаем,
    // пишем только финальные реплики Iva.
    "message.completed": (event) => {
      if (event.data.finishReason === "tool-calls") return;
      const text = (event.data.message ?? "").trim();
      if (!text) return;
      appendDaily("[iva]", text);
    },
  },
});
