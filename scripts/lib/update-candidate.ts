import { existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  archiveInvalidCustomLayer,
  commitCustomLayer,
  discardCustomLayer,
  ensureCustomRecoveryBundle,
  materializeCustomLayer,
  rebaseBuildOutput,
  readCustomManifest,
  type MaterializedCustomLayer,
} from "./custom-layer.ts";
import { type CommandResult, runCommand } from "./update-command.ts";
import type { UpdateRecoveryOwner } from "./update-recovery.ts";
import type { UpdateResourceOwners } from "./update-resource-owners.ts";

export type UpdateCandidate = {
  staging: string;
  targetSha: string;
  depsChanged: boolean;
  customization: "clean" | "applied" | "conflicted" | "fallback";
  conflicts: string[];
  coreConflicts: string[];
  customConflicts: string[];
  fallbackReason:
    | "stash-apply-failed"
    | "custom-build-failed"
    | "custom-layer-invalid"
    | null;
  customRecoveryDir: string | null;
};

type CandidateTarget = {
  plan: "none" | "fast-forward" | "rebase";
  remote: string;
};

type CandidateState =
  | { phase: "idle"; invalidRecoveryDir: string | null }
  | {
      phase: "ready";
      invalidRecoveryDir: string | null;
      candidate: UpdateCandidate;
      customLayer: MaterializedCustomLayer | null;
    };

type CandidateDependencies = {
  root: string;
  dataDir: string;
  envPath: string;
  commandEnv: NodeJS.ProcessEnv;
  logFile?: string;
  verbose: boolean;
  git: (...args: string[]) => Promise<CommandResult>;
  mustGit: (...args: string[]) => Promise<string>;
  unmergedPaths: (cwd: string) => Promise<string[]>;
  resolveConflictsToHead: (
    paths: readonly string[],
    cwd: string,
  ) => Promise<void>;
  resources: UpdateResourceOwners;
};

function safeChild(base: string, relative: string): string {
  const basePath = resolve(base);
  const target = resolve(base, relative);
  if (target === basePath || !target.startsWith(`${basePath}${sep}`))
    throw new Error("unsafe path in update candidate");
  return target;
}

export class UpdateCandidateOwner {
  readonly #deps: CandidateDependencies;
  #state: CandidateState = { phase: "idle", invalidRecoveryDir: null };

  constructor(dependencies: CandidateDependencies) {
    this.#deps = dependencies;
  }

  get candidate(): UpdateCandidate | null {
    return this.#state.phase === "ready" ? this.#state.candidate : null;
  }

  setInvalidRecoveryDir(path: string): void {
    this.#state = { ...this.#state, invalidRecoveryDir: path };
  }

  async build({
    target,
    originalHead,
    recovery,
    originalUntracked,
    npm = "npm",
  }: {
    target: CandidateTarget | null;
    originalHead: string;
    recovery: UpdateRecoveryOwner;
    originalUntracked: readonly string[];
    npm?: string;
  }): Promise<UpdateCandidate | null> {
    if (!target)
      throw new Error("resolveTarget must run before buildCandidate");
    if (target.plan !== "fast-forward") return null;
    await this.teardown();

    const { root } = this.#deps;
    const targetSha = target.remote;
    const staging = join(root, ".iva-update", "staging");
    let invalidRecoveryDir = this.#state.invalidRecoveryDir;
    let customLayer: MaterializedCustomLayer | null = null;
    const added = await this.#deps.git(
      "worktree",
      "add",
      "--detach",
      staging,
      targetSha,
    );
    if (added.code !== 0)
      throw new Error(
        added.stderr || "couldn't prepare the update candidate worktree",
      );

    try {
      const coreDepsChanged = await this.#prepareCleanBuild({
        npm,
        originalHead,
        staging,
        targetSha,
      });
      let candidate: UpdateCandidate = {
        staging,
        targetSha,
        depsChanged: coreDepsChanged,
        customization: "clean",
        conflicts: [],
        coreConflicts: [],
        customConflicts: [],
        fallbackReason: null,
        customRecoveryDir: null,
      };
      let hasCanonicalCustomizations = false;
      if (!invalidRecoveryDir) {
        try {
          hasCanonicalCustomizations =
            Object.keys(readCustomManifest(this.#deps.dataDir).entries).length >
            0;
        } catch (error) {
          invalidRecoveryDir = archiveInvalidCustomLayer({
            dataDir: this.#deps.dataDir,
            targetRevision: targetSha,
            error,
          });
        }
      }
      if (
        !recovery.restoreStashOid &&
        !hasCanonicalCustomizations &&
        !invalidRecoveryDir
      ) {
        this.#state = {
          phase: "ready",
          candidate,
          customLayer: null,
          invalidRecoveryDir,
        };
        return candidate;
      }

      const cleanOutput = join(staging, ".output.iva-core");
      renameSync(join(staging, ".output"), cleanOutput);
      let cleanNodeModules = "";
      let customDepsChanged = false;
      let customRecoveryDir: string | null = invalidRecoveryDir;
      const restoreCleanCandidate = async (
        coreConflicts: string[],
        fallbackReason: "stash-apply-failed" | "custom-build-failed",
      ): Promise<void> => {
        let customConflicts = invalidRecoveryDir
          ? ["custom/manifest.json"]
          : [];
        customRecoveryDir = invalidRecoveryDir;
        if (customLayer && fallbackReason === "custom-build-failed") {
          customRecoveryDir = ensureCustomRecoveryBundle({
            result: customLayer,
            root: staging,
            targetRevision: targetSha,
            reason: "custom-build-failed",
          });
          customConflicts = Object.keys(customLayer.manifest.entries).sort();
        }
        const recoveryConflicts = [
          ...new Set([...coreConflicts, ...customConflicts]),
        ].sort();
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
        for (const relative of originalUntracked)
          rmSync(safeChild(staging, relative), {
            recursive: true,
            force: true,
          });
        await runCommand("git", ["reset", "--hard", "HEAD"], {
          cwd: staging,
          env: this.#deps.commandEnv,
        });
        candidate = {
          staging,
          targetSha,
          depsChanged: coreDepsChanged,
          customization: "fallback",
          conflicts: recoveryConflicts,
          coreConflicts,
          customConflicts,
          fallbackReason,
          customRecoveryDir,
        };
      };

      let conflicts: string[] = [];
      if (recovery.restoreStashOid) {
        const applied = await this.#runLogged(
          "git",
          ["stash", "apply", "--index", recovery.restoreStashOid],
          staging,
        );
        conflicts =
          applied.code === 0 ? [] : await this.#deps.unmergedPaths(staging);
        if (applied.code !== 0 && conflicts.length === 0) {
          await restoreCleanCandidate([], "stash-apply-failed");
          return this.#finish(candidate, customLayer, invalidRecoveryDir);
        }
        if (conflicts.length > 0)
          await this.#deps.resolveConflictsToHead(conflicts, staging);
      }

      const dependencyDiff = await runCommand(
        "git",
        [
          "diff",
          "--name-only",
          "HEAD",
          "--",
          "package.json",
          "package-lock.json",
        ],
        { cwd: staging, env: this.#deps.commandEnv },
      );
      if (dependencyDiff.code !== 0)
        throw new Error("couldn't inspect customized dependencies");
      customDepsChanged = Boolean(dependencyDiff.stdout.trim());
      if (customDepsChanged) {
        const currentNodeModules = join(staging, "node_modules");
        if (existsSync(currentNodeModules)) {
          cleanNodeModules = join(staging, "node_modules.iva-core");
          renameSync(currentNodeModules, cleanNodeModules);
        }
        const install = await this.#runLogged(
          npm,
          [existsSync(join(staging, "package-lock.json")) ? "ci" : "install"],
          staging,
        );
        if (install.code !== 0) {
          await restoreCleanCandidate(conflicts, "custom-build-failed");
          return this.#finish(candidate, customLayer, invalidRecoveryDir);
        }
      }

      if (hasCanonicalCustomizations) {
        customLayer = materializeCustomLayer({
          root: staging,
          dataDir: this.#deps.dataDir,
          targetRevision: targetSha,
        });
        customRecoveryDir = customLayer.recoveryDir;
      }
      const customConflicts =
        customLayer?.conflicts ??
        (invalidRecoveryDir ? ["custom/manifest.json"] : []);
      const allConflicts = [
        ...new Set([...conflicts, ...customConflicts]),
      ].sort();
      const customBuild = await this.#runLogged(
        npm,
        ["run", "build:core"],
        staging,
      );
      if (customBuild.code !== 0 || !existsSync(join(staging, ".output"))) {
        await restoreCleanCandidate(allConflicts, "custom-build-failed");
        return this.#finish(candidate, customLayer, invalidRecoveryDir);
      }
      rebaseBuildOutput({
        outputDir: join(staging, ".output"),
        buildRoot: staging,
        appRoot: root,
        agentRoot: customLayer?.runtimeRoot,
      });
      rmSync(cleanOutput, { recursive: true, force: true });
      if (cleanNodeModules)
        rmSync(cleanNodeModules, { recursive: true, force: true });
      candidate = {
        staging,
        targetSha,
        depsChanged: coreDepsChanged || customDepsChanged,
        customization: invalidRecoveryDir
          ? "fallback"
          : allConflicts.length > 0
            ? "conflicted"
            : "applied",
        conflicts: allConflicts,
        coreConflicts: conflicts,
        customConflicts,
        fallbackReason: invalidRecoveryDir ? "custom-layer-invalid" : null,
        customRecoveryDir,
      };
      return this.#finish(candidate, customLayer, invalidRecoveryDir);
    } catch (error) {
      if (customLayer) discardCustomLayer(customLayer);
      this.#state = { phase: "idle", invalidRecoveryDir };
      await this.#removeWorktree();
      throw error;
    }
  }

  async promote(): Promise<boolean> {
    const candidate = this.candidate;
    if (!candidate) return false;
    if (!existsSync(join(candidate.staging, ".output"))) return false;
    const head = await this.#deps.mustGit("rev-parse", "HEAD");
    if (head !== candidate.targetSha) return false;
    if (candidate.depsChanged) {
      const source = join(candidate.staging, "node_modules");
      if (!existsSync(source)) return false;
      this.#deps.resources.promoteNodeModules(source);
    }
    this.#deps.resources.promoteOutput(join(candidate.staging, ".output"));
    return true;
  }

  discardCustomLayer(): void {
    if (this.#state.phase !== "ready" || !this.#state.customLayer) return;
    discardCustomLayer(this.#state.customLayer);
    this.#state = { ...this.#state, customLayer: null };
  }

  commitCustomLayer(): void {
    if (this.#state.phase !== "ready" || !this.#state.customLayer) return;
    commitCustomLayer(this.#state.customLayer);
    this.#state = { ...this.#state, customLayer: null };
  }

  async teardown(): Promise<void> {
    this.discardCustomLayer();
    await this.#removeWorktree();
    this.#state = {
      phase: "idle",
      invalidRecoveryDir: this.#state.invalidRecoveryDir,
    };
  }

  async #prepareCleanBuild({
    npm,
    originalHead,
    staging,
    targetSha,
  }: {
    npm: string;
    originalHead: string;
    staging: string;
    targetSha: string;
  }): Promise<boolean> {
    const { root, envPath } = this.#deps;
    const depsDiff = await this.#deps.mustGit(
      "diff",
      "--name-only",
      `${originalHead}..${targetSha}`,
      "--",
      "package.json",
      "package-lock.json",
    );
    const depsChanged =
      Boolean(depsDiff.trim()) || !existsSync(join(root, "node_modules"));
    if (depsChanged) {
      const install = await this.#runLogged(
        npm,
        [existsSync(join(staging, "package-lock.json")) ? "ci" : "install"],
        staging,
      );
      if (install.code !== 0)
        throw new Error(
          "candidate dependency installation failed — live installation untouched",
        );
    } else {
      symlinkSync(
        join(root, "node_modules"),
        join(staging, "node_modules"),
        "dir",
      );
    }
    if (existsSync(envPath)) symlinkSync(envPath, join(staging, ".env"));
    const build = await this.#runLogged(npm, ["run", "build:core"], staging);
    if (build.code !== 0)
      throw new Error("candidate build failed — live installation untouched");
    if (!existsSync(join(staging, ".output")))
      throw new Error(
        "candidate build produced no output — live installation untouched",
      );
    rebaseBuildOutput({
      outputDir: join(staging, ".output"),
      buildRoot: staging,
      appRoot: root,
    });
    return depsChanged;
  }

  #finish(
    candidate: UpdateCandidate,
    customLayer: MaterializedCustomLayer | null,
    invalidRecoveryDir: string | null,
  ): UpdateCandidate {
    this.#state = {
      phase: "ready",
      candidate,
      customLayer,
      invalidRecoveryDir,
    };
    return candidate;
  }

  #runLogged(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<CommandResult> {
    return runCommand(command, args, {
      cwd,
      env: this.#deps.commandEnv,
      logFile: this.#deps.logFile,
      verbose: this.#deps.verbose,
    });
  }

  async #removeWorktree(): Promise<void> {
    const stagingRoot = join(this.#deps.root, ".iva-update");
    await this.#deps.git(
      "worktree",
      "remove",
      "--force",
      join(stagingRoot, "staging"),
    );
    await this.#deps.git("worktree", "prune");
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
