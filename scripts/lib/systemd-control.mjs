const UNIT_RE = /^[A-Za-z0-9_.@:-]+$/;

function safeUnit(unit) {
  if (!UNIT_RE.test(unit)) throw new Error(`invalid systemd unit: ${unit}`);
  return unit;
}

function resultOf(result) {
  return {
    code: result?.code ?? result?.status ?? 1,
    out: String(result?.out ?? result?.stdout ?? "").trim(),
  };
}

function journalHint(unit) {
  return `journalctl --user -u ${safeUnit(unit)} -n 100 --no-pager`;
}

export class SystemdControlError extends Error {
  constructor(message, { unit, code } = {}) {
    const suffix = unit ? ` Check: ${journalHint(unit)}` : "";
    super(`${message}${code === undefined ? "" : ` (exit ${code})`}.${suffix}`);
    this.name = "SystemdControlError";
    this.unit = unit;
    this.code = code;
  }
}

export function cleanupSystemdUnits({ units, disable, remove, reload, reset }) {
  const errors = [];
  const attempt = (label, action) => {
    try {
      action();
    } catch (cause) {
      errors.push(new Error(`${label}: ${cause?.message || String(cause)}`, { cause }));
    }
  };

  const checkedUnits = units.map(safeUnit);
  for (const unit of checkedUnits) attempt(`disable ${unit}`, () => disable(unit));
  for (const unit of checkedUnits) attempt(`remove ${unit}`, () => remove(unit));
  attempt("daemon-reload", reload);
  attempt("reset-failed", reset);

  if (errors.length > 0) {
    const shown = errors.slice(0, 8).map((error) => error.message.replace(/\s+/g, " ").slice(0, 240));
    const omitted = errors.length - shown.length;
    const detail = `${shown.join("; ")}${omitted > 0 ? `; ${omitted} more failure(s)` : ""}`;
    throw new AggregateError(errors, `systemd unit cleanup failed: ${detail}`);
  }
  return checkedUnits;
}

export function createSystemdControl({ run }) {
  if (typeof run !== "function") throw new TypeError("systemd control requires run(args)");

  const query = (...args) => resultOf(run(args));

  function mutate(args, unit) {
    const result = query(...args);
    if (result.code !== 0) {
      throw new SystemdControlError(`systemctl --user ${args.join(" ")} failed`, {
        unit,
        code: result.code,
      });
    }
    return result;
  }

  function isEnabled(unit) {
    safeUnit(unit);
    const result = query("is-enabled", unit);
    return result.code === 0 && result.out === "enabled";
  }

  function isActive(unit) {
    safeUnit(unit);
    const result = query("is-active", unit);
    return result.code === 0 && result.out === "active";
  }

  function requireEnabledActive(unit) {
    safeUnit(unit);
    if (!isEnabled(unit)) {
      throw new SystemdControlError(`${unit} did not become enabled`, { unit });
    }
    if (!isActive(unit)) {
      throw new SystemdControlError(`${unit} did not become active`, { unit });
    }
  }

  return {
    query,
    isEnabled,
    isActive,
    activate(units) {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["enable", "--now", unit], unit);
        requireEnabledActive(unit);
      }
    },
    restart(units) {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["restart", unit], unit);
        if (!isActive(unit)) {
          throw new SystemdControlError(`${unit} did not become active after restart`, { unit });
        }
      }
    },
    stop(units) {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["stop", unit], unit);
      }
    },
    disableNow(units) {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["disable", "--now", unit], unit);
      }
    },
    resetFailed(units = []) {
      if (units.length === 0) return mutate(["reset-failed"]);
      for (const unit of units) {
        safeUnit(unit);
        mutate(["reset-failed", unit], unit);
      }
    },
    daemonReload() {
      return mutate(["daemon-reload"]);
    },
  };
}
