export type UpdateCallbackAction =
  | { action: "do" }
  | { action: "skip" }
  | { action: "conflicts"; bundleId: string };

const UPDATE_CALLBACK_PREFIX = "iva_update:";
const RECOVERY_BUNDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function validRecoveryBundleId(value: string): boolean {
  return RECOVERY_BUNDLE_PATTERN.test(value) && value !== "." && value !== "..";
}

export function parseUpdateCallbackData(
  data: unknown,
): UpdateCallbackAction | null {
  if (data === `${UPDATE_CALLBACK_PREFIX}do`) return { action: "do" };
  if (data === `${UPDATE_CALLBACK_PREFIX}skip`) return { action: "skip" };
  if (typeof data !== "string") return null;
  const prefix = `${UPDATE_CALLBACK_PREFIX}conflicts:`;
  if (!data.startsWith(prefix)) return null;
  const bundleId = data.slice(prefix.length);
  return validRecoveryBundleId(bundleId)
    ? { action: "conflicts", bundleId }
    : null;
}
