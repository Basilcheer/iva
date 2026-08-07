import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listCustomConflicts,
  resolveCustomConflict,
} from "./lib/custom-layer.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SideSchema = z.enum(["base", "local", "upstream", "edited"]);

function dataDir(): string {
  const configured = process.env.ASSISTANT_DATA_DIR || "data";
  return isAbsolute(configured) ? configured : join(ROOT, configured);
}

export function runCustomRecovery(args: readonly string[]): void {
  const [command = "status", path, rawSide] = args;
  const customDataDir = resolve(dataDir());
  if (command === "status") {
    let conflicts: ReturnType<typeof listCustomConflicts> = [];
    let manifestError: string | undefined;
    try {
      conflicts = listCustomConflicts(customDataDir);
    } catch (error) {
      manifestError = error instanceof Error ? error.message : String(error);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: "iva-custom-recovery/v1",
          customRoot: join(customDataDir, "custom"),
          conflicts,
          ...(manifestError ? { manifestError } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  try {
    if (command !== "resolve" || !path || !rawSide)
      throw new Error(
        "usage: custom-recovery.ts status | resolve <agent/path> <base|local|upstream|edited>",
      );
    const side = SideSchema.parse(rawSide);
    const resolved = resolveCustomConflict({
      dataDir: customDataDir,
      path,
      side,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        ...resolved,
        next: "npm run build, then ask the owner to send /restart",
      })}\n`,
    );
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url)))
  runCustomRecovery(process.argv.slice(2));
