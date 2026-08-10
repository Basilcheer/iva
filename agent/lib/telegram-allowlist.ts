// БЕЗОПАСНОСТЬ: бот отвечает ТОЛЬКО доверенным Telegram user ID из
// TELEGRAM_ALLOWED_USER_IDS (через запятую). Это личный ассистент с приватными
// данными — без allowlist кто угодно мог бы вытащить их. Fail-closed: если список
// пуст, не пускается никто.
//
// Список читается на каждой проверке, а не один раз на загрузке модуля: он
// крошечный, зато правка окружения не переживает ход в устаревшем виде.
export function allowedTelegramUsers(): ReadonlySet<string> {
  return new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
