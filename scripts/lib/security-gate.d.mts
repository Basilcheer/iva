export interface SanitizeResult {
  text: string;
  blocked: boolean;
  reason: string;
  flags: string[];
  truncatedChars: number;
}

export interface OutboundFinding {
  type: string;
  name: string;
  preview: string;
}

export interface OutboundResult {
  clean: boolean;
  text: string;
  findings: OutboundFinding[];
}

export function hasInboundAttackSignal(
  result: Pick<SanitizeResult, "blocked" | "flags">,
): boolean;
export function sanitizeInbound(input: string, maxChars?: number): SanitizeResult;
export function scanOutbound(input: string, redact?: boolean): OutboundResult;
