import test from "node:test";
import assert from "node:assert/strict";
import {
  alreadyDelivered,
  parseOffsetFile,
  serializeOffsetFile,
} from "./offset-store.mjs";

test("round-trip offset + delivered", () => {
  const raw = serializeOffsetFile(42, 41);
  assert.deepEqual(parseOffsetFile(raw), { offset: 42, delivered: 41 });
});

test("легаси-файл без delivered читается, битый JSON отвергается", () => {
  assert.deepEqual(parseOffsetFile('{"offset":7}'), {
    offset: 7,
    delivered: null,
  });
  assert.deepEqual(parseOffsetFile('{"offset":7,"delivered":null}'), {
    offset: 7,
    delivered: null,
  });
  assert.throws(() => parseOffsetFile("garbage"), SyntaxError);
});

test("alreadyDelivered: пропускаем только то, что уже уходило в eve", () => {
  assert.equal(alreadyDelivered(41, 41), true, "равный — доставлялся");
  assert.equal(alreadyDelivered(40, 41), true, "меньший — доставлялся");
  assert.equal(alreadyDelivered(42, 41), false, "новый — доставлять");
  assert.equal(alreadyDelivered(42, null), false, "маркера нет — доставлять");
});

test("маркер — не вечная граница: далёкое прошлое вне окна доставляется", () => {
  assert.equal(
    alreadyDelivered(5, 5_000_000),
    false,
    "перевыдача id с другой базы — не глотаем",
  );
  assert.equal(
    alreadyDelivered(4_999_999, 5_000_000),
    true,
    "в пределах окна — дубль",
  );
});

test("невалидные значения делают существующий файл невалидным", () => {
  for (const raw of [
    '{"offset":1.5}',
    '{"offset":9007199254740992}',
    '{"offset":-1}',
    '{"offset":7,"delivered":"7"}',
    '{"offset":7,"delivered":-1}',
  ]) {
    assert.throws(() => parseOffsetFile(raw), /invalid schema/u);
  }
});
