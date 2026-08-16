import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dataDir, mode = "hang", guardDirectory, guardIdentity] =
  process.argv.slice(2);
if (!dataDir || !guardDirectory || !guardIdentity)
  throw new Error(
    "usage: child <data-dir> [hang|delete-webhook-false|kill-holder-before-bot-api] <guard-directory> <guard-identity>",
  );

process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_HOST = "http://iva-guard.invalid";
process.env.TELEGRAM_BOT_TOKEN = "74002:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

let firstBotApi = true;
let guardOwnerFile: string | null = null;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: async (url: string | URL | Request, init?: RequestInit) => {
    const target =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!target.startsWith("https://api.telegram.org/")) {
      throw new Error(
        `unexpected request before Telegram guard proof: ${target}`,
      );
    }
    const method = target.slice(target.lastIndexOf("/") + 1);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : null;
    writeFileSync(
      join(dataDir, "telegram-bot-api-calls.jsonl"),
      `${JSON.stringify({ method, body })}\n`,
      { flag: "a" },
    );
    if (!firstBotApi && mode === "delete-webhook-false") {
      throw new Error("Bot API reached after rejected deleteWebhook");
    }
    if (firstBotApi) {
      firstBotApi = false;
      if (typeof init?.body !== "string") {
        throw new Error("Telegram Bot API fixture expected a JSON body");
      }
      const evidence = {
        method,
        body,
        ownerAtCall: readFileSync(
          guardOwnerFile ?? "missing-telegram-process-owner",
          "utf8",
        ),
        markerAtCall: readFileSync(
          join(dataDir, "telegram-backlog-drop.json"),
          "utf8",
        ),
      };
      writeFileSync(
        join(dataDir, `first-bot-api-${process.pid}`),
        `${JSON.stringify(evidence)}\n`,
        { flag: "wx" },
      );
      process.stdout.write(
        `${JSON.stringify({ event: "BOT_API", pid: process.pid })}\n`,
      );
      if (mode === "delete-webhook-false") {
        return {
          json: () =>
            Promise.resolve({
              ok: false,
              description: "fixture rejected deleteWebhook",
            }),
        };
      }
    }
    return new Promise<never>(() => {
      setInterval(() => {}, 60_000);
    });
  },
});

try {
  const { main } = (await import(
    `../poller/main.ts?guard=${process.pid}`
  )) as unknown as {
    main: (options: {
      acquireProcessLockImpl: () => Promise<unknown>;
    }) => Promise<void>;
  };
  // Use the same module instance as main.ts: the accepted lease capability is
  // intentionally module-private and cannot be minted by a duplicate import.
  const { acquireTelegramProcessLock } =
    (await import("../poller/process-lock.ts")) as unknown as {
      acquireTelegramProcessLock: (options: {
        testGuard: { identity: string; directory: string };
      }) => Promise<{ guardOwnerFile: string; holderPid: number }>;
    };
  await main({
    acquireProcessLockImpl: async () => {
      const lease = await acquireTelegramProcessLock({
        testGuard: { identity: guardIdentity, directory: guardDirectory },
      });
      guardOwnerFile = lease.guardOwnerFile;
      if (mode === "kill-holder-before-bot-api") {
        process.kill(lease.holderPid, "SIGKILL");
        // The production lease-loss callback terminates this Bridge. Keeping
        // the injected acquire pending proves no startup or Bot API work can
        // race ahead after the kernel helper has died.
        await new Promise<never>(() => {
          setInterval(() => {}, 60_000);
        });
      }
      return lease;
    },
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
