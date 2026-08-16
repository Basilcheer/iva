import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyFlags,
  type IndexFlags,
  type SnapshotTreeEntry,
} from "./update-recovery-manifest.ts";

type ObjectGit = {
  run(
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; input?: Buffer; rawOutput?: boolean },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
};

export class RecoveryObjectStore {
  readonly #git: ObjectGit;
  readonly #liveBytes: (entry: SnapshotTreeEntry) => Buffer;
  readonly #removeTemporary: (path: string) => void;

  constructor({
    git,
    liveBytes,
    removeTemporary,
  }: {
    git: ObjectGit;
    liveBytes: (entry: SnapshotTreeEntry) => Buffer;
    removeTemporary: (path: string) => void;
  }) {
    this.#git = git;
    this.#liveBytes = liveBytes;
    this.#removeTemporary = removeTemporary;
  }

  async createRawTree(
    name: string,
    entries: readonly SnapshotTreeEntry[],
  ): Promise<{ tree: string; entries: SnapshotTreeEntry[] }> {
    const snapshotDir = mkdtempSync(
      join(tmpdir(), `iva-update-${name}-snapshot-`),
    );
    const indexEnv = { GIT_INDEX_FILE: join(snapshotDir, "index") };
    try {
      await this.snapshotGit(["read-tree", "--empty"], indexEnv);
      const resolved: SnapshotTreeEntry[] = [];
      for (const entry of entries) {
        let oid: string;
        if (entry.mode === "120000") {
          oid = await this.snapshotGit(
            ["hash-object", "-w", "--stdin"],
            {},
            this.#liveBytes(entry),
          );
        } else if (entry.mode === "100644" || entry.mode === "100755") {
          oid = await this.snapshotGit([
            "hash-object",
            "-w",
            "--no-filters",
            "--",
            entry.path,
          ]);
        } else {
          throw new Error(`unsupported working-tree mode: ${entry.mode}`);
        }
        resolved.push({ ...entry, oid });
      }
      if (resolved.length > 0) {
        const input = Buffer.concat(
          resolved.map(({ mode, oid, path }) =>
            Buffer.from(`${mode} ${oid}\t${path}\0`),
          ),
        );
        await this.snapshotGit(
          ["update-index", "-z", "--index-info"],
          indexEnv,
          input,
        );
      }
      const tree = await this.snapshotGit(["write-tree"], indexEnv);
      return { tree, entries: resolved };
    } finally {
      this.#removeTemporary(snapshotDir);
    }
  }

  parseIndexEntries(text: string): SnapshotTreeEntry[] {
    return text
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t");
        const [mode, oid, stage] = record.slice(0, tab).split(" ");
        if (tab < 0 || !mode || !oid || stage !== "0")
          throw new Error("the Git index cannot be snapshotted");
        return { mode, oid, path: record.slice(tab + 1) };
      });
  }

  parseTreeEntries(text: string): SnapshotTreeEntry[] {
    return text
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const tab = record.indexOf("\t");
        const [mode, , oid] = record.slice(0, tab).split(" ");
        if (tab < 0 || !mode || !oid)
          throw new Error("the recovery tree cannot be verified");
        return { mode, oid, path: record.slice(tab + 1) };
      });
  }

  parseIndexFlags(text: string): IndexFlags {
    const flags = emptyFlags();
    for (const record of text.split("\0").filter(Boolean)) {
      if (record.length < 3 || record[1] !== " ")
        throw new Error("the Git index flags cannot be snapshotted");
      const tag = record[0] ?? "";
      const path = record.slice(2);
      if (tag !== tag.toUpperCase()) flags.assumeUnchanged.push(path);
      if (tag.toUpperCase() === "S") flags.skipWorktree.push(path);
    }
    return flags;
  }

  async snapshotGit(
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
    input?: Buffer,
  ): Promise<string> {
    const result = await this.#git.run(args, {
      env: {
        GIT_AUTHOR_NAME: "Iva Update Recovery",
        GIT_AUTHOR_EMAIL: "iva-update@localhost",
        GIT_COMMITTER_NAME: "Iva Update Recovery",
        GIT_COMMITTER_EMAIL: "iva-update@localhost",
        ...extraEnv,
      },
      ...(input ? { input } : {}),
    });
    if (result.code !== 0)
      throw new Error(
        result.stderr || result.stdout || `git ${args[0]} failed`,
      );
    return result.stdout;
  }
}
