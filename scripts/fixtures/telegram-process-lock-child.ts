import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, dataDir, botId = "71020", guardDirectory, guardIdentity] =
  process.argv.slice(2);
if (!mode || !dataDir || !guardDirectory || !guardIdentity) {
  throw new Error(
    "usage: child <hold|write-on-signal|kill-holder> <data-dir> <bot-id> <guard-directory> <guard-identity>",
  );
}
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = `${botId}:test-token`;
if (mode === "write-on-signal") {
  process.on("SIGUSR1", () => {
    writeFileSync(join(dataDir, "active-writer"), `${process.pid}\n`);
  });
}

try {
  const { acquireTelegramProcessLock } = (await import(
    `../poller/process-lock.ts?child=${process.pid}`
  )) as unknown as {
    acquireTelegramProcessLock: (options: {
      testGuard: { identity: string; directory: string };
    }) => Promise<{
      owner: unknown;
      resource: string;
      guardRoot: string;
      lockFile: string;
      guardOwnerFile: string;
      holderPid: number;
    }>;
  };
  const lease = await acquireTelegramProcessLock({
    testGuard: { identity: guardIdentity, directory: guardDirectory },
  });
  process.stdout.write(
    `${JSON.stringify({
      event: "READY",
      owner: lease.owner,
      resource: lease.resource,
      guardRoot: lease.guardRoot,
      lockFile: lease.lockFile,
      guardOwnerFile: lease.guardOwnerFile,
      holderPid: lease.holderPid,
    })}\n`,
  );
  if (mode === "kill-holder") {
    process.kill(lease.holderPid, "SIGKILL");
  } else if (mode !== "hold" && mode !== "write-on-signal") {
    throw new Error(`unknown mode: ${mode}`);
  }
  setInterval(() => {}, 60_000);
} catch (error) {
  console.error(error);
  process.exit(1);
}
