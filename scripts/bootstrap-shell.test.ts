import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BOOTSTRAP = join(ROOT, "bootstrap.sh");

type Failure = { status?: number; stdout?: string; stderr?: string };

function runBootstrap(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync("bash", [BOOTSTRAP, ...args], {
    encoding: "utf8",
    // No terminal: the dispatcher then runs non-interactively, so nothing waits
    // for an answer that a test can never give.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

void test("bootstrap.sh parses: a truncated or half-edited script never reaches a server", () => {
  assert.doesNotThrow(() =>
    execFileSync("bash", ["-n", BOOTSTRAP], { encoding: "utf8" }),
  );
});

void test("bootstrap.sh answers --help before it needs root, and ignores junk flags", () => {
  const output = runBootstrap(["--not-a-flag", "--help"]);
  assert.match(output, /unknown flag: --not-a-flag \(ignoring\)/);
  assert.match(output, /Prepare a fresh Ubuntu\/Debian VPS for Iva/);
  assert.match(output, /--non-interactive/);
});

void test("bootstrap.sh refuses to run as a normal user, before it touches anything", (t) => {
  if (process.getuid?.() === 0) {
    t.skip(
      "running as root: the script would go on and configure this machine",
    );
    return;
  }
  try {
    const output = runBootstrap(["--non-interactive"], { IVA_USER: "iva" });
    assert.fail(`bootstrap.sh should have refused: ${output}`);
  } catch (error) {
    const failure = error as Failure;
    assert.equal(failure.status, 1);
    assert.match(String(failure.stderr), /run this as root/);
  }
});

// Both steps below only ever run on a Debian box, as root, inside another user's home,
// so each is exercised on its own: the passwd entry and the privilege drop are stubbed,
// and what the function does with them is the assertion. The stubbed runuser records
// its whole command line and then runs it — under the test's own uid, which is exactly
// the privilege the real call drops to.
function bashFunction(name: string): string {
  const source = readFileSync(BOOTSTRAP, "utf8");
  const body = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(
    source,
  )?.[0];
  assert.ok(body, `${name} is gone from bootstrap.sh`);
  return body;
}

type Stubs = {
  readonly home: string;
  readonly runLog: string;
  readonly rootLog: string;
  readonly times?: number;
  readonly extra?: readonly string[];
  readonly pubkey?: string;
};

function runBootstrapStep(step: string, stubs: Stubs): string {
  const { home, runLog, rootLog, times = 1, extra = [], pubkey = "" } = stubs;
  const prelude = [
    "set -Eeuo pipefail",
    'ok() { printf "ok: %s\\n" "$*"; }',
    'warn() { printf "warn: %s\\n" "$*"; }',
    "LOG_FILE=/dev/null",
    "TARGET_USER=iva",
    `PUBKEY=${JSON.stringify(pubkey)}`,
    `getent() { printf 'iva:x:1000:1000::%s:/bin/bash\\n' "${home}"; }`,
    // Everything that would carry root's privilege into the user's home is logged:
    // a direct mkdir, a chown, an id lookup for a group to chown to, or a tee.
    // `command` on purpose: the payload has to reach the real binary, not the stubs
    // below, which exist only to catch what root ran with its own hands.
    `runuser() { printf 'runuser %s\\n' "$*" >>"${runLog}"; shift 3; command "$@"; }`,
    `mkdir() { printf 'root-mkdir %s\\n' "$*" >>"${rootLog}"; command mkdir "$@"; }`,
    `chown() { printf 'root-chown %s\\n' "$*" >>"${rootLog}"; }`,
    `chmod() { printf 'root-chmod %s\\n' "$*" >>"${rootLog}"; command chmod "$@"; }`,
    `tee() { printf 'root-tee %s\\n' "$*" >>"${rootLog}"; command tee "$@"; }`,
    `id() { printf 'root-id %s\\n' "$*" >>"${rootLog}"; printf 'ivagroup\\n'; }`,
    ...extra,
  ].join("\n");
  const calls = Array.from({ length: times }, () => step).join("\n");
  return execFileSync(
    "bash",
    [
      "-c",
      `${prelude}\n${bashFunction("as_target_user")}\n${bashFunction(step)}\n${calls}`,
    ],
    { encoding: "utf8" },
  );
}

/**
 * A stand-in for util-linux `su` that parses its arguments the way the real one does:
 * its getopt has no leading `+`, so options are PERMUTED out of whatever follows the
 * user name until a `--` stops the scan. That is the whole behaviour under test — a
 * stub that merely echoed its arguments would agree with any spelling, including the
 * one that silently drops `mkdir -p` and aborts on `tee -a`.
 *
 * optstring: c:fg:G:lmpPTs:u:hVw: — note `-p` (--preserve-environment) among the flags
 * and `-c`/`-s` among the ones taking a value. The payload it finally runs is logged,
 * so a test can assert what actually survived the parse.
 */
function fakeSu(log: string): string {
  return [
    "su() {",
    "  local rest=() ended=0 cmd=''",
    "  while [ $# -gt 0 ]; do",
    '    if [ $ended = 1 ]; then rest+=("$1"); shift; continue; fi',
    "    case $1 in",
    "      --) ended=1; shift ;;",
    "      -c) cmd=$2; shift 2 ;;",
    "      -s|-g|-G|-u|-w) shift 2 ;;",
    "      -f|-l|-m|-p|-P|-T|-h|-V|-) shift ;;",
    `      -*) printf 'su: invalid option -- %s\\n' "\${1#-}" >&2; return 1 ;;`,
    '      *) rest+=("$1"); shift ;;',
    "    esac",
    "  done",
    '  [ ${#rest[@]} -gt 1 ] || { printf "su: no command\\n" >&2; return 1; }',
    // rest[0] is the user; everything after it is what the real su would hand to the
    // shell as $0, $1 … — which is exactly what gets logged and then run.
    `  printf 'payload: %s\\n' "\${rest[*]:1}" >>"${log}"`,
    '  sh -c "$cmd" "${rest[@]:1}"',
    "}",
  ].join("\n");
}

function runEnsureLocalBin(stubs: Stubs): string {
  return runBootstrapStep("ensure_local_bin", stubs);
}

function runInstallPubkey(stubs: Stubs): string {
  return runBootstrapStep("install_pubkey", stubs);
}

void test("ensure_local_bin creates ~/.local/bin as the user, never as root", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-localbin-"));
  try {
    const home = join(fixture, "home", "iva");
    const runLog = join(fixture, "runuser.log");
    const rootLog = join(fixture, "root.log");
    mkdirSync(home, { recursive: true });
    const output = runEnsureLocalBin({ home, runLog, rootLog });

    assert.ok(statSync(join(home, ".local", "bin")).isDirectory());
    assert.match(output, /ok: ~\/\.local\/bin ready/);
    // The whole command line, so a privilege drop that names the wrong user shows up.
    assert.equal(
      readFileSync(runLog, "utf8"),
      `runuser -u iva -- mkdir -p ${join(home, ".local", "bin")}\n`,
    );
    // Nothing ran with root's own hands: no mkdir, no chown, not even a group lookup.
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("ensure_local_bin refuses to follow a ~/.local symlink out of the home", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-localbin-link-"));
  try {
    // The privilege-escalation shape: an existing account may already have ~/.local
    // pointing at a directory it cannot write. Root following that link would create
    // a directory inside somebody else's tree and hand it over; the user's own uid
    // simply cannot, and 0500 here is what "somebody else's tree" means to it.
    const home = join(fixture, "home", "iva");
    const foreign = join(fixture, "foreign");
    mkdirSync(home, { recursive: true });
    mkdirSync(foreign);
    symlinkSync(foreign, join(home, ".local"));
    chmodSync(foreign, 0o500);
    const runLog = join(fixture, "runuser.log");
    const rootLog = join(fixture, "root.log");
    const output = runEnsureLocalBin({ home, runLog, rootLog });

    assert.deepEqual(readdirSync(foreign), []);
    assert.match(output, /warn: couldn't create/);
    assert.doesNotMatch(output, /ok: /);
    // Refused while wearing the user's uid, which is the guarantee under test.
    assert.match(readFileSync(runLog, "utf8"), /^runuser -u iva -- mkdir -p /);
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
  } finally {
    chmodSync(join(fixture, "foreign"), 0o700);
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("ensure_local_bin drops privileges with su where runuser is missing", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-localbin-su-"));
  try {
    // runuser ships with util-linux, so the fallback is the unusual box — and the one
    // nobody would notice was broken. PATH without /usr/sbin plus the stub removed is
    // what "no runuser here" looks like from inside the function.
    const home = join(fixture, "home", "iva");
    const suLog = join(fixture, "su.log");
    const rootLog = join(fixture, "root.log");
    mkdirSync(home, { recursive: true });
    const output = runEnsureLocalBin({
      home,
      runLog: join(fixture, "runuser.log"),
      rootLog,
      extra: ["unset -f runuser", "PATH=/usr/bin:/bin", fakeSu(suLog)],
    });

    // The effect, not the command line: `.local` does not exist beforehand, so the
    // directory tree can only appear if mkdir kept its -p through su's option
    // parsing. An echo stub would have passed either way.
    assert.ok(statSync(join(home, ".local", "bin")).isDirectory());
    assert.match(output, /ok: ~\/\.local\/bin ready/);
    assert.equal(
      readFileSync(suLog, "utf8"),
      `payload: mkdir -p ${join(home, ".local", "bin")}\n`,
    );
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("ensure_local_bin is idempotent: bootstrap.sh is documented as re-runnable", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-localbin-again-"));
  try {
    const home = join(fixture, "home", "iva");
    mkdirSync(home, { recursive: true });
    const output = runEnsureLocalBin({
      home,
      runLog: join(fixture, "runuser.log"),
      rootLog: join(fixture, "root.log"),
      times: 3,
    });

    assert.equal(output.match(/ok: ~\/\.local\/bin ready/g)?.length, 3);
    assert.doesNotMatch(output, /warn:/);
    assert.deepEqual(readdirSync(join(home, ".local")), ["bin"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("ensure_local_bin does not invent a home directory that passwd only promises", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-localbin-nohome-"));
  try {
    // A home root created by this script, at root's umask, is a home the user cannot
    // write — an install that then fails on a box reported as ready.
    const home = join(fixture, "home", "iva");
    const runLog = join(fixture, "runuser.log");
    const rootLog = join(fixture, "root.log");
    const output = runEnsureLocalBin({ home, runLog, rootLog });

    assert.match(output, /warn: no home directory for iva/);
    assert.throws(() => readFileSync(runLog), { code: "ENOENT" });
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
    assert.throws(() => statSync(home), { code: "ENOENT" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("ensure_local_bin survives a passwd lookup that fails under pipefail", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-localbin-passwd-"));
  try {
    // getent exits non-zero for an unknown user, and the whole script runs under
    // `set -o pipefail` with an ERR trap: a bare pipeline here would kill the
    // bootstrap on the spot instead of reaching the check below it.
    const runLog = join(fixture, "runuser.log");
    const rootLog = join(fixture, "root.log");
    const output = runEnsureLocalBin({
      home: join(fixture, "unused"),
      runLog,
      rootLog,
      extra: ["getent() { return 2; }"],
    });

    assert.match(output, /warn: no home directory for iva/);
    assert.throws(() => readFileSync(runLog), { code: "ENOENT" });
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI+test iva@example";

void test("install_pubkey authorizes the key as the user, never as root", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-pubkey-"));
  try {
    const home = join(fixture, "home", "iva");
    const runLog = join(fixture, "runuser.log");
    const rootLog = join(fixture, "root.log");
    mkdirSync(home, { recursive: true });
    const output = runInstallPubkey({ home, runLog, rootLog, pubkey: KEY });

    assert.equal(
      readFileSync(join(home, ".ssh", "authorized_keys"), "utf8"),
      `${KEY}\n`,
    );
    assert.match(output, /ok: Key authorized for iva/);
    // Every step went through the privilege drop: the directory, its mode, the write
    // of the key itself, and the mode of the file.
    const dropped = readFileSync(runLog, "utf8");
    assert.match(dropped, /^runuser -u iva -- mkdir -p .*\.ssh$/m);
    assert.match(dropped, /^runuser -u iva -- chmod 700 .*\.ssh$/m);
    assert.match(dropped, /^runuser -u iva -- tee -a .*authorized_keys$/m);
    assert.match(dropped, /^runuser -u iva -- chmod 600 .*authorized_keys$/m);
    // Root itself touched nothing in the home — no mkdir, chmod, tee, chown or group
    // lookup of its own.
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
    assert.equal(statSync(join(home, ".ssh")).mode & 0o777, 0o700);
    assert.equal(
      statSync(join(home, ".ssh", "authorized_keys")).mode & 0o777,
      0o600,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("install_pubkey refuses to follow a ~/.ssh symlink into somebody else's tree", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-pubkey-link-"));
  const foreign = join(fixture, "foreign");
  try {
    // The escalation shape for an existing account: ~/.ssh already points into a tree
    // the user cannot write. Root would create the directory there and write the key
    // through the link; the user's own uid cannot get past the first step.
    //
    // The link points at a path that does not exist yet inside the locked directory,
    // which is where the real boundary sits. Pointing it at a directory the fixture
    // itself owns would prove nothing: the user may chmod what they own, so the mode
    // would come off and the write would succeed — as it also would for root, and as
    // it would NOT for the /etc case this stands in for.
    const home = join(fixture, "home", "iva");
    mkdirSync(home, { recursive: true });
    mkdirSync(foreign);
    symlinkSync(join(foreign, "ssh"), join(home, ".ssh"));
    chmodSync(foreign, 0o500);
    const runLog = join(fixture, "runuser.log");
    const rootLog = join(fixture, "root.log");
    const output = runInstallPubkey({ home, runLog, rootLog, pubkey: KEY });

    assert.deepEqual(readdirSync(foreign), []);
    assert.match(output, /warn: couldn't create .*\.ssh as iva/);
    assert.doesNotMatch(output, /ok: Key authorized/);
    // Refused while wearing the user's uid, and root wrote nothing of its own.
    assert.match(readFileSync(runLog, "utf8"), /^runuser -u iva -- mkdir -p /);
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
  } finally {
    chmodSync(foreign, 0o700);
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("install_pubkey adds the key once, however often bootstrap.sh is re-run", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-pubkey-again-"));
  try {
    const home = join(fixture, "home", "iva");
    mkdirSync(home, { recursive: true });
    const output = runInstallPubkey({
      home,
      runLog: join(fixture, "runuser.log"),
      rootLog: join(fixture, "root.log"),
      times: 3,
      pubkey: KEY,
    });

    assert.equal(
      readFileSync(join(home, ".ssh", "authorized_keys"), "utf8"),
      `${KEY}\n`,
    );
    assert.equal(output.match(/ok: Key already authorized/g)?.length, 2);
    assert.doesNotMatch(output, /warn:/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("install_pubkey authorizes the key through su where runuser is missing", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-pubkey-su-"));
  try {
    // The other half of the option-permutation damage, and the expensive one: su eats
    // no flag here, it ABORTS on `tee -a` and `grep -qxF` as invalid options. A box
    // without runuser would then finish "successfully" with no key installed — and
    // with IVA_DISABLE_PASSWORD_AUTH the owner is locked out of the server.
    const home = join(fixture, "home", "iva");
    const suLog = join(fixture, "su.log");
    const rootLog = join(fixture, "root.log");
    mkdirSync(home, { recursive: true });
    const output = runInstallPubkey({
      home,
      runLog: join(fixture, "runuser.log"),
      rootLog,
      pubkey: KEY,
      extra: ["unset -f runuser", "PATH=/usr/bin:/bin", fakeSu(suLog)],
    });

    assert.equal(
      readFileSync(join(home, ".ssh", "authorized_keys"), "utf8"),
      `${KEY}\n`,
    );
    assert.match(output, /ok: Key authorized for iva/);
    assert.doesNotMatch(output, /warn:/);
    // Each payload reached the far side with its flags intact.
    const payloads = readFileSync(suLog, "utf8");
    assert.match(payloads, /^payload: mkdir -p .*\.ssh$/m);
    assert.match(payloads, /^payload: chmod 700 .*\.ssh$/m);
    assert.match(payloads, /^payload: tee -a .*authorized_keys$/m);
    assert.match(payloads, /^payload: chmod 600 .*authorized_keys$/m);
    assert.throws(() => readFileSync(rootLog), { code: "ENOENT" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("install_pubkey does not invent a home directory to authorize into", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-pubkey-nohome-"));
  try {
    const home = join(fixture, "home", "iva");
    const runLog = join(fixture, "runuser.log");
    const output = runInstallPubkey({
      home,
      runLog,
      rootLog: join(fixture, "root.log"),
      pubkey: KEY,
      // Same pipefail trap as ensure_local_bin: a bare `getent | cut` would take the
      // ERR trap and the whole bootstrap with it.
      extra: ["getent() { return 2; }"],
    });

    assert.match(output, /warn: no home directory for iva/);
    assert.throws(() => readFileSync(runLog), { code: "ENOENT" });
    assert.throws(() => statSync(home), { code: "ENOENT" });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("install_pubkey stays silent with no key to authorize", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-pubkey-none-"));
  try {
    const home = join(fixture, "home", "iva");
    const runLog = join(fixture, "runuser.log");
    mkdirSync(home, { recursive: true });
    const output = runInstallPubkey({
      home,
      runLog,
      rootLog: join(fixture, "root.log"),
    });

    assert.equal(output, "");
    assert.throws(() => readFileSync(runLog), { code: "ENOENT" });
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// The lockout class: install_pubkey and harden_ssh are exercised back to back, exactly
// as main() runs them. DISABLE_PASSWORD_AUTH arrives true (the ask_pubkey default when a
// key is provided); the question is whether harden_ssh keeps it true. SSHD_MAIN_CONFIG
// points at nothing, so harden_ssh runs its password-switch decision and then returns at
// the missing-config guard — the drop-in is never written, and DISABLE_PASSWORD_AUTH is
// left holding the verdict for the test to read.
function runLockout(opts: {
  readonly home: string;
  readonly runLog: string;
  readonly rootLog: string;
  readonly pubkey?: string;
  readonly extra?: readonly string[];
}): string {
  const { home, runLog, rootLog, pubkey = KEY, extra = [] } = opts;
  const prelude = [
    "set -Eeuo pipefail",
    'ok() { printf "ok: %s\\n" "$*"; }',
    'warn() { printf "warn: %s\\n" "$*"; }',
    "section() { :; }",
    "LOG_FILE=/dev/null",
    "TARGET_USER=iva",
    "SSHD_MAIN_CONFIG=/nonexistent/sshd_config",
    // The intent handed down from ask_pubkey: a key was provided, so turn passwords off.
    "DISABLE_PASSWORD_AUTH=true",
    "KEY_AUTHORIZED=false",
    `PUBKEY=${JSON.stringify(pubkey)}`,
    `getent() { printf 'iva:x:1000:1000::%s:/bin/bash\\n' "${home}"; }`,
    `runuser() { printf 'runuser %s\\n' "$*" >>"${runLog}"; shift 3; command "$@"; }`,
    `mkdir() { printf 'root-mkdir %s\\n' "$*" >>"${rootLog}"; command mkdir "$@"; }`,
    `chmod() { printf 'root-chmod %s\\n' "$*" >>"${rootLog}"; command chmod "$@"; }`,
    `tee() { printf 'root-tee %s\\n' "$*" >>"${rootLog}"; command tee "$@"; }`,
    ...extra,
  ].join("\n");
  const body = [
    bashFunction("as_target_user"),
    bashFunction("install_pubkey"),
    bashFunction("harden_ssh"),
    "install_pubkey",
    "harden_ssh",
    'printf "state: DISABLE_PASSWORD_AUTH=%s KEY_AUTHORIZED=%s\\n" "$DISABLE_PASSWORD_AUTH" "$KEY_AUTHORIZED"',
  ].join("\n");
  return execFileSync("bash", ["-c", `${prelude}\n${body}`], {
    encoding: "utf8",
  });
}

void test("harden_ssh keeps passwords ON when the key never landed — no lockout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-lockout-nokey-"));
  try {
    const home = join(fixture, "home", "iva");
    mkdirSync(home, { recursive: true });
    // The key cannot be authorized: getent hands back no home, so install_pubkey warns
    // and leaves KEY_AUTHORIZED false. The intent said "disable passwords"; the fact
    // says the owner has no key waiting, so passwords must stay on.
    const output = runLockout({
      home,
      runLog: join(fixture, "runuser.log"),
      rootLog: join(fixture, "root.log"),
      extra: ["getent() { return 2; }"],
    });

    assert.match(output, /warn: no home directory for iva/);
    assert.match(output, /leaving password logins ON/);
    assert.match(
      output,
      /state: DISABLE_PASSWORD_AUTH=false KEY_AUTHORIZED=false/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("harden_ssh disables passwords once the key is really authorized, fixing bad perms", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-lockout-fix-"));
  try {
    const home = join(fixture, "home", "iva");
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    // A world-writable authorized_keys with unrelated content: sshd StrictModes would
    // reject 0666, so the perms must be fixed before the key is trusted.
    const keys = join(sshDir, "authorized_keys");
    writeFileSync(keys, "ssh-rsa AAAAOTHER other@host\n");
    chmodSync(keys, 0o666);
    const output = runLockout({
      home,
      runLog: join(fixture, "runuser.log"),
      rootLog: join(fixture, "root.log"),
    });

    assert.match(output, /ok: Key authorized for iva/);
    assert.doesNotMatch(output, /leaving password logins ON/);
    assert.match(
      output,
      /state: DISABLE_PASSWORD_AUTH=true KEY_AUTHORIZED=true/,
    );
    assert.equal(statSync(keys).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(keys, "utf8"),
      `ssh-rsa AAAAOTHER other@host\n${KEY}\n`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("harden_ssh trusts an already-authorized key only after locking its 0666 file to 0600", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-lockout-already-"));
  try {
    const home = join(fixture, "home", "iva");
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    // The key is ALREADY present, but the file is world-writable. The "already
    // authorized" path must still tighten it to 0600 before it may report success —
    // otherwise sshd rejects the file and passwords would be off with no way in.
    const keys = join(sshDir, "authorized_keys");
    writeFileSync(keys, `${KEY}\n`);
    chmodSync(keys, 0o666);
    const output = runLockout({
      home,
      runLog: join(fixture, "runuser.log"),
      rootLog: join(fixture, "root.log"),
    });

    assert.match(output, /ok: Key already authorized for iva/);
    assert.doesNotMatch(output, /leaving password logins ON/);
    assert.match(
      output,
      /state: DISABLE_PASSWORD_AUTH=true KEY_AUTHORIZED=true/,
    );
    assert.equal(statSync(keys).mode & 0o777, 0o600);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("create_user runs ensure_local_bin: a step nobody calls fixes nothing", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-bootstrap-createuser-"));
  try {
    // Run, not grepped: a call spelled in a branch that never executes reads the same
    // in the source and does nothing on the box.
    const output = runBootstrapStep("create_user", {
      home: join(fixture, "home", "iva"),
      runLog: join(fixture, "runuser.log"),
      rootLog: join(fixture, "root.log"),
      extra: [
        "CREATE_USER=false",
        "section() { :; }",
        `id() { printf 'iva sudo\\n'; }`,
        "ensure_local_bin() { printf 'step: ensure_local_bin\\n'; }",
        "enable_linger() { printf 'step: enable_linger\\n'; }",
      ],
    });

    assert.match(output, /^step: ensure_local_bin$/m);
    // Ordered before linger, so the home is ready by the time the services are.
    assert.ok(
      output.indexOf("step: ensure_local_bin") <
        output.indexOf("step: enable_linger"),
      `ensure_local_bin ran after enable_linger:\n${output}`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
