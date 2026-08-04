# Tech debt

Known gaps and deferred decisions, tracked so they don't get lost between releases.

## 1. Approval gates (eve `tools.approval` + Telegram HITL)

eve ships a native tool-approval flow (human-in-the-loop confirmation before a tool
runs). Iva doesn't wire it up yet — every tool call executes unattended. Adopting it
means designing the Telegram side of the approval prompt (inline buttons, timeout,
what happens to the turn while waiting) before it's worth turning on. Deferred
deliberately, not an oversight.

## 2. Poller UI wizards → native HITL

The `/model`, `/think` and related menu flows in the Telegram poller are
hand-rolled multi-step wizards predating eve's native human-in-the-loop primitives.
They should eventually move onto the same mechanism as item 1 instead of maintaining
a parallel bespoke UI layer.

## 3. Cross-imports from `agent/` into the Telegram channel

Several files under the channel currently reach back into `agent/` in ways that
blur the module boundary: `telegram-format`, `telegram-reply-context`,
`telegram-reset-route`, `telegram-turn-start`, plus `provider.ts` and
`hooks/usage.ts` (both consumed from `instructions/20-core.ts`). These should move
into `agent/lib` so the channel depends on a stable published surface rather than
reaching into agent internals.

## 4. Evals

`evals.json` exists for three skills but there's no runner wired up, and the
`#evals/*` import alias is declared in `package.json` but unused. eve ships a native
`eve/evals` module — adopt it instead of building a custom runner.

## 5. CI discovery guardrails

Neither `npm run validate` nor `eve info` runs in CI. Both would catch silent eve
discovery failures (agent/tool/skill wiring that eve can't find at build time) before
they reach a release. Worth adding as a CI step.

## 6. `sessionTimeoutMs: false`

Disabled in `agent/agent.ts` to preserve eve 0.27's behavior (no auto-expiry) after
the 0.28 default changed to a 30-day session lifetime. This was the safe choice for
existing self-hosted installs with long-lived Telegram/rollup sessions, but it opts
out of a framework-owned cleanup mechanism. Revisit deliberately once Iva has its own
session-retirement story, rather than leaving the override in place indefinitely.

## 7. Opt-in UI for the digest cron

The daily-digest cron has no menu-driven opt-in/opt-out; enabling or disabling it is
a config/file-level operation. Worth exposing in `/menu` alongside the other
settings.

## 8. Future `.mjs` → TypeScript conversion

New scripts under `agent/lib` should land as TypeScript; existing `.mjs` files there
are candidates for conversion as they're touched, not a scheduled migration.

## 9. Upstream feature request: catch-up for missed schedule runs

If the box is down when an eve schedule would have fired, the run is simply skipped
— there's no catch-up on next start, unlike systemd's `Persistent=true` timers. Worth
filing as a feature request against `vercel/eve`.

## 10. Rollup-turn workarounds for vercel/eve#1450

`scripts/lib/rollup-turn.mjs` and the timeout/safety-net logic in
`scripts/memory/rollup.ts` work around an open upstream bug
([vercel/eve#1450](https://github.com/vercel/eve/issues/1450)). Once that's fixed
upstream, remove the workarounds rather than leaving them as permanent scaffolding.
