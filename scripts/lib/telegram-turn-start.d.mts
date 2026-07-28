type ChatStatus = Record<string, unknown> | null;
type GetStatus = (chatKey: string) => ChatStatus;
type SetStatus = (chatKey: string, patch: Record<string, unknown>) => unknown;
type SetStatusIf = (
  chatKey: string,
  expected: Record<string, unknown>,
  patch: Record<string, unknown>,
) => unknown;

export interface PublishTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId?: string;
  now?: () => number;
  setStatusImpl: SetStatus;
  setStatusIfImpl: SetStatusIf;
  sendWorkingStatusImpl: (options: { canStop: false }) => Promise<number | null | undefined>;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export function publishTelegramEarlyStatus(
  options: PublishTelegramEarlyStatusOptions,
): Promise<string | null>;

export interface PublishTelegramTurnStartedOptions {
  chatKey: string;
  continuationToken: string;
  sessionId: string;
  turnId: string;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  sendWorkingStatusImpl?: (options: { canStop: true }) => Promise<number | null | undefined>;
  enableWorkingStatusStopImpl?: (messageId: number) => Promise<unknown>;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export function publishTelegramTurnStarted(
  options: PublishTelegramTurnStartedOptions,
): Promise<boolean>;

export interface AbandonTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId: string;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export function abandonTelegramEarlyStatus(
  options: AbandonTelegramEarlyStatusOptions,
): Promise<boolean>;

export interface EmitTelegramTurnLatencyOptions {
  chatKey: string;
  sessionId: string;
  deliveryAt: number;
  delivered: boolean;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  logImpl?: (line: string) => void;
}

export function emitTelegramTurnLatency(
  options: EmitTelegramTurnLatencyOptions,
): boolean;

export interface MarkTelegramFirstOutputOptions {
  chatKey: string;
  sessionId: string;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
}

export function markTelegramFirstOutput(
  options: MarkTelegramFirstOutputOptions,
): boolean;
