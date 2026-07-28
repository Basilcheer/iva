export const TELEGRAM_REPLY_TEXT_MAX_CHARS: number;
export interface TelegramReplySanitizeResult {
  text: string;
  blocked: boolean;
  flags: string[];
}
export interface TelegramReplyContextResult {
  item: string;
  flagged: boolean;
}
export function buildTelegramReplyContext(
  rawMessage: unknown,
  sanitizeText: (text: string) => TelegramReplySanitizeResult,
  hasAttackSignal: (result: TelegramReplySanitizeResult) => boolean,
): TelegramReplyContextResult | null;
