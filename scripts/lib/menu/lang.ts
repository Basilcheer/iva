// Экран языка интерфейса: [Русский ✓] [English]. Переключение применяется мгновенно —
// settings.json подхватывают свежим чтением оба процесса (мост и канал). Плюс дублируем в
// .env AGENT_LANGUAGE, чтобы node --env-file потребители (cron-скрипты, init-vault) были
// согласованы на своём следующем запуске без правок.
import { writeSettings } from "#lib/settings.mjs";
import { upsertEnv } from "../env-file.ts";

type Lang = "en" | "ru";
type Button = { text: string; callback_data: string };
type MenuState = { page: number };
type MenuContext = {
  lang: Lang;
  deps: { envPath: string };
  getLang: () => Lang;
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
  show: (state: MenuState, screen: string) => Promise<void>;
};

export default {
  parent: "r",
  render(_st: MenuState, ctx: MenuContext) {
    const cur = ctx.getLang();
    const mark = (v: Lang) => (cur === v ? " ✓" : "");
    const rows = [
      [
        ctx.btn(`Русский${mark("ru")}`, "iva_menu:lang:set:ru"),
        ctx.btn(`English${mark("en")}`, "iva_menu:lang:set:en"),
      ],
      ctx.backRow("r"),
    ];
    return {
      text: ctx.tr("🌐 Interface language", "🌐 Язык интерфейса"),
      rows,
    };
  },
  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb !== "set") return;
    const v = args[0] === "en" ? "en" : "ru";
    writeSettings({ language: v });
    try {
      await upsertEnv(ctx.deps.envPath, { AGENT_LANGUAGE: v });
    } catch {
      // .env недоступен — язык всё равно сменится через settings.json; не падаем.
    }
    ctx.lang = v; // обновляем снимок -> root перерисуется уже на новом языке
    st.page = 0;
    await ctx.show(st, "r");
  },
};
