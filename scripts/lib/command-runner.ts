import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { CommandResult, Runner } from "./version-update.ts";

/**
 * npm (or any other command) as a `Runner`: silent unless it fails, because for an
 * update the captured output only matters as the failure report.
 */
export function commandRunner(verbose: boolean): Runner {
  return (command, args, cwd) =>
    new Promise<CommandResult>((resolve) => {
      const child = spawn(command, [...args], {
        cwd,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        stdio: [
          "ignore",
          verbose ? "inherit" : "pipe",
          verbose ? "inherit" : "pipe",
        ],
      });
      let output = "";
      const collect = (chunk: unknown): void => {
        output = `${output}${String(chunk)}`.slice(-20_000);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => resolve({ code: 1, output: error.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
}
