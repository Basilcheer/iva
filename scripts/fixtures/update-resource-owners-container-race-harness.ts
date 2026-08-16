import { mock } from "node:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [modeArg, temp] = process.argv.slice(2);
if ((modeArg !== "environment" && modeArg !== "output") || !temp)
  throw new Error("usage: harness <environment|output> <temp-dir>");

const fs = await import("node:fs");
const namedExports = Object.fromEntries(
  Object.entries(fs).filter(([name]) => name !== "default"),
) as Record<string, unknown>;
const originalRmdirSync = fs.rmdirSync;
let armed = false;
let managedRmdirs = 0;
let foreignPath: string | null = null;
const capturedOriginal = join(temp, "critic-captured-container");

namedExports.rmdirSync = (path: unknown): void => {
  if (armed && typeof path === "string") {
    managedRmdirs++;
    renameSync(path, capturedOriginal);
    mkdirSync(path);
    foreignPath = path;
  }
  Reflect.apply(originalRmdirSync, fs, [path]);
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
writeFileSync(env, "original-env\n");

const resources = new UpdateResourceOwners({
  root,
  dataDir: data,
  envPath: env,
  logFile,
  timestamp: () => "stamp",
});

let rollbackErrors = 0;
if (modeArg === "environment") {
  resources.protectEnvironment();
  armed = true;
  resources.cleanup();
} else {
  const live = join(root, ".output");
  const source = join(temp, "source");
  mkdirSync(live);
  mkdirSync(source);
  writeFileSync(join(live, "old"), "old\n");
  writeFileSync(join(source, "new"), "new\n");
  resources.promoteOutput(source);
  armed = true;
  rollbackErrors = resources.rollback().length;
}
armed = false;

process.stdout.write(
  JSON.stringify({
    managedRmdirs,
    injected: foreignPath !== null,
    foreignSurvived: foreignPath !== null && existsSync(foreignPath),
    capturedOriginalSurvived: existsSync(capturedOriginal),
    rollbackErrors,
    envBytes: readFileSync(env, "utf8"),
    outputOld:
      modeArg === "output" &&
      readFileSync(join(root, ".output", "old"), "utf8") === "old\n",
    cleanupLog: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
  }),
);
