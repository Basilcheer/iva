import { posix } from "node:path";

/**
 * Which files in an Iva tree are the user's to own. Deliberately free of
 * dependencies: the updater decides what to overlay before the new version has a
 * `node_modules`, so it may only reach for node built-ins at load time.
 */
const AUTHORED_PREFIXES = [
  "agent/skills/",
  "agent/connections/",
  "agent/tools/",
  "agent/subagents/",
] as const;

export function isAuthoredPath(value: string): boolean {
  // Nothing absolute, nothing that climbs out with `..`, nothing outside `agent/`.
  if (!value || value.includes("\\") || posix.isAbsolute(value)) return false;
  const path = posix.normalize(value);
  if (path !== value || path === "." || path === ".." || path.startsWith("../"))
    return false;
  return (
    path === "agent/instructions.md" ||
    AUTHORED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}
