const [mode, dataDir] = process.argv.slice(2);
if (!mode || !dataDir)
  throw new Error("usage: child <hold|kill-holder> <data-dir>");
process.env.ASSISTANT_DATA_DIR = dataDir;

try {
  const { acquireTelegramProcessLock } = (await import(
    `../poller/process-lock.ts?child=${process.pid}`
  )) as unknown as {
    acquireTelegramProcessLock: () => Promise<{
      owner: unknown;
      holderPid: number;
    }>;
  };
  const lease = await acquireTelegramProcessLock();
  process.stdout.write(
    `${JSON.stringify({ event: "READY", owner: lease.owner })}\n`,
  );
  if (mode === "kill-holder") {
    process.kill(lease.holderPid, "SIGKILL");
  } else if (mode !== "hold") {
    throw new Error(`unknown mode: ${mode}`);
  }
  setInterval(() => {}, 60_000);
} catch (error) {
  console.error(error);
  process.exit(1);
}
