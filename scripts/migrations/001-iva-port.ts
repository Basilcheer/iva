import { join } from "node:path";
import { createCliRuntime } from "../cli/runtime.ts";
import { createCliSystemd } from "../cli/systemd.ts";
import type { MigrationContext } from "../lib/version-update.ts";

/**
 * Give installs made before IVA_PORT an explicit port. The in-place updater did
 * this on every run; on the immutable layout a data change belongs to the version
 * that introduced it, runs once, and is a no-op afterwards.
 */
export default function migrate(context: MigrationContext): void {
  const home = typeof context.home === "string" ? context.home : "";
  const systemd = createCliSystemd(createCliRuntime(join(home, "current")));
  systemd.migrateEnv({ quiet: true });
}
