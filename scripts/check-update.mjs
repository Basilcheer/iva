#!/usr/bin/env node
// Permanent shim: deployed systemd units point here. Logic lives in check-update.ts.
import { main, runDailyUpdateCheck } from "./check-update.ts";
export { runDailyUpdateCheck };
void main(import.meta.url);
