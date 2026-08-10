/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Guard for the authored tree: eve rebuilds `agent/` at service start, so any module
// specifier there that resolves outside `agent/` drags `scripts/` into the bundle — the
// failure that produced the 0.3.14 crash loop (issue #176). The remaining escapes are
// pinned by path and specifier rather than counted, so the list can only shrink by a
// deliberate edit, and `#`-aliases are resolved through package.json instead of trusted.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AUTHORED = join(ROOT, "agent");

// Each remaining escape waits on the release that owns its other consumers: 0.3.15
// (updater + memory) owns `scripts/cli/*` and `scripts/memory/*`, and moving these
// modules into `agent/lib` means rewriting the imports there too. See docs/tech-debt.md.
const PINNED_ESCAPES: Readonly<Record<string, readonly string[]>> = {
  "agent/hooks/usage.ts": ["../../scripts/lib/usage.ts"],
  "agent/instructions/20-core.ts": [
    "../../scripts/lib/core-cap.ts",
    "../../scripts/memory/core-clamp.ts",
  ],
  "agent/instrumentation.ts": [
    "../scripts/lib/config-transaction.ts",
    "../scripts/lib/schedule-migration.ts",
    "../scripts/lib/timezone.ts",
  ],
  "agent/provider.ts": [
    "../scripts/lib/codex-oauth.ts",
    "../scripts/lib/model-catalog.ts",
  ],
};

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
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        files.push(relativePath);
    }
  };
  visit("agent");
  return files.sort();
}

function escapesByFile(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of authoredTypeScriptFiles()) {
    const outside = new Set<string>();
    for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(
      MODULE_LITERAL,
    )) {
      const specifier = match[1];
      const target = targetOf(specifier, file);
      if (target !== null && relative(AUTHORED, target).startsWith(".."))
        outside.add(specifier);
    }
    if (outside.size > 0) found[file] = [...outside].sort();
  }
  return found;
}

test("the authored tree reaches outside agent/ only where a pinned escape says so", () => {
  assert.deepEqual(
    escapesByFile(),
    PINNED_ESCAPES,
    "agent/ must not import from scripts/ — move the module into agent/lib and let scripts/ import it back through #lib/",
  );
});

test("the pin resolves #-aliases through package.json instead of trusting the prefix", () => {
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
