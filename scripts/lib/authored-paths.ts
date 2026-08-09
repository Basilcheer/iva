import { posix } from "node:path";

/**
 * Which files in an Iva tree are the user's to own.
 *
 * Its own module, and deliberately free of dependencies: the updater decides
 * what to overlay onto a new version before that version has a `node_modules`,
 * so anything it reaches for at load time has to be node built-ins only.
 */
const AUTHORED_PREFIXES = [
  "agent/skills/",
  "agent/connections/",
  "agent/tools/",
  "agent/subagents/",
] as const;

/** A relative path that stays inside the tree, or null. */
function normalizedRelativePath(value: string): string | null {
  if (!value || value.includes("\\") || posix.isAbsolute(value)) return null;
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    return null;
  return normalized;
}

export function isAuthoredPath(value: string): boolean {
  const path = normalizedRelativePath(value);
  if (!path) return false;
  return (
    path === "agent/instructions.md" ||
    AUTHORED_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}
