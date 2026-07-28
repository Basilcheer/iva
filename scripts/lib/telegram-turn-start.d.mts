export interface PublishTelegramTurnStartedOptions {
  chatKey: string;
  continuationToken: string;
  sessionId: string;
  turnId: string;
  setStatusImpl: (chatKey: string, patch: Record<string, unknown>) => unknown;
  setStatusIfImpl: (
    chatKey: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => unknown;
  sendWorkingStatusImpl: () => Promise<number | null | undefined>;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export function publishTelegramTurnStarted(
  options: PublishTelegramTurnStartedOptions,
): Promise<void>;
