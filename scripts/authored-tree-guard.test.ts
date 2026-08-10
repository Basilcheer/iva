/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Guard for the authored tree: eve rebuilds `agent/` at service start, so any module
// specifier there that resolves outside `agent/` drags `scripts/` into the bundle — the
// failure that produced the 0.3.14 crash loop (issue #176). There are no escapes left and
// no list to add one to: the tree is closed, and a new specifier out of `agent/` is red on
// sight. `#`-aliases are resolved through package.json instead of trusted.
//
// What replaced the last of them is the seam: the half the authored tree needs lives in
// `agent/lib`, the half `iva` loads on an install whose `agent/` is missing stays in
// `scripts/`, and neither reaches the other at load time. Where the two halves must know
// the same thing anyway — an env-var name, the OAuth constants, the reasoning vocabulary —
// each side is deliberately self-contained and a test pins the copies together, the way
// `usage` shares only its log path (docs/tech-debt.md §3).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AUTHORED = join(ROOT, "agent");

// Every module-looking literal, not just `import`/`export` clauses: a specifier parked in
// a `const` and fed to a dynamic `import()` escapes the tree exactly as hard.
const MODULE_LITERAL = /"([^"\n]+\.(?:ts|mts|mjs|js))"/gu;

const importsMap = (): [string, string][] => {
  const manifest: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const entries =
    typeof manifest === "object" && manifest !== null && "imports" in manifest
      ? Object.entries(manifest.imports as Record<string, string>)
      : [];
  // Node picks the most specific pattern; longest prefix first reproduces that.
  return entries.sort(
    ([left], [right]) => right.indexOf("*") - left.indexOf("*"),
  );
};

// Absolute path the specifier points at, or null when it names a bare package/builtin.
function targetOf(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("."))
    return resolve(dirname(join(ROOT, fromFile)), specifier);
  if (!specifier.startsWith("#")) return null;
  for (const [pattern, mapped] of importsMap()) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === specifier) return join(ROOT, mapped);
      continue;
    }
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (
      specifier.length >= head.length + tail.length &&
      specifier.startsWith(head) &&
      specifier.endsWith(tail)
    ) {
      const filled = specifier.slice(
        head.length,
        specifier.length - tail.length,
      );
      return join(ROOT, mapped.replace("*", filled));
    }
  }
  return null;
}

function authoredTypeScriptFiles(): string[] {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    for (const entry of readdirSync(join(ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      // Tests are not shipped in the bundle eve rebuilds, so they cannot drag `scripts/`
      // into it; the guard judges the production surface only.
      else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      )
        files.push(relativePath);
    }
  };
  visit("agent");
  return files.sort();
}

// Every edge out of the authored tree, as "file -> specifier".
function escapes(): string[] {
  const found = new Set<string>();
  for (const file of authoredTypeScriptFiles()) {
    for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(
      MODULE_LITERAL,
    )) {
      const target = targetOf(match[1], file);
      if (target !== null && relative(AUTHORED, target).startsWith(".."))
        found.add(`${file} -> ${match[1]}`);
    }
  }
  return [...found].sort();
}

test("the authored tree opens no escape out of agent/", () => {
  assert.deepEqual(
    escapes(),
    [],
    "agent/ must not import from scripts/ — move the module into agent/lib and let scripts/ import it back through #lib/",
  );
});

// Only `from "..."` clauses: a dynamic import() is exactly the escape hatch a CLI module
// uses when it needs the authored tree at call time but must still load without it.
// Passing here therefore does not make a module movable — a command may still need it at
// call time; `scripts/cli/account-entrypoints.test.ts` runs the commands themselves.
// Anchored at the start of a line, where a static import/export clause is the only thing
// that can stand: prose in a comment naming an import no longer counts as one.
const FROM_CLAUSE =
  /^\s*(?:import|export)\b(?<clause>[^"]*?)\bfrom\s+"(?<specifier>[^"\n]+)"/gmu;

// Specifiers a load actually resolves. `import type`/`export type` clauses are erased by
// the compiler, so they emit no require of the authored tree at run time and cannot break
// a CLI running without it; an inline `{ type X }` inside a value clause still loads the
// module, so only the type-only form is dropped.
function loadTimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(FROM_CLAUSE)) {
    const { clause, specifier } = match.groups as {
      clause: string;
      specifier: string;
    };
    if (/^\s*type\b/u.test(clause)) continue;
    specifiers.push(specifier);
  }
  return specifiers;
}

// Processes that must load on an install whose `agent/` is missing, beyond `scripts/cli/*`.
// The walk stops at a child process, so each one is seeded by hand: the setup wizard is a
// separate node run (`iva config` → scripts/setup.mjs, and install.sh), and the daily update
// check is a systemd unit — both are exactly the "broken tree" paths of ADR-0003.
const SPAWNED_ENTRYPOINTS = [
  "scripts/setup/main.ts",
  "scripts/check-update.ts",
];

// Every edge the CLI would resolve at load time, as "importer -> specifier".
function cliEdgesIntoAuthoredTree(): string[] {
  const edges: string[] = [];
  const seen = new Set<string>();
  const queue = readdirSync(join(ROOT, "scripts/cli"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => posix.join("scripts/cli", name))
    .concat(SPAWNED_ENTRYPOINTS);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of loadTimeSpecifiers(
      readFileSync(join(ROOT, file), "utf8"),
    )) {
      const target = targetOf(specifier, file);
      if (target === null) continue;
      if (!relative(AUTHORED, target).startsWith(".."))
        edges.push(`${file} -> ${specifier}`);
      else queue.push(posix.normalize(relative(ROOT, target)));
    }
  }
  return edges.sort();
}

test("the CLI loads without the authored tree present", () => {
  assert.deepEqual(
    cliEdgesIntoAuthoredTree(),
    [],
    "iva repair/doctor run on installs whose agent/ is missing or half-written — reach the authored tree through a dynamic import inside the call that needs it",
  );
});

test("the CLI walk keeps value imports and drops only the erased type-only ones", () => {
  assert.deepEqual(
    loadTimeSpecifiers(
      'import { runScheduledJob } from "#lib/schedule-runner.ts";',
    ),
    ["#lib/schedule-runner.ts"],
    "a value import of the authored tree must still fail the CLI load-time walk",
  );
  assert.deepEqual(
    loadTimeSpecifiers(
      'import { readFileSync, type Stats } from "#lib/schedule-runner.ts";\nexport * from "#lib/settings.ts";',
    ),
    ["#lib/schedule-runner.ts", "#lib/settings.ts"],
  );
  assert.deepEqual(
    loadTimeSpecifiers(
      'import type { ScheduleCron } from "#lib/schedule-table.ts";\nexport type { ScheduleName } from "#lib/schedule-table.ts";',
    ),
    [],
  );
});

test("the guard resolves #-aliases through package.json instead of trusting the prefix", () => {
  assert.equal(
    targetOf("#lib/i18n.ts", "agent/agent.ts"),
    join(AUTHORED, "lib/i18n.ts"),
  );
  assert.equal(
    targetOf("#evals/smoke.ts", "agent/agent.ts"),
    join(ROOT, "evals/smoke.ts"),
  );
  assert.equal(targetOf("eve/channels", "agent/agent.ts"), null);
});
