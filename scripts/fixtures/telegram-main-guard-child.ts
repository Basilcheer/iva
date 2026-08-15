import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: child <data-dir>");

process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_HOST = "http://iva-guard.invalid";
process.env.TELEGRAM_BOT_TOKEN = "999:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

let firstBotApi = true;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: async (url: string | URL | Request) => {
    const target =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!target.startsWith("https://api.telegram.org/")) {
      throw new Error(
        `unexpected request before Telegram guard proof: ${target}`,
      );
    }
    if (firstBotApi) {
      firstBotApi = false;
      writeFileSync(join(dataDir, `first-bot-api-${process.pid}`), "called\n", {
        flag: "wx",
      });
      process.stdout.write(
        `${JSON.stringify({ event: "BOT_API", pid: process.pid })}\n`,
      );
    }
    return new Promise<never>(() => {
      setInterval(() => {}, 60_000);
    });
  },
});

try {
  const { main } = (await import(
    `../poller/main.ts?guard=${process.pid}`
  )) as unknown as { main: () => Promise<void> };
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
