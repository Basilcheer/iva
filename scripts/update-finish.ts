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
  const force = flags.includes("--force");
  const layout = layoutFor(home);
  const lock = adoptUpdateLock(layout.data);
  const log = (message: string): void => console.log(`  ${message}`);
  let outcome: UpdateOutcome;
  try {
    outcome = await finishVersionUpdate({
      home,
      name,
      run: commandRunner(verbose),
      force,
      log,
      notify: (message) => console.log(`! ${message}`),
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
      adopt: () => {
        writeShim(home, log);
        if (existsSync(join(home, ".git")))
          for (const removed of retireCheckout(home)) log(`retired ${removed}`);
      },
    });
  } catch (error) {
    // The caller is another process: a stack trace on its terminal explains
    // nothing, and the update stays where the next run can pick it up.
    outcome = {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    lock.release();
  }
  const report = process.env.IVA_UPDATE_OUTCOME;
  if (report) writeFileSync(report, JSON.stringify(outcome));
  else console.log(JSON.stringify(outcome));
  return outcome.status === "updated" ? 0 : 1;
}

if (isEntrypoint(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
