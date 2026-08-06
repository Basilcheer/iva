// Compatibility entry point for the built agent. Operational scripts import the
// canonical pure-JavaScript implementation directly so stock Node never loads TS.
export {
  hasInboundAttackSignal,
  sanitizeInbound,
  scanOutbound,
} from "../../scripts/lib/security-gate.ts";
export type {
  OutboundFinding,
  OutboundResult,
  SanitizeResult,
} from "../../scripts/lib/security-gate.ts";
