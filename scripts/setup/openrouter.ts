/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions -- preserve legacy provider-value coercion exactly. */
type OpenRouterError = {
  message?: unknown;
  metadata?: { raw?: unknown; provider_name?: unknown };
};
type OpenRouterBody = { error?: OpenRouterError };
type RawProviderError = { error?: unknown; message?: unknown };

export function openrouterErrReason(body: unknown, status: number): unknown {
  // This deliberately mirrors the former JavaScript property accesses.  These
  // values come from a provider response, and coercing malformed shapes into a
  // harmless fallback would change the error shown by setup.
  const error = (body as OpenRouterBody | null | undefined)?.error || {};
  let reason: unknown = error.message || `HTTP ${status}`;
  let raw = error.metadata?.raw;
  if (raw != null) {
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        /* raw is not JSON; keep the original string */
      }
    }
    let inner: unknown;
    if (raw && typeof raw === "object") {
      const rawObject = raw as RawProviderError;
      const nested = rawObject.error;
      inner =
        (nested && typeof nested === "object"
          ? (nested as RawProviderError).message
          : nested) || rawObject.message;
    } else {
      inner = raw;
    }
    if (inner != null && String(inner).trim()) {
      const provider = error.metadata?.provider_name;
      reason = provider ? `${String(inner)} (${provider})` : String(inner);
    }
  }
  return reason;
}
