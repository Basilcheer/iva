import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isOfficialIvaOrigin,
  validateOfficialCheckout,
} from "./repair-update.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

void test("repair bootstrap accepts only the canonical Iva GitHub remote", () => {
  assert.equal(isOfficialIvaOrigin("git@github.com:smixs/iva.git"), true);
  assert.equal(isOfficialIvaOrigin("https://github.com/smixs/iva.git"), true);
  assert.equal(isOfficialIvaOrigin("ssh://git@github.com/smixs/iva"), true);
  assert.equal(isOfficialIvaOrigin("https://github.com/smixs/iva-evil"), false);
  assert.equal(isOfficialIvaOrigin("http://github.com/smixs/iva.git"), false);
  assert.equal(isOfficialIvaOrigin("ftp://github.com/smixs/iva.git"), false);
  assert.equal(isOfficialIvaOrigin("git://github.com/smixs/iva.git"), false);
  assert.equal(
    isOfficialIvaOrigin("https://github.com:444/smixs/iva.git"),
    false,
  );
  assert.equal(isOfficialIvaOrigin("https://github.com//smixs/iva.git"), false);
  assert.equal(isOfficialIvaOrigin("https://github.com/SMIXS/IVA.GIT"), true);
  assert.equal(isOfficialIvaOrigin("git@example.com:smixs/iva.git"), false);
});

void test("repair bootstrap validates the checkout before changing files", () => {
  const root = mkdtempSync(join(tmpdir(), "iva-repair-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Iva Test");
  writeFileSync(join(root, "package.json"), '{"name":"iva"}\n');
  git(root, "add", "package.json");
  git(root, "commit", "-m", "fixture");
  git(root, "remote", "add", "origin", "git@github.com:smixs/iva.git");

  assert.doesNotThrow(() => validateOfficialCheckout(root));
  git(root, "remote", "set-url", "origin", "git@example.com:smixs/iva.git");
  assert.throws(() => validateOfficialCheckout(root), /official smixs\/iva/);
});
