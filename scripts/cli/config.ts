import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfigTransaction,
  probeEveHealth,
  recoverConfigTransaction,
} from "../lib/config-transaction.ts";
import { parseEnvText } from "../lib/env-file.ts";
import { catalogProvider } from "../lib/model-catalog.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type CliSystemd = ReturnType<typeof createCliSystemd>;

type ConfigCommandOverrides = {
  readonly applyConfigTransaction?: typeof applyConfigTransaction;
  readonly probeEveHealth?: typeof probeEveHealth;
  readonly recoverConfigTransaction?: typeof recoverConfigTransaction;
};

type ProviderSelection = [model: string, key: string | null];

/** Create the config command without performing filesystem, process, or systemd work at import time. */
export function createConfigCommand(
  runtime: CliRuntime,
  cliSystemd: Pick<CliSystemd, "writeUnits">,
  {
    applyConfigTransaction: applyTransaction = applyConfigTransaction,
    probeEveHealth: probeHealth = probeEveHealth,
    recoverConfigTransaction: recoverTransaction = recoverConfigTransaction,
  }: ConfigCommandOverrides = {},
) {
  const {
    ENV_PATH,
    NODE,
    childEnv,
    SERVICES,
    DEFAULT_PORT,
    ok,
    warn,
    run,
    systemd,
    dataDirAbs,
    confirm,
    requireSystemd,
  } = runtime;
  const { writeUnits } = cliSystemd;

  return async function cmdConfig(args: readonly string[] = []): Promise<void> {
    requireSystemd();
    const restartConfiguredServices = (): void => {
      // Units embed IVA_PORT, so both apply and rollback must regenerate them from
      // whichever .env is currently live before the checked restart. The candidate
      // already carries a valid bearer; skipping its migration here also keeps a
      // rollback snapshot byte-exact for older installations.
      writeUnits({ ensureBearer: false });
      systemd.restart(SERVICES);
    };

    const recovered = await recoverTransaction(
      { envPath: ENV_PATH, services: SERVICES },
      { restart: restartConfiguredServices },
    );
    if (recovered)
      ok("Recovered the previous configuration and restarted services");
    if (args.includes("--recover")) {
      if (!recovered) ok("No pending configuration recovery");
      return;
    }

    const candidateDir = mkdtempSync(join(tmpdir(), "iva-config-"));
    const candidatePath = join(candidateDir, ".env");
    try {
      const result = run(NODE, ["scripts/setup.mjs"], {
        env: { ...childEnv, IVA_CONFIG_OUTPUT: candidatePath },
      });
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        return;
      }
      if (!(await confirm("Apply settings and restart services now?", true))) {
        warn("Configuration unchanged");
        return;
      }

      const nextText = readFileSync(candidatePath, "utf8");
      const nextEnv = parseEnvText(nextText);
      // Тот же каталог, что у мастера, доктора и кнопок /model, — и тот же перечень имён,
      // что принимает рантайм (сверяет scripts/lib/model-catalog.test.ts).
      const provider = nextEnv.MODEL_PROVIDER;
      const catalog = catalogProvider(provider);
      if (!catalog)
        throw new Error(
          "candidate configuration has an invalid model provider",
        );
      const selected: ProviderSelection = [catalog.modelVar, catalog.keyVar];
      const port = Number(nextEnv.IVA_PORT || DEFAULT_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("candidate configuration has an invalid IVA_PORT");
      }

      await applyTransaction(
        {
          envPath: ENV_PATH,
          nextText,
          selection: {
            provider,
            model: nextEnv[selected[0]],
            key: selected[1] ? nextEnv[selected[1]] : undefined,
            dataDir: dataDirAbs(nextEnv),
          },
          services: SERVICES,
          healthUrl: `http://127.0.0.1:${port}/eve/v1/health`,
        },
        {
          restart: restartConfiguredServices,
          health: (url) => probeHealth(url),
        },
      );
      ok("Configuration applied; agent and Telegram bridge are active");
    } finally {
      rmSync(candidateDir, { recursive: true, force: true });
    }
  };
}
