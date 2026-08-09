import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATION_FILE = /^\d{3}-[a-z0-9-]+\.ts$/;
const MARKER = "migrations.json";

export type MigrationContext = Record<string, unknown>;
export type Migration = (context: MigrationContext) => void | Promise<void>;

type RunOptions = {
  /** Directory holding NNN-name.ts migrations. */
  readonly dir: string;
  /** Where the marker of applied migrations lives - outside any version. */
  readonly dataDir: string;
  readonly context: MigrationContext;
  readonly load?: (path: string) => Promise<{ default: Migration }>;
  readonly log?: (message: string) => void;
};

/** Names already applied. An unreadable marker means "nothing", never a crash. */
function appliedMigrations(dataDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dataDir, MARKER), "utf8"),
    );
    const applied = (parsed as { applied?: unknown } | null)?.applied;
    return Array.isArray(applied)
      ? applied.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

function recordApplied(dataDir: string, applied: readonly string[]): void {
  const marker = join(dataDir, MARKER);
  const temp = `${marker}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify({ schema: "iva-migrations/v1", applied }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(temp, marker);
}

/**
 * Apply the migrations this version ships and has not applied yet.
 *
 * The marker only avoids repeat work; correctness rests on each migration being
 * idempotent, because a lost or corrupted marker must stay a recoverable state.
 */
export async function runMigrations({
  dir,
  dataDir,
  context,
  load = (path) =>
    import(pathToFileURL(path).href) as Promise<{ default: Migration }>,
  log,
}: RunOptions): Promise<string[]> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => MIGRATION_FILE.test(name));
  } catch {
    return [];
  }
  const applied = appliedMigrations(dataDir);
  const pending = files
    .sort()
    .map((file) => file.slice(0, -3))
    .filter((name) => !applied.includes(name));

  const done: string[] = [];
  for (const name of pending) {
    log?.(`migration ${name}`);
    try {
      const module = await load(join(dir, `${name}.ts`));
      await module.default(context);
    } catch (error) {
      throw new Error(
        `migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    done.push(name);
    recordApplied(dataDir, [...applied, ...done]);
  }
  return done;
}
