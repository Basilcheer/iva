export const CONTEXT_WINDOW_CONFIGURATION_ERROR =
  "CONTEXT_WINDOW_CONFIGURATION_ERROR";

export class ContextWindowConfigurationError extends Error {
  declare readonly code: typeof CONTEXT_WINDOW_CONFIGURATION_ERROR;
  declare readonly variable: string;
  declare readonly value: string;

  constructor(variable: string, value: string) {
    super(
      `Invalid ${variable} ${JSON.stringify(value)}; expected a positive safe integer — run: iva config`,
    );
    this.name = "ContextWindowConfigurationError";
    this.code = CONTEXT_WINDOW_CONFIGURATION_ERROR;
    this.variable = variable;
    this.value = value;
  }
}

export function resolveContextWindow(
  variable: string,
  raw: string,
  fallback?: number,
): number;
export function resolveContextWindow(
  variable: string,
  raw: string | undefined,
  fallback: number,
): number;
export function resolveContextWindow(
  variable: string,
  raw: string | undefined,
  fallback?: number,
): number {
  if (raw !== undefined && !/^\d+$/.test(raw))
    throw new ContextWindowConfigurationError(variable, raw);
  const value = raw === undefined ? fallback : Number(raw);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new ContextWindowConfigurationError(
      variable,
      raw ?? String(fallback),
    );
  return value;
}
