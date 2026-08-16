/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node registers tests synchronously and mocks async interfaces. */
import assert from "node:assert/strict";
import test from "node:test";
import { AppliedRecoveryVerifier } from "./update-recovery-applied.ts";
import type { RecoveryObjectStore } from "./update-recovery-objects.ts";
import type { OriginalUntrackedOwner } from "./update-recovery-ownership.ts";
import type {
  RecoverySnapshot,
  SnapshotTreeEntry,
} from "./update-recovery-manifest.ts";

test("applied recovery rejects a chmod-only tracked mismatch", async () => {
  const head = "1".repeat(40);
  const tree = "2".repeat(40);
  const blob = "3".repeat(40);
  const indexEntry: SnapshotTreeEntry = {
    mode: "100644",
    oid: blob,
    path: "tracked.txt",
  };
  const snapshot: RecoverySnapshot = {
    oid: "4".repeat(40),
    indexTree: tree,
    worktreeTree: tree,
    untrackedTree: null,
    indexEntries: [indexEntry],
    worktreeEntries: [
      { ...indexEntry, permissions: 0o640, device: 1, inode: 2 },
    ],
    untrackedEntries: [],
    untrackedDirectories: [],
    ignoredCollisionEntries: [],
    ignoredCollisionDirectories: [],
    ignoredCollisionScopes: [],
    indexFlags: { assumeUnchanged: [], skipWorktree: [] },
  };
  const git = {
    async run(args: string[]) {
      if (args[0] === "rev-parse")
        return {
          code: 0,
          stdout: args.at(-1)?.endsWith("^{tree}") ? tree : head,
          stderr: "",
        };
      if (args[0] === "ls-files")
        return { code: 0, stdout: "index", stderr: "" };
      if (args[0] === "write-tree")
        return { code: 0, stdout: tree, stderr: "" };
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
  };
  const objects = {
    parseIndexEntries() {
      return [indexEntry];
    },
    async createRawTree() {
      return { tree, entries: [indexEntry] };
    },
  } as unknown as RecoveryObjectStore;
  const untracked = {
    async verify() {},
  } as unknown as OriginalUntrackedOwner;
  const verifier = new AppliedRecoveryVerifier({
    git,
    objects,
    originalHead: head,
    untracked,
    liveTrackedEntries: () => [
      { ...indexEntry, permissions: 0o600, device: 1, inode: 2 },
    ],
    indexFlags: async () => ({ assumeUnchanged: [], skipWorktree: [] }),
    untrackedPaths: async () => [],
  });

  await assert.rejects(
    () =>
      verifier.verify({
        snapshot,
        restoreStashOid: "",
        excludedUntrackedPaths: [],
      }),
    /applied recovery state is incomplete: worktree-permissions/u,
  );
});
