// Разметка текста карточки: где кончается frontmatter и где кодовые фенсы. Модуль без
// зависимостей, канонический дом — authored tree: его тянут frontmatter и card-store,
// то есть сам контракт write_card. Ночной doctor читает его же через #lib/ (сканер
// карточек живёт в scripts/memory/card-fences.ts); CLI-дерево к нему не обращается.

/** Границы frontmatter: группа 1 - его строки, группа 2 - тело карточки. */
const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface CardText {
  /** null — frontmatter отсутствует (тогда body === весь текст). */
  frontmatter: string | null;
  body: string;
}

/** Frontmatter отдельно, тело отдельно; переводы строк нормализуются к \n. */
export function splitCard(content: string): CardText {
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = FRONTMATTER_BLOCK.exec(text);
  return match
    ? { frontmatter: match[1], body: match[2] }
    : { frontmatter: null, body: text };
}

interface FenceScan {
  /** Для каждой строки: лежит ли она ВНЕ кодового фенса. */
  outside: boolean[];
  /** Фенс остался открытым до конца текста. */
  open: boolean;
}

export function scanFences(lines: string[]): FenceScan {
  const outside = Array(lines.length).fill(true) as boolean[];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      outside[index] = false;
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (
        close &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.length
      )
        fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) continue;
    outside[index] = false;
    fence = { marker: open[1][0] as "`" | "~", length: open[1].length };
  }
  return { outside, open: fence !== null };
}

export function outsideFences(lines: string[]): boolean[] {
  return scanFences(lines).outside;
}

/** Незакрытый фенс уводит остаток документа в код — заголовков за ним уже не видно. */
export function hasUnclosedFence(body: string): boolean {
  return scanFences(body.split("\n")).open;
}
