import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./entrypoint.ts";

const HELPER = fileURLToPath(new URL("./entrypoint.ts", import.meta.url));

test("isEntrypoint recognises the started module behind a symlinked directory", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "iva-entrypoint-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const real = join(temp, "real");
  const link = join(temp, "link");
  mkdirSync(real);
  symlinkSync(real, link, "dir");
  const probe = join(real, "probe.ts");
  writeFileSync(
    probe,
    `import { isEntrypoint } from ${JSON.stringify(HELPER)};\n` +
      `process.stdout.write(isEntrypoint(import.meta.url) ? "entry" : "imported");\n`,
  );

  const started = spawnSync(process.execPath, [join(link, "probe.ts")], {
    encoding: "utf8",
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, "entry");
});

test("isEntrypoint rejects a module that is not the started one", () => {
  assert.equal(
    isEntrypoint(new URL("./update-safety.ts", import.meta.url).href),
    false,
  );
  assert.equal(isEntrypoint("file:///nonexistent/module.ts"), false);
});
