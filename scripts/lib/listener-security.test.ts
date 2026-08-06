import { strict as assert } from "node:assert";
import { classifyAgentListeners } from "./listener-security.ts";

const line = (host: string) => `LISTEN 0 511 ${host}:8723 0.0.0.0:*`;

assert.equal(classifyAgentListeners("", 8723), "absent");
assert.equal(classifyAgentListeners(line("127.0.0.1"), 8723), "loopback");
assert.equal(classifyAgentListeners(line("[::1]"), 8723), "loopback");
assert.equal(classifyAgentListeners(line("0.0.0.0"), 8723), "exposed");
assert.equal(classifyAgentListeners(line("[::]"), 8723), "exposed");
assert.equal(classifyAgentListeners(line("192.0.2.10"), 8723), "exposed");
assert.equal(
  classifyAgentListeners(`${line("127.0.0.1")}\n${line("0.0.0.0")}`, 8723),
  "exposed",
);
console.log("listener-security: all assertions passed");
