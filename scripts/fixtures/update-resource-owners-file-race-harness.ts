import { mock } from "node:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const [phaseArg, temp] = process.argv.slice(2);
if ((phaseArg !== "live" && phaseArg !== "backup") || !temp)
  throw new Error("usage: harness <live|backup> <temp-dir>");

const fs = await import("node:fs");
const namedExports = Object.fromEntries(
  Object.entries(fs).filter(([name]) => name !== "default"),
) as Record<string, unknown>;
const originalRmSync = fs.rmSync;
let armed = false;
let managedUnlinks = 0;
let injectedPath: string | null = null;
const capturedOriginal = join(temp, "critic-captured-original");

namedExports.rmSync = (...args: unknown[]): void => {
  const [path, options] = args;
  const recursive =
    typeof options === "object" &&
    options !== null &&
    "recursive" in options &&
    options.recursive === true;
  if (
    armed &&
    !recursive &&
    typeof path === "string" &&
    basename(path) === "owned"
  ) {
    managedUnlinks++;
    renameSync(path, capturedOriginal);
    writeFileSync(path, "foreign\n");
    injectedPath = path;
  }
  Reflect.apply(originalRmSync, fs, args);
};

mock.module("node:fs", { namedExports });

const { UpdateResourceOwners } =
  await import("../lib/update-resource-owners.ts");
const root = join(temp, "root");
const data = join(temp, "data");
const env = join(root, ".env");
const logFile = join(temp, "cleanup.log");
mkdirSync(root);
mkdirSync(data);
writeFileSync(env, "original\n", { mode: 0o640 });

const resources = new UpdateResourceOwners({
  root,
  dataDir: data,
  envPath: env,
  logFile,
  timestamp: () => "stamp",
});
resources.protectEnvironment();

armed = true;
const rollbackErrors = phaseArg === "live" ? resources.rollback().length : 0;
if (phaseArg === "backup") resources.cleanup();
armed = false;

function containsOriginal(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isFile() && readFileSync(child, "utf8") === "original\n")
      return true;
    if (entry.isDirectory() && containsOriginal(child)) return true;
  }
  return false;
}

process.stdout.write(
  JSON.stringify({
    managedUnlinks,
    injected: injectedPath !== null,
    foreignSurvived: injectedPath !== null && existsSync(injectedPath),
    capturedOriginalSurvived: existsSync(capturedOriginal),
    rollbackErrors,
    liveBytes: readFileSync(env, "utf8"),
    retainedBackup: containsOriginal(data),
    cleanupLog: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
  }),
);
