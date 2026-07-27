import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableDeliverStatus } from "./deliver-policy.mjs";

test("сетевые и серверные сбои ретраятся: 5xx, 408, 425, 429", () => {
  for (const s of [500, 502, 503, 529, 408, 425, 429]) {
    assert.equal(isRetryableDeliverStatus(s), true, `status ${s}`);
  }
});

test("постоянные клиентские ошибки не ретраятся: прочие 4xx", () => {
  for (const s of [400, 401, 403, 404, 413, 422]) {
    assert.equal(isRetryableDeliverStatus(s), false, `status ${s}`);
  }
});
