import { randomBytes } from "node:crypto";

/** Generate the shared secret used by Iva's local Eve clients. */
export function generateAssistantBearer() {
  return randomBytes(32).toString("base64url");
}

/** Generated Iva bearers encode exactly 32 random bytes as base64url. */
export function isAssistantBearer(value: string | null | undefined): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(String(value || "").trim());
}
