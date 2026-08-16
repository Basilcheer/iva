import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  verbose?: boolean;
  input?: Buffer;
  trimOutput?: boolean;
};

export function runCommand(
  command: string,
  args: string[],
  {
    cwd,
    env = process.env,
    logFile,
    verbose = false,
    input,
    trimOutput = true,
  }: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const collect = (
      kind: "out" | "err",
      stream: NodeJS.ReadableStream,
      target: NodeJS.WriteStream,
    ) => {
      stream.on("data", (chunk: unknown) => {
        const text = String(chunk);
        if (kind === "out") stdout += text;
        else stderr += text;
        if (logFile) appendFileSync(logFile, text);
        if (verbose) target.write(text);
      });
    };
    collect("out", child.stdout, process.stdout);
    collect("err", child.stderr, process.stderr);
    child.stdin.end(input);
    child.on("error", (error) =>
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: trimOutput ? stdout.trim() : stdout,
        stderr: stderr.trim(),
      }),
    );
  });
}

export function runCommandBuffer(
  command: string,
  args: string[],
  { cwd, env = process.env }: Pick<CommandOptions, "cwd" | "env"> = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        code: 1,
        stdout: Buffer.concat(stdout),
        stderr: error.message,
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: stderr.trim(),
      });
    });
  });
}
