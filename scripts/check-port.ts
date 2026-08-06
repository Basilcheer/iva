#!/usr/bin/env node
// Iva port preflight check — thin CLI wrapper over scripts/lib/ports.ts.
//
//   node scripts/check-port.ts            # IVA_PORT from .env (or 8723)
//   node scripts/check-port.ts 8723       # specific port
//   node scripts/check-port.ts --suggest  # suggest the nearest free one
//   node scripts/check-port.ts --json
//
// Exit code: 0 — free, 1 — occupied, 2 — usage error.

import {
  defaultChecker,
  PortSelector,
  readIvaPort,
  type PortCheckResult,
} from "./lib/ports.ts";

type PortSuggestion = number | null;

// Reporter: output formatting is decoupled from the check logic (SRP).
const reporter = {
  human(
    { port, occupied, holders }: PortCheckResult,
    suggestion: PortSuggestion,
  ): string {
    if (!occupied) return `✓ Port ${port} is free.`;
    const who = holders.length ? `\n  held by → ${holders.join("; ")}` : "";
    const sug = suggestion ? `\n  free alternative → ${suggestion}` : "";
    return `✗ Port ${port} is occupied.${who}${sug}`;
  },
  json: (result: PortCheckResult, suggestion: PortSuggestion): string =>
    JSON.stringify({ ...result, suggestion }, null, 2),
};

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const suggest = args.includes("--suggest");
  const portArg = args.find((a) => /^\d+$/.test(a));
  const port = portArg ? Number(portArg) : readIvaPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(2);
  }

  const checker = defaultChecker();
  const result = await checker.check(port);

  let suggestion = null;
  if (suggest || result.occupied) {
    suggestion = await new PortSelector(checker).firstFree(
      result.occupied ? port + 1 : port,
    );
  }

  console.log(
    asJson
      ? reporter.json(result, suggestion)
      : reporter.human(result, suggestion),
  );
  process.exit(result.occupied ? 1 : 0);
}

function errorDetail(error: unknown): unknown {
  return (
    (error as { message?: unknown } | null | undefined)?.message ||
    String(error)
  );
}

main(process.argv).catch((error: unknown) => {
  console.error(errorDetail(error));
  process.exit(2);
});
