import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `moduleUrl` names the module the process was started with.
 *
 * Both sides are resolved through symlinks: a plain string compare lies on
 * macOS (`/tmp` is a link to `/private/tmp`) and under the versioned install
 * layout, where the launcher passes a path below the `current` symlink while
 * `import.meta.url` already points at the real version directory.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return realPath(invoked) === realPath(fileURLToPath(moduleUrl));
}
