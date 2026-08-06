#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../scripts/cli/main.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

main(root, process.argv.slice(2));
