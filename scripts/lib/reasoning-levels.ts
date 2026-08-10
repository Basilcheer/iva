// Stable reasoning vocabulary understood by the runtime protocol.
// Telegram shows a model's live subset, with a conservative fallback when the
// catalog is unavailable. `ultra` is intentionally unsupported.
// The canonical list is repeated in agent/lib/reasoning-levels.ts, where the runtime
// validates THINKING_EFFORT: this copy is loaded by `iva config` on installs whose agent/
// may be missing, so it cannot reach for the authored tree. Pinned in the test next door.
export const CANONICAL_REASONING_EFFORTS = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const FALLBACK_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
]);
