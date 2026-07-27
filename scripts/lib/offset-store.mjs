// Формат data/telegram-offset.json: { offset, delivered }. offset — курсор getUpdates;
// delivered — update_id последнего апдейта, ДОСТАВЛЕННОГО в eve. Telegram отдаёт
// at-least-once: краш между доставкой и записью offset переигрывает апдейт на старте.
// Маркер delivered сужает окно двойной доставки до единственного апдейта «в полёте»:
// всё, что <= delivered, на переигровке пропускается (offset двигаем, в eve не шлём).
export function parseOffsetFile(raw) {
  try {
    const j = JSON.parse(raw);
    return {
      offset: typeof j?.offset === "number" ? j.offset : null,
      delivered: typeof j?.delivered === "number" ? j.delivered : null,
    };
  } catch {
    return { offset: null, delivered: null };
  }
}

export function serializeOffsetFile(offset, delivered) {
  return JSON.stringify(delivered === null ? { offset } : { offset, delivered });
}

// Апдейт уже доставлялся в eve в прошлой жизни процесса — не доставлять повторно.
export function alreadyDelivered(updateId, delivered) {
  return delivered !== null && updateId <= delivered;
}
