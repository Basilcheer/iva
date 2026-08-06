// Формат data/telegram-offset.json: { offset, delivered }. offset — курсор getUpdates;
// delivered — update_id последнего апдейта, ДОСТАВЛЕННОГО в eve. Telegram отдаёт
// at-least-once: краш между доставкой и записью offset переигрывает апдейт на старте.
// Маркер delivered сужает окно двойной доставки до единственного апдейта «в полёте»:
// свежепереигранное (<= delivered, в пределах окна) пропускается — offset двигаем,
// в eve не шлём.
type OffsetFile = { offset: number; delivered: number | null };

const asInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOffsetFile(raw: string): OffsetFile {
  const j: unknown = JSON.parse(raw);
  if (!isRecord(j)) {
    throw new Error("Telegram offset file has invalid schema");
  }
  const offset = asInt(j.offset);
  const delivered = j.delivered == null ? null : asInt(j.delivered);
  if (offset === null || (j.delivered != null && delivered === null)) {
    throw new Error("Telegram offset file has invalid schema");
  }
  return { offset, delivered };
}

export function serializeOffsetFile(
  offset: number,
  delivered: number | null,
): string {
  return JSON.stringify(
    delivered === null ? { offset } : { offset, delivered },
  );
}

// Маркер — НЕ вечная верхняя граница: Telegram может (редко) перевыдать update_id с
// другой базы, и «всё, что меньше давнего маркера» превратилось бы в чёрную дыру.
// Пропускаем только НЕДАВНО доставленное — в пределах окна от маркера.
export const DEDUPE_WINDOW = 100_000;

export function alreadyDelivered(
  updateId: number,
  delivered: number | null,
): boolean {
  return (
    delivered !== null &&
    updateId <= delivered &&
    delivered - updateId < DEDUPE_WINDOW
  );
}
