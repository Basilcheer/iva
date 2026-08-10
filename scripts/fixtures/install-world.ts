import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * A build that fails on broken source, like the real one - and a start that can
 * fail on source the build accepted, which is the seam every custom-layer
 * incident went through: `eve start` re-reads the authored TypeScript from its
 * own directory, so a green build has never proven that the service comes up.
 */
const SCAN = `import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function sources(dir, prefix = "") {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".output" || name === ".git") return [];
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return [];
    const relative = prefix ? prefix + "/" + name : name;
    if (stat.isDirectory()) return sources(full, relative);
    return name.endsWith(".mjs") || name.endsWith(".ts") ? [[relative, readFileSync(full, "utf8")]] : [];
  });
}
`;

const BUILD = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sources } from "./source-scan.mjs";
// Assembled, so the marker in this file is not itself a broken source file.
const mark = ["BUILD", "BREAK"].join("_");
const broken = sources(process.cwd()).filter(([, text]) => text.includes(mark));
if (broken.length) {
  process.stderr.write("cannot compile " + broken.map(([name]) => name).join(", ") + "\\n");
  process.exit(1);
}
mkdirSync(join(process.cwd(), ".output"), { recursive: true });
writeFileSync(join(process.cwd(), ".output/built.json"), JSON.stringify(sources(process.cwd()).length));
`;

/**
 * The dependency the health probe and the service both start.
 *
 * Like the real one it writes to the state it is given the moment it comes up -
 * eve re-enqueues the open runs from its durable store on every start - so a
 * probe that borrowed the installation's state leaves fingerprints in it.
 */
const EVE = `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { sources } from "../../../scripts/source-scan.mjs";
if (!existsSync(join(process.cwd(), ".output/built.json"))) {
  process.stderr.write("no build output\\n");
  process.exit(1);
}
const store = join(process.cwd(), ".eve/.workflow-data");
mkdirSync(store, { recursive: true });
appendFileSync(join(store, "started.log"), "re-enqueued active runs\\n");
// Where the real agent keeps its cards: the .env variable when there is one,
// which on a live installation is free to be an absolute path.
const data = process.env.ASSISTANT_DATA_DIR || join(process.cwd(), "data");
appendFileSync(join(data, "started.log"), "started\\n");
if (process.env.IVA_TEST_STARTS)
  appendFileSync(
    process.env.IVA_TEST_STARTS,
    JSON.stringify({
      cwd: process.cwd(),
      probe: process.env.IVA_HEALTH_PROBE ?? "",
      port: process.env.PORT,
      ivaPort: process.env.IVA_PORT,
      envMark: process.env.IVA_ENV_MARK ?? "",
      store: realpathSync(store),
      data: realpathSync(data),
    }) + "\\n",
  );
// After the store is opened, like the real thing: a start that crashes here has
// already touched whatever state it was given.
const mark = ["START", "BREAK"].join("_");
const broken = sources(process.cwd()).filter(([, text]) => text.includes(mark));
if (broken.length) {
  process.stderr.write("Cannot find module '../scripts/lib/provider.ts' in " + broken[0][0] + "\\n");
  process.exit(1);
}
createServer((_request, response) => response.writeHead(200).end("ok")).listen(
  Number(process.env.PORT),
  "127.0.0.1",
);
`;

/** postinstall: the dependency the health probe starts, plus the real node_modules. */
const INSTALL_EVE = `import { mkdirSync, readdirSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
const modules = join(process.cwd(), "node_modules");
mkdirSync(join(modules, "eve/bin"), { recursive: true });
writeFileSync(join(modules, "eve/bin/eve.js"), process.env.IVA_TEST_EVE);
chmodSync(join(modules, "eve/bin/eve.js"), 0o755);
for (const name of readdirSync(process.env.IVA_TEST_MODULES)) {
  if (name === "eve") continue;
  try {
    symlinkSync(join(process.env.IVA_TEST_MODULES, name), join(modules, name));
  } catch {}
}
`;

/** Builds the venv where it is told to, like `uv venv` does, and nothing else. */
const UV = `#!/bin/sh
printf '%s\\n' "$*" >> "$IVA_TEST_UV"
if [ "$1" = "venv" ]; then
  for venv; do :; done
  mkdir -p "$venv/bin"
  printf '%s\\n' '#!/bin/sh' 'exit 0' > "$venv/bin/python"
  chmod 755 "$venv/bin/python"
fi
exit 0
`;

const SYSTEMCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$IVA_TEST_SYSTEMCTL"
[ "$1" = "--user" ] && shift
if [ -n "$IVA_TEST_SYSTEMCTL_FAIL" ] && [ "$1" = "restart" ]; then
  printf 'Failed to connect to bus: No such file or directory\\n' >&2
  exit 1
fi
[ "$1" = "is-enabled" ] && printf 'enabled\\n'
[ "$1" = "is-active" ] && printf 'active\\n'
exit 0
`;

export type World = {
  readonly dir: string;
  /** The installation root, and after the bridge also the layout home. */
  readonly home: string;
  readonly fakeHome: string;
  readonly shim: string;
  readonly upstream: string;
  readonly systemctlLog: string;
  /** One line per `uv` call the update makes, in the order they happened. */
  readonly uvLog: string;
  /** One JSON line per server start, probe or service, in the order they happened. */
  readonly startsLog: string;
  /** Run the user's `iva` command, always through the shim they actually have. */
  iva(
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): SpawnSyncReturns<string>;
  /** The same command, without blocking - the only way to overlap two of them. */
  ivaAsync(args: readonly string[]): Promise<{ code: number; output: string }>;
  /** Publish a new upstream commit, optionally editing the tree first. */
  publish(edit?: (tree: string) => void): string;
  git(cwd: string, args: readonly string[]): string;
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "iva",
      GIT_AUTHOR_EMAIL: "iva@example.com",
      GIT_COMMITTER_NAME: "iva",
      GIT_COMMITTER_EMAIL: "iva@example.com",
    },
  }).trim();
}

function seed(tree: string): void {
  for (const path of [
    "bin",
    "scripts/cli",
    "scripts/lib",
    "scripts/migrations",
    "deploy",
  ])
    cpSync(join(REPO, path), join(tree, path), {
      recursive: true,
      filter: (source) => !source.endsWith(".test.ts"),
    });
  cpSync(
    join(REPO, "scripts/update-finish.ts"),
    join(tree, "scripts/update-finish.ts"),
  );
  // A stock skill under a name that git has to quote unless it is asked not to.
  mkdirSync(join(tree, "agent/skills"), { recursive: true });
  writeFileSync(
    join(tree, "agent/skills/\u043f\u0440\u0438\u0432\u0435\u0442.md"),
    "# skill\n",
  );
  // The proxy the userbot service runs: tracked code beside a venv git ignores.
  mkdirSync(join(tree, "services/telegram-userbot"), { recursive: true });
  cpSync(
    join(REPO, "services/telegram-userbot/requirements.lock"),
    join(tree, "services/telegram-userbot/requirements.lock"),
  );
  writeFileSync(join(tree, "services/telegram-userbot/serve.py"), "\n");
  writeFileSync(
    join(tree, ".gitignore"),
    // `*.local` stands in for the credentials skills keep beside their code.
    "node_modules\n.env\n/data/\n/vault/\n.eve\n.output\n*.local\nservices/telegram-userbot/.venv\n",
  );
  writeFileSync(join(tree, "scripts/source-scan.mjs"), SCAN);
  writeFileSync(join(tree, "scripts/build-stub.mjs"), BUILD);
  writeFileSync(join(tree, "scripts/install-eve.mjs"), INSTALL_EVE);
  writeFileSync(
    join(tree, "package.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.3.15",
        private: true,
        type: "module",
        scripts: {
          build: "node scripts/build-stub.mjs",
          postinstall: "node scripts/install-eve.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(tree, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.3.15",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "iva", version: "0.3.15" } },
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * A whole Iva installation as a user has it: a git checkout, the shim on PATH,
 * state next to the code, and an upstream to update from. Everything the update
 * touches is real here - git, npm, the symlinks, the spawned processes - so the
 * only stand-ins are the dependency the probe starts and systemctl.
 */
export function createWorld(): World {
  // Resolved: a temporary directory is behind a symlink on macOS, and every path
  // the update writes down is the resolved one.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-world-")));
  const upstream = join(dir, "upstream.git");
  const source = join(dir, "source");
  const home = join(dir, "iva");
  const fakeHome = join(dir, "home");
  const bin = join(dir, "bin");
  const systemctlLog = join(dir, "systemctl.log");
  const uvLog = join(dir, "uv.log");
  const startsLog = join(dir, "starts.log");

  git(dir, ["init", "--bare", "--initial-branch=main", upstream]);
  mkdirSync(source, { recursive: true });
  seed(source);
  git(source, ["init", "--initial-branch=main"]);
  git(source, ["remote", "add", "origin", upstream]);
  git(source, ["add", "-A"]);
  git(source, ["commit", "-m", "initial"]);
  git(source, ["push", "-q", "origin", "main"]);

  git(dir, ["clone", "-q", upstream, home]);
  git(home, ["config", "iva.updateBranch", "main"]);
  for (const name of ["data", "vault", ".eve"])
    mkdirSync(join(home, name), { recursive: true });
  writeFileSync(join(home, ".env"), "AGENT_LANGUAGE=en\nIVA_PORT=8723\n");
  // An installed checkout has its dependencies; a version installs its own.
  symlinkSync(join(REPO, "node_modules"), join(home, "node_modules"));

  mkdirSync(join(fakeHome, ".local/bin"), { recursive: true });
  const shim = join(fakeHome, ".local/bin/iva");
  // Exactly what install.sh wrote before the bridge existed.
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${home}/bin/iva.mjs" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ["systemctl", SYSTEMCTL],
    ["uv", UV],
  ]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }

  const childEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
    HOME: fakeHome,
    NO_COLOR: "1",
    TERM: "dumb",
    AGENT_LANGUAGE: "en",
    IVA_TEST_SYSTEMCTL: systemctlLog,
    IVA_TEST_UV: uvLog,
    IVA_TEST_STARTS: startsLog,
    IVA_TEST_EVE: EVE,
    IVA_TEST_MODULES: join(REPO, "node_modules"),
    // An update keeps the Google CLI current with a global install. Here that must
    // reach neither the network nor the developer's own global prefix: it fails in
    // the world, which is exactly what a box without one does.
    npm_config_prefix: join(dir, "npm-global"),
    npm_config_offline: "1",
  };

  return {
    dir,
    home,
    fakeHome,
    shim,
    upstream,
    systemctlLog,
    uvLog,
    startsLog,
    git,
    iva: (args, env = {}) =>
      spawnSync(shim, [...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...childEnv, ...env },
      }),
    ivaAsync: (args) =>
      new Promise((resolve) => {
        const child = spawn(shim, [...args], { cwd: dir, env: childEnv });
        let output = "";
        const collect = (chunk: unknown): void => {
          output += String(chunk);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("close", (code) => resolve({ code: code ?? 1, output }));
      }),
    publish: (edit) => {
      edit?.(source);
      git(source, ["add", "-A"]);
      git(source, ["commit", "--allow-empty", "-m", "update"]);
      git(source, ["push", "-q", "origin", "main"]);
      return git(source, ["rev-parse", "HEAD"]);
    },
  };
}
