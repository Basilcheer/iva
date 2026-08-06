import { createAccountCommands } from "./account.ts";
import { createConfigCommand } from "./config.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createCliRuntime } from "./runtime.ts";
import { createServiceCommands } from "./services.ts";
import { createCliSystemd } from "./systemd.ts";
import { createTreeRenderer } from "./tree.ts";
import { createUpdateCommand } from "./update.ts";
import { createUserbotCommands } from "./userbot.ts";

export type CliCommand = (args: readonly string[]) => unknown;

type DispatchDependencies = {
  readonly bad: (message: string) => void;
  readonly help: () => void;
  readonly exit?: (code: number) => never;
};

/** Dispatch one CLI invocation while preserving the legacy sync-throw boundary. */
export function dispatchCli(
  argv: readonly string[],
  commands: Readonly<Record<string, CliCommand>>,
  {
    bad,
    help,
    exit = (code): never => process.exit(code),
  }: DispatchDependencies,
): Promise<unknown> {
  const [commandName, ...rest] = argv;
  const command = commandName ? commands[commandName] : undefined;
  if (!command) {
    if (commandName) bad(`Unknown command: ${commandName}`);
    help();
    return exit(commandName ? 1 : 0);
  }
  return Promise.resolve(command(rest)).catch((error: unknown) => {
    const message =
      (error as { readonly message?: string } | null | undefined)?.message ||
      String(error);
    bad(message);
    exit(1);
  });
}

/** Compose the CLI command groups without executing a command. */
export function createCliMain(root: string) {
  const runtime = createCliRuntime(root);
  const systemdLifecycle = createCliSystemd(runtime);
  const tree = createTreeRenderer(root);
  const userbot = createUserbotCommands(runtime, systemdLifecycle);
  const account = createAccountCommands(runtime, systemdLifecycle);
  const services = createServiceCommands(runtime, systemdLifecycle);
  const cmdConfig = createConfigCommand(runtime, systemdLifecycle);
  const cmdDoctor = createDoctorCommand(runtime, systemdLifecycle);
  const cmdUpdate = createUpdateCommand({
    runtime,
    systemdLifecycle,
    showTree: tree.showTree,
    restartUserbotIfActive: userbot.restartUserbotIfActive,
  });
  const { C, SERVICES, TIMERS, bad, ok } = runtime;

  function cmdHelp(): void {
    console.log(`
${C.b}Iva CLI${C.x} — manage your personal agent

${C.b}Commands:${C.x}
  ${C.c}iva update${C.x}         update: git pull + build + restart
  ${C.c}iva config${C.x}         configure: model, Telegram, Deepgram, TZ, vault
  ${C.c}iva login${C.x} [--browser]  sign in to an OpenAI subscription (ChatGPT) for MODEL_PROVIDER=codex
  ${C.c}iva doctor${C.x}         diagnose and safely auto-repair the install
  ${C.c}iva status${C.x}         status of services and memory timers
  ${C.c}iva restart${C.x}        restart the agent and Telegram bridge
  ${C.c}iva reset${C.x}          full reset: clear stuck workflows and restart
  ${C.c}iva start${C.x} / ${C.c}stop${C.x}    start / stop
  ${C.c}iva usage${C.x} [win]      token usage (last|today|week|month|by-model|by-source|tail)
  ${C.c}iva userbot${C.x} [creds|setup|status|diagnose --json|off]  personal-account userbot proxy
  ${C.c}iva logs${C.x} [poll]     agent logs (or the Telegram bridge) -f
  ${C.c}iva uninstall${C.x}       remove units and the command (--purge — delete code+vault)
  ${C.c}iva version${C.x}         version and git commit

  ${C.d}flags: update --force — rebuild with no changes; update --verbose — show technical output${C.x}
`);
  }

  const commands: Readonly<Record<string, CliCommand>> = {
    update: cmdUpdate,
    userbot: userbot.cmdUserbot,
    config: cmdConfig,
    login: account.cmdLogin,
    doctor: cmdDoctor,
    status: services.cmdStatus,
    restart: services.cmdRestart,
    reset: services.cmdReset,
    usage: account.cmdUsage,
    start: services.cmdStart,
    stop: services.cmdStop,
    logs: services.cmdLogs,
    uninstall: account.cmdUninstall,
    version: account.cmdVersion,
    tree: tree.showTree,
    help: cmdHelp,
    "--help": cmdHelp,
    "-h": cmdHelp,
    "_install-units": () =>
      ok(`systemd units written: ${systemdLifecycle.writeUnits().length}`),
    "_activate-units": () => {
      systemdLifecycle.activateUnits();
      ok(
        `systemd units enabled and active: ${SERVICES.length + TIMERS.length}`,
      );
    },
  };

  return {
    commands,
    cmdHelp,
    dispatch: (argv: readonly string[]) =>
      dispatchCli(argv, commands, { bad, help: cmdHelp }),
  };
}

export function main(
  root: string,
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return createCliMain(root).dispatch(argv);
}
