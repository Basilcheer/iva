import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_CAP } from "#lib/core-cap.ts";
import { commitVaultWrite, commitVaultSweep } from "#lib/vault-commit.ts";
import { resolveDataDir } from "../lib/data-dir.ts";
import { alertOnce } from "../lib/notice-policy.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import { vaultDirOrExit } from "../lib/vault-boundary.ts";
import { writeVaultGraph } from "./graph.ts";

const vault = vaultDirOrExit();
const dataDir = resolveDataDir(process.cwd());

// Alert тем же швом, что у ночи и сторожа: Outbox, разметка, трасса.
async function send(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = notificationChat();
  const sent = token && chat ? await sendTelegramHtml(token, chat, text) : null;
  if (!sent?.ok)
    console.error(`brain alert: ${text} (${sent?.error ?? "нет чата"})`);
  return sent?.ok ?? false;
}

async function commitOwnerChanges(): Promise<boolean> {
  const result = await commitVaultSweep("brain: owner changes", vault);
  if (!result.ok)
    console.error(`brain: backup commit failed: ${result.reason ?? "unknown"}`);
  return result.ok;
}

async function refreshGraph(): Promise<boolean> {
  try {
    const graph = writeVaultGraph(vault);
    const commit = await commitVaultWrite("brain: link graph", [graph], vault);
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
  if (length <= CORE_CAP) return;
  await alertOnce(dataDir, "core-over-cap", String(length), () =>
    send(
      `CORE.md длиннее ${CORE_CAP} знаков (${length}). Сократи его в vault; Brain не режет файл автоматически.`,
    ),
  );
}

async function pushBackup(): Promise<boolean> {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: vault,
    encoding: "utf8",
  });
  if (remote.status !== 0) return true;
  const push = spawnSync("git", ["push", "origin", "HEAD"], {
    cwd: vault,
    encoding: "utf8",
  });
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
  const ownerCommitted = await commitOwnerChanges();
  const graphRefreshed = await refreshGraph();
  await alertCoreCap();
  const pushed = await pushBackup();
  return ownerCommitted && graphRefreshed && pushed ? 0 : 1;
}

process.exitCode = await main();
