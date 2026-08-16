import { mock } from "node:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const [resourceArg, phaseArg, temp] = process.argv.slice(2);
if (
  (resourceArg !== ".output" && resourceArg !== "node_modules") ||
  (phaseArg !== "live" && phaseArg !== "backup") ||
  !temp
)
  throw new Error(
    "usage: harness <.output|node_modules> <live|backup> <temp-dir>",
  );

const resource = resourceArg;
const phase = phaseArg;
const fs = await import("node:fs");
const namedExports = Object.fromEntries(
  Object.entries(fs).filter(([name]) => name !== "default"),
) as Record<string, unknown>;
const originalRmSync = fs.rmSync;
let armed = false;
let recursiveManagedRemovals = 0;
const injectedPaths: string[] = [];

namedExports.rmSync = (...args: unknown[]): void => {
  const [path, options] = args;
  const recursive =
    typeof options === "object" &&
    options !== null &&
    "recursive" in options &&
    options.recursive === true;
  if (
    armed &&
    recursive &&
    typeof path === "string" &&
    basename(path) === "owned"
  ) {
    recursiveManagedRemovals++;
    const foreign = join(path, "foreign-after-proof");
    writeFileSync(foreign, "foreign\n");
    injectedPaths.push(foreign);
  }
  Reflect.apply(originalRmSync, fs, args);
};

mock.module("node:fs", {
  namedExports,
});

const { UpdateResourceOwners } =
  await import("../lib/update-resource-owners.ts");
const root = join(temp, "root");
const data = join(temp, "data");
const live = join(root, resource);
const source = join(temp, "source");
const logFile = join(temp, "cleanup.log");
mkdirSync(root);
mkdirSync(data);
mkdirSync(live);
mkdirSync(source);
writeFileSync(join(live, "old"), "old\n");
writeFileSync(join(source, "new"), "new\n");

const resources = new UpdateResourceOwners({
  root,
  dataDir: data,
  envPath: join(root, ".env"),
  logFile,
  timestamp: () => "stamp",
});
if (resource === ".output") resources.promoteOutput(source);
else resources.promoteNodeModules(source);

armed = true;
const rollbackErrors = phase === "live" ? resources.rollback().length : 0;
if (phase === "backup") resources.cleanup();
armed = false;

function containsFile(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isFile() && entry.name === name) return true;
    if (entry.isDirectory() && containsFile(child, name)) return true;
  }
  return false;
}

const cleanupLog = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
process.stdout.write(
  JSON.stringify({
    recursiveManagedRemovals,
    injected: injectedPaths.length > 0,
    foreignSurvived: injectedPaths.some((path) => existsSync(path)),
    rollbackErrors,
    liveHasOld: existsSync(join(live, "old")),
    liveHasNew: existsSync(join(live, "new")),
    retainedOld: containsFile(temp, "old"),
    retainedNew: containsFile(temp, "new"),
    cleanupLog,
  }),
);
