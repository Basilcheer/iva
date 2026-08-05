import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastForwardOffset, loadOffset, saveOffset } from "./poller/offset.mjs";

test("corrupt JSON fails closed before getUpdates(-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-offset-corrupt-test-"));
  const file = join(dir, "telegram-offset.json");
  writeFileSync(file, "{broken");
  let getUpdatesCalls = 0;

  await assert.rejects(async () => {
    const loaded = await loadOffset({ file });
    if (loaded.offset === null) {
      await fastForwardOffset({
        tgImpl: async () => {
          getUpdatesCalls++;
          return { ok: true, result: [] };
        },
      });
    }
  }, /failed to load Telegram offset/u);
  assert.equal(getUpdatesCalls, 0);
  assert.equal(readFileSync(file, "utf8"), "{broken");
});

test("ENOENT is the only first-run path and fast-forwards to the Telegram tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-offset-first-run-test-"));
  const file = join(dir, "telegram-offset.json");
  assert.deepEqual(await loadOffset({ file }), { offset: null, delivered: null });

  const calls = [];
  const offset = await fastForwardOffset({
    tgImpl: async (method, body) => {
      calls.push([method, body]);
      return { ok: true, result: [{ update_id: 40 }, { update_id: 41 }] };
    },
  });
  assert.equal(offset, 42);
  assert.deepEqual(calls, [["getUpdates", { offset: -1, timeout: 0 }]]);
});

test("first-run fast-forward propagates Telegram and response-shape failures", async () => {
  for (const tgImpl of [
    async () => { throw new Error("network down"); },
    async () => ({ ok: false, description: "Telegram unavailable" }),
    async () => ({ ok: true, result: null }),
    async () => ({ ok: "true", result: [] }),
    async () => ({ ok: true, result: [{}] }),
    async () => ({ ok: true, result: [{ update_id: null }] }),
    async () => ({ ok: true, result: [{ update_id: "41" }] }),
    async () => ({ ok: true, result: [{ update_id: -1 }] }),
    async () => ({ ok: true, result: [{ update_id: Number.MAX_SAFE_INTEGER }] }),
  ]) {
    const logs = [];
    await assert.rejects(
      fastForwardOffset({ tgImpl, logImpl: (...args) => logs.push(args.join(" ")) }),
      /failed to fast-forward Telegram offset/u,
    );
    assert.equal(logs.length, 1);
  }
});

test("saveOffset propagates a write error and never renames the cursor", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "iva-offset-write-error-test-"));
  const file = join(dataDir, "telegram-offset-test.json");
  const calls = [];
  await assert.rejects(
    saveOffset(42, 41, {
      file,
      dataDir,
      pid: 123,
      tmpId: "write-error",
      mkdirImpl: async () => {},
      writeFileImpl: async (file, _data, options) => {
        calls.push(["write", file, options]);
        throw new Error("injected write failure");
      },
      renameImpl: async (...args) => calls.push(["rename", ...args]),
      rmImpl: async (...args) => calls.push(["rm", ...args]),
    }),
    /injected write failure/u,
  );
  assert.equal(calls.some(([kind]) => kind === "rename"), false);
  assert.equal(calls[0][1], `${file}.tmp-123-write-error`);
  assert.deepEqual(calls[0][2], { encoding: "utf8", mode: 0o600, flag: "wx" });
});

test("saveOffset publishes a private tmp file with one atomic rename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-offset-save-test-"));
  const file = join(dir, "telegram-offset.json");
  const calls = [];
  const writeFileImpl = async (path, data, options) => {
    calls.push(["write", path, options]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, data, options);
  };
  const renameImpl = async (from, to) => {
    calls.push(["rename", from, to]);
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  };
  await saveOffset(42, 41, {
    file,
    dataDir: dir,
    pid: 456,
    tmpId: "atomic",
    writeFileImpl,
    renameImpl,
  });
  assert.deepEqual(calls.map(([kind]) => kind), ["write", "rename"]);
  assert.equal(calls[0][1], `${file}.tmp-456-atomic`);
  assert.deepEqual(calls[1], ["rename", `${file}.tmp-456-atomic`, file]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { offset: 42, delivered: 41 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
