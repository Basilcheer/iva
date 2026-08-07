import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { persistUpdateBranch, resolveUpdateTarget } from "./update-channel.ts";

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

type CommandResult = { code: number; stdout: string; stderr: string };
type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  verbose?: boolean;
};
type UpdateLock = { ok: boolean; path: string; owner: string | null };
type UpdateTarget = Awaited<ReturnType<typeof resolveUpdateTarget>> & {
  remote: string;
  plan: "none" | "fast-forward" | "rebase";
  changed: boolean;
};
type UpdateCandidate = {
  staging: string;
  targetSha: string;
  depsChanged: boolean;
  customization: "clean" | "applied" | "conflicted" | "fallback";
  conflicts: string[];
  fallbackReason: "stash-apply-failed" | "custom-build-failed" | null;
};
export type RestoreConflict = {
  path: string;
  baseMode: string | null;
  localMode: string | null;
  upstreamMode: string | null;
};
export type RestoreReport =
  | { status: "none" | "applied"; conflicts: readonly [] }
  | {
      status: "conflicted" | "preserved";
      conflicts: RestoreConflict[];
      recoveryDir: string;
      stashOid: string;
    };
type UpdateTransactionOptions = {
  root: string;
  dataDir: string;
  envPath: string;
  verbose?: boolean;
  logFile?: string;
  env?: NodeJS.ProcessEnv;
};

function readJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function runCommand(
  command: string,
  args: string[],
  { cwd, env = process.env, logFile, verbose = false }: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const collect = (
      kind: "out" | "err",
      stream: NodeJS.ReadableStream,
      target: NodeJS.WriteStream,
    ) => {
      stream.on("data", (chunk: unknown) => {
        const text = String(chunk);
        if (kind === "out") stdout += text;
        else stderr += text;
        if (logFile) appendFileSync(logFile, text);
        if (verbose) target.write(text);
      });
    };
    collect("out", child.stdout, process.stdout);
    collect("err", child.stderr, process.stderr);
    child.on("error", (error) =>
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      }),
    );
  });
}

function runCommandBuffer(
  command: string,
  args: string[],
  { cwd, env = process.env }: Pick<CommandOptions, "cwd" | "env"> = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        code: 1,
        stdout: Buffer.concat(stdout),
        stderr: error.message,
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: stderr.trim(),
      });
    });
  });
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function createUpdateLog(dataDir: string, now = new Date()): string {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `update-${safeTimestamp(now)}.log`);
  writeFileSync(file, "", { mode: 0o600 });
  const old = readdirSync(dir)
    .filter((name) => /^update-.*\.log$/.test(name))
    .sort()
    .reverse()
    .slice(10);
  for (const name of old) rmSync(join(dir, name), { force: true });
  return file;
}

export function acquireUpdateLock(dataDir: string, owner: string): UpdateLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "update.lock");
  const claim = () => {
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        owner,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
      {
        mode: 0o600,
      },
    );
    return { ok: true, path, owner };
  };
  try {
    return claim();
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException;
    if (error.code !== "EEXIST") throw error;
  }
  try {
    const current = readJsonObject(
      readFileSync(join(path, "owner.json"), "utf8"),
    );
    if (current?.owner === owner) return { ok: true, path, owner };
    const age = Date.now() - statSync(path).mtimeMs;
    if (age > LOCK_TTL_MS) {
      rmSync(path, { recursive: true, force: true });
      return claim();
    }
    return {
      ok: false,
      path,
      owner: typeof current?.owner === "string" ? current.owner : null,
    };
  } catch {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age <= LOCK_TTL_MS) return { ok: false, path, owner: null };
    rmSync(path, { recursive: true, force: true });
    return claim();
  }
}

export function releaseUpdateLock(lock: UpdateLock | null | undefined): void {
  if (!lock?.ok || !lock.path) return;
  try {
    const current = readJsonObject(
      readFileSync(join(lock.path, "owner.json"), "utf8"),
    );
    if (current?.owner !== lock.owner) return;
  } catch {
    return;
  }
  rmSync(lock.path, { recursive: true, force: true });
}

export async function commitThenRunPostCommit({
  commit,
  postCommit,
}: {
  commit: () => Promise<void>;
  postCommit: () => Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: unknown }> {
  await commit();
  try {
    await postCommit();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function parseVersion(text: string): string | null {
  try {
    const value = readJsonObject(text)?.version;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function createUpdateTransaction({
  root,
  dataDir,
  envPath,
  verbose = false,
  logFile,
  env = process.env,
}: UpdateTransactionOptions) {
  const commandEnv = { ...env };
  let originalHead = "";
  let branch = "";
  let updateBranch = "";
  let backupRef = "";
  let stashOid = "";
  let hadLocalChanges = false;
  let stashApplied = false;
  let preserveStash = false;
  let envBackup = "";
  let outputBackup = "";
  let changed = false;
  let originalUntracked: string[] = [];
  let cachedTarget: UpdateTarget | null = null;
  let candidate: UpdateCandidate | null = null;
  let nodeModulesBackup = "";
  let outputTouched = false;

  const run = (command: string, args: string[]): Promise<CommandResult> =>
    runCommand(command, args, { cwd: root, env: commandEnv, logFile, verbose });
  const git = (...args: string[]): Promise<CommandResult> => run("git", args);
  const mustGit = async (...args: string[]): Promise<string> => {
    const result = await git(...args);
    if (result.code !== 0)
      throw new Error(
        result.stderr || result.stdout || `git ${args[0]} failed`,
      );
    return result.stdout ?? "";
  };

  const safeChild = (base: string, ...parts: string[]): string => {
    const basePath = resolve(base);
    const target = resolve(base, ...parts);
    if (target !== basePath && !target.startsWith(`${basePath}${sep}`))
      throw new Error("unsafe path in update recovery data");
    return target;
  };

  const removeOriginalUntracked = (): void => {
    for (const relative of originalUntracked) {
      const target = safeChild(root, relative);
      rmSync(target, { recursive: true, force: true });
    }
  };

  const unmergedPaths = async (cwd = root): Promise<string[]> => {
    const result = await runCommand(
      "git",
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      { cwd, env: commandEnv },
    );
    if (result.code !== 0)
      throw new Error(result.stderr || "couldn't inspect update conflicts");
    return result.stdout.split("\0").filter(Boolean).sort();
  };

  const resolveConflictsToHead = async (
    paths: readonly string[],
    cwd = root,
  ): Promise<void> => {
    for (const path of paths) {
      const existsAtHead = await runCommand(
        "git",
        ["cat-file", "-e", `HEAD:${path}`],
        { cwd, env: commandEnv },
      );
      const resolved =
        existsAtHead.code === 0
          ? await runCommand(
              "git",
              [
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                path,
              ],
              { cwd, env: commandEnv },
            )
          : await runCommand(
              "git",
              ["rm", "-f", "--ignore-unmatch", "--", path],
              { cwd, env: commandEnv },
            );
      if (resolved.code !== 0)
        throw new Error(resolved.stderr || `couldn't resolve ${path}`);
      if (existsAtHead.code !== 0)
        rmSync(safeChild(cwd, path), { recursive: true, force: true });
    }
  };

  const gitBlob = async (
    revision: string,
    path: string,
  ): Promise<Buffer | null> => {
    const result = await runCommandBuffer(
      "git",
      ["show", `${revision}:${path}`],
      { cwd: root, env: commandEnv },
    );
    return result.code === 0 ? result.stdout : null;
  };

  const gitMode = async (
    revision: string,
    path: string,
  ): Promise<string | null> => {
    const result = await git("ls-tree", revision, "--", path);
    if (result.code !== 0 || !result.stdout) return null;
    return result.stdout.split(/\s+/, 1)[0] || null;
  };

  const writeRecoveryBlob = (
    recoveryDir: string,
    side: "base" | "local" | "upstream",
    path: string,
    contents: Buffer | null,
  ): void => {
    if (!contents) return;
    const target = safeChild(recoveryDir, side, path);
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(target, contents, { mode: 0o600 });
    chmodSync(target, 0o600);
  };

  const archiveLocalChanges = async ({
    conflicts,
    reason,
  }: {
    conflicts: readonly string[];
    reason: "conflict" | "stash-apply-failed" | "custom-build-failed";
  }): Promise<{
    recoveryDir: string;
    conflictReports: RestoreConflict[];
  }> => {
    const shortTarget = (cachedTarget?.remote || "unknown").slice(0, 12);
    const recoveryDir = join(
      dataDir,
      "update-conflicts",
      `${safeTimestamp()}-${shortTarget}`,
    );
    mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    chmodSync(recoveryDir, 0o700);
    const conflictReports: RestoreConflict[] = [];
    for (const path of conflicts) {
      const stashBlob = await gitBlob(stashOid, path);
      const localRevision = stashBlob !== null ? stashOid : `${stashOid}^3`;
      const [base, local, upstream, baseMode, localMode, upstreamMode] =
        await Promise.all([
          gitBlob(originalHead, path),
          stashBlob !== null
            ? Promise.resolve(stashBlob)
            : gitBlob(localRevision, path),
          gitBlob("HEAD", path),
          gitMode(originalHead, path),
          gitMode(localRevision, path),
          gitMode("HEAD", path),
        ]);
      writeRecoveryBlob(recoveryDir, "base", path, base);
      writeRecoveryBlob(recoveryDir, "local", path, local);
      writeRecoveryBlob(recoveryDir, "upstream", path, upstream);
      conflictReports.push({
        path,
        baseMode,
        localMode,
        upstreamMode,
      });
    }
    const patch = await runCommandBuffer(
      "git",
      ["diff", "--binary", "--full-index", originalHead, stashOid],
      { cwd: root, env: commandEnv },
    );
    if (patch.code !== 0)
      throw new Error(patch.stderr || "couldn't archive local update patch");
    const patchPath = join(recoveryDir, "changes.patch");
    writeFileSync(patchPath, patch.stdout, { mode: 0o600 });
    chmodSync(patchPath, 0o600);
    const reportPath = join(recoveryDir, "report.json");
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          schema: "iva-update-conflicts/v1",
          createdAt: new Date().toISOString(),
          reason,
          beforeHead: originalHead,
          afterHead: cachedTarget?.remote || null,
          stashOid,
          originalUntracked,
          conflicts: conflictReports,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    chmodSync(reportPath, 0o600);
    return { recoveryDir, conflictReports };
  };

  async function protect() {
    originalHead = await mustGit("rev-parse", "HEAD");
    branch = await mustGit("rev-parse", "--abbrev-ref", "HEAD");
    if (!branch || branch === "HEAD")
      throw new Error("detached HEAD: switch to the update branch first");
    backupRef = `refs/iva/update-backups/${safeTimestamp()}`;
    await mustGit("update-ref", backupRef, originalHead);

    const backups = join(dataDir, "update-backups");
    mkdirSync(backups, { recursive: true });
    if (existsSync(envPath)) {
      envBackup = join(backups, `.env-${safeTimestamp()}`);
      copyFileSync(envPath, envBackup);
      chmodSync(envBackup, 0o600);
    }

    const status = await mustGit("status", "--porcelain=v1");
    hadLocalChanges = Boolean(status.trim());
    if (hadLocalChanges) {
      const untracked = await mustGit(
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      );
      originalUntracked = untracked.split("\0").filter(Boolean);
      const message = `iva-update-${safeTimestamp()}`;
      await mustGit(
        "stash",
        "push",
        "--include-untracked",
        "--message",
        message,
      );
      stashOid = await mustGit("rev-parse", "refs/stash");
    }
    return { originalHead, branch, hadLocalChanges, stashOid };
  }

  // Fetch + классификация плана интеграции БЕЗ движения HEAD. Отдельный шаг, чтобы
  // buildCandidate() мог собрать target в worktree до любых изменений живого дерева.
  async function resolveTarget() {
    const target = await resolveUpdateTarget({ git });
    updateBranch = target.branch;
    const remote = target.targetHead;
    let plan: UpdateTarget["plan"] = "none";
    if (remote !== originalHead) {
      if (
        (await git("merge-base", "--is-ancestor", originalHead, remote))
          .code === 0
      )
        plan = "fast-forward";
      else if (
        (await git("merge-base", "--is-ancestor", remote, originalHead))
          .code === 0
      )
        plan = "none";
      else plan = "rebase";
    }
    cachedTarget = { ...target, remote, plan, changed: plan !== "none" };
    return cachedTarget;
  }

  async function fetchAndIntegrate() {
    const target = cachedTarget ?? (await resolveTarget());
    if (!target) throw new Error("update target could not be resolved");
    if (target.plan === "none") return { ...target, changed: false };
    if (target.plan === "fast-forward") {
      await mustGit("merge", "--ff-only", target.remote);
    } else {
      const rebase = await git("rebase", target.remote);
      if (rebase.code !== 0) {
        await git("rebase", "--abort");
        throw new Error("local commits conflict with the update");
      }
    }
    changed = true;
    return { ...target, changed };
  }

  async function restoreLocalChanges(): Promise<RestoreReport> {
    if (!stashOid) return { status: "none", conflicts: [] };
    const result = await git("stash", "apply", "--index", stashOid);
    const conflicts = result.code === 0 ? [] : await unmergedPaths();
    const fallbackReason = candidate?.fallbackReason;
    if (result.code === 0 && !fallbackReason) {
      stashApplied = true;
      return { status: "applied", conflicts: [] };
    }
    if (result.code !== 0 && conflicts.length === 0)
      throw new Error(
        result.stderr || "local changes could not be restored safely",
      );

    const archived = await archiveLocalChanges({
      conflicts,
      reason: fallbackReason || "conflict",
    });
    preserveStash = true;
    if (fallbackReason) {
      await mustGit("reset", "--hard", "HEAD");
      removeOriginalUntracked();
      return {
        status: "preserved",
        conflicts: archived.conflictReports,
        recoveryDir: archived.recoveryDir,
        stashOid,
      };
    }
    await resolveConflictsToHead(conflicts);
    return {
      status: "conflicted",
      conflicts: archived.conflictReports,
      recoveryDir: archived.recoveryDir,
      stashOid,
    };
  }

  // Build the clean target first, then layer the protected local stash onto the detached
  // worktree. Conflicts are resolved to the new core there, so unrelated customizations can
  // still be built. The clean output remains available as a fallback throughout the process.
  async function buildCandidate({
    npm = "npm",
  }: { npm?: string } = {}): Promise<UpdateCandidate | null> {
    if (!cachedTarget)
      throw new Error("resolveTarget must run before buildCandidate");
    if (cachedTarget.plan !== "fast-forward") return null;
    const targetSha = cachedTarget.remote;
    const staging = join(root, ".iva-update", "staging");
    await teardownCandidate();
    const added = await git("worktree", "add", "--detach", staging, targetSha);
    if (added.code !== 0)
      throw new Error(
        added.stderr || "couldn't prepare the update candidate worktree",
      );
    try {
      const depsDiff = await mustGit(
        "diff",
        "--name-only",
        `${originalHead}..${targetSha}`,
        "--",
        "package.json",
        "package-lock.json",
      );
      // Отсутствие живых node_modules (битая/недоустановленная инсталляция) лечим так же,
      // как смену лока: полной установкой зависимостей в staging.
      const coreDepsChanged =
        Boolean(depsDiff.trim()) || !existsSync(join(root, "node_modules"));
      if (coreDepsChanged) {
        const install = await runCommand(
          npm,
          [existsSync(join(staging, "package-lock.json")) ? "ci" : "install"],
          { cwd: staging, env: commandEnv, logFile, verbose },
        );
        if (install.code !== 0)
          throw new Error(
            "candidate dependency installation failed — live installation untouched",
          );
      } else {
        // Лок не менялся — живые node_modules (уже пропатченные patch-package) валидны для target.
        symlinkSync(
          join(root, "node_modules"),
          join(staging, "node_modules"),
          "dir",
        );
      }
      // Паритет с in-place сборкой: она идёт в cwd, где лежит .env.
      if (existsSync(envPath)) symlinkSync(envPath, join(staging, ".env"));
      const build = await runCommand(npm, ["run", "build"], {
        cwd: staging,
        env: commandEnv,
        logFile,
        verbose,
      });
      if (build.code !== 0)
        throw new Error("candidate build failed — live installation untouched");
      if (!existsSync(join(staging, ".output")))
        throw new Error(
          "candidate build produced no output — live installation untouched",
        );

      candidate = {
        staging,
        targetSha,
        depsChanged: coreDepsChanged,
        customization: "clean",
        conflicts: [],
        fallbackReason: null,
      };
      if (!stashOid) return candidate;

      const cleanOutput = join(staging, ".output.iva-core");
      renameSync(join(staging, ".output"), cleanOutput);
      let cleanNodeModules = "";
      let customDepsChanged = false;
      const restoreCleanCandidate = async (
        conflicts: string[],
        fallbackReason: "stash-apply-failed" | "custom-build-failed",
      ) => {
        rmSync(join(staging, ".output"), { recursive: true, force: true });
        renameSync(cleanOutput, join(staging, ".output"));
        if (customDepsChanged) {
          rmSync(join(staging, "node_modules"), {
            recursive: true,
            force: true,
          });
          if (cleanNodeModules)
            renameSync(cleanNodeModules, join(staging, "node_modules"));
        }
        await runCommand("git", ["reset", "--hard", "HEAD"], {
          cwd: staging,
          env: commandEnv,
        });
        for (const relative of originalUntracked)
          rmSync(safeChild(staging, relative), {
            recursive: true,
            force: true,
          });
        candidate = {
          staging,
          targetSha,
          depsChanged: coreDepsChanged,
          customization: "fallback",
          conflicts,
          fallbackReason,
        };
      };

      const applied = await runCommand(
        "git",
        ["stash", "apply", "--index", stashOid],
        { cwd: staging, env: commandEnv, logFile, verbose },
      );
      const conflicts = applied.code === 0 ? [] : await unmergedPaths(staging);
      if (applied.code !== 0 && conflicts.length === 0) {
        await restoreCleanCandidate([], "stash-apply-failed");
        return candidate;
      }
      if (conflicts.length > 0)
        await resolveConflictsToHead(conflicts, staging);

      const customDependencyDiff = await runCommand(
        "git",
        [
          "diff",
          "--name-only",
          "HEAD",
          "--",
          "package.json",
          "package-lock.json",
        ],
        { cwd: staging, env: commandEnv },
      );
      if (customDependencyDiff.code !== 0)
        throw new Error("couldn't inspect customized dependencies");
      customDepsChanged = Boolean(customDependencyDiff.stdout.trim());
      if (customDepsChanged) {
        const currentNodeModules = join(staging, "node_modules");
        if (existsSync(currentNodeModules)) {
          const cleanDependencyPath = join(staging, "node_modules.iva-core");
          renameSync(currentNodeModules, cleanDependencyPath);
          cleanNodeModules = cleanDependencyPath;
        }
        const install = await runCommand(
          npm,
          [existsSync(join(staging, "package-lock.json")) ? "ci" : "install"],
          { cwd: staging, env: commandEnv, logFile, verbose },
        );
        if (install.code !== 0) {
          await restoreCleanCandidate(conflicts, "custom-build-failed");
          return candidate;
        }
      }

      const customBuild = await runCommand(npm, ["run", "build"], {
        cwd: staging,
        env: commandEnv,
        logFile,
        verbose,
      });
      if (customBuild.code !== 0) {
        await restoreCleanCandidate(conflicts, "custom-build-failed");
        return candidate;
      }
      rmSync(cleanOutput, { recursive: true, force: true });
      if (cleanNodeModules)
        rmSync(cleanNodeModules, { recursive: true, force: true });
      candidate = {
        staging,
        targetSha,
        depsChanged: coreDepsChanged || customDepsChanged,
        customization: conflicts.length > 0 ? "conflicted" : "applied",
        conflicts,
        fallbackReason: null,
      };
      return candidate;
    } catch (error) {
      await teardownCandidate();
      throw error;
    }
  }

  // Перенос артефактов кандидата в живой корень. Только rename внутри root (одна ФС, атомарно).
  // false — вызывающий обязан собрать in-place, как раньше.
  async function promoteCandidate(): Promise<boolean> {
    if (!candidate) return false;
    if (!existsSync(join(candidate.staging, ".output"))) return false;
    const head = await mustGit("rev-parse", "HEAD");
    if (head !== candidate.targetSha) return false;
    if (candidate.depsChanged) {
      // Свежие node_modules обязаны существовать в staging; иначе безопаснее пересобрать in-place.
      if (!existsSync(join(candidate.staging, "node_modules"))) return false;
      nodeModulesBackup = join(root, `node_modules.iva-backup-${Date.now()}`);
      if (existsSync(join(root, "node_modules")))
        renameSync(join(root, "node_modules"), nodeModulesBackup);
      renameSync(
        join(candidate.staging, "node_modules"),
        join(root, "node_modules"),
      );
    }
    backupOutput();
    renameSync(join(candidate.staging, ".output"), join(root, ".output"));
    return true;
  }

  // Идемпотентный teardown: безопасен до создания worktree, после переноса артефактов и
  // при остатках от упавшего прошлого апдейта.
  async function teardownCandidate() {
    const stagingRoot = join(root, ".iva-update");
    await git("worktree", "remove", "--force", join(stagingRoot, "staging"));
    await git("worktree", "prune");
    rmSync(stagingRoot, { recursive: true, force: true });
    candidate = null;
  }

  function backupOutput() {
    outputTouched = true;
    const output = join(root, ".output");
    if (!existsSync(output)) return;
    outputBackup = join(root, `.output.iva-backup-${Date.now()}`);
    renameSync(output, outputBackup);
  }

  function restoreOutput() {
    if (!outputBackup || !existsSync(outputBackup)) return;
    rmSync(join(root, ".output"), { recursive: true, force: true });
    renameSync(outputBackup, join(root, ".output"));
    outputBackup = "";
  }

  async function rollback() {
    await git("rebase", "--abort");
    if (originalHead) await git("reset", "--hard", originalHead);
    if (envBackup && existsSync(envBackup)) {
      copyFileSync(envBackup, envPath);
      chmodSync(envPath, 0o600);
    }
    if (nodeModulesBackup && existsSync(nodeModulesBackup)) {
      rmSync(join(root, "node_modules"), { recursive: true, force: true });
      renameSync(nodeModulesBackup, join(root, "node_modules"));
      nodeModulesBackup = "";
    }
    restoreOutput();
    if (stashOid) {
      // A failed stash apply can leave a subset of the original untracked files behind.
      // Remove every path recorded before protect(), then re-apply the stash on the exact
      // original HEAD. Never use git clean or a broad directory target.
      removeOriginalUntracked();
      const reapplied = await git("stash", "apply", "--index", stashOid);
      stashApplied = reapplied.code === 0;
    }
  }

  async function dropExactStash() {
    if (!stashOid) return;
    const list = await git("stash", "list", "--format=%H %gd");
    const match = (list.stdout ?? "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2))
      .find(([oid]) => oid === stashOid);
    if (match?.[1]) await git("stash", "drop", match[1]);
  }

  async function commit() {
    if (outputBackup) {
      rmSync(outputBackup, { recursive: true, force: true });
      outputBackup = "";
    }
    if (nodeModulesBackup) {
      rmSync(nodeModulesBackup, { recursive: true, force: true });
      nodeModulesBackup = "";
    }
    if (!preserveStash) await dropExactStash();
    if (updateBranch) await persistUpdateBranch(git, updateBranch);
    if (backupRef) await git("update-ref", "-d", backupRef);
    if (envBackup) rmSync(envBackup, { force: true });
  }

  async function versions() {
    const beforeText = await git("show", `${originalHead}:package.json`);
    const afterHead = (await mustGit("rev-parse", "HEAD")).trim();
    const afterText = await git("show", `${afterHead}:package.json`);
    return {
      beforeHead: originalHead,
      afterHead,
      beforeVersion: parseVersion(beforeText.stdout ?? "")
        ? `v${parseVersion(beforeText.stdout ?? "")}`
        : "previous build",
      afterVersion: parseVersion(afterText.stdout ?? "")
        ? `v${parseVersion(afterText.stdout ?? "")}`
        : "new build",
    };
  }

  return {
    protect,
    resolveTarget,
    fetchAndIntegrate,
    restoreLocalChanges,
    buildCandidate,
    promoteCandidate,
    teardownCandidate,
    backupOutput,
    rollback,
    commit,
    versions,
    run,
    git,
    get changed() {
      return changed;
    },
    get hadLocalChanges() {
      return hadLocalChanges;
    },
    get stashApplied() {
      return stashApplied;
    },
    get outputTouched() {
      return outputTouched;
    },
  };
}
