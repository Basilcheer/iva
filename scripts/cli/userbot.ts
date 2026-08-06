import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { userbotSyncArgs } from "../lib/userbot-deps.ts";
import {
  probeUserbotHealth,
  type UserbotHealth,
} from "../lib/userbot-health.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type CliSystemd = ReturnType<typeof createCliSystemd>;

export type UserbotRuntime = Pick<
  CliRuntime,
  | "ROOT"
  | "SVC_USERBOT"
  | "USERBOT_DIR"
  | "VENV_PY"
  | "TOKEN_FILE"
  | "ok"
  | "bad"
  | "step"
  | "run"
  | "cap"
  | "systemd"
  | "readEnv"
  | "writeEnvVars"
>;

export interface EnsureUserbotVenvOptions {
  readonly quiet?: boolean;
  readonly requirementsPath?: string | null;
  readonly requireHashes?: boolean;
}

export interface RestartUserbotOptions extends EnsureUserbotVenvOptions {
  readonly knownActive?: boolean;
}

interface UserbotFileSystem {
  exists(path: string): boolean;
  readUtf8(path: string | number): string;
  mkdir(path: string): void;
  writePrivate(path: string, data: string): void;
  chmodPrivate(path: string): void;
}

export interface UserbotDependencies {
  readonly fileSystem?: Partial<UserbotFileSystem>;
  readonly randomHex?: (bytes: number) => string;
  readonly probeHealth?: (options: {
    readonly root: string;
    readonly port: string;
  }) => Promise<UserbotHealth>;
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => never;
}

const DEFAULT_FILE_SYSTEM: UserbotFileSystem = {
  exists: existsSync,
  readUtf8: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writePrivate: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
  chmodPrivate: (path) => chmodSync(path, 0o600),
};

export function createUserbotCommands(
  runtime: UserbotRuntime,
  systemdLifecycle: Pick<CliSystemd, "writeUnits">,
  dependencies: UserbotDependencies = {},
) {
  const {
    ROOT,
    SVC_USERBOT,
    USERBOT_DIR,
    VENV_PY,
    TOKEN_FILE,
    ok,
    bad,
    step,
    run,
    cap,
    systemd,
    readEnv,
    writeEnvVars,
  } = runtime;
  const fileSystem: UserbotFileSystem = {
    ...DEFAULT_FILE_SYSTEM,
    ...dependencies.fileSystem,
  };
  const randomHex =
    dependencies.randomHex ??
    ((bytes: number): string => randomBytes(bytes).toString("hex"));
  const probeHealth = dependencies.probeHealth ?? probeUserbotHealth;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const exit =
    dependencies.exit ?? ((code: number): never => process.exit(code));

  function ensureUserbotVenv({
    quiet = false,
    requirementsPath = join(USERBOT_DIR, "requirements.lock"),
    requireHashes = true,
  }: EnsureUserbotVenvOptions = {}): void {
    const hasUv = !!cap("sh", ["-c", "command -v uv"]).out;
    if (!hasUv)
      throw new Error("userbot: uv не найден — повторно запусти install.sh");
    const options = {
      cwd: USERBOT_DIR,
      ...(quiet ? { stdio: "ignore" as const } : {}),
    };
    const must = (
      result: { readonly status?: number | null } | null | undefined,
      operation: string,
    ): void => {
      if ((result?.status ?? 1) !== 0)
        throw new Error(`userbot: ${operation} не удалось`);
    };
    if (!fileSystem.exists(VENV_PY)) {
      if (!quiet) step("Создаю venv для userbot-прокси…");
      must(
        run("uv", ["venv", "--python", "3.12", ".venv"], options),
        "создание venv",
      );
      if (!fileSystem.exists(VENV_PY))
        throw new Error("userbot: venv не создан — проверь python3/uv");
    }
    if (!quiet) step("Синхронизирую зависимости userbot-прокси…");
    const requirements = fileSystem.readUtf8(requirementsPath as string);
    must(
      run(
        "uv",
        userbotSyncArgs({
          pythonPath: VENV_PY,
          requirementsFile: requirementsPath as string,
          requirementsText: requirements,
          requireHashes,
        }),
        options,
      ),
      "установка зависимостей",
    );
    const check = cap(
      VENV_PY,
      ["-c", "import telethon, telegram_mcp, qrcode, mcp"],
      options,
    );
    if (check.code !== 0)
      throw new Error(
        `userbot: зависимости не импортируются — ${check.err.split("\n").pop() || "проверь requirements"}`,
      );
  }

  function ensureUserbotToken(): void {
    if (fileSystem.exists(TOKEN_FILE)) return;
    fileSystem.mkdir(dirname(TOKEN_FILE));
    fileSystem.writePrivate(TOKEN_FILE, randomHex(24));
    try {
      fileSystem.chmodPrivate(TOKEN_FILE);
    } catch {
      // The token file is already created with mode 0600; chmod is best-effort.
    }
    ok("Сгенерировал токен прокси (data/telegram-userbot.token).");
  }

  function restartUserbotIfActive({
    quiet = false,
    knownActive = false,
    requirementsPath = join(USERBOT_DIR, "requirements.lock"),
    requireHashes = true,
  }: RestartUserbotOptions = {}): void {
    if (!knownActive && !systemd.isActive(SVC_USERBOT)) return;
    if (!quiet) step("Обновляю userbot-прокси…");
    ensureUserbotVenv({ quiet, requirementsPath, requireHashes });
    systemd.restart([SVC_USERBOT]);
    if (!quiet) ok("userbot-прокси перезапущен на новом коде");
  }

  async function cmdUserbot(args: readonly string[]): Promise<void> {
    const sub = args[0] || "status";
    if (sub === "creds") {
      let data = "";
      try {
        data = fileSystem.readUtf8(0);
      } catch {
        // Empty input falls through to the existing credential validation.
      }
      const [apiId, apiHash] = data
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!apiId || !apiHash) {
        bad(
          "stdin: жду две строки — api_id и api_hash (создай приложение на my.telegram.org)",
        );
        exit(1);
      }
      if (!/^\d+$/.test(apiId)) {
        bad("api_id должен быть числом");
        exit(1);
      }
      writeEnvVars({ TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash });
      ok("Ключи Telegram записаны в .env. Теперь: iva userbot setup");
      return;
    }
    if (sub === "setup") {
      const env = readEnv();
      if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
        bad(
          "Нет TELEGRAM_API_ID/TELEGRAM_API_HASH в .env. Создай приложение на my.telegram.org,",
        );
        bad("впиши оба ключа в .env и запусти снова: iva userbot setup");
        exit(1);
      }
      ensureUserbotToken();
      ensureUserbotVenv();
      systemdLifecycle.writeUnits();
      systemd.activate([SVC_USERBOT]);
      systemd.restart([SVC_USERBOT]);
      ok(
        "Userbot-прокси включён. Подключи аккаунт по QR через бота: напиши боту «подключи мой телеграм».",
      );
      ok("Статус: iva userbot status · выключить: iva userbot off");
      return;
    }
    if (sub === "off") {
      systemd.disableNow([SVC_USERBOT]);
      ok("Userbot-прокси остановлен и выключен.");
      return;
    }
    if (sub === "diagnose") {
      if (args[1] !== "--json") {
        bad("Использование: iva userbot diagnose --json");
        exit(1);
      }
      const env = readEnv();
      const health = await probeHealth({
        root: ROOT,
        port: env.TELEGRAM_MCP_PORT || "8724",
      });
      log(JSON.stringify(health));
      return;
    }
    if (sub !== "status") {
      bad(`Неизвестная команда userbot: ${sub}`);
      exit(1);
    }
    const env = readEnv();
    const health = await probeHealth({
      root: ROOT,
      port: env.TELEGRAM_MCP_PORT || "8724",
    });
    log(`${SVC_USERBOT}: ${health.state}`);
    log(
      `venv: ${fileSystem.exists(VENV_PY) ? "собран" : "нет — будет собран при setup"}`,
    );
    log(
      `токен: ${fileSystem.exists(TOKEN_FILE) ? "есть" : "нет — создастся при setup"}`,
    );
  }

  return {
    ensureUserbotVenv,
    ensureUserbotToken,
    restartUserbotIfActive,
    cmdUserbot,
  };
}
