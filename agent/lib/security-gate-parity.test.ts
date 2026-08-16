import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import secretKeyInventory from "../skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };
import { scanOutbound } from "./security-gate.ts";

const PYTHON_GATE = fileURLToPath(
  new URL(
    "../skills/security-defense/scripts/outbound_gate.py",
    import.meta.url,
  ),
);

await test("TypeScript and Python redact the canonical secret inventory identically", () => {
  const values = new Map(
    secretKeyInventory.map((name, index) => [
      name,
      `syntheticParityValue${index.toString().padStart(2, "0")}abcdef`,
    ]),
  );
  const input = secretKeyInventory
    .map((name, index) => {
      const value = values.get(name)!;
      return index % 2 === 0
        ? `${name}=${value}`
        : JSON.stringify({ [name]: value });
    })
    .join("\n");

  const typescript = scanOutbound(input);
  const python = spawnSync(
    "uv",
    ["run", "python", PYTHON_GATE, "--text", input, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(python.error, undefined);
  assert.equal(python.status, 1, python.stderr);
  const parsed = JSON.parse(python.stdout) as {
    readonly clean: boolean;
    readonly findings: readonly { readonly name: string }[];
    readonly text: string;
  };

  assert.equal(typescript.clean, false);
  assert.equal(parsed.clean, typescript.clean);
  assert.equal(parsed.text, typescript.text);
  const namedSecrets = (findings: readonly { readonly name: string }[]) =>
    findings.filter((finding) => finding.name === "named_secret").length;
  assert.equal(namedSecrets(typescript.findings), secretKeyInventory.length);
  assert.equal(
    namedSecrets(parsed.findings),
    namedSecrets(typescript.findings),
  );
  for (const [name, value] of values) {
    assert.equal(typescript.text.includes(value), false, `${name}: TS leaked`);
    assert.equal(parsed.text.includes(value), false, `${name}: Python leaked`);
  }
});

await test("TypeScript and Python keep an exact name inside a longer identifier", () => {
  const input = "NOT_ASSISTANT_BEARER=syntheticBoundaryValue123456";
  const typescript = scanOutbound(input);
  const python = spawnSync(
    "uv",
    ["run", "python", PYTHON_GATE, "--text", input, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(python.error, undefined);
  assert.equal(python.status, 0, python.stderr);
  const parsed = JSON.parse(python.stdout) as {
    readonly clean: boolean;
    readonly text: string;
  };

  assert.equal(typescript.clean, true);
  assert.equal(typescript.text, input);
  assert.equal(parsed.clean, typescript.clean);
  assert.equal(parsed.text, typescript.text);
});
