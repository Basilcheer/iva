import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareTelegramStartup } from "../poller/startup-state.ts";

const [mode, directory] = process.argv.slice(2);
if (!mode || !directory)
  throw new Error("usage: child <prime|verify> <directory>");
const markerFile = join(directory, "telegram-backlog-drop.json");

if (mode === "prime") {
  await prepareTelegramStartup({
    markerFile,
    loadOffsetImpl: () => Promise.resolve({ offset: null, delivered: null }),
  });
  writeFileSync(join(directory, "marker-durable"), "ready\n");
  setInterval(() => {}, 60_000);
} else if (mode === "verify") {
  try {
    await prepareTelegramStartup({
      markerFile,
      loadOffsetImpl: () => Promise.resolve({ offset: null, delivered: null }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /marker exists without an offset/u.test(error.message)
    ) {
      process.stdout.write("AMBIGUOUS\n");
      process.exit(0);
    }
    throw error;
  }
  throw new Error("marker without offset permitted a second drop");
} else {
  throw new Error(`unknown mode: ${mode}`);
}
