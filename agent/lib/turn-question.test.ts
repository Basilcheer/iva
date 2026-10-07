import assert from "node:assert/strict";
import test from "node:test";
import { rememberTurnQuestion, turnQuestion } from "./turn-question.ts";

void test("the last accepted message of a chat is its question; a Try again tap keeps the old one", () => {
  rememberTurnQuestion("c-1", "  Первый вопрос ");
  rememberTurnQuestion("c-1", "Второй вопрос");
  assert.equal(turnQuestion("c-1"), "Второй вопрос");
  rememberTurnQuestion(
    "c-1",
    "Повторить\n\n(кнопка под сообщением Ивы: «Связь оборвалась…»)",
  );
  assert.equal(turnQuestion("c-1"), "Второй вопрос");
  rememberTurnQuestion("c-1", "   ");
  assert.equal(turnQuestion("c-1"), "Второй вопрос");
  assert.equal(turnQuestion("c-2"), undefined);
});

void test("the memory keeps 256 chats and drops the oldest", () => {
  for (let index = 0; index < 300; index++)
    rememberTurnQuestion(`k-${index}`, `q-${index}`);
  assert.equal(turnQuestion("k-0"), undefined);
  assert.equal(turnQuestion("k-299"), "q-299");
  assert.equal(turnQuestion("k-44"), "q-44");
});
