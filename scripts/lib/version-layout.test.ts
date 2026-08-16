/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRoot,
  isManagedInstall,
  refreshOwnedShim,
  shimScript,
} from "./version-layout.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function installation(t: { after(fn: () => void): void }): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-shim-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Built in release order, which is the reverse of the order their names sort in.
  for (const [name, age] of [
    ["0.3.9-bbbbbbbbbbbb", 2],
    ["0.3.14-aaaaaaaaaaaa", 1],
  ] as const) {
    mkdirSync(join(home, "versions", name, "bin"), { recursive: true });
    writeFileSync(
      join(home, "versions", name, "bin/iva.mjs"),
      `process.stdout.write(${JSON.stringify(name)});\n`,
    );
    const at = new Date(Date.now() - age * 60_000);
    utimesSync(join(home, "versions", name), at, at);
  }
  mkdirSync(join(home, "data"), { recursive: true });
  return home;
}

test("a shim without `current` runs the version the installation settled on", (t) => {
  const home = installation(t);
  const shim = join(home, "iva");
  writeFileSync(shim, shimScript(home, process.execPath, join(home, "data")));
  chmodSync(shim, 0o755);
  const run = (): string => execFileSync(shim, { encoding: "utf8" });

  // `current` is lost - the state the shim exists to survive.
  writeFileSync(
    join(home, "data/active.json"),
    `${JSON.stringify({ schema: "iva-active/v1", version: "0.3.14-aaaaaaaaaaaa" })}\n`,
  );
  assert.equal(run(), "0.3.14-aaaaaaaaaaaa");

  // No marker to go by: running something still beats running nothing, because
  // the command that repairs the installation is this one - and the newest build,
  // not the name that sorts last, or the repair starts an older release.
  rmSync(join(home, "data/active.json"));
  assert.equal(run(), "0.3.14-aaaaaaaaaaaa");

  // And an active version outranks both.
  symlinkSync(join(home, "versions/0.3.9-bbbbbbbbbbbb"), join(home, "current"));
  assert.equal(run(), "0.3.9-bbbbbbbbbbbb");
});

test("a shim reads active state from the canonical custom data directory", (t) => {
  const home = installation(t);
  const dataDir = join(home, 'state $ " ` \\');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "active.json"),
    `${JSON.stringify({ schema: "iva-active/v1", version: "0.3.9-bbbbbbbbbbbb" })}\n`,
  );
  const shim = join(home, "iva");
  writeFileSync(shim, shimScript(home, process.execPath, dataDir));
  chmodSync(shim, 0o755);

  assert.equal(execFileSync(shim, { encoding: "utf8" }), "0.3.9-bbbbbbbbbbbb");
  assert.throws(
    () => shimScript(home, process.execPath, `${dataDir}\nbroken`),
    /NUL or a newline/u,
  );
});

test("an owned shim refreshes its data snapshot without replacing a foreign command", (t) => {
  const home = installation(t);
  const shim = join(home, ".local/bin/iva");
  const firstData = join(home, "first data");
  const nextData = join(home, "next data");

  assert.equal(refreshOwnedShim(shim, home, process.execPath, firstData), true);
  assert.equal(refreshOwnedShim(shim, home, process.execPath, nextData), true);
  assert.equal(
    readFileSync(shim, "utf8"),
    shimScript(home, process.execPath, nextData),
  );

  const previousDirect = `#!/usr/bin/env bash\nexec "${process.execPath}" "${home}/bin/iva.mjs" "$@"\n`;
  writeFileSync(shim, previousDirect);
  assert.equal(refreshOwnedShim(shim, home, process.execPath, nextData), true);
  assert.equal(
    readFileSync(shim, "utf8"),
    shimScript(home, process.execPath, nextData),
  );

  const foreignExecutable = Buffer.from(
    `#!/usr/bin/env bash\nexec "/bin/echo" "${home}/bin/iva.mjs" "$@"\n`,
  );
  writeFileSync(shim, foreignExecutable);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), foreignExecutable);

  const foreignCurrent = Buffer.from(shimScript(home, "/bin/echo", firstData));
  writeFileSync(shim, foreignCurrent);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), foreignCurrent);

  const victim = join(home, "other-file");
  writeFileSync(victim, previousDirect);
  rmSync(shim);
  symlinkSync(victim, shim);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.equal(isManagedInstall(classifyRoot(home), shim), false);
  assert.equal(readFileSync(victim, "utf8"), previousDirect);
  rmSync(shim);

  linkSync(victim, shim);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.equal(isManagedInstall(classifyRoot(home), shim), false);
  assert.equal(readFileSync(victim, "utf8"), previousDirect);
  rmSync(shim);

  const previousOwned = shimScript(home, process.execPath, join(home, "data"))
    .replace(`IVA_DATA="${join(home, "data")}"\n`, "")
    .replace("$IVA_DATA/active.json", "$IVA_ROOT/data/active.json");
  writeFileSync(shim, previousOwned);
  assert.equal(refreshOwnedShim(shim, home, process.execPath, nextData), true);
  assert.equal(
    readFileSync(shim, "utf8"),
    shimScript(home, process.execPath, nextData),
  );

  writeFileSync(shim, "#!/bin/sh\necho foreign\n");
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.equal(readFileSync(shim, "utf8"), "#!/bin/sh\necho foreign\n");

  const substitution = Buffer.from(
    shimScript(home, process.execPath, join(home, "state/$(foreign)")).replace(
      "\\$(foreign)",
      "$(foreign)",
    ),
  );
  writeFileSync(shim, substitution);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), substitution);

  const hostile = Buffer.from(`#!/bin/sh\necho "${home}/reports"\n`);
  writeFileSync(shim, hostile);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), hostile);
});

test("a replacement arriving during refresh preserves both inodes", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs,{mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=mkdtempSync(join(tmpdir(),"iva-shim-swap-"));
try { const home=join(dir,"home"),shim=join(dir,"iva"),moved=join(dir,"moved");
mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`;
const foreign="#!/bin/sh\\necho foreign\\n"; writeFileSync(shim,old);
const lstat=fs.lstatSync; let swapped=false;
fs.lstatSync=((path,options)=>{const stat=lstat(path,options); if(path===shim&&!swapped){renameSync(shim,moved);writeFileSync(shim,foreign);swapped=true;}return stat;});
syncBuiltinESMExports();
const {refreshOwnedShim}=await import("./scripts/lib/version-layout.ts?swap-test");
const result=refreshOwnedShim(shim,home,process.execPath,join(home,"next"));
console.log(JSON.stringify({result,path:readFileSync(shim,"utf8"),moved:readFileSync(moved,"utf8")}));
} finally {rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const result = JSON.parse(output) as {
    result: boolean;
    path: string;
    moved: string;
  };
  assert.equal(result.result, false);
  assert.equal(result.path, "#!/bin/sh\necho foreign\n");
  assert.match(result.moved, /exec ".+" ".+\/bin\/iva\.mjs" "\$@"/u);
});

test("a replacement winning publication leaves an explicit recovery", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=fs.mkdtempSync(join(tmpdir(),"iva-shim-publish-"));
try {const home=join(dir,"home"),shim=join(dir,"iva"); fs.mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`;
const foreign="#!/bin/sh\\necho foreign\\n"; fs.writeFileSync(shim,old);
const open=fs.openSync; fs.openSync=(path,flags,...rest)=>{if(path===shim&&(flags&fs.constants.O_EXCL))fs.writeFileSync(shim,foreign);return open(path,flags,...rest);};
syncBuiltinESMExports();
const {refreshOwnedShim}=await import("./scripts/lib/version-layout.ts?publish-test");
const result=refreshOwnedShim(shim,home,process.execPath,join(home,"next"));
const recovery=fs.readdirSync(dir).find(name=>name.startsWith("iva.iva-recovery-"));
console.log(JSON.stringify({result,path:fs.readFileSync(shim,"utf8"),recovery:fs.readFileSync(join(dir,recovery,"previous"),"utf8")}));
} finally {fs.rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const result = JSON.parse(output) as {
    result: boolean;
    path: string;
    recovery: string;
  };
  assert.equal(result.result, false);
  assert.equal(result.path, "#!/bin/sh\necho foreign\n");
  assert.match(result.recovery, /exec ".+" ".+\/bin\/iva\.mjs" "\$@"/u);
});

test("a short shim write restores the complete previous command", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=fs.mkdtempSync(join(tmpdir(),"iva-shim-short-"));
try {const home=join(dir,"home"),shim=join(dir,"iva"); fs.mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`; fs.writeFileSync(shim,old);
const write=fs.writeSync; fs.writeSync=(fd,data,...rest)=>write(fd,data.subarray(0,1),...rest); syncBuiltinESMExports();
const {refreshOwnedShim}=await import("./scripts/lib/version-layout.ts?short-test");
let failed=false; try {refreshOwnedShim(shim,home,process.execPath,join(home,"next"));} catch {failed=true;}
console.log(JSON.stringify({failed,restored:fs.readFileSync(shim,"utf8")===old,entries:fs.readdirSync(dir)}));
} finally {fs.rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), {
    failed: true,
    restored: true,
    entries: ["home", "iva"],
  });
});

test("a close error cannot hide a complete published shim", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=fs.mkdtempSync(join(tmpdir(),"iva-shim-close-"));
try {const home=join(dir,"home"),shim=join(dir,"iva"),data=join(home,"next"); fs.mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`; fs.writeFileSync(shim,old);
const {refreshOwnedShim,shimScript}=await import("./scripts/lib/version-layout.ts?close-test");
const close=fs.closeSync; let injected=false; fs.closeSync=(fd)=>{if(!injected){injected=true;throw new Error("close boom");}return close(fd);}; syncBuiltinESMExports();
let error="",result=false; try {result=refreshOwnedShim(shim,home,process.execPath,data);} catch(cause){error=String(cause);}
fs.closeSync=close; syncBuiltinESMExports();
console.log(JSON.stringify({error,result,complete:fs.readFileSync(shim,"utf8")===shimScript(home,process.execPath,data),entries:fs.readdirSync(dir)}));
} finally {fs.rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), {
    error: "",
    result: true,
    complete: true,
    entries: ["home", "iva"],
  });
});

test("a checkout somebody develops in is never converted, however the shim points", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-managed-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
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
  const upstream = join(dir, "upstream.git");
  const source = join(dir, "source");
  const home = join(dir, "iva");
  git(dir, "init", "--bare", "--initial-branch=main", upstream);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), "{}\n");
  git(source, "init", "--initial-branch=main");
  git(source, "add", "-A");
  git(source, "commit", "-m", "initial");
  git(source, "push", "-q", upstream, "main");
  git(dir, "clone", "-q", upstream, home);

  // Exactly what install.sh leaves behind: one branch, nothing of the user's own
  // on top of it, and a shim on PATH that runs it.
  const shim = join(dir, "iva-shim");
  writeFileSync(shim, shimScript(home, process.execPath, join(home, "data")));
  const managed = (root = home): boolean =>
    isManagedInstall(classifyRoot(root), shim);
  assert.equal(managed(), true);

  const alias = join(dir, "iva-alias");
  symlinkSync(home, alias);
  const previousDirect = `#!/usr/bin/env bash\nexec "${process.execPath}" "${alias}/bin/iva.mjs" "$@"\n`;
  writeFileSync(shim, previousDirect);
  assert.equal(managed(alias), true);
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\nexec "/bin/echo" "${alias}/bin/iva.mjs" "$@"\n`,
  );
  assert.equal(managed(alias), false);
  writeFileSync(shim, shimScript(alias, "/bin/echo", join(alias, "data")));
  assert.equal(managed(alias), false);
  writeFileSync(shim, shimScript(alias, process.execPath, join(alias, "data")));
  assert.equal(managed(alias), true);

  const foreignWrapper = `#!/bin/sh\n: "${alias}/reports"\nexec "${process.execPath}" "${alias}/bin/iva.mjs" "$@"\n`;
  writeFileSync(shim, foreignWrapper);
  assert.equal(managed(alias), false);
  writeFileSync(shim, shimScript(home, process.execPath, join(home, "data")));
  assert.equal(managed(), true);

  // The deliberate ceiling of the test: an installation is free to have edits of
  // its own - preserving them is what the checkout-era updater is for - so dirt
  // alone cannot mean somebody develops here. History is the only tell.
  writeFileSync(join(home, "package.json"), '{ "edited": true }\n');
  assert.equal(managed(), true);

  // A branch of their own: a working tree, not an installation. Converting it
  // would retire the checkout somebody is working in.
  git(home, "checkout", "-q", "-b", "feature");
  assert.equal(managed(), false);

  // And commits of their own on the branch that tracks upstream.
  git(home, "checkout", "-q", "main");
  git(home, "branch", "-D", "feature");
  assert.equal(managed(), true);
  git(home, "commit", "-q", "--allow-empty", "-m", "mine");
  assert.equal(managed(), false);
});

test("install.sh creates and refreshes only its own shim", (t) => {
  const home = installation(t);
  const dataDir = join(home, "state with spaces");
  const nextDataDir = join(home, "next state");
  writeFileSync(join(home, ".env"), "ASSISTANT_DATA_DIR=state with spaces\n");
  const installer = readFileSync(join(ROOT, "install.sh"), "utf8");
  const block =
    /\nnode --input-type=module -e '\n([\s\S]*?)\n' "\$PROJECT_DIR" "\$HOME\/\.local\/bin\/iva"\n/u.exec(
      installer,
    );
  assert.ok(block, "the installer no longer calls the shared shim generator");

  // The installer's own lines, run as the installer runs them: an installation
  // that never had a `current` to lose gets the same resolution rules as one the
  // bridge converted, or a lost symlink means two different behaviours.
  const target = join(home, ".local/bin/iva");
  mkdirSync(dirname(target), { recursive: true });
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", block[1], home, target],
    { cwd: ROOT },
  );
  assert.equal(
    readFileSync(target, "utf8"),
    shimScript(home, process.execPath, dataDir),
  );

  writeFileSync(join(home, ".env"), "ASSISTANT_DATA_DIR=next state\n");
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", block[1], home, target],
    { cwd: ROOT },
  );
  assert.equal(
    readFileSync(target, "utf8"),
    shimScript(home, process.execPath, nextDataDir),
  );

  const foreign = Buffer.from("#!/bin/sh\necho foreign\n");
  writeFileSync(target, foreign);
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", block[1], home, target],
    { cwd: ROOT },
  );
  assert.deepEqual(readFileSync(target), foreign);
});
