#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main } from "./poller/main.ts";
export * from "./poller/main.ts";
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("telegram-poll fatal:", e);
    process.exit(1);
  });
}
