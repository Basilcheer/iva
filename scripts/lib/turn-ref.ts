// `<session>/<turn>` — имя одного хода: `iva trace show`, список сбоев Insight и `iva diagnose --turn`
// (docs/trace.md). `turn_N` начинается с `turn_0` в каждой сессии, поэтому без сессии ход не назван.
// Разделитель — `/`: `|` без кавычек shell понимает как конвейер.
export const turnRef = (session: string, turn: string): string =>
  session !== "" && turn !== "" ? `${session}/${turn}` : turn || session;

/** Обратно: последний `/` отделяет ход (в `turn_N` его нет). Не пара — null. */
export function parseTurnRef(
  ref: string,
): { readonly session: string; readonly turn: string } | null {
  const at = ref.lastIndexOf("/");
  if (at <= 0 || at === ref.length - 1) return null;
  return { session: ref.slice(0, at), turn: ref.slice(at + 1) };
}
