/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXPECTED_PRODUCTION_COUNT = 138;
const EXPECTED_REPORTED_COUNT = 109;
const EXPECTED_INVENTORY_SHA256 =
  "3036ecacad8d0db5949d252f790bceefa5809fd6e0760ef53f017c836c7add88";

// Node's native include globs filter loaded modules; they do not load untouched files.
// Keep the measured exceptions explicit so a new production module cannot join this
// blind spot without forcing a fresh coverage run and an intentional classification.
// This inventory ratchet neither makes all 138 files covered nor detects import-graph
// changes when the set of production paths stays unchanged.
const UNREPORTED_BY_CATEGORY = {
  frameworkBoundaries: [
    "agent/agent.ts",
    "agent/channels/eve.ts",
    "agent/connections/telegram-userbot.ts",
    "agent/hooks/transcript.ts",
    "agent/hooks/usage.ts",
    "agent/instructions/05-language.ts",
    "agent/instructions/20-core.ts",
    "agent/instructions/25-persona.ts",
    "agent/instructions/now.ts",
    "agent/instrumentation.ts",
    "agent/sandbox.ts",
    "agent/schedules/digest.ts",
    "agent/schedules/memory-daily.ts",
    "agent/schedules/memory-monthly.ts",
    "agent/schedules/memory-weekly.ts",
    "agent/schedules/memory-yearly.ts",
    "agent/subagents/planner/agent.ts",
  ],
  thinAgentTools: [
    "agent/tools/glob.ts",
    "agent/tools/grep.ts",
    "agent/tools/tasks.ts",
    "agent/tools/web_search.ts",
  ],
  standaloneOperations: [
    "scripts/check-bash-cwd.ts",
    "scripts/check-reasoning-strip.ts",
    "scripts/daily-digest.ts",
    "scripts/memory/doctor.ts",
    "scripts/memory/embed-index.ts",
    "scripts/memory/rollup.ts",
    "scripts/replica-smoke.ts",
    "scripts/setup/main.ts",
  ],
} as const;

const EXPECTED_COVERAGE_ARGUMENTS = [
  "--test-coverage-include='agent/**/*.ts'",
  "--test-coverage-include='scripts/**/*.ts'",
  "--test-coverage-exclude='**/*.test.ts'",
  "--test-coverage-exclude='scripts/fixtures/**/*.ts'",
  "--test-coverage-lines=76",
  "--test-coverage-branches=78.0",
  "--test-coverage-functions=72",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productionTypeScriptFiles(): string[] {
  const files: string[] = [];

  function visit(relativeDirectory: string): void {
    for (const entry of readdirSync(join(ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures") visit(relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(relativePath);
      }
    }
  }

  visit("agent");
  visit("scripts");
  return files.sort();
}

function digest(paths: readonly string[]): string {
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

function assertCoverageInventory(productionFiles: readonly string[]): void {
  assert.equal(
    productionFiles.length,
    EXPECTED_PRODUCTION_COUNT,
    "production TypeScript inventory changed; rerun scoped coverage and classify the changed files",
  );
  assert.equal(
    digest(productionFiles),
    EXPECTED_INVENTORY_SHA256,
    "production TypeScript paths changed; rerun scoped coverage before updating the inventory ratchet",
  );

  const unreported = Object.values(UNREPORTED_BY_CATEGORY).flat().sort();
  assert.equal(new Set(unreported).size, unreported.length);
  assert.deepEqual(
    unreported.filter((path) => !productionFiles.includes(path)),
    [],
    "the unreported coverage inventory contains a missing production file",
  );
  assert.equal(
    productionFiles.length - unreported.length,
    EXPECTED_REPORTED_COUNT,
  );
}

test("coverage policy ratchets the classified production TypeScript inventory", () => {
  const productionFiles = productionTypeScriptFiles();
  assertCoverageInventory(productionFiles);

  assert.throws(
    () =>
      assertCoverageInventory(
        [...productionFiles, "agent/lib/unclassified-production.ts"].sort(),
      ),
    /production TypeScript inventory changed/u,
  );
});

test("coverage command reports only loaded production TypeScript", () => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  assert.ok(isRecord(parsed));
  assert.ok(isRecord(parsed.scripts));
  const command = parsed.scripts["test:coverage"];
  if (typeof command !== "string") {
    throw new TypeError("test:coverage must be a package script");
  }
  for (const argument of EXPECTED_COVERAGE_ARGUMENTS) {
    assert.ok(
      command.includes(argument),
      `missing coverage argument: ${argument}`,
    );
  }
});
