// Рантайм-доступ к подписке OpenAI (ChatGPT Plus/Pro/Team): прочитать data/codex-auth.json,
// обновить протухший токен и собрать заголовки для Codex-бэкенда. Живёт в authored tree,
// потому что этим занимается сам агент — agent/provider.ts подставляет свежий Bearer перед
// КАЖДЫМ запросом модели, а eve пересобирает дерево при старте (issue #176).
//
// Второй половиной шва остаётся scripts/lib/codex-oauth.ts: там живёт ВХОД (device-code и
// browser-PKCE), который этот файл и создаёт, — `iva login` обязан работать на инсталле без
// авторского дерева (ADR-0003), поэтому обратный импорт оттуда сюда невозможен. Общее у
// половин — сам файл токена и протокол его получения; совпадение пинует
// scripts/lib/codex-auth-seam.test.ts.
//
// Протокол (reverse-engineered из openai/codex, публичный client_id):
//   auth-домен  https://auth.openai.com     refresh
//   API-домен   https://chatgpt.com/backend-api/codex   Responses API (/responses, /models)
// Токен (access_token — JWT, живёт ~1 ч) лежит в data/codex-auth.json (0600, gitignored).
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface CodexAuth {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  accountId: string | null;
  planType: string | null;
}

type JsonRecord = Record<string, unknown>;
type TokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
};

export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // публичный client_id Codex CLI
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const TOKEN_URL = `${ISSUER}/oauth/token`;
export const ORIGINATOR = "codex_cli_rs";
// Для ?client_version= у /models и User-Agent. ВАЖНО: /models гейтит список по версии —
// слишком старая (напр. 0.20/0.42) → бэкенд отдаёт {"models":[]}, а модель прячется, если её
// minimal_client_version выше нашей (напр. gpt-5.6-* требуют ≥0.144.0). Держим на актуальном релизе
// codex, иначе свежие модели не появятся в списке. Проверено: 0.144.0 отдаёт gpt-5.6-{sol,terra,luna}.
export const CLIENT_VERSION = "0.144.0";
const REFRESH_SKEW_S = 300; // рефрешим за 5 мин до exp (как окно codex CLI)

const defaultDir = (): string => process.env.ASSISTANT_DATA_DIR || "data";

// ── хранилище токенов ─────────────────────────────────────────────────────
export function authFilePath(dataDir = defaultDir()): string {
  return join(dataDir, "codex-auth.json");
}

export function readAuth(dataDir = defaultDir()): CodexAuth | null {
  try {
    return JSON.parse(readFileSync(authFilePath(dataDir), "utf8")) as CodexAuth;
  } catch {
    return null;
  }
}

// Атомарная запись 0600 (temp + rename) — секрет не должен мелькнуть с широкими правами,
// а конкурентный read не должен поймать полу-записанный файл.
export function writeAuth(auth: CodexAuth, dataDir = defaultDir()): void {
  const file = authFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// ── JWT (без внешних зависимостей) ─────────────────────────────────────────
export function parseJwt(jwt: string): JsonRecord {
  const payload = String(jwt).split(".")[1];
  if (!payload) throw new Error("malformed JWT");
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as JsonRecord;
}

// exp (unix-секунды) из access_token; 0 если нет клейма.
export function jwtExp(jwt: string): number {
  try {
    return Number(parseJwt(jwt).exp) || 0;
  } catch {
    return 0;
  }
}

// Из id_token достаём account_id и план подписки (клейм https://api.openai.com/auth).
export function accountFromIdToken(idToken: string): {
  accountId: string | null;
  planType: string | null;
} {
  let auth: JsonRecord = {};
  try {
    auth = (parseJwt(idToken)["https://api.openai.com/auth"] ||
      {}) as JsonRecord;
  } catch {
    /* нет клейма — вернём пустое */
  }
  const accountId = auth.chatgpt_account_id;
  const planType = auth.chatgpt_plan_type;
  return {
    accountId: typeof accountId === "string" && accountId ? accountId : null,
    planType: typeof planType === "string" && planType ? planType : null,
  };
}

// Собирает объект хранилища из ответа токен-эндпоинта.
export function toAuth(
  tokens: TokenResponse,
  prev: Partial<CodexAuth> = {},
): CodexAuth {
  const idToken = tokens.id_token || prev.id_token;
  const { accountId, planType } = idToken
    ? accountFromIdToken(idToken)
    : { accountId: prev.accountId, planType: prev.planType };
  return {
    id_token: idToken,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prev.refresh_token,
    accountId: accountId as string | null,
    planType: planType as string | null,
  };
}

async function refresh(
  refreshToken: string | undefined,
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok)
    throw new Error(
      `token refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  return (await res.json()) as TokenResponse; // { id_token?, access_token, refresh_token? }
}

// ── getAccessToken: свежий токен для каждого запроса ────────────────────────
// Дедуп рефреша в пределах процесса (модель зовётся конкурентно). Кросс-процессный
// рейс (CLI login + сервер) маловероятен и самолечится: при провале рефреша
// перечитываем файл — вдруг другой процесс уже обновил.
let refreshInFlight: Promise<CodexAuth> | null = null;
export async function getAccessToken(
  dataDir = defaultDir(),
): Promise<{ accessToken: string; accountId: string | null }> {
  let auth = readAuth(dataDir);
  if (!auth?.access_token) throw new Error("not logged in — run `iva login`");
  const fresh =
    jwtExp(auth.access_token) - REFRESH_SKEW_S > Math.floor(Date.now() / 1000);
  if (fresh)
    return { accessToken: auth.access_token, accountId: auth.accountId };

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const next = toAuth(await refresh(auth.refresh_token), auth);
        writeAuth(next, dataDir);
        return next;
      } catch (err) {
        const reread = readAuth(dataDir); // мог обновить другой процесс
        if (
          reread?.access_token &&
          jwtExp(reread.access_token) - REFRESH_SKEW_S >
            Math.floor(Date.now() / 1000)
        )
          return reread;
        throw err;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  auth = await refreshInFlight;
  return { accessToken: auth.access_token, accountId: auth.accountId };
}

// Заголовки авторизации для вызова Codex-бэкенда (/responses, /models).
export async function codexAuthHeaders(
  dataDir = defaultDir(),
): Promise<Record<string, string>> {
  const { accessToken, accountId } = await getAccessToken(dataDir);
  const h: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    originator: ORIGINATOR,
    "User-Agent": `${ORIGINATOR}/${CLIENT_VERSION}`,
  };
  if (accountId) h["ChatGPT-Account-ID"] = accountId;
  return h;
}
