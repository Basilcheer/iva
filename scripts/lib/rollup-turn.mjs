// Таймаут одного хода ночного роллапа.
//
// Зачем: на eve 0.27.13 резюм припаркованной сессии ПОСЛЕ рестарта сервера виснет молча
// (#104) — `session.send()` отвечает 200, а `await response.result()` не резолвится никогда.
// Обычный try/catch такое не ловит: ошибки нет, ход просто не заканчивается, и ночной
// юнит висит до утра, не написав ни строчки в журнал. Гонка с таймером превращает молчание
// в честную ошибку, по которой вызывающий может уйти на свежую сессию.
//
// Таймер обязательно гасится в finally: живой setTimeout держит event loop и не даёт
// процессу (и тесту) завершиться после успешного хода.

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

// Node держит таймер в 32-битном знаковом диапазоне: всё сверх этого молча схлопывается в 1 мс.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Разбор ROLLUP_TURN_TIMEOUT_MS. Пустая строка (частый случай — `ROLLUP_TURN_TIMEOUT_MS=` в .env)
// и мусор дают Number() → 0/NaN, а это таймер на 1 мс: каждый ход «зависал» бы мгновенно и ночь
// уходила бы в фолбэк. Мусор не роняет ночь — падаем на дефолт и громко пишем в stderr.
export function resolveTurnTimeoutMs(raw, { warn = () => {} } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_TURN_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMER_MS) {
    warn(
      `ROLLUP_TURN_TIMEOUT_MS=${String(raw)} is not a positive integer of milliseconds (max ${MAX_TIMER_MS}) — ` +
        `falling back to ${DEFAULT_TURN_TIMEOUT_MS}`,
    );
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  return n;
}

export class RollupTurnTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`rollup turn "${label}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "RollupTurnTimeoutError";
    this.code = "ROLLUP_TURN_TIMEOUT";
    this.label = label;
  }
}

export const DEFAULT_CANCEL_TIMEOUT_MS = 30_000;

// Отмена проигравшего гонку хода. Таймаут не останавливает ход на сервере — тот продолжает
// писать в vault, — поэтому перед retry в свежей сессии старый ход надо погасить, иначе два
// писателя правят одни и те же карточки и CORE.md под одним флоком.
// Best-effort по определению: у заклинившей сессии cancel сам может висеть или ответить 500,
// а у не начатой — бросить. Любой исход проглатывается, наверх идёт только признак успеха.
export async function cancelTurnQuietly(session, { timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS } = {}) {
  try {
    await withTurnTimeout(() => session.cancel(), { timeoutMs, label: "cancel" });
    return true;
  } catch {
    return false;
  }
}

// Выполняет fn() и отклоняется RollupTurnTimeoutError, если тот не уложился в timeoutMs.
// Проигравшая сторона гонки не отменяется (у eve-хода нет abort) — она просто повисает
// в фоне; вызывающий должен считать сессию непригодной и завести новую.
export async function withTurnTimeout(fn, { timeoutMs = DEFAULT_TURN_TIMEOUT_MS, label = "turn" } = {}) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new RollupTurnTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
