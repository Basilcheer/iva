import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const hookUrl = new URL("./ts-esm-hooks.mjs", import.meta.url).href;

async function runEntry(entryPath, { withHook = true } = {}) {
  const entryUrl = pathToFileURL(entryPath).href;
  const source = [
    withHook ? `import ${JSON.stringify(hookUrl)};` : "",
    `await import(${JSON.stringify(entryUrl)});`,
  ].join("\n");

  return execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { encoding: "utf8" },
  );
}

async function makeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "iva-ts-esm-hooks-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test("resolves a missing sibling.js import to an existing sibling.ts", async (t) => {
  const directory = await makeFixture(t);
  const entryPath = join(directory, "entry.ts");
  await writeFile(
    entryPath,
    'import value from "./sibling.js";\nconsole.log(value);\n',
  );
  await writeFile(
    join(directory, "sibling.ts"),
    'const value: string = "typescript";\nexport default value;\n',
  );

  const { stdout } = await runEntry(entryPath);

  assert.equal(stdout, "typescript\n");
});

test("keeps an existing sibling.js ahead of sibling.ts", async (t) => {
  const directory = await makeFixture(t);
  const entryPath = join(directory, "entry.mjs");
  await writeFile(
    entryPath,
    'import value from "./sibling.js";\nconsole.log(value);\n',
  );
  await writeFile(
    join(directory, "sibling.js"),
    'export default "javascript";\n',
  );
  await writeFile(
    join(directory, "sibling.ts"),
    'export default "typescript";\n',
  );

  const { stdout } = await runEntry(entryPath);

  assert.equal(stdout, "javascript\n");
});

test("preserves standard bare, non-file, and unresolved resolution", async (t) => {
  const directory = await makeFixture(t);
  const entryPath = join(directory, "entry.mjs");
  await writeFile(
    entryPath,
    [
      'const bare = await import("node:path");',
      'const nonFile = await import("data:text/javascript,export default %27data%27");',
      "let unresolvedCode;",
      "try {",
      '  await import("./missing.js");',
      "} catch (error) {",
      "  unresolvedCode = error.code;",
      "}",
      "console.log(",
      "  JSON.stringify({",
      '    bare: typeof bare.join === "function",',
      "    nonFile: nonFile.default,",
      "    unresolvedCode,",
      "  }),",
      ");",
      "",
    ].join("\n"),
  );

  const baseline = await runEntry(entryPath, { withHook: false });
  const withHook = await runEntry(entryPath);

  assert.equal(withHook.stdout, baseline.stdout);
  assert.deepEqual(JSON.parse(withHook.stdout), {
    bare: true,
    nonFile: "data",
    unresolvedCode: "ERR_MODULE_NOT_FOUND",
  });
});
