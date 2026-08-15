/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration. */
// Враждебные тесты атомарной записи (ADR-0002): читатель не видит половину файла,
// а success подтверждает все нужные directory barriers. Проверяются faults, SIGKILL,
// races, symlink retarget, parent recreation и ABA directory entries.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ATOMIC_WRITE_DURABILITY,
  ATOMIC_WRITE_PARENT_CHANGED,
  writeFileAtomic,
  writeFileAtomicSync,
} from "./fs-atomic.ts";
import {
  MODULE_URL,
  startChild,
  workspace,
} from "./fs-atomic.fixtures.test.ts";

const tmpLeftovers = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.includes(".tmp-"));

const FILE_WRITE_STEPS = [
  "open-temp",
  "chmod-temp",
  "write-temp",
  "sync-temp",
  "close-temp",
] as const;

const DIRECTORY_WRITE_STEPS = [
  "open-directory",
  "stat-parent-snapshot",
  "sync-directory",
  "close-directory",
] as const;

const ancestors = (path: string): string[] => {
  const paths: string[] = [];
  let current = path;
  for (;;) {
    paths.push(current);
    const next = dirname(current);
    if (next === current) return paths;
    current = next;
  }
};

const physicalAncestors = (parent: string): string[] =>
  ancestors(realpathSync(parent));

const protocolSteps = (parent: string): string[] => {
  const directories = physicalAncestors(parent);
  const verify = ["verify-parent"];
  return [
    "mkdir",
    "realpath-directory",
    ...directories.map(() => "stat-directory"),
    "open-directory",
    "stat-parent-snapshot",
    ...FILE_WRITE_STEPS,
    ...verify,
    "rename",
    "sync-directory",
    "close-directory",
    ...directories.map(() => "stat-directory"),
    ...directories.slice(1).flatMap(() => DIRECTORY_WRITE_STEPS),
    ...verify,
  ];
};

// ─── атомарная запись ──────────────────────────────────────────────────────

test("запись целиком заменяет файл и не оставляет tmp — sync и async", async () => {
  const dir = workspace();
  const file = join(dir, "nested", "store.json");

  writeFileAtomicSync(file, "первая\n");
  assert.equal(readFileSync(file, "utf8"), "первая\n");
  await writeFileAtomic(file, "вторая\n");
  assert.equal(readFileSync(file, "utf8"), "вторая\n");

  assert.deepEqual(tmpLeftovers(join(dir, "nested")), []);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["store.json"]);
});

test("mode применяется к создаваемому файлу", () => {
  const dir = workspace();
  const file = join(dir, "secret.json");
  writeFileAtomicSync(file, "{}", { mode: 0o600 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("strict mode exists before the first byte and replaces a permissive target", async () => {
  for (const writer of ["sync", "async"] as const) {
    const dir = workspace();
    const file = join(dir, `${writer}-secret.json`);
    writeFileSync(file, "old", { mode: 0o644 });
    let inspected = false;
    const options = {
      mode: 0o600,
      afterStep(step: string, path: string) {
        if (step !== "chmod-temp") return;
        inspected = true;
        assert.equal(statSync(path).size, 0, "mode must precede every byte");
        assert.equal(statSync(path).mode & 0o777, 0o600);
      },
    };

    if (writer === "sync") writeFileAtomicSync(file, "new", options);
    else await writeFileAtomic(file, "new", options);

    assert.equal(inspected, true);
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("sync writer keeps an old or new whole file after every injected I/O fault", () => {
  const faultCount = protocolSteps(workspace()).length;
  for (let faultIndex = 0; faultIndex < faultCount; faultIndex++) {
    const dir = workspace();
    const file = join(dir, "settings.json");
    const expected = protocolSteps(dir);
    const faultAt = expected[faultIndex];
    const before = JSON.stringify({ generation: "before" });
    const after = JSON.stringify({ generation: "after" });
    writeFileSync(file, before);

    let caught: unknown;
    let completed = 0;
    try {
      writeFileAtomicSync(file, after, {
        mode: 0o600,
        afterStep(step) {
          assert.equal(step, expected[completed]);
          if (completed++ === faultIndex)
            throw new Error(`fault after ${step} #${faultIndex}`);
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught, `fault after ${faultAt} must escape`);
    const published = faultIndex >= expected.indexOf("rename");
    assert.equal(
      (caught as NodeJS.ErrnoException).code,
      published ? ATOMIC_WRITE_DURABILITY : undefined,
    );
    assert.equal(readFileSync(file, "utf8"), published ? after : before);
    assert.deepEqual(tmpLeftovers(dir), []);
  }
});

test("async writer keeps an old or new whole file after every injected I/O fault", async () => {
  const faultCount = protocolSteps(workspace()).length;
  for (let faultIndex = 0; faultIndex < faultCount; faultIndex++) {
    const dir = workspace();
    const file = join(dir, "settings.json");
    const expected = protocolSteps(dir);
    const faultAt = expected[faultIndex];
    const before = JSON.stringify({ generation: "before" });
    const after = JSON.stringify({ generation: "after" });
    writeFileSync(file, before);

    let caught: unknown;
    let completed = 0;
    try {
      await writeFileAtomic(file, after, {
        mode: 0o600,
        afterStep(step) {
          assert.equal(step, expected[completed]);
          if (completed++ === faultIndex)
            throw new Error(`fault after ${step} #${faultIndex}`);
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught, `fault after ${faultAt} must escape`);
    const published = faultIndex >= expected.indexOf("rename");
    assert.equal(
      (caught as NodeJS.ErrnoException).code,
      published ? ATOMIC_WRITE_DURABILITY : undefined,
    );
    assert.equal(readFileSync(file, "utf8"), published ? after : before);
    assert.deepEqual(tmpLeftovers(dir), []);
  }
});

test("sync and async writers publish the same ordered protocol", async () => {
  const traces: string[][] = [];
  for (const writer of ["sync", "async"] as const) {
    const dir = workspace();
    const file = join(dir, `${writer}.json`);
    const trace: string[] = [];
    const options = {
      mode: 0o600,
      afterStep: (step: string) => trace.push(step),
    };
    if (writer === "sync") writeFileAtomicSync(file, "payload", options);
    else await writeFileAtomic(file, "payload", options);
    assert.deepEqual(trace, protocolSteps(dir));
    traces.push(trace);
  }
  assert.deepEqual(traces[1], traces[0]);
});

test("cold writes confirm every ancestor and unchanged hot writes reuse the proof", async () => {
  for (const writer of ["sync", "async"] as const) {
    const base = workspace();
    const parent = join(base, writer, "nested", "data");
    const file = join(parent, "settings.json");
    const cold: string[] = [];
    const coldOptions = {
      afterStep(step: string, path: string) {
        if (step === "open-directory") cold.push(path);
      },
    };

    if (writer === "sync") writeFileAtomicSync(file, "cold", coldOptions);
    else await writeFileAtomic(file, "cold", coldOptions);

    const hot: string[] = [];
    const hotOptions = {
      afterStep(step: string, path: string) {
        if (step === "open-directory") hot.push(path);
      },
    };
    if (writer === "sync") writeFileAtomicSync(file, "hot", hotOptions);
    else await writeFileAtomic(file, "hot", hotOptions);

    assert.deepEqual(cold, physicalAncestors(parent));
    assert.deepEqual(hot, [realpathSync(parent)]);
    assert.equal(readFileSync(file, "utf8"), "hot");
  }
});

test("a successful retry fsyncs a parent chain left by a pre-rename failure", async () => {
  for (const writer of ["sync", "async"] as const) {
    const base = workspace();
    const parent = join(base, writer, "one", "two", "three");
    const file = join(parent, "store.json");
    const failAfterMkdir = {
      afterStep(step: string) {
        if (step === "mkdir") throw new Error("fault after mkdir");
      },
    };

    if (writer === "sync")
      assert.throws(() => writeFileAtomicSync(file, "first", failAfterMkdir));
    else
      await assert.rejects(() =>
        writeFileAtomic(file, "first", failAfterMkdir),
      );

    const synced: string[] = [];
    const retry = {
      afterStep(step: string, path: string) {
        if (step === "sync-directory") synced.push(path);
      },
    };
    if (writer === "sync") writeFileAtomicSync(file, "second", retry);
    else await writeFileAtomic(file, "second", retry);

    assert.deepEqual(synced, physicalAncestors(parent));
    assert.equal(readFileSync(file, "utf8"), "second");
  }
});

test("a fault before full ancestor confirmation is never cached", async () => {
  for (const writer of ["sync", "async"] as const) {
    const base = workspace();
    const parent = join(base, writer, "one", "two", "three");
    const file = join(parent, "store.json");
    const failDuringChain = {
      afterStep(step: string, path: string) {
        if (step === "sync-directory" && path === realpathSync(parent))
          throw new Error("fault before ancestor confirmation");
      },
    };

    if (writer === "sync")
      assert.throws(
        () => writeFileAtomicSync(file, "first", failDuringChain),
        (error: unknown) =>
          (error as NodeJS.ErrnoException).code === ATOMIC_WRITE_DURABILITY,
      );
    else
      await assert.rejects(
        () => writeFileAtomic(file, "first", failDuringChain),
        (error: unknown) =>
          (error as NodeJS.ErrnoException).code === ATOMIC_WRITE_DURABILITY,
      );

    const retryOpened: string[] = [];
    const retry = {
      afterStep(step: string, path: string) {
        if (step === "open-directory") retryOpened.push(path);
      },
    };
    if (writer === "sync") writeFileAtomicSync(file, "second", retry);
    else await writeFileAtomic(file, "second", retry);

    assert.deepEqual(retryOpened, physicalAncestors(parent));
    assert.equal(readFileSync(file, "utf8"), "second");
  }
});

test("a new process confirms the full chain again", () => {
  const base = workspace();
  const parent = join(base, "existing", "deep", "parent");
  const file = join(parent, "store.json");
  writeFileAtomicSync(file, "parent-process");

  const source = [
    `import { writeFileAtomicSync } from ${JSON.stringify(MODULE_URL)};`,
    "const file = process.argv[1];",
    "const opened = [];",
    "writeFileAtomicSync(file, 'child-process', {",
    "  afterStep(step, path) {",
    "    if (step === 'open-directory') opened.push(path);",
    "  },",
    "});",
    "console.log(JSON.stringify(opened));",
  ].join("\n");
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", source, file],
    { encoding: "utf8" },
  );

  assert.deepEqual(JSON.parse(output) as unknown, physicalAncestors(parent));
  assert.equal(readFileSync(file, "utf8"), "child-process");
});

test("cached proofs follow physical symlink targets and reject a recreated parent", () => {
  const base = workspace();
  const firstRoot = join(base, "first-root");
  const firstParent = join(firstRoot, "deep", "parent");
  const alias = join(base, "alias");
  mkdirSync(firstParent, { recursive: true });
  symlinkSync(firstRoot, alias, "dir");

  const aliasParent = join(alias, "deep", "parent");
  writeFileAtomicSync(join(aliasParent, "one.json"), "cold-alias");

  const physicalHot: string[] = [];
  writeFileAtomicSync(join(firstParent, "two.json"), "hot-physical", {
    afterStep(step, path) {
      if (step === "open-directory") physicalHot.push(path);
    },
  });
  assert.deepEqual(physicalHot, [realpathSync(firstParent)]);

  rmSync(firstParent, { recursive: true, force: true });
  mkdirSync(firstParent, { recursive: true });
  const recreated: string[] = [];
  writeFileAtomicSync(join(firstParent, "three.json"), "recreated", {
    afterStep(step, path) {
      if (step === "open-directory") recreated.push(path);
    },
  });
  assert.deepEqual(recreated, physicalAncestors(firstParent));

  const secondRoot = join(base, "second-root");
  const secondParent = join(secondRoot, "deep", "parent");
  mkdirSync(secondParent, { recursive: true });
  rmSync(alias, { force: true });
  symlinkSync(secondRoot, alias, "dir");
  const retargeted: string[] = [];
  writeFileAtomicSync(join(aliasParent, "four.json"), "retargeted", {
    afterStep(step, path) {
      if (step === "open-directory") retargeted.push(path);
    },
  });
  assert.deepEqual(retargeted, physicalAncestors(secondParent));
});

test("same-inode ABA respects the cache-hit linearization point", async () => {
  const results: Array<{
    writer: "sync" | "async";
    trigger:
      | "before-call"
      | "before-post-inspection"
      | "inside-post-inspection"
      | "after-linearization";
    sameIdentity: boolean;
    containerMetadataChanged: boolean;
    synced: string[];
    expected: string[];
    retrySynced: string[];
    retryExpected: string[];
  }> = [];

  for (const writer of ["sync", "async"] as const) {
    for (const trigger of [
      "before-call",
      "before-post-inspection",
      "inside-post-inspection",
      "after-linearization",
    ] as const) {
      const base = workspace();
      const root = join(base, `${writer}-${trigger}`);
      const ancestor = join(root, "ancestor");
      const moved = join(root, "moved");
      const parent = join(ancestor, "parent");
      const file = join(parent, "settings.json");
      mkdirSync(parent, { recursive: true });

      if (writer === "sync") writeFileAtomicSync(file, "warm");
      else await writeFileAtomic(file, "warm");

      const before = statSync(ancestor, { bigint: true });
      const containerBefore = statSync(root, { bigint: true });
      let movedAwayAndBack = false;
      const moveAwayAndBack = () => {
        movedAwayAndBack = true;
        renameSync(ancestor, moved);
        renameSync(moved, ancestor);
      };
      if (trigger === "before-call") moveAwayAndBack();

      const synced: string[] = [];
      const directoryCount = physicalAncestors(parent).length;
      let statDirectorySteps = 0;
      const options = {
        afterStep(step: string, path: string) {
          if (step === "sync-directory") synced.push(path);
          if (step === "stat-directory") {
            statDirectorySteps++;
            if (
              !movedAwayAndBack &&
              trigger === "inside-post-inspection" &&
              statDirectorySteps === directoryCount * 2
            )
              moveAwayAndBack();
          }
          if (
            !movedAwayAndBack &&
            trigger === "before-post-inspection" &&
            step === "close-directory" &&
            path === realpathSync(parent)
          )
            moveAwayAndBack();
          if (
            !movedAwayAndBack &&
            trigger === "after-linearization" &&
            step === "linearize-directory-proof"
          )
            moveAwayAndBack();
        },
      };
      if (writer === "sync") writeFileAtomicSync(file, "hot", options);
      else await writeFileAtomic(file, "hot", options);

      const after = statSync(ancestor, { bigint: true });
      const containerAfter = statSync(root, { bigint: true });
      const retrySynced: string[] = [];
      const retryOptions = {
        afterStep(step: string, path: string) {
          if (step === "sync-directory") retrySynced.push(path);
        },
      };
      if (writer === "sync") writeFileAtomicSync(file, "retry", retryOptions);
      else await writeFileAtomic(file, "retry", retryOptions);
      results.push({
        writer,
        trigger,
        sameIdentity: before.dev === after.dev && before.ino === after.ino,
        containerMetadataChanged:
          containerBefore.mtimeNs !== containerAfter.mtimeNs ||
          containerBefore.ctimeNs !== containerAfter.ctimeNs,
        synced,
        expected:
          trigger === "inside-post-inspection" ||
          trigger === "after-linearization"
            ? [realpathSync(parent)]
            : physicalAncestors(parent),
        retrySynced,
        retryExpected:
          trigger === "inside-post-inspection" ||
          trigger === "after-linearization"
            ? physicalAncestors(parent)
            : [realpathSync(parent)],
      });
      assert.equal(readFileSync(file, "utf8"), "retry");
    }
  }

  assert.equal(
    results.every(
      ({ sameIdentity, containerMetadataChanged }) =>
        sameIdentity && containerMetadataChanged,
    ),
    true,
  );
  assert.deepEqual(
    results.map(({ writer, trigger, synced }) => ({ writer, trigger, synced })),
    results.map(({ writer, trigger, expected }) => ({
      writer,
      trigger,
      synced: expected,
    })),
    "sync and async writers must not reuse an ABA-stale proof",
  );
  assert.deepEqual(
    results.map(({ writer, trigger, retrySynced }) => ({
      writer,
      trigger,
      synced: retrySynced,
    })),
    results.map(({ writer, trigger, retryExpected }) => ({
      writer,
      trigger,
      synced: retryExpected,
    })),
    "an ABA after the point must invalidate the next write instead",
  );
});

test("alias retargets before temp, before rename, and after rename never report false success", async () => {
  for (const writer of ["sync", "async"] as const) {
    for (const trigger of [
      "realpath-directory",
      "close-temp",
      "rename",
    ] as const) {
      const base = workspace();
      const oldRoot = join(base, "old");
      const newRoot = join(base, "new");
      const oldParent = join(oldRoot, "parent");
      const newParent = join(newRoot, "parent");
      const alias = join(base, "alias");
      mkdirSync(oldParent, { recursive: true });
      mkdirSync(newParent, { recursive: true });
      symlinkSync(oldRoot, alias, "dir");
      const file = join(alias, "parent", "settings.json");
      const oldFile = join(oldParent, "settings.json");
      const newFile = join(newParent, "settings.json");
      writeFileSync(oldFile, "old-target");
      writeFileSync(newFile, "new-target");

      let switched = false;
      const synced: string[] = [];
      const options = {
        afterStep(step: string, path: string) {
          if (step === "sync-directory") synced.push(path);
          if (switched || step !== trigger) return;
          switched = true;
          rmSync(alias);
          symlinkSync(newRoot, alias, "dir");
        },
      };
      let caught: unknown;
      try {
        if (writer === "sync") writeFileAtomicSync(file, "published", options);
        else await writeFileAtomic(file, "published", options);
      } catch (error) {
        caught = error;
      }

      assert.equal(switched, true);
      assert.equal(
        (caught as NodeJS.ErrnoException | undefined)?.code,
        ATOMIC_WRITE_PARENT_CHANGED,
      );
      assert.equal(
        (caught as { published?: boolean } | undefined)?.published,
        trigger === "rename",
      );
      assert.equal(
        readFileSync(oldFile, "utf8"),
        trigger === "rename" ? "published" : "old-target",
      );
      assert.equal(readFileSync(newFile, "utf8"), "new-target");
      assert.deepEqual(tmpLeftovers(oldParent), []);
      assert.deepEqual(tmpLeftovers(newParent), []);
      if (trigger === "rename") {
        assert.equal(synced[0], realpathSync(oldParent));
        assert.equal(
          (caught as Error).message.includes(
            join(realpathSync(oldParent), "settings.json"),
          ),
          true,
        );
      } else {
        assert.deepEqual(synced, []);
      }

      const retryOpened: string[] = [];
      if (writer === "sync")
        writeFileAtomicSync(file, "retried", {
          afterStep(step, path) {
            if (step === "open-directory") retryOpened.push(path);
          },
        });
      else
        await writeFileAtomic(file, "retried", {
          afterStep(step, path) {
            if (step === "open-directory") retryOpened.push(path);
          },
        });
      assert.deepEqual(retryOpened, physicalAncestors(newParent));
      assert.equal(readFileSync(newFile, "utf8"), "retried");
    }
  }
});

test("parent verification linearizes before every mutating callback", async () => {
  for (const writer of ["sync", "async"] as const) {
    for (const verifyIndex of [1, 2] as const) {
      const base = workspace();
      const oldRoot = join(base, "old");
      const newRoot = join(base, "new");
      const oldParent = join(oldRoot, "parent");
      const newParent = join(newRoot, "parent");
      const alias = join(base, "alias");
      mkdirSync(oldParent, { recursive: true });
      mkdirSync(newParent, { recursive: true });
      symlinkSync(oldRoot, alias, "dir");
      const file = join(alias, "parent", "settings.json");
      const oldFile = join(oldParent, "settings.json");
      const newFile = join(newParent, "settings.json");
      writeFileSync(oldFile, "old-target");
      writeFileSync(newFile, "new-target");

      let verifies = 0;
      let switched = false;
      const options = {
        afterStep(step: string) {
          if (step !== "verify-parent" || ++verifies !== verifyIndex) return;
          switched = true;
          rmSync(alias);
          symlinkSync(newRoot, alias, "dir");
        },
      };
      let caught: unknown;
      try {
        if (writer === "sync") writeFileAtomicSync(file, "published", options);
        else await writeFileAtomic(file, "published", options);
      } catch (error) {
        caught = error;
      }

      assert.equal(switched, true);
      assert.equal(readFileSync(oldFile, "utf8"), "published");
      assert.equal(readFileSync(newFile, "utf8"), "new-target");
      assert.deepEqual(tmpLeftovers(oldParent), []);
      assert.deepEqual(tmpLeftovers(newParent), []);
      if (verifyIndex === 1) {
        assert.equal(
          (caught as NodeJS.ErrnoException | undefined)?.code,
          ATOMIC_WRITE_PARENT_CHANGED,
        );
        assert.equal(
          (caught as { published?: boolean } | undefined)?.published,
          true,
        );
      } else {
        assert.equal(caught, undefined);
      }
    }
  }
});

test("a direct parent recreated after inspection cannot receive a false publish", async () => {
  for (const writer of ["sync", "async"] as const) {
    const base = workspace();
    const parent = join(base, writer, "deep", "parent");
    const moved = join(base, `${writer}-moved-parent`);
    const file = join(parent, "settings.json");
    mkdirSync(parent, { recursive: true });
    writeFileAtomicSync(file, "warm");
    const physicalParent = realpathSync(parent);

    let recreated = false;
    const options = {
      afterStep(step: string, path: string) {
        if (recreated || step !== "stat-directory" || path !== physicalParent)
          return;
        recreated = true;
        renameSync(parent, moved);
        mkdirSync(parent, { recursive: true });
        writeFileSync(file, "replacement");
      },
    };
    let caught: unknown;
    try {
      if (writer === "sync") writeFileAtomicSync(file, "bad", options);
      else await writeFileAtomic(file, "bad", options);
    } catch (error) {
      caught = error;
    }

    assert.equal(recreated, true);
    assert.equal(
      (caught as NodeJS.ErrnoException | undefined)?.code,
      ATOMIC_WRITE_PARENT_CHANGED,
    );
    assert.equal(
      (caught as { published?: boolean } | undefined)?.published,
      false,
    );
    assert.equal(readFileSync(join(moved, "settings.json"), "utf8"), "warm");
    assert.equal(readFileSync(file, "utf8"), "replacement");
    assert.deepEqual(tmpLeftovers(moved), []);
    assert.deepEqual(tmpLeftovers(parent), []);

    const retryOpened: string[] = [];
    if (writer === "sync")
      writeFileAtomicSync(file, "good", {
        afterStep(step, path) {
          if (step === "open-directory") retryOpened.push(path);
        },
      });
    else
      await writeFileAtomic(file, "good", {
        afterStep(step, path) {
          if (step === "open-directory") retryOpened.push(path);
        },
      });
    assert.deepEqual(retryOpened, physicalAncestors(parent));
    assert.equal(readFileSync(file, "utf8"), "good");
  }
});

test("an async first-use race reuses only the completed sync proof", async () => {
  const base = workspace();
  const parent = join(base, "shared", "deep", "parent");
  const asyncFile = join(parent, "async.json");
  const syncFile = join(parent, "sync.json");
  const asyncOpened: string[] = [];
  const pending = writeFileAtomic(asyncFile, "async", {
    afterStep(step, path) {
      if (step === "open-directory") asyncOpened.push(path);
    },
  });

  const syncOpened: string[] = [];
  writeFileAtomicSync(syncFile, "sync", {
    afterStep(step, path) {
      if (step === "open-directory") syncOpened.push(path);
    },
  });
  await pending;

  assert.deepEqual(syncOpened, physicalAncestors(parent));
  assert.deepEqual(asyncOpened, [realpathSync(parent)]);
  assert.equal(readFileSync(syncFile, "utf8"), "sync");
  assert.equal(readFileSync(asyncFile, "utf8"), "async");
});

test("a hot post-rename fault invalidates its in-flight ancestor proof", () => {
  const base = workspace();
  const parent = join(base, "existing", "deep", "parent");
  const file = join(parent, "store.json");
  writeFileAtomicSync(file, "before");

  assert.throws(
    () =>
      writeFileAtomicSync(file, "published", {
        afterStep(step) {
          if (step === "rename") throw new Error("fault after rename");
        },
      }),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === ATOMIC_WRITE_DURABILITY,
  );
  assert.equal(readFileSync(file, "utf8"), "published");

  const retryOpened: string[] = [];
  writeFileAtomicSync(file, "retried", {
    afterStep(step, path) {
      if (step === "open-directory") retryOpened.push(path);
    },
  });
  assert.deepEqual(retryOpened, physicalAncestors(parent));
  assert.equal(readFileSync(file, "utf8"), "retried");
});

test("a fault at every ancestor directory barrier reports published durability", () => {
  const parent = join(workspace(), "one", "two", "three");
  mkdirSync(parent, { recursive: true });
  for (
    let faultIndex = 0;
    faultIndex < physicalAncestors(parent).length;
    faultIndex++
  ) {
    const base = workspace();
    const file = join(base, "one", "two", "three", "store.json");
    let directorySync = 0;
    let caught: unknown;
    try {
      writeFileAtomicSync(file, "complete", {
        afterStep(step) {
          if (step === "sync-directory" && directorySync++ === faultIndex)
            throw new Error(`directory fault ${faultIndex}`);
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(
      (caught as NodeJS.ErrnoException | undefined)?.code,
      ATOMIC_WRITE_DURABILITY,
    );
    assert.equal(readFileSync(file, "utf8"), "complete");
  }
});

test("cleanup never removes another writer's orphan temp or the last good target", () => {
  const dir = workspace();
  const file = join(dir, "store.json");
  const orphan = `${file}.tmp-999-orphan`;
  writeFileSync(file, "last-good");
  writeFileSync(orphan, "unowned-temp");

  writeFileAtomicSync(file, "next-good");

  assert.equal(readFileSync(file, "utf8"), "next-good");
  assert.equal(readFileSync(orphan, "utf8"), "unowned-temp");
});

test("SIGKILL at write, file-fsync and rename boundaries never exposes a partial target", async (t) => {
  const source = [
    `import { writeFileAtomicSync } from ${JSON.stringify(MODULE_URL)};`,
    "const [file, stopAt, size] = process.argv.slice(1);",
    'const payload = "B".repeat(Number(size));',
    "writeFileAtomicSync(file, payload, {",
    "  mode: 0o600,",
    "  afterStep(step) {",
    "    if (step !== stopAt) return;",
    '    process.stdout.write("ready\\n");',
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    "  },",
    "});",
  ].join("\n");

  for (const stopAt of ["write-temp", "sync-temp", "rename"] as const) {
    const dir = workspace();
    const file = join(dir, "crash.json");
    const size = 256 * 1024;
    const before = "A".repeat(size);
    const after = "B".repeat(size);
    writeFileSync(file, before);
    const child = await startChild(source, [file, stopAt, String(size)]);
    t.after(() => child.kill("SIGKILL"));
    child.kill("SIGKILL");
    await once(child, "exit");

    assert.equal(
      readFileSync(file, "utf8"),
      stopAt === "rename" ? after : before,
    );
    for (const name of tmpLeftovers(dir)) {
      assert.equal(
        readFileSync(join(dir, name), "utf8"),
        after,
        `${stopAt} left a partial staging file`,
      );
    }
  }
});

test("сбой rename убирает tmp и пробрасывает ошибку, не трогая цель", async () => {
  const dir = workspace();
  // Цель — каталог: rename на него обязан упасть, а старые данные (сам каталог с
  // его содержимым) остаться нетронутыми.
  const file = join(dir, "occupied");
  mkdirSync(join(file, "inside"), { recursive: true });

  assert.throws(() => {
    writeFileAtomicSync(file, "новое");
  });
  await assert.rejects(() => writeFileAtomic(file, "новое"));

  assert.deepEqual(readdirSync(file), ["inside"]);
  assert.deepEqual(tmpLeftovers(dir), [], "tmp обязан быть убран после сбоя");
});

test("восемь параллельных писателей не делят tmp: побеждает один, мусора нет", async () => {
  const dir = workspace();
  const file = join(dir, "contended.json");
  const payloads = Array.from({ length: 8 }, (_, i) => `writer-${i}`);

  await Promise.all(payloads.map((payload) => writeFileAtomic(file, payload)));

  assert.ok(payloads.includes(readFileSync(file, "utf8")));
  assert.deepEqual(readdirSync(dir), ["contended.json"]);
});

test("убитый посреди записи писатель не оставляет полфайла — читатель видит только целые версии (seed виден)", async (t) => {
  const seed = Number(process.env.IVA_TEST_SEED ?? Date.now() % 100_000);
  console.log(
    `fs-atomic partial-write seed: ${seed} (IVA_TEST_SEED to replay)`,
  );
  let lcg = seed >>> 0;
  const nextDelay = (): number => {
    lcg = (lcg * 1_664_525 + 1_013_904_223) >>> 0;
    return 5 + (lcg % 120);
  };

  const dir = workspace();
  const file = join(dir, "big.json");
  const size = 512 * 1024;
  const before = "A".repeat(size);
  const after = "B".repeat(size);
  writeFileAtomicSync(file, before);

  const source = [
    `import { writeFileAtomicSync } from ${JSON.stringify(MODULE_URL)};`,
    "const [file, size] = process.argv.slice(1);",
    'const payload = "B".repeat(Number(size));',
    'process.stdout.write("ready\\n");',
    "for (;;) writeFileAtomicSync(file, payload);",
  ].join("\n");

  for (let round = 0; round < 4; round++) {
    const child = await startChild(source, [file, String(size)]);
    t.after(() => child.kill("SIGKILL"));
    // Читатель работает параллельно с писателем: каждая прочитанная версия обязана
    // быть целой, «полкарточки» не существует ни в одном кадре.
    const deadline = Date.now() + nextDelay();
    while (Date.now() < deadline) {
      const seen = readFileSync(file, "utf8");
      assert.ok(
        seen === before || seen === after,
        `seed ${seed} round ${round}: читатель увидел ${seen.length} байт`,
      );
    }
    child.kill("SIGKILL");
    await once(child, "exit");

    const survived = readFileSync(file, "utf8");
    assert.ok(
      survived === before || survived === after,
      `seed ${seed} round ${round}: после SIGKILL в файле ${survived.length} байт`,
    );
  }
});
