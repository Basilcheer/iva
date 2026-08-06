import assert from "node:assert/strict";
import test from "node:test";
import { createTreeRenderer, type TreeGrid } from "./tree.ts";

type Dependencies = NonNullable<Parameters<typeof createTreeRenderer>[1]>;
type TreeSignal = "SIGINT" | "SIGTERM";

const INSTALL_WITH_TREE = [
  "#!/bin/sh",
  "<<'IVA_TREE'",
  "  \\033[38;2;10;20;30m.\\033[0m ",
  "\\033[38;2;255;0;128m@\\033[0m",
  "IVA_TREE",
  "exit 0",
].join("\n");

const STATIC_FRAME =
  "  \x1b[38;2;10;20;30m.\x1b[0m\x1b[K\n" +
  "\x1b[38;2;255;0;128m@\x1b[0m\x1b[K\n";

type TerminalHarness = {
  readonly dependencies: Dependencies;
  readonly handlers: Partial<Record<TreeSignal, () => void>>;
  readonly kills: Array<readonly [number, TreeSignal]>;
  readonly onceSignals: TreeSignal[];
  readonly removedSignals: TreeSignal[];
  readonly sleeps: number[];
  readonly writes: string[];
};

function terminalHarness({
  columns = 80,
  env = {},
  isTTY = true,
  readFile = () => INSTALL_WITH_TREE,
  sleep,
}: {
  readonly columns?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  readonly readFile?: (path: string) => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
} = {}): TerminalHarness {
  const handlers: Partial<Record<TreeSignal, () => void>> = {};
  const kills: Array<readonly [number, TreeSignal]> = [];
  const onceSignals: TreeSignal[] = [];
  const removedSignals: TreeSignal[] = [];
  const sleeps: number[] = [];
  const writes: string[] = [];
  return {
    dependencies: {
      stdout: {
        columns,
        isTTY,
        write: (text) => writes.push(text),
      },
      env,
      readFile,
      sleep:
        sleep ??
        ((milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        }),
      once: (signal, handler) => {
        onceSignals.push(signal);
        handlers[signal] = handler;
      },
      removeListener: (signal, handler) => {
        removedSignals.push(signal);
        if (handlers[signal] === handler) delete handlers[signal];
      },
      kill: (pid, signal) => kills.push([pid, signal]),
      pid: 4242,
    },
    handlers,
    kills,
    onceSignals,
    removedSignals,
    sleeps,
    writes,
  };
}

void test("factory is lazy, parser preserves cells and static render trims trailing background", async () => {
  let reads = 0;
  const harness = terminalHarness({
    isTTY: false,
    readFile: () => {
      reads++;
      return INSTALL_WITH_TREE;
    },
  });

  const renderer = createTreeRenderer("/srv/iva", harness.dependencies);
  assert.equal(reads, 0);
  await renderer.showTree();
  assert.equal(
    reads,
    0,
    "non-TTY output must return before reading install.sh",
  );

  const grid = renderer.loadTreeGrid();
  assert.equal(reads, 1);
  assert.deepEqual(grid, [
    [
      { ch: " ", bg: true },
      { ch: " ", bg: true },
      { ch: ".", r: 10, g: 20, b: 30 },
      { ch: " ", bg: true },
    ],
    [{ ch: "@", r: 255, g: 0, b: 128 }],
  ]);
  assert.equal(renderer.renderTreeFrame(grid, 0, false), STATIC_FRAME);
  assert.equal(
    reads,
    1,
    "rendering a parsed grid performs no filesystem reads",
  );
});

void test("missing tree heredoc returns null", () => {
  const renderer = createTreeRenderer("/srv/iva", {
    readFile: () => "#!/bin/sh\necho no-tree\n",
  });

  assert.equal(renderer.loadTreeGrid(), null);
});

void test("non-TTY, NO_COLOR and dumb terminals are no-ops before install.sh read", async () => {
  for (const terminal of [
    { isTTY: false, env: {} },
    { isTTY: true, env: { NO_COLOR: "1" } },
    { isTTY: true, env: { TERM: "dumb" } },
  ]) {
    let reads = 0;
    const harness = terminalHarness({
      ...terminal,
      readFile: () => {
        reads++;
        throw new Error("must not read");
      },
    });
    const renderer = createTreeRenderer("/srv/iva", harness.dependencies);

    await renderer.showTree();

    assert.equal(reads, 0);
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.onceSignals, []);
    assert.deepEqual(harness.removedSignals, []);
  }
});

void test("narrow and IVA_NO_ANIM terminals render one static frame without hiding the cursor", async () => {
  for (const options of [{ columns: 6 }, { env: { IVA_NO_ANIM: "1" } }]) {
    const harness = terminalHarness(options);
    const renderer = createTreeRenderer("/srv/iva", harness.dependencies);

    await renderer.showTree();

    assert.deepEqual(harness.writes, ["\n", `${STATIC_FRAME}\n`]);
    assert.deepEqual(harness.sleeps, []);
    assert.deepEqual(harness.onceSignals, []);
    assert.deepEqual(harness.removedSignals, ["SIGINT", "SIGTERM"]);
    assert.equal(harness.writes.includes("\x1b[?25l"), false);
  }
});

void test("animated rendering preserves 36 frames, delay cadence and final cursor cleanup", async () => {
  const harness = terminalHarness();
  const renderer = createTreeRenderer("/srv/iva", harness.dependencies);

  await renderer.showTree();

  assert.equal(harness.sleeps.length, 36);
  assert.equal(
    harness.sleeps.every((delay) => delay === 70),
    true,
  );
  assert.deepEqual(harness.onceSignals, ["SIGINT", "SIGTERM"]);
  assert.deepEqual(harness.removedSignals, ["SIGINT", "SIGTERM"]);
  assert.equal(harness.writes[0], "\n");
  assert.equal(harness.writes[1], "\x1b[?25l");
  assert.equal(harness.writes.filter((text) => text === "\x1b[2A").length, 35);
  assert.equal(harness.writes.at(-3), `\x1b[2A${STATIC_FRAME}`);
  assert.equal(harness.writes.at(-2), "\x1b[?25h");
  assert.equal(harness.writes.at(-1), "\n");
});

void test("animation failure restores the cursor and removes both signal handlers", async () => {
  let calls = 0;
  const harness = terminalHarness({
    sleep: () => {
      calls++;
      return Promise.reject(new Error("timer failed"));
    },
  });
  const renderer = createTreeRenderer("/srv/iva", harness.dependencies);

  await renderer.showTree();

  assert.equal(calls, 1);
  assert.equal(harness.writes[0], "\n");
  assert.equal(harness.writes[1], "\x1b[?25l");
  assert.equal(harness.writes.at(-1), "\x1b[?25h");
  assert.equal(harness.writes.filter((text) => text === "\x1b[?25h").length, 1);
  assert.deepEqual(harness.removedSignals, ["SIGINT", "SIGTERM"]);
});

void test("signal handler restores the cursor, removes listeners and forwards the signal", async () => {
  let sleepCalls = 0;
  const harness = terminalHarness({
    sleep: () => {
      sleepCalls++;
      if (sleepCalls === 1) harness.handlers.SIGTERM?.();
      return Promise.reject(new Error("stop after signal"));
    },
  });
  const renderer = createTreeRenderer("/srv/iva", harness.dependencies);

  await renderer.showTree();

  assert.deepEqual(harness.kills, [[4242, "SIGTERM"]]);
  assert.equal(harness.writes.filter((text) => text === "\x1b[?25h").length, 1);
  assert.deepEqual(harness.removedSignals, [
    "SIGINT",
    "SIGTERM",
    "SIGINT",
    "SIGTERM",
  ]);
});

void test("install.sh read failures remain silent and still run final listener cleanup", async () => {
  const harness = terminalHarness({
    readFile: () => {
      throw new Error("missing install.sh");
    },
  });
  const renderer = createTreeRenderer("/srv/iva", harness.dependencies);

  await renderer.showTree();

  assert.deepEqual(harness.writes, []);
  assert.deepEqual(harness.onceSignals, []);
  assert.deepEqual(harness.removedSignals, ["SIGINT", "SIGTERM"]);
});

void test("static rendering preserves blank rows and clamps live RGB values", () => {
  const renderer = createTreeRenderer("/srv/iva");
  const grid: TreeGrid = [[], [{ ch: "@", r: 255, g: 255, b: 255 }]];

  assert.equal(
    renderer.renderTreeFrame(grid, 0, false),
    "\x1b[0m\x1b[K\n\x1b[38;2;255;255;255m@\x1b[0m\x1b[K\n",
  );
  assert.equal(
    renderer
      .renderTreeFrame(grid, Math.PI / 2, true)
      .includes("\x1b[38;2;255;255;255m"),
    true,
  );
});
