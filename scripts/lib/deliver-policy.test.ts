import test from "node:test";
import assert from "node:assert/strict";
import { classifyDeliverStatus } from "./deliver-policy.ts";

void test("сетевые и серверные сбои ретраятся быстро: 5xx, 408, 425, 429", () => {
  for (const s of [500, 502, 503, 529, 408, 425, 429]) {
    assert.equal(classifyDeliverStatus(s), "retry", `status ${s}`);
  }
});

void test("401/403/404 — сломанная конфигурация: ретрай с длинным бэкоффом, не дроп", () => {
  for (const s of [401, 403, 404]) {
    assert.equal(classifyDeliverStatus(s), "config", `status ${s}`);
  }
});

void test("постоянные клиентские ошибки ограничивают один delivery pass", () => {
  for (const s of [400, 413, 422]) {
    assert.equal(classifyDeliverStatus(s), "bounded", `status ${s}`);
  }
});

void test("503 acceptance-роута — bounded dispatch, а не вечный 5xx-ретрай", () => {
  assert.equal(classifyDeliverStatus(503), "retry");
  assert.equal(classifyDeliverStatus(503, { acceptance: true }), "bounded");
  assert.equal(classifyDeliverStatus(502, { acceptance: true }), "retry");
  assert.equal(classifyDeliverStatus(401, { acceptance: true }), "config");
});
