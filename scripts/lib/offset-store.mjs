// Формат data/telegram-offset.json: { offset, delivered }. offset — курсор getUpdates;
// delivered — update_id последнего апдейта, ДОСТАВЛЕННОГО в eve. Telegram отдаёт
// at-least-once: краш между доставкой и записью offset переигрывает апдейт на старте.
// Маркер delivered сужает окно двойной доставки до единственного апдейта «в полёте»:
// свежепереигранное (<= delivered, в пределах окна) пропускается — offset двигаем,
// в eve не шлём.
const asInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

export function parseOffsetFile(raw) {
  const j = JSON.parse(raw);
  if (
    typeof j !== "object" ||
    j === null ||
    Array.isArray(j) ||
    asInt(j.offset) === null ||
    (j.delivered !== undefined && j.delivered !== null && asInt(j.delivered) === null)
  ) {
    throw new Error("Telegram offset file has invalid schema");
  }
  return { offset: j.offset, delivered: j.delivered ?? null };
}

export function serializeOffsetFile(offset, delivered) {
  return JSON.stringify(delivered === null ? { offset } : { offset, delivered });
}

// Маркер — НЕ вечная верхняя граница: Telegram может (редко) перевыдать update_id с
// другой базы, и «всё, что меньше давнего маркера» превратилось бы в чёрную дыру.
// Пропускаем только НЕДАВНО доставленное — в пределах окна от маркера.
export const DEDUPE_WINDOW = 100_000;

export function alreadyDelivered(updateId, delivered) {
  return delivered !== null && updateId <= delivered && delivered - updateId < DEDUPE_WINDOW;
}
