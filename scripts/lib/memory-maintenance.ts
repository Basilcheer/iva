import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { resolve, sep } from "node:path";
import { hasUnclosedFence, splitCard } from "./card-text.ts";

// Keep headroom below GitHub's hard 100 MB blob limit so the nightly backup
// cannot create history that the remote will reject.
export const GITHUB_BLOB_GUARD_BYTES = 90 * 1024 * 1024;
export const MEMORY_REPORT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

interface GitCommandResult {
  status?: number | null;
  code?: number | null;
  stdout?: string;
  stderr?: string;
}

type FileInfo = Pick<Stats, "isFile" | "isSymbolicLink" | "size">;

export interface OversizeWorkingTreeFile {
  path: string;
  size: number;
}

interface OversizeScanOptions {
  vaultPath: string;
  runGit: (args: string[]) => GitCommandResult;
  stat?: (path: string) => FileInfo;
  limitBytes?: number;
}

type MemoryProblemKey = "fixed" | "review" | "duplicates" | "skipped_oversize";

export interface MemoryReportProblem {
  key: MemoryProblemKey;
  count: number;
}

export type MemoryMaintenanceReportResult =
  | { status: "missing" | "stale" | "invalid"; problems: [] }
  | { status: "fresh"; problems: MemoryReportProblem[] };

function commandStatus(result: GitCommandResult | null | undefined): number {
  return result?.status ?? result?.code ?? 1;
}

function firstNonEmptyLine(text: string | null | undefined): string {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function scanOversizeWorkingTreeFiles({
  vaultPath,
  runGit,
  stat = lstatSync,
  limitBytes = GITHUB_BLOB_GUARD_BYTES,
}: OversizeScanOptions): OversizeWorkingTreeFile[] {
  const listed = runGit([
    "ls-files",
    "--others",
    "--modified",
    "--exclude-standard",
    "-z",
  ]);
  if (commandStatus(listed) !== 0) {
    const detail = firstNonEmptyLine(listed?.stderr);
    throw new Error(`git ls-files failed${detail ? `: ${detail}` : ""}`);
  }

  const paths = [
    ...new Set(
      String(listed.stdout ?? "")
        .split("\0")
        .filter(Boolean),
    ),
  ];
  const oversized: OversizeWorkingTreeFile[] = [];
  for (const path of paths) {
    let info;
    try {
      info = stat(resolve(vaultPath, path));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue; // deleted between git listing and stat
      throw error;
    }
    // lstat measures the blob stored for a symlink, not the file it points outside the vault to.
    if (!info.isFile() && !info.isSymbolicLink()) continue;
    if (info.size > limitBytes) oversized.push({ path, size: info.size });
  }
  return oversized;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function classifyGitPushError(stderr: string): {
  kind: "oversize" | "auth" | "other";
  firstLine: string;
} {
  const text = String(stderr ?? "");
  const firstLine = firstNonEmptyLine(text) || "unknown git error";
  if (/GH001|exceeds\s+GitHub(?:\.com)?['’]s\s+file size limit/i.test(text)) {
    return { kind: "oversize", firstLine };
  }
  if (
    /Authentication failed|could not read (?:Username|Password)|Permission denied/i.test(
      text,
    )
  ) {
    return { kind: "auth", firstLine };
  }
  return { kind: "other", firstLine };
}

export function memoryReportProblems(report: unknown): MemoryReportProblem[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  const fields = report as Record<string, unknown>;
  const keys: readonly MemoryProblemKey[] = [
    "fixed",
    "review",
    "duplicates",
    "skipped_oversize",
  ];
  return keys.flatMap((key) => {
    const count = fields[key];
    return typeof count === "number" && Number.isFinite(count) && count !== 0
      ? [{ key, count }]
      : [];
  });
}

export function readMemoryMaintenanceReport(
  reportPath: string,
  {
    now = Date.now(),
    maxAgeMs = MEMORY_REPORT_MAX_AGE_MS,
  }: {
    now?: number;
    maxAgeMs?: number;
  } = {},
): MemoryMaintenanceReportResult {
  if (!existsSync(reportPath)) return { status: "missing", problems: [] };
  try {
    const ageMs = now - statSync(reportPath).mtimeMs;
    if (ageMs >= maxAgeMs) return { status: "stale", problems: [] };
    const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      return { status: "invalid", problems: [] };
    }
    return { status: "fresh", problems: memoryReportProblems(report) };
  } catch {
    return { status: "invalid", problems: [] };
  }
}

export function recordSkippedOversize(
  reportPath: string,
  count: number,
): boolean {
  if (!existsSync(reportPath)) return false;
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return false;
  }
  if (!report || typeof report !== "object" || Array.isArray(report))
    return false;
  const fields = report as Record<string, unknown>;

  const tmp = `${reportPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(
      tmp,
      `${JSON.stringify({ ...fields, skipped_oversize: count }, null, 2)}\n`,
      "utf8",
    );
    chmodSync(tmp, statSync(reportPath).mode & 0o777);
    renameSync(tmp, reportPath);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort: preserve the report update failure */
    }
    return false;
  }
}

/**
 * Карточки с незакрытым кодовым фенсом: их ## History и ## Log читаются как код, поэтому
 * write_card отказывает такой карточке в UPDATE и SUPERSEDE. Только перечисление - чинит
 * фенс человек: догадаться, где автор хотел закрыть блок, машине нечем, а закрыть его
 * наугад значит переписать чужой текст.
 */
export function scanUnclosedFenceCards(vaultPath: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(vaultPath, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort()) {
    const path = entry.split(sep).join("/");
    // Служебные каталоги (.git, .graph, .obsidian) - не карточки пользователя.
    if (!path.endsWith(".md") || path.split("/").some((p) => p.startsWith(".")))
      continue;
    let text: string;
    try {
      text = readFileSync(resolve(vaultPath, entry), "utf8");
    } catch {
      continue; // исчез между листингом и чтением - следующий ночной прогон увидит
    }
    if (hasUnclosedFence(splitCard(text).body)) found.push(path);
  }
  return found;
}
