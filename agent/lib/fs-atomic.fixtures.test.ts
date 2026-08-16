import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODULE_URL = pathToFileURL(
  fileURLToPath(new URL("./fs-atomic.ts", import.meta.url)),
).href;

export const workspace = (): string =>
  mkdtempSync(join(tmpdir(), "iva-fs-atomic-"));

// A real child is required for SIGKILL and dead-owner scenarios.
export async function startChild(
  source: string,
  args: string[],
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, ...args],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  assert.ok(child.stdout);
  await once(child.stdout, "data");
  return child;
}
