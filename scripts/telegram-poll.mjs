#!/usr/bin/env node
import { runEntrypoint } from "./poller/main.ts";
export * from "./poller/main.ts";
runEntrypoint(import.meta.url);
