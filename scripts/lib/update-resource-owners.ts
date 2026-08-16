import { appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  captureDirectoryLease,
  captureStableFile,
  createOwnedContainer,
  moveOwnedDirectory,
  pathMissing,
  removeOwnedContainer,
  removeOwnedDirectory,
  removeOwnedFile,
  releaseDirectoryLease,
  type ResourceContainer,
  type ResourceDirectoryLease,
  type ResourceFileSnapshot,
  type ResourceIdentityHooks,
  verifyDirectoryLease,
  verifyStableFile,
  writeExclusiveFile,
} from "./update-resource-identity.ts";

type OwnedFileBackup = {
  container: ResourceContainer;
  path: string;
  snapshot: ResourceFileSnapshot;
};

type ProtectedFileState =
  | { phase: "uncaptured" }
  | { phase: "absent" }
  | {
      phase: "backup";
      original: ResourceFileSnapshot;
      backup: OwnedFileBackup;
    };

type OwnedDirectoryBackup = {
  container: ResourceContainer;
  path: string;
  lease: ResourceDirectoryLease;
};

type PromotedDirectoryState =
  | { phase: "untouched" }
  | {
      phase: "changed";
      backup: OwnedDirectoryBackup | null;
      live: ResourceDirectoryLease | null;
    };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class ProtectedFileOwner {
  readonly #path: string;
  readonly #backupRoot: string;
  readonly #backupName: () => string;
  readonly #logCleanupFailure: (message: string) => void;
  readonly #hooks: ResourceIdentityHooks;
  #state: ProtectedFileState = { phase: "uncaptured" };

  constructor({
    path,
    backupRoot,
    backupName,
    logCleanupFailure,
    hooks,
  }: {
    path: string;
    backupRoot: string;
    backupName: () => string;
    logCleanupFailure: (message: string) => void;
    hooks: ResourceIdentityHooks;
  }) {
    this.#path = path;
    this.#backupRoot = backupRoot;
    this.#backupName = backupName;
    this.#logCleanupFailure = logCleanupFailure;
    this.#hooks = hooks;
  }

  capture(): void {
    if (this.#state.phase !== "uncaptured")
      throw new Error("environment owner already captured state");
    if (pathMissing(this.#path)) {
      this.#state = { phase: "absent" };
      return;
    }
    const original = captureStableFile(this.#path, "environment file");
    const container = createOwnedContainer(
      this.#backupRoot,
      `${this.#backupName()}-`,
    );
    const path = join(container.path, "owned");
    const snapshot = writeExclusiveFile({
      path,
      bytes: original.bytes,
      mode: 0o600,
      label: "environment backup",
    });
    this.#state = {
      phase: "backup",
      original,
      backup: { container, path, snapshot },
    };
    verifyStableFile(this.#path, original, "environment file");
  }

  rollback(): void {
    if (this.#state.phase === "uncaptured") return;
    if (this.#state.phase === "absent") {
      if (!pathMissing(this.#path))
        throw new Error("environment file ownership changed");
      return;
    }
    const state = this.#state;
    verifyDirectoryLease(
      state.backup.container.path,
      state.backup.container.lease,
      "environment backup container",
    );
    verifyStableFile(
      state.backup.path,
      state.backup.snapshot,
      "environment backup",
    );
    if (pathMissing(this.#path)) {
      const restored = writeExclusiveFile({
        path: this.#path,
        bytes: state.original.bytes,
        mode: state.original.mode,
        label: "environment file",
      });
      this.#state = { ...state, original: restored };
      return;
    }
    verifyStableFile(this.#path, state.original, "environment file");
  }

  cleanup(): void {
    if (this.#state.phase !== "backup") return;
    try {
      verifyDirectoryLease(
        this.#state.backup.container.path,
        this.#state.backup.container.lease,
        "environment backup container",
      );
      removeOwnedFile({
        path: this.#state.backup.path,
        expected: this.#state.backup.snapshot,
        label: "environment backup",
        hooks: this.#hooks,
      });
      removeOwnedContainer(this.#state.backup.container);
      this.#state = { phase: "uncaptured" };
    } catch (error) {
      this.#logCleanupFailure(
        `environment backup cleanup failed: ${String(error)}`,
      );
    }
  }
}

class PromotedDirectoryOwner {
  readonly #path: string;
  readonly #backupPrefix: string;
  readonly #label: string;
  readonly #logCleanupFailure: (message: string) => void;
  readonly #hooks: ResourceIdentityHooks;
  #state: PromotedDirectoryState = { phase: "untouched" };

  constructor({
    path,
    backupPrefix,
    label,
    logCleanupFailure,
    hooks,
  }: {
    path: string;
    backupPrefix: string;
    label: string;
    logCleanupFailure: (message: string) => void;
    hooks: ResourceIdentityHooks;
  }) {
    this.#path = path;
    this.#backupPrefix = backupPrefix;
    this.#label = label;
    this.#logCleanupFailure = logCleanupFailure;
    this.#hooks = hooks;
  }

  get touched(): boolean {
    return this.#state.phase !== "untouched";
  }

  get backupPath(): string | null {
    return this.#state.phase === "changed" && this.#state.backup
      ? this.#state.backup.container.path
      : null;
  }

  backup(): void {
    if (this.#state.phase !== "untouched")
      throw new Error(`${this.#label} owner already changed live state`);
    if (pathMissing(this.#path)) {
      this.#state = { phase: "changed", backup: null, live: null };
      return;
    }
    const lease = captureDirectoryLease(this.#path, this.#label);
    const container = createOwnedContainer(
      join(this.#path, ".."),
      this.#backupPrefix,
    );
    const path = join(container.path, "owned");
    this.#state = {
      phase: "changed",
      backup: { container, path, lease },
      live: null,
    };
    moveOwnedDirectory({
      source: this.#path,
      destination: path,
      expected: lease,
      label: `${this.#label} backup`,
    });
  }

  adoptLive(): void {
    if (this.#state.phase !== "changed" || this.#state.live)
      throw new Error(`${this.#label} owner cannot adopt live state`);
    this.#state = {
      ...this.#state,
      live: pathMissing(this.#path)
        ? null
        : captureDirectoryLease(this.#path, `${this.#label} live`),
    };
  }

  promote(source: string): void {
    const live = captureDirectoryLease(source, `${this.#label} candidate`);
    this.backup();
    const state = this.#changedState();
    this.#state = { ...state, live };
    moveOwnedDirectory({
      source,
      destination: this.#path,
      expected: live,
      label: `${this.#label} live`,
    });
  }

  rollback(): void {
    if (this.#state.phase === "untouched") return;
    const state = this.#state;
    if (state.backup) {
      verifyDirectoryLease(
        state.backup.container.path,
        state.backup.container.lease,
        `${this.#label} backup container`,
      );
      verifyDirectoryLease(
        state.backup.path,
        state.backup.lease,
        `${this.#label} backup`,
      );
    }
    if (state.live)
      verifyDirectoryLease(this.#path, state.live, `${this.#label} live`);
    else if (!pathMissing(this.#path))
      throw new Error(`${this.#label} live ownership changed`);

    if (state.live)
      removeOwnedDirectory({
        path: this.#path,
        expected: state.live,
        label: `${this.#label} live`,
        hooks: this.#hooks,
      });
    if (state.backup) {
      moveOwnedDirectory({
        source: state.backup.path,
        destination: this.#path,
        expected: state.backup.lease,
        label: `${this.#label} backup`,
      });
      removeOwnedContainer(state.backup.container);
      releaseDirectoryLease(state.backup.lease);
    }
    this.#state = { phase: "untouched" };
  }

  cleanup(): void {
    if (this.#state.phase !== "changed") return;
    if (!this.#state.backup) {
      if (this.#state.live) {
        verifyDirectoryLease(
          this.#path,
          this.#state.live,
          `${this.#label} live`,
        );
        releaseDirectoryLease(this.#state.live);
      }
      this.#state = { phase: "untouched" };
      return;
    }
    try {
      if (this.#state.live)
        verifyDirectoryLease(
          this.#path,
          this.#state.live,
          `${this.#label} live`,
        );
      verifyDirectoryLease(
        this.#state.backup.container.path,
        this.#state.backup.container.lease,
        `${this.#label} backup container`,
      );
      removeOwnedDirectory({
        path: this.#state.backup.path,
        expected: this.#state.backup.lease,
        label: `${this.#label} backup`,
        hooks: this.#hooks,
      });
      removeOwnedContainer(this.#state.backup.container);
      if (this.#state.live) releaseDirectoryLease(this.#state.live);
      this.#state = { phase: "untouched" };
    } catch (error) {
      this.#logCleanupFailure(
        `${this.#label} backup cleanup failed: ${String(error)}`,
      );
    }
  }

  #changedState(): Extract<PromotedDirectoryState, { phase: "changed" }> {
    if (this.#state.phase !== "changed")
      throw new Error(`${this.#label} owner has no changed state`);
    return this.#state;
  }
}

export class UpdateResourceOwners {
  readonly #root: string;
  readonly #environment: ProtectedFileOwner;
  readonly #output: PromotedDirectoryOwner;
  readonly #nodeModules: PromotedDirectoryOwner;

  constructor({
    root,
    dataDir,
    envPath,
    logFile,
    timestamp,
    identityHooks = {},
  }: {
    root: string;
    dataDir: string;
    envPath: string;
    logFile?: string;
    timestamp: () => string;
    identityHooks?: ResourceIdentityHooks;
  }) {
    this.#root = root;
    const logCleanupFailure = (message: string): void => {
      if (logFile) appendFileSync(logFile, `${message}\n`);
    };
    this.#environment = new ProtectedFileOwner({
      path: envPath,
      backupRoot: join(dataDir, "update-backups"),
      backupName: () => `.env-${timestamp()}`,
      logCleanupFailure,
      hooks: identityHooks,
    });
    this.#output = new PromotedDirectoryOwner({
      path: join(root, ".output"),
      backupPrefix: ".output.iva-backup-",
      label: "output",
      logCleanupFailure,
      hooks: identityHooks,
    });
    this.#nodeModules = new PromotedDirectoryOwner({
      path: join(root, "node_modules"),
      backupPrefix: "node_modules.iva-backup-",
      label: "node_modules",
      logCleanupFailure,
      hooks: identityHooks,
    });
  }

  get outputTouched(): boolean {
    return this.#output.touched;
  }

  get recoveryExcludedPaths(): string[] {
    return [this.#output.backupPath, this.#nodeModules.backupPath]
      .filter((path): path is string => path !== null)
      .map((path) => relative(this.#root, path));
  }

  protectEnvironment(): void {
    this.#environment.capture();
  }

  backupOutput(): void {
    this.#output.backup();
  }

  adoptOutput(): void {
    this.#output.adoptLive();
  }

  promoteOutput(source: string): void {
    this.#output.promote(source);
  }

  promoteNodeModules(source: string): void {
    this.#nodeModules.promote(source);
  }

  rollback(): Error[] {
    const errors: Error[] = [];
    for (const owner of [this.#environment, this.#nodeModules, this.#output]) {
      try {
        owner.rollback();
      } catch (error) {
        errors.push(asError(error));
      }
    }
    return errors;
  }

  cleanup(): void {
    this.#output.cleanup();
    this.#nodeModules.cleanup();
    this.#environment.cleanup();
  }
}
