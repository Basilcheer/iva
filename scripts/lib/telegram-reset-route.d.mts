import type { ResetFn } from "eve/channels";

export function handleTelegramResetRequest(
  req: Request,
  reset: ResetFn,
  secretToken?: string,
): Promise<Response>;
