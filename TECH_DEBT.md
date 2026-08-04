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

## 3. Cross-imports from `scripts/lib` into `agent/`

First wave done: `telegram-continuation-token`, `telegram-acceptance`, `run-status`,
`settings` and `i18n` moved from `scripts/lib` to `agent/lib` (canonical home);
`scripts/` consumers now reach them through the `#lib/` alias instead of the other
way around.

The Telegram channel (`agent/channels/telegram.ts`) and other files under `agent/`
still reach into `scripts/lib` for the remainder: `telegram-format`,
`telegram-reply-context`, `telegram-reset-route`, `telegram-turn-start`, plus
`provider.ts` and `hooks/usage.ts` (both consumed from `instructions/20-core.ts`)
pull in further `scripts/lib` modules. This still drags `scripts` code into the
eve bundle for that remainder. These are the next wave to move into `agent/lib`.

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

`agent/schedules/digest.ts` exists now (off by default, reads `digestSchedule.enabled`
from `data/settings.json` at fire time), but there's still no menu-driven opt-in/opt-out
— enabling or disabling it is a raw `settings.json` edit. Worth exposing in `/menu`
alongside the other settings.

## 8. Future `.mjs` → TypeScript conversion

New scripts under `agent/lib` should land as TypeScript; existing `.mjs` files there
are candidates for conversion as they're touched, not a scheduled migration.

## 9. Upstream feature request: catch-up for missed schedule runs

If the box is down when an eve schedule would have fired, the run is simply skipped
— there's no catch-up on next start, unlike systemd's `Persistent=true` timers. Worth
filing as a feature request against `vercel/eve`.

**Workaround implemented here**: `scripts/lib/schedule-migration.mjs`, run fire-and-forget
from `agent/instrumentation.ts` on every server start, replaces `Persistent=true` for the
four memory-rollup schedules (`agent/schedules/memory-*.ts`). It compares each period's
last recorded success (`data/rollup-status.json`) against its most recent
timezone-aware scheduled point and runs it once if stale and still within a grace window
(20h daily / 3d weekly / 7d monthly / 14d yearly) — home-grown, and specific to this app's
four schedules, not a general answer other eve apps could reuse. Superseded if/when eve
grows a native catch-up story.

## 10. Rollup-turn workarounds for vercel/eve#1450

`scripts/lib/rollup-turn.mjs` and the timeout/safety-net logic in
`scripts/memory/rollup.ts` work around an open upstream bug
([vercel/eve#1450](https://github.com/vercel/eve/issues/1450)). Once that's fixed
upstream, remove the workarounds rather than leaving them as permanent scaffolding.
