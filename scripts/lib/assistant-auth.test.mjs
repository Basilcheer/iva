import { strict as assert } from "node:assert";
import {
  generateAssistantBearer,
  isAssistantBearer,
} from "./assistant-auth.mjs";

const first = generateAssistantBearer();
const second = generateAssistantBearer();

assert.match(first, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(first, second);
assert.equal(isAssistantBearer(first), true);
assert.equal(isAssistantBearer("short-secret"), false);
assert.equal(isAssistantBearer(`${first}\nextra`), false);
console.log("assistant-auth: all assertions passed");
