// Экран статуса: одна карта — версия, провайдер·модель·размышления, поиск+ключ, язык,
// userbot, Google, расход за сегодня. Быстрые поля (env/файлы) читаются синхронно в первом
// рендере; общая userbot-проба systemd/HTTP/Telethon НЕ ждётся синхронно — сначала
// заглушка «…», затем async-edit по завершении. Так единственный getUpdates-цикл моста не
// блокируется дольше ~1.5с.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readEnvValues } from "../env-file.ts";
import { CATALOG } from "../model-catalog.mjs";
import { SEARCH_CATALOG } from "../search-catalog.mjs";
import { readEntries, summarize } from "../usage.mjs";
import { probeUserbotHealth } from "../userbot-health.mjs";

function version(root) {
  try {
    return (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ||
      "?"
    );
  } catch {
    return "?";
  }
}

const groupThousands = (n) =>
  String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function usageToday(dataDir, tz, T) {
  try {
    const agg = summarize(readEntries(dataDir), {
      window: "today",
      now: Date.now(),
      tz,
    });
    const total = agg?.totals?.total || 0;
    const turns = agg?.totals?.turns || 0;
    return T(
      `${groupThousands(total)} tokens · ${turns} turns`,
      `${groupThousands(total)} токенов · ${turns} ходов`,
    );
  } catch {
    return T("n/a", "н/д");
  }
}

// Собирает быстрые поля (без медленной пробы) — переиспользуется первым рендером и async-edit'ом.
function fastFields(env, ctx) {
  const provider = CATALOG[env.MODEL_PROVIDER] ? env.MODEL_PROVIDER : "ollama";
  const cat = CATALOG[provider];
  const searchProv = env.SEARCH_PROVIDER || "tavily";
  const searchCat = SEARCH_CATALOG[searchProv];
  return {
    version: version(ctx.deps.root),
    provider,
    model: env[cat.modelVar] || cat.def,
    effort: (env.THINKING_EFFORT || "").toLowerCase(),
    searchProv,
    hasKey: Boolean(searchCat && env[searchCat.keyVar]),
    lang: ctx.getLang(),
    gws: existsSync(join(homedir(), ".config/gws/client_secret.json")),
    usage: usageToday(ctx.deps.dataDir, env.ASSISTANT_TIMEZONE, ctx.tr),
  };
}

function buildView(d, health, ctx) {
  const T = ctx.tr;
  const labels = {
    off: T("off", "выкл"),
    starting: T("starting", "запускается"),
    unreachable: T("unreachable", "недоступен"),
    unauthorized: T("login required", "нужен вход"),
    ready: T("ready", "готов"),
  };
  const ub = health === null ? "…" : labels[health.state] || labels.unreachable;
  const lines = [
    T("📊 Status", "📊 Статус"),
    "",
    `Iva v${d.version}`,
    T(
      `Model: ${d.provider} · ${d.model}${d.effort ? ` · think ${d.effort}` : ""}`,
      `Модель: ${d.provider} · ${d.model}${d.effort ? ` · размышления ${d.effort}` : ""}`,
    ),
    T(
      `Search: ${d.searchProv} ${d.hasKey ? "🔑" : "🔒"}`,
      `Поиск: ${d.searchProv} ${d.hasKey ? "🔑" : "🔒"}`,
    ),
    T(`Language: ${d.lang}`, `Язык: ${d.lang}`),
    `Userbot: ${ub}`,
    T(
      `Google: ${d.gws ? "configured" : "not set"}`,
      `Google: ${d.gws ? "настроен" : "не настроен"}`,
    ),
    T(`Usage today: ${d.usage}`, `Расход за сегодня: ${d.usage}`),
  ];
  const rows = [
    [ctx.btn(T("🔄 Refresh", "🔄 Обновить"), "iva_menu:st:rf")],
    ctx.backRow("r"),
  ];
  return { text: lines.join("\n"), rows };
}

export default {
  parent: "r",
  async render(st, ctx) {
    const env = await readEnvValues(ctx.deps.envPath);
    const d = fastFields(env, ctx);

    // Медленную пробу гоним ОТДЕЛЬНО и правим сообщение по готовности — только если экран
    // всё ещё текущий (пользователь не ушёл в другой раздел / не закрыл меню).
    const probe = ctx.deps.probeUserbotHealth || probeUserbotHealth;
    probe({ root: ctx.deps.root, port: env.TELEGRAM_MCP_PORT || "8724" })
      .then((result) => {
        if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === "st") {
          const v = buildView(d, result, ctx);
          return ctx.flows.screen(st, v.text, v.rows);
        }
      })
      .catch(() => {});
    return buildView(d, null, ctx);
  },
  on() {},
};
