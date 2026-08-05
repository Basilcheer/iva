import { writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";

import { acknowledgeQueueHead } from "../lib/telegram-queue.mjs";

const [queueFile, markerFile] = process.argv.slice(2);
if (!queueFile || !markerFile) {
  throw new Error(
    "usage: telegram-queue-ack-crash-child <queue-file> <marker-file>",
  );
}

await acknowledgeQueueHead(queueFile, "1:", 101, {
  renameImpl: async (from, to) => {
    await rename(from, to);
    if (String(to) !== queueFile) return;
    writeFileSync(markerFile, "queue removal published\n", { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
