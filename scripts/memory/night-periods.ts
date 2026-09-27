import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { weekOfDay } from "#lib/vault-links.ts";
import { commitVaultWrite } from "#lib/vault-commit.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { parseFrontmatterOrSkip } from "#lib/frontmatter.ts";
import { canonicalHash, srcList, summaryText } from "./night-input.ts";
import { callBySchema, NightSchemaError } from "./night-call.ts";

// Неделя, месяц (календарный), год: один вызов на период, когда он кончился и готов
// каждый ребёнок. Ответ не по форме — выжимка из description детей (mode: fallback).

type Period = "weekly" | "monthly" | "yearly";
type Child = { id: string; path?: string };
const periodAnswer = z.object({
  gist: z.string().default(""),
  topics: z.array(z.string()).default([]),
  points: z
    .array(z.object({ text: z.string().min(1), src: srcList }))
    .default([]),
});

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pad = (value: number) => String(value).padStart(2, "0");

/** Дни ребёнка: неделя `YYYY-Www`, месяц `YYYY-MM` или сам день. */
function daysOf(id: string): string[] {
  const week = /^(\d{4})-W(\d{2})$/u.exec(id);
  if (week) {
    const jan4 = Date.UTC(Number(week[1]), 0, 4);
    const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
    const start = monday + (Number(week[2]) - 1) * 7 * DAY_MS;
    return Array.from({ length: 7 }, (_, index) => iso(start + index * DAY_MS));
  }
  if (id.length !== 7) return [id];
  const [year, month] = id.split("-").map(Number);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${id}-${pad(index + 1)}`);
}

/** Дети периода: дни недели; недели, целиком лежащие в месяце, и краевые дни; месяцы. */
export function periodChildIds(period: Period, id: string): string[] {
  if (period === "weekly") return daysOf(id);
  if (period === "yearly")
    return Array.from({ length: 12 }, (_, i) => `${id}-${pad(i + 1)}`);
  const weeks = new Map<string, string[]>();
  for (const day of daysOf(id))
    weeks.set(weekOfDay(day)!, [...(weeks.get(weekOfDay(day)!) ?? []), day]);
  return [...weeks].flatMap(([week, days]) =>
    days.length === 7 ? [week] : days,
  );
}

/** Готовые дети или null. Ребёнок без файла и без единого сырого дня — «нет данных». */
export function periodChildren(
  vault: string,
  period: Period,
  id: string,
): Child[] | null {
  const children: Child[] = [];
  for (const child of periodChildIds(period, id)) {
    const path = child.includes("W")
      ? `weekly/${child}`
      : child.length === 7
        ? `monthly/${child}`
        : `summaries/daily/${child}`;
    const raw = daysOf(child).some((day) =>
      existsSync(join(vault, "daily", `${day}.md`)),
    );
    if (existsSync(join(vault, `${path}.md`)))
      children.push({ id: child, path });
    else if (raw) return null;
    else children.push({ id: child });
  }
  return children.some((child) => child.path) ? children : null;
}

function summaryOf(vault: string, child: Child): string {
  const file = join(vault, `${child.path}.md`);
  const fields = child.path
    ? parseFrontmatterOrSkip(readFileSync(file, "utf8"), file)?.fields
    : null;
  return typeof fields?.description === "string" ? fields.description : "";
}

type Ask = { skill: string; model: string; signal: AbortSignal };

async function buildPeriod(
  vault: string,
  period: Period,
  id: string,
  ask: Ask,
) {
  const file = join(vault, period, `${id}.md`);
  const children = existsSync(file) ? null : periodChildren(vault, period, id);
  if (!children) return null;
  const values = children.map((child) => ({
    id: child.id,
    missing: !child.path,
    summary: summaryOf(vault, child),
  }));
  let answer: z.infer<typeof periodAnswer>;
  let fallback = false;
  try {
    const input = { period, id, children: values };
    answer = await callBySchema({
      skill: ask.skill,
      input,
      schema: periodAnswer,
      signal: ask.signal,
    });
  } catch (error) {
    if (!(error instanceof NightSchemaError)) throw error;
    fallback = true;
    const text = (value: (typeof values)[number]) =>
      value.summary || `Нет данных за ${value.id}`;
    answer = {
      gist: "",
      topics: [],
      points: values.map((value) => ({ text: text(value), src: [value.id] })),
    };
  }
  const paths = new Map(children.map((child) => [child.id, child.path]));
  const points = answer.points.map((point) => {
    const links = point.src.flatMap((src) =>
      paths.get(src) ? [`[[${paths.get(src)}]]`] : [],
    );
    return `- ${point.text}${links.length ? ` · ${links.join(", ")}` : ""}`;
  });
  const down = children.map((child) =>
    child.path ? `- [[${child.path}]]` : `- нет данных за ${child.id}`,
  );
  const body = [
    `# ${id}`,
    "",
    ...points,
    "",
    "## Период",
    "",
    ...down,
    "",
  ].join("\n");
  const fields = {
    type: `${period}-summary`,
    period: id,
    description: answer.gist || id,
    topics: answer.topics,
    tags: answer.topics.length ? answer.topics : [period],
    source: "night",
    input_hash: canonicalHash({
      v: 1,
      step: period,
      model: ask.model,
      inputs: values,
    }),
    ...(fallback ? { mode: "fallback" } : {}),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomicSync(file, summaryText(fields, body));
  if (!(await commitVaultWrite(`${period} ${id}: night`, [file], vault)).ok)
    throw new Error(`${period} ${id} не закоммичен`);
  return fallback ? `${period}/${id}` : "";
}

/** Прошлые неделя, месяц и год, если готовы; сбой периода не роняет ночь, а идёт
 * строкой в факт Job. Возвращает периоды, собранные без модели. */
export async function buildReadyPeriods(
  vault: string,
  today: string,
  ask: Ask,
  jobs: string[],
): Promise<string[]> {
  const yesterday = Date.parse(`${today}T00:00:00Z`) - DAY_MS;
  const lastSunday = iso(yesterday - new Date(yesterday).getUTCDay() * DAY_MS);
  const lastMonth = iso(
    Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - DAY_MS,
  ).slice(0, 7);
  const fallbacks: string[] = [];
  const periods: Array<[Period, string]> = [
    ["weekly", weekOfDay(lastSunday)!],
    ["monthly", lastMonth],
    ["yearly", String(Number(today.slice(0, 4)) - 1)],
  ];
  for (const [period, id] of periods)
    try {
      const made = await buildPeriod(vault, period, id, ask);
      if (made) fallbacks.push(made);
    } catch (error) {
      jobs.push(`${period} ${id} не собран: ${String(error)}`);
    }
  return fallbacks;
}
