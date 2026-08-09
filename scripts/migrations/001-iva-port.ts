import { join } from "node:path";
import { createCliRuntime } from "../cli/runtime.ts";
import { createCliSystemd } from "../cli/systemd.ts";
import type { MigrationContext } from "../lib/migrations.ts";

/**
 * Give installs made before IVA_PORT an explicit port.
 *
 * The in-place updater used to do this on every single run; on the immutable
 * layout a data change belongs to the version that introduced it, runs once, and
 * is a no-op afterwards because the variable is then already there.
 */
export default function migrate(context: MigrationContext): void {
  const home = typeof context.home === "string" ? context.home : "";
  const systemd = createCliSystemd(createCliRuntime(join(home, "current")));
  systemd.migrateEnv({ quiet: true });
}
