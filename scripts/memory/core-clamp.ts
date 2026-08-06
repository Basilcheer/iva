import { CORE_CAP } from "../lib/core-cap.ts";

type Section = "user" | "preferences" | "goals" | "pointers";

interface CoreLine {
  readonly content: string;
  readonly ending: string;
  section: Section | null;
  sectionId: number;
  heading: boolean;
  removed: boolean;
  replacement: string | null;
}

interface PreferenceCandidate {
  readonly line: CoreLine;
  readonly index: number;
  readonly date: string | null;
}

const SECTION_KIND = new Map<string, Section>([
  ["Пользователь", "user"],
  ["User", "user"],
  ["Предпочтения", "preferences"],
  ["Preferences", "preferences"],
  ["Активные цели (≤3)", "goals"],
  ["Active goals (≤3)", "goals"],
  // Existing vaults may have lost the hint while keeping the canonical section name.
  ["Активные цели", "goals"],
  ["Active goals", "goals"],
  ["Указатели", "pointers"],
  ["Pointers", "pointers"],
]);

function linesOf(text: string): CoreLine[] {
  const lines: CoreLine[] = [];
  let start = 0;

  while (start < text.length) {
    let contentEnd = start;
    while (
      contentEnd < text.length &&
      text[contentEnd] !== "\n" &&
      text[contentEnd] !== "\r"
    ) {
      contentEnd += 1;
    }

    let rawEnd = contentEnd;
    if (text[rawEnd] === "\r" && text[rawEnd + 1] === "\n") rawEnd += 2;
    else if (text[rawEnd] === "\r" || text[rawEnd] === "\n") rawEnd += 1;

    lines.push({
      content: text.slice(start, contentEnd),
      ending: text.slice(contentEnd, rawEnd),
      section: null,
      sectionId: -1,
      heading: false,
      removed: false,
      replacement: null,
    });
    start = rawEnd;
  }

  return lines;
}

function classifySections(lines: CoreLine[]): void {
  let section: Section | null = null;
  let sectionId = 0;

  for (const line of lines) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line.content);
    if (heading) {
      section = SECTION_KIND.get(heading[1]) ?? null;
      sectionId += 1;
      line.heading = true;
    }
    line.section = section;
    line.sectionId = sectionId;
  }
}

function isBullet(line: CoreLine): boolean {
  return !line.heading && /^-(?:[ \t]+|$)/.test(line.content);
}

function render(lines: readonly CoreLine[]): string {
  let out = "";
  for (const line of lines) {
    if (line.removed) continue;
    out += line.replacement ?? `${line.content}${line.ending}`;
  }
  return out;
}

function enforceGoalLimit(lines: CoreLine[]): void {
  const seen = new Map<number, number>();
  for (const line of lines) {
    if (line.section !== "goals" || !isBullet(line)) continue;
    const count = seen.get(line.sectionId) ?? 0;
    seen.set(line.sectionId, count + 1);
    if (count >= 3) line.removed = true;
  }
}

function preferenceEvictionOrder(
  lines: readonly CoreLine[],
): PreferenceCandidate[] {
  return lines
    .map((line, index) => {
      if (line.section !== "preferences" || !isBullet(line)) return null;
      const date =
        /^-[ \t]+(\d{4}-\d{2}(?:-\d{2})?)\b/.exec(line.content)?.[1] ?? null;
      return { line, index, date };
    })
    .filter((item): item is PreferenceCandidate => item !== null)
    .sort((a, b) => {
      if (a.date === null && b.date !== null) return -1;
      if (a.date !== null && b.date === null) return 1;
      if (a.date !== b.date) return (a.date ?? "") < (b.date ?? "") ? -1 : 1;
      return a.index - b.index;
    });
}

function longestMutableBullet(lines: readonly CoreLine[]): CoreLine | null {
  let longest: CoreLine | null = null;
  for (const line of lines) {
    if (
      line.removed ||
      !isBullet(line) ||
      line.section === null ||
      line.section === "pointers"
    ) {
      continue;
    }
    if (!longest || line.content.length > longest.content.length)
      longest = line;
  }
  return longest;
}

function truncateToCap(lines: CoreLine[]): string {
  const current = render(lines);
  const excess = current.length - CORE_CAP;
  if (excess <= 0) return current;

  const line = longestMutableBullet(lines);
  // Keep one ellipsis. If protected content alone makes the cap impossible, leave this
  // phase untouched so another clamp call cannot progressively eat additional bullets.
  if (!line || line.content.length - 1 < excess) return current;

  let prefixLength = line.content.length - excess - 1;
  // Do not leave an unpaired high surrogate when the cut crosses an emoji/code point.
  if (
    prefixLength > 0 &&
    /[\uD800-\uDBFF]/.test(line.content[prefixLength - 1]) &&
    /[\uDC00-\uDFFF]/.test(line.content[prefixLength])
  ) {
    prefixLength -= 1;
  }
  if (prefixLength < 2) {
    line.removed = true;
    return render(lines);
  }
  line.replacement = `${line.content.slice(0, prefixLength)}…${line.ending}`;
  return render(lines);
}

/**
 * Deterministically shrink CORE.md without ever cutting headings, pointers or unknown
 * sections. Files already within the cap are returned byte-for-byte unchanged.
 */
export function clampCore(text: string): string {
  if (typeof text !== "string")
    throw new TypeError("clampCore expects a string");
  if (text.length <= CORE_CAP) return text;

  const lines = linesOf(text);
  classifySections(lines);
  enforceGoalLimit(lines);

  let current = render(lines);
  if (current.length <= CORE_CAP) return current;

  for (const item of preferenceEvictionOrder(lines)) {
    item.line.removed = true;
    current = render(lines);
    if (current.length <= CORE_CAP) return current;
  }

  return truncateToCap(lines);
}
