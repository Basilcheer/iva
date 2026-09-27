import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../lib/data-dir.ts";
import { alertOnce } from "../lib/notice-policy.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { vaultDirOrExit } from "../lib/vault-boundary.ts";

const vault = vaultDirOrExit();
const dataDir = resolveDataDir(process.cwd());

/** Агентское дерево — динамическим импортом: юнит грузится и на установке, где agent/
 * нет или он переписан наполовину (scripts/authored-tree-guard.test.ts). */
async function authoredTree() {
  return {
    ...(await import("#lib/core-cap.ts")),
    ...(await import("#lib/vault-commit.ts")),
    ...(await import("../lib/telegram-send.ts")),
    ...(await import("./graph.ts")),
  };
}
let tree: Awaited<ReturnType<typeof authoredTree>>;

// Alert тем же швом, что у ночи и сторожа: Outbox, разметка, трасса.
async function send(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = notificationChat();
  const sent =
    token && chat ? await tree.sendTelegramHtml(token, chat, text) : null;
  if (!sent?.ok)
    console.error(`brain alert: ${text} (${sent?.error ?? "нет чата"})`);
  return sent?.ok ?? false;
}

async function commitOwnerChanges(): Promise<boolean> {
  const result = await tree.commitVaultSweep("brain: owner changes", vault);
  if (!result.ok)
    console.error(`brain: backup commit failed: ${result.reason ?? "unknown"}`);
  return result.ok;
}

async function refreshGraph(): Promise<boolean> {
  try {
    const graph = tree.writeVaultGraph(vault);
    const commit = await tree.commitVaultWrite(
      "brain: link graph",
      [graph],
      vault,
    );
    if (!commit.ok)
      console.error(
        `brain: graph commit failed: ${commit.reason ?? "unknown"}`,
      );
    return commit.ok;
  } catch (error) {
    console.error("brain: graph failed:", error);
    return false;
  }
}

async function alertCoreCap(): Promise<void> {
  const core = join(vault, "CORE.md");
  if (!existsSync(core)) return;
  const length = readFileSync(core, "utf8").length;
  if (length <= tree.CORE_CAP) return;
  await alertOnce(dataDir, "core-over-cap", String(length), () =>
    send(
      `CORE.md длиннее ${tree.CORE_CAP} знаков (${length}). Сократи его в vault; Brain не режет файл автоматически.`,
    ),
  );
}

const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: vault, encoding: "utf8" });

/** origin vault есть или создан: приватный iva-vault через уже авторизованный gh. */
function ensureRemote(): boolean {
  const origin = () => run("git", ["remote", "get-url", "origin"]).status === 0;
  if (origin()) return true;
  if (run("gh", ["auth", "status"]).status !== 0) return false;
  run("gh", ["auth", "setup-git"]);
  const create = ["repo", "create", "iva-vault", "--private", "--source"];
  if (run("gh", [...create, vault, "--remote", "origin", "--push"]).status) {
    // Репозиторий уже есть — origin на <login>/iva-vault.
    const login = run("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
    const url = `https://github.com/${login}/iva-vault.git`;
    if (login) run("git", ["remote", "add", "origin", url]);
  }
  return origin();
}

async function pushBackup(): Promise<boolean> {
  if (!ensureRemote()) {
    console.error("brain: no remote and gh unavailable — backup skipped");
    await alertOnce(dataDir, "vault-remote", "missing", () =>
      send(
        "Память не бэкапится: у vault нет git remote. Зайди на сервер и выполни: gh auth login (scope repo). Brain сам создаст приватный репозиторий iva-vault и включит бэкап.",
      ),
    );
    return false;
  }
  const push = run("git", ["push", "origin", "HEAD"]);
  if (push.status === 0) return true;
  const reason = (push.stderr || push.stdout || "git push failed").trim();
  console.error(`brain: backup push failed: ${reason}`);
  await alertOnce(dataDir, "brain-backup", reason, () =>
    send(
      "Бэкап vault не ушёл в git remote. Проверь `git -C vault push origin HEAD` и доступ к remote.",
    ),
  );
  return false;
}

async function main(): Promise<number> {
  if (!existsSync(vault)) {
    console.error(`brain: vault not found: ${vault}`);
    return 1;
  }
  try {
    tree = await authoredTree();
  } catch (error) {
    console.error(`brain: agent tree did not load: ${String(error)}`);
    return 1;
  }
  const ownerCommitted = await commitOwnerChanges();
  const graphRefreshed = await refreshGraph();
  await alertCoreCap();
  const pushed = await pushBackup();
  return ownerCommitted && graphRefreshed && pushed ? 0 : 1;
}

process.exitCode = await main();
