#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../scripts/cli/main.ts";
import { stableRoot } from "../scripts/lib/version-layout.ts";

// A version is addressed through `current`, so everything the CLI writes down
// (systemd units above all) names a path that outlives this particular version.
const root = stableRoot(join(dirname(fileURLToPath(import.meta.url)), ".."));

main(root, process.argv.slice(2));
