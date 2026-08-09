import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandRunner } from "./lib/command-runner.ts";
import { isEntrypoint } from "./lib/entrypoint.ts";
import { retireCheckout, writeShim } from "./lib/legacy-bridge.ts";
import { adoptUpdateLock } from "./lib/update-lock.ts";
import { layoutFor } from "./lib/version-store.ts";
import {
  finishVersionUpdate,
  type UpdateOutcome,
} from "./lib/version-update.ts";

/**
 * The second half of an update, run by the version being installed.
 *
 * Everything from here on - installing dependencies, building, proving the build
 * starts, flipping, migrating, restarting and retiring the old checkout - is the
 * new code's own logic, so a fix to any of it ships in the release that carries it.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [home, name, ...flags] = argv;
  if (!home || !name) throw new Error("usage: update-finish <home> <version>");
  const verbose = flags.includes("--verbose");
  const layout = layoutFor(home);
  const lock = adoptUpdateLock(layout.data);
  const log = (message: string): void => console.log(`  ${message}`);
  const notify = (message: string): void => console.log(`! ${message}`);
  try {
    const outcome = await finishVersionUpdate({
      home,
      name,
      run: commandRunner(verbose),
      log,
      notify,
      restart: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const { createCliSystemd } = await import("./cli/systemd.ts");
        // Units name `current`, never a version directory, so they survive every
        // later flip and garbage collection without being rewritten.
        const runtime = createCliRuntime(root);
        createCliSystemd(runtime).restartServices();
        runtime.systemd.activate([runtime.UPDATE_TIMER]);
        await Promise.resolve();
      },
    });
    if (outcome.status === "updated") {
      writeShim(home, log);
      if (existsSync(join(home, ".git")))
        for (const removed of retireCheckout(home)) log(`retired ${removed}`);
    }
    const report = process.env.IVA_UPDATE_OUTCOME;
    if (report) writeFileSync(report, JSON.stringify(outcome));
    return report ? 0 : reportLocally(outcome);
  } finally {
    lock.release();
  }
}

function reportLocally(outcome: UpdateOutcome): number {
  console.log(JSON.stringify(outcome));
  return outcome.status === "unhealthy" ? 1 : 0;
}

if (isEntrypoint(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
