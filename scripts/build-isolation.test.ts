import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Stands in for `eve build`: names the tree the bundle was built from. */
const CORE = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
mkdirSync(join(process.cwd(), ".output"), { recursive: true });
writeFileSync(
  join(process.cwd(), ".output/app.mjs"),
  "import " + JSON.stringify(join(process.cwd(), "agent/agent.ts")) + ";\\n",
);
`;

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  // Resolved: a temporary directory is behind a symlink on macOS, and the paths
  // the build writes into its output are the resolved ones.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-build-")));
  worlds.push(dir);
  return dir;
}

/** Enough of an Iva tree for the real `scripts/build.ts` to run over it. */
function plantTree(root: string): void {
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(REPO, "scripts/build.ts"), join(root, "scripts/build.ts"));
  cpSync(join(REPO, "scripts/lib"), join(root, "scripts/lib"), {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
  writeFileSync(join(root, "scripts/core-build.mjs"), CORE);
  mkdirSync(join(root, "agent/skills/mine"), { recursive: true });
  writeFileSync(join(root, "agent/agent.ts"), "export const agent = 1;\n");
  writeFileSync(join(root, "agent/skills/mine/SKILL.md"), "stock\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.3.15",
        private: true,
        type: "module",
        scripts: {
          build: "node scripts/build.ts",
          "build:core": "node scripts/core-build.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
}

/** A customization as PR #169 leaves it: a canonical file under data/custom. */
function plantCustomization(dataDir: string): void {
  mkdirSync(join(dataDir, "custom/agent/skills/mine"), { recursive: true });
  writeFileSync(join(dataDir, "custom/agent/skills/mine/SKILL.md"), "mine\n");
}

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

function build(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [join(root, "scripts/build.ts")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("a checkout still builds through the custom layer it owns", () => {
  const home = join(world(), "iva");
  mkdirSync(home, { recursive: true });
  plantTree(home);
  git(home, ["init", "--initial-branch=main"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-m", "initial"]);
  plantCustomization(join(home, "data"));

  const built = build(home);
  assert.equal(built.status, 0, built.output);

  // The control for the version case below: on a checkout the legacy machinery
  // is what applies the customization, and it does apply it.
  assert.ok(existsSync(join(home, "data/custom/manifest.json")));
  assert.match(
    readFileSync(join(home, ".output/app.mjs"), "utf8"),
    /data\/custom\/runtimes\//u,
  );
});

test("a version builds itself, never the checkout's custom layer", () => {
  const dir = world();
  const home = join(dir, "iva");
  const version = join(home, "versions/0.3.15-0123456789ab");
  mkdirSync(version, { recursive: true });
  plantTree(version);
  mkdirSync(join(home, "data"), { recursive: true });
  plantCustomization(join(home, "data"));
  symlinkSync(join(home, "data"), join(version, "data"));
  // The checkout the bridge has not retired yet. It is still there during the
  // very first build of the very first version - the update this release exists
  // for - and git discovery climbs out of the version straight into it.
  git(home, ["init", "--initial-branch=main"]);
  git(home, ["commit", "--allow-empty", "-m", "installed"]);
  assert.match(git(version, ["rev-parse", "HEAD"]), /^[0-9a-f]{40}$/u);

  const built = build(version);
  assert.equal(built.status, 0, built.output);

  const output = readFileSync(join(version, ".output/app.mjs"), "utf8");
  // What runs is inside the version, so rolling back to it is a symlink flip and
  // nothing else - not a directory shared with every other version.
  assert.ok(output.includes(`${version}/agent/agent.ts`), output);
  assert.doesNotMatch(output, /runtimes/u);
  assert.ok(!existsSync(join(home, "data/custom/runtimes")));
  // Untouched: no manifest written, no base blobs, no customization applied
  // behind the updater's back.
  assert.ok(!existsSync(join(home, "data/custom/manifest.json")));
  assert.equal(
    readFileSync(join(version, "agent/skills/mine/SKILL.md"), "utf8"),
    "stock\n",
  );
});
