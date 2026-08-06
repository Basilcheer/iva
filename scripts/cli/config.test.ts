/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and async stubs preserve production signatures. */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createConfigCommand } from "./config.ts";
import { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type RuntimeRun = CliRuntime["run"];

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function result(status: number | null): ReturnType<RuntimeRun> {
  return { status } as ReturnType<RuntimeRun>;
}

test("--recover preserves recovery ordering and never creates a setup candidate", async (t) => {
  const root = await sandbox(t);
  const events: unknown[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => {
      events.push("require-systemd");
    },
    ok: (message) => {
      events.push(["ok", message]);
    },
    run: () => {
      throw new Error("setup must not run during recovery-only mode");
    },
    systemd: {
      ...base.systemd,
      restart: (services) => {
        events.push(["restart", services]);
      },
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    {
      writeUnits: (options) => {
        events.push(["write-units", options]);
        return [];
      },
    },
    {
      recoverConfigTransaction: async (target, options = {}) => {
        events.push(["recover", target]);
        await options.restart?.(target.services);
        return true;
      },
    },
  );

  await cmdConfig(["ignored", "--recover"]);

  assert.deepEqual(events, [
    "require-systemd",
    ["recover", { envPath: join(root, ".env"), services: runtime.SERVICES }],
    ["write-units", { ensureBearer: false }],
    ["restart", runtime.SERVICES],
    ["ok", "Recovered the previous configuration and restarted services"],
  ]);
});

test("--recover reports an absent journal without touching setup or systemd", async (t) => {
  const root = await sandbox(t);
  const messages: string[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    ok: (message) => messages.push(message),
    run: () => {
      throw new Error("setup must not run during recovery-only mode");
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    {
      writeUnits: () => {
        throw new Error("units must not change without a recovery journal");
      },
    },
    { recoverConfigTransaction: async () => false },
  );

  await cmdConfig(["--recover"]);

  assert.deepEqual(messages, ["No pending configuration recovery"]);
});

test("setup failures preserve status coercion and always remove the candidate", async (t) => {
  const root = await sandbox(t);
  const savedExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = savedExitCode;
  });
  const candidates: string[] = [];
  let status: number | null = 7;
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    run: (command, args, options) => {
      assert.equal(command, base.NODE);
      assert.deepEqual(args, ["scripts/setup.mjs"]);
      const candidate = options?.env?.IVA_CONFIG_OUTPUT;
      assert.equal(typeof candidate, "string");
      candidates.push(candidate as string);
      assert.equal(existsSync(dirname(candidate as string)), true);
      return result(status);
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    { writeUnits: () => [] },
    { recoverConfigTransaction: async () => false },
  );

  process.exitCode = undefined;
  await cmdConfig();
  assert.equal(process.exitCode, 7);
  assert.equal(existsSync(dirname(candidates[0])), false);

  status = null;
  process.exitCode = undefined;
  await cmdConfig();
  assert.equal(process.exitCode, 1);
  assert.equal(existsSync(dirname(candidates[1])), false);
});

test("a declined candidate is removed without parsing or applying it", async (t) => {
  const root = await sandbox(t);
  let candidatePath = "";
  const warnings: string[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    run: (_command, _args, options) => {
      candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
      return result(0);
    },
    confirm: async (question, defaultValue) => {
      assert.equal(question, "Apply settings and restart services now?");
      assert.equal(defaultValue, true);
      return false;
    },
    warn: (message) => warnings.push(message),
  };
  const cmdConfig = createConfigCommand(
    runtime,
    { writeUnits: () => [] },
    {
      recoverConfigTransaction: async () => false,
      applyConfigTransaction: async () => {
        throw new Error("declined configuration must not be applied");
      },
    },
  );

  await cmdConfig();

  assert.deepEqual(warnings, ["Configuration unchanged"]);
  assert.equal(existsSync(dirname(candidatePath)), false);
});

test("a valid candidate continues after recovery with exact transaction and restart order", async (t) => {
  const root = await sandbox(t);
  const events: unknown[] = [];
  const nextText = [
    "MODEL_PROVIDER=codex",
    "CODEX_MODEL=gpt-5",
    "IVA_PORT=08723",
    "ASSISTANT_DATA_DIR=nested/data",
    "",
  ].join("\n");
  let candidatePath = "";
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => {
      events.push("require-systemd");
    },
    run: (command, args, options) => {
      events.push(["run", command, args]);
      assert.equal(options?.env?.PATH, base.childEnv.PATH);
      candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
      writeFileSync(candidatePath, nextText);
      return result(0);
    },
    confirm: async (question, defaultValue) => {
      events.push(["confirm", question, defaultValue]);
      return true;
    },
    systemd: {
      ...base.systemd,
      restart: (services) => {
        events.push(["restart", services]);
      },
    },
    ok: (message) => {
      events.push(["ok", message]);
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    {
      writeUnits: (options) => {
        events.push(["write-units", options]);
        return [];
      },
    },
    {
      recoverConfigTransaction: async (target, options = {}) => {
        events.push("recover");
        await options.restart?.(target.services);
        return true;
      },
      applyConfigTransaction: async (target, options = {}) => {
        events.push(["apply", target, existsSync(candidatePath)]);
        await options.restart?.(target.services);
        await options.health?.(target.healthUrl);
        return { committed: true };
      },
      probeEveHealth: async (url) => {
        events.push(["health", url]);
      },
    },
  );

  await cmdConfig();

  assert.deepEqual(events, [
    "require-systemd",
    "recover",
    ["write-units", { ensureBearer: false }],
    ["restart", runtime.SERVICES],
    ["ok", "Recovered the previous configuration and restarted services"],
    ["run", base.NODE, ["scripts/setup.mjs"]],
    ["confirm", "Apply settings and restart services now?", true],
    [
      "apply",
      {
        envPath: join(root, ".env"),
        nextText,
        selection: {
          provider: "codex",
          model: "gpt-5",
          key: undefined,
          dataDir: join(root, "nested/data"),
        },
        services: runtime.SERVICES,
        healthUrl: "http://127.0.0.1:8723/eve/v1/health",
      },
      true,
    ],
    ["write-units", { ensureBearer: false }],
    ["restart", runtime.SERVICES],
    ["health", "http://127.0.0.1:8723/eve/v1/health"],
    ["ok", "Configuration applied; agent and Telegram bridge are active"],
  ]);
  assert.equal(existsSync(dirname(candidatePath)), false);
});

test("invalid candidate metadata and apply failures propagate after cleanup", async (t) => {
  const root = await sandbox(t);
  const cases = [
    {
      text: "MODEL_PROVIDER=invalid\nIVA_PORT=8723\n",
      message: "candidate configuration has an invalid model provider",
    },
    {
      text: "MODEL_PROVIDER=codex\nIVA_PORT=65536\n",
      message: "candidate configuration has an invalid IVA_PORT",
    },
  ];

  for (const testCase of cases) {
    let candidatePath = "";
    const base = createCliRuntime(root);
    const runtime: CliRuntime = {
      ...base,
      requireSystemd: () => undefined,
      run: (_command, _args, options) => {
        candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
        writeFileSync(candidatePath, testCase.text);
        return result(0);
      },
      confirm: async () => true,
    };
    const cmdConfig = createConfigCommand(
      runtime,
      { writeUnits: () => [] },
      {
        recoverConfigTransaction: async () => false,
        applyConfigTransaction: async () => {
          throw new Error("invalid candidates must fail before apply");
        },
      },
    );

    await assert.rejects(cmdConfig(), new RegExp(testCase.message, "u"));
    assert.equal(existsSync(dirname(candidatePath)), false);
  }

  let candidatePath = "";
  const applyError = new Error("transaction failed");
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    run: (_command, _args, options) => {
      candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
      writeFileSync(candidatePath, "MODEL_PROVIDER=codex\nIVA_PORT=8723\n");
      return result(0);
    },
    confirm: async () => true,
  };
  const cmdConfig = createConfigCommand(
    runtime,
    { writeUnits: () => [] },
    {
      recoverConfigTransaction: async () => false,
      applyConfigTransaction: async () => {
        throw applyError;
      },
    },
  );

  await assert.rejects(cmdConfig(), (error) => error === applyError);
  assert.equal(existsSync(dirname(candidatePath)), false);
});
