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

eve rebuilds `agent/` at service start, so a specifier there that resolves into
`scripts/` drags operational code into the bundle — the failure behind the 0.3.14 crash
loop (issue #176). The target is zero such specifiers.
`scripts/authored-tree-guard.test.ts` lists the escapes that remain and fails on any new
one; the list is a record of what is blocked, not a budget to spend, and removing an entry
never turns the suite red.

Moved to their canonical home in `agent/lib` so far: `telegram-continuation-token`,
`telegram-acceptance`, `run-status`, `settings`, `i18n`, `telegram-format`,
`security-gate`, `telegram-reply-context`, `telegram-reset-route`, `telegram-turn-start`,
`schedule-runner` and the write half of `usage`. `scripts/` consumers reach them through
the `#lib/` alias instead of the other way around.

Seven escapes remain, blocked by two different constraints.

**Five are blocked by the CLI, and no ownership change unblocks them.** `iva` has to work
on an install whose `agent/` is missing or half-written — that is the state `iva repair`
exists for (ADR-0003) — so a module the CLI needs cannot live in the authored tree, and
`agent/` reaches into `scripts/` instead:

- `agent/instrumentation.ts` → `config-transaction`, `schedule-migration`, `timezone`,
  and `agent/provider.ts` → `model-catalog`: all statically reachable from
  `scripts/cli/*`, so moving them breaks `iva` at load time.
- `agent/provider.ts` → `codex-oauth` (`iva login`): reached only through a dynamic import
  in `scripts/cli/account.ts`, so the load-time walk in the guard misses it — but
  `scripts/cli/account-entrypoints.test.ts` runs the command against a fixture holding
  only `bin/` + `scripts/`, and a move fails there.

`usage` was the sixth and is closed: `iva usage` needs the report, the hook needs the
append, and the two halves share nothing but the log file itself. So the write contract
(record shape, path, `appendUsage`, `subagentTurnId`) moved into `agent/lib/usage.ts` and
the reporting stayed in `scripts/lib/usage.ts` — which knows the same path, and a
round-trip test in `scripts/lib/usage.test.ts` writes through one half and reads through
the other so the halves cannot drift apart silently. The remaining five have no such seam:
what the CLI and the authored tree share there is behaviour, not a file, and closing them
needs a different mechanism — a small shared payload the bundle can carry and `iva repair`
can restore, or a CLI that degrades when the authored tree is gone.

**Two are blocked by ownership only.** `agent/instructions/20-core.ts` →
`scripts/lib/core-cap.ts` and `scripts/memory/core-clamp.ts`: the cap and its clamp are
shared with the nightly rollup and the doctor, so the move rewrites imports under
`scripts/memory/`, and lands with the release that owns those paths. Nothing
architectural stands in the way.

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

## 8. TypeScript-only Node source

The repository migration is complete. New Node.js source and tests must be TypeScript;
JavaScript modules must not be added. Five permanent, logic-free `.mjs` entry shims keep
externally installed paths stable: `bin/iva.mjs` and
`scripts/{telegram-poll,check-update,setup,init-vault}.mjs`. All implementation belongs
in the TypeScript modules behind those shims.

## 9. Upstream feature request: catch-up for missed schedule runs

If the box is down when an eve schedule would have fired, the run is simply skipped
— there's no catch-up on next start, unlike systemd's `Persistent=true` timers. Worth
filing as a feature request against `vercel/eve`.

**Workaround implemented here**: `scripts/lib/schedule-migration.ts`, run fire-and-forget
from `agent/instrumentation.ts` on every server start, replaces `Persistent=true` for the
four memory-rollup schedules (`agent/schedules/memory-*.ts`). It compares each period's
last recorded success (`data/rollup-status.json`) against its most recent
timezone-aware scheduled point and runs it once if stale and still within a grace window
(20h daily / 3d weekly / 7d monthly / 14d yearly) — home-grown, and specific to this app's
four schedules, not a general answer other eve apps could reuse. Superseded if/when eve
grows a native catch-up story.

## 10. Rollup-turn workarounds for vercel/eve#1450

`scripts/lib/rollup-turn.ts` and the timeout/safety-net logic in
`scripts/memory/rollup.ts` work around an open upstream bug
([vercel/eve#1450](https://github.com/vercel/eve/issues/1450)). Once that's fixed
upstream, remove the workarounds rather than leaving them as permanent scaffolding.

## 11. Cron/name metadata duplicated across schedules, migration, and the menu

The same 5 schedule names + cron expressions used to be hand-maintained in three places:
`agent/schedules/*.ts` (the actual cron strings), `scripts/lib/schedule-migration.ts`'s
`PERIOD_SCHEDULE` (hour/minute per period, for catch-up math), and
`scripts/lib/menu/crons.ts`'s `EVE_SCHEDULES` (for the /menu → ⏰ display). Changing one
schedule's cadence meant remembering to update up to three files by hand; a missed one
would make the menu display (or the catch-up math) silently wrong.

RESOLVED: the table lives once, in `agent/lib/schedule-table.ts` (`SCHEDULE_CRON`), and
all three read it — the schedule files take their `cron` from it, the migration places its
catch-up point with `parseCron()`, time of day and day constraint alike (it keeps only
its own per-period grace window, which is catch-up policy, not schedule metadata), and the
menu renders the entries in table order. `agent/lib/schedule-table.test.ts` cross-checks
all three against the table — the migration through its behavior, by bisecting the point
where a recorded success stops counting as stale and checking that instant against the cron
— and fails if any cron expression reappears in another source file, so the copies cannot
silently grow back.

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
RESOLVED after 0.3.12: shared golden fixtures live in
`scripts/autograph/tests/golden/` (input Markdown + expected normalized JSON per case);
both `scripts/golden-parsers.test.ts` (CI node glob) and
`scripts/autograph/tests/test_autograph.py` assert against the same expectations. The
result shapes differ (TS returns fields, Python returns a tuple), so fixtures compare a
normalized form only: fields+body for frontmatter, outside[] plus [start,end) section
ranges for the scanner. Known dialect divergences deliberately NOT covered (quoted commas
inside flow-list items, mixed-quote stripping) — fixtures encode the shared contract;
extending it means adding a fixture first.
