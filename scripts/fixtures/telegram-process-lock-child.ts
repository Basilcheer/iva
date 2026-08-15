const [mode, dataDir, botId = "71020", guardBaseDir] = process.argv.slice(2);
if (!mode || !dataDir)
  throw new Error(
    "usage: child <hold|kill-holder|kill-logical-holder|kill-state-holder> <data-dir> [bot-id] [guard-base-dir]",
  );
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = `${botId}:test-token`;

try {
  const { acquireTelegramProcessLock } = (await import(
    `../poller/process-lock.ts?child=${process.pid}`
  )) as unknown as {
    acquireTelegramProcessLock: (options?: {
      guardBaseDir?: string;
    }) => Promise<{
      owner: unknown;
      botId: string;
      guardRoot: string;
      logicalGuardRoot: string;
      stateGuardRoot: string;
      lockFile: string;
      logicalLockFile: string;
      stateLockFile: string;
      guardOwnerFile: string;
      logicalGuardOwnerFile: string;
      stateGuardOwnerFile: string;
      holderPid: number;
      logicalHolderPid: number;
      stateHolderPid: number;
    }>;
  };
  const lease = await acquireTelegramProcessLock({
    ...(guardBaseDir === undefined ? {} : { guardBaseDir }),
  });
  process.stdout.write(
    `${JSON.stringify({
      event: "READY",
      owner: lease.owner,
      botId: lease.botId,
      guardRoot: lease.guardRoot,
      logicalGuardRoot: lease.logicalGuardRoot,
      stateGuardRoot: lease.stateGuardRoot,
      lockFile: lease.lockFile,
      logicalLockFile: lease.logicalLockFile,
      stateLockFile: lease.stateLockFile,
      guardOwnerFile: lease.guardOwnerFile,
      logicalGuardOwnerFile: lease.logicalGuardOwnerFile,
      stateGuardOwnerFile: lease.stateGuardOwnerFile,
      holderPid: lease.holderPid,
      logicalHolderPid: lease.logicalHolderPid,
      stateHolderPid: lease.stateHolderPid,
    })}\n`,
  );
  if (mode === "kill-holder") {
    process.kill(lease.holderPid, "SIGKILL");
  } else if (mode === "kill-logical-holder") {
    process.kill(lease.logicalHolderPid, "SIGKILL");
  } else if (mode === "kill-state-holder") {
    process.kill(lease.stateHolderPid, "SIGKILL");
  } else if (mode !== "hold") {
    throw new Error(`unknown mode: ${mode}`);
  }
  setInterval(() => {}, 60_000);
} catch (error) {
  console.error(error);
  process.exit(1);
}
