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

One file, `scripts/autograph/docs/evals/evals.json`, contains Autograph documentation
evals; it is not attached to Iva's bundled skills and has no runner wired up. The
`#evals/*` import alias is declared in `package.json` but unused. eve ships a native
`eve/evals` module — adopt it before adding product-level skill evals.

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

## 11. Cron/name metadata duplicated across schedules, migration, and the menu

The same 5 schedule names + cron expressions are hand-maintained in three places:
`agent/schedules/*.ts` (the actual cron strings), `scripts/lib/schedule-migration.mjs`'s
`PERIOD_SCHEDULE` (hour/minute per period, for catch-up math), and
`scripts/lib/menu/crons.mjs`'s `EVE_SCHEDULES` (for the /menu → ⏰ display). Changing one
schedule's cadence means remembering to update up to three files by hand; a missed one
would make the menu display (or the catch-up math) silently wrong. Fixing this properly
means either introducing a single shared schedule-metadata source all three read from, or
adding a CI check that parses and cross-validates the three copies — both a heavier lift
than the rest of this pass, so deferred rather than done here.

## 12. scripts/autograph is a deliberate fork of smixs/autograph

Since the 0.3.12 round the bundled engine (`scripts/autograph/`) and the standalone
[smixs/autograph](https://github.com/smixs/autograph) skill have intentionally diverged:
iva's copy resolves wiki-links before the embed exemption and knows the rollup calendar
(managed-card health, `expected_future_link`, `--as-of`), while the standalone skill got a
generic `raw_dirs` mechanism and its own newer `cleanup.py` (schema-driven
`description_max_chars`, symlink guard, mtime race check). Owner's decision: this is a
fork under iva's vault contract, not drift to be merged back. Consequence to remember:
a contributor fix landing in one repo does NOT automatically apply to the other — when
touching graph/enforce/cleanup in either repo, check whether the sibling needs the same
fix by hand.

## 13. Two dual-language parser pairs lack shared golden fixtures

Two Markdown-parsing contracts are implemented twice, once in TypeScript and once in
Python, and must stay semantically identical: (a) frontmatter — `agent/lib/frontmatter.ts`
vs `scripts/autograph/common.py`; (b) the fence-aware H1/H2 section scanner added in
0.3.12 — `agent/lib/card-store.ts` (`outsideFences`/`h2Sections`) vs
`scripts/autograph/enforce.py` (`_outside_fences`/`_sections`). Pair (a) already broke
once in both parsers simultaneously (blank line inside a folded block, fixed in 0.3.11).
Neither pair is tested against shared fixtures today. Planned fix: a directory of golden
fixture files (input Markdown + expected normalized JSON) that both the Node test suite
and `scripts/autograph/tests/test_autograph.py` read and assert against, for both
contracts. Note the result shapes differ (TS returns fields, Python returns a tuple), so
fixtures should compare a normalized field dictionary only.
