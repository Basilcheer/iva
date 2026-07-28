import { createHash, timingSafeEqual } from "node:crypto";
import {
  extractBearerToken,
  localDev,
  placeholderAuth,
  vercelOidc,
  type AuthFn,
} from "eve/channels/auth";

const SERVICE_AUTH = {
  attributes: {},
  authenticator: "iva-bearer",
  principalId: "iva-internal-client",
  principalType: "service",
} as const;

function equalSecret(left: string, right: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Authenticate Iva's internal Eve clients with the shared bearer from `.env`. */
export function assistantBearerAuth(expectedToken?: string): AuthFn<Request> {
  const expected = expectedToken?.trim();
  return (request) => {
    if (!expected) return null;
    const received = extractBearerToken(request.headers.get("authorization"));
    return received && equalSecret(received, expected) ? SERVICE_AUTH : null;
  };
}

type EveAuthEnvironment = {
  readonly ASSISTANT_BEARER?: string;
  readonly EVE_DEV?: string;
};

export function createEveAuth(env: EveAuthEnvironment = process.env) {
  return [
    assistantBearerAuth(env.ASSISTANT_BEARER),
    vercelOidc(),
    // Eve sets EVE_DEV=1 itself. Production never trusts the request Host as authentication.
    ...(env.EVE_DEV === "1" ? [localDev()] : []),
    placeholderAuth(),
  ];
}
