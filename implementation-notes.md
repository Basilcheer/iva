# Implementation notes

## Structured Telegram reply context (IVA-009 / #53)

- Eve keeps quoted text and media only in `raw.reply_to_message`; IVA now adds one
  bounded JSON item to model context after the normal allowlist gate.
- The item marks the quote as untrusted and uses JSON escaping rather than
  prompt-like delimiters. Quotes, Unicode and newlines remain data.
- Quoted media exposes only its type, bounded filename and caption. Telegram file
  IDs, unique IDs, MIME metadata and bytes are excluded, and quoted files are
  never downloaded again.
- Empty or malformed replies add no context. Oversized content is truncated by
  Unicode code point and reports that fact through the item's `truncated` field.
- Reply text and captions pass through the existing inbound security gate.
  Informational sanitizer signals (for example, Cyrillic lookalikes) preserve
  normal UX; blocked content, role markers and override attempts get an adjacent
  untrusted-data warning.
- User names, usernames, channel titles and media filenames use the same bounded
  sanitizer path. Invalid IDs and unknown sender-chat types are omitted. Replies
  from channels and anonymous admins use bounded `sender_chat` metadata, including
  when Telegram also supplies its `GroupAnonymousBot` placeholder. A malformed
  sender-chat identity falls back to the validated `from` author.
- Telegram reply message IDs must be positive safe integers; malformed or
  oversized values are rejected before serialization.
- Private/group/topic routing and Eve's existing HITL reply path remain unchanged;
  the reply item is only additional context for messages that already dispatch.
  In particular, a quote does not wake a silent sticker or animation.

## Checked systemd activation (IVA-003 / #54)

- All CLI systemd mutations now go through `scripts/lib/systemd-control.mjs`. A non-zero
  command raises a sanitized error with a fixed per-unit journal hint; captured command
  output and process environment are never copied into diagnostics.
- Activation is idempotent and succeeds only after every requested unit reports both
  `enabled` and `active`. Restart also verifies the final active state.
- `install.sh` keeps unit rendering in `_install-units` and delegates activation to the
  same checked `_activate-units` seam used by `iva start` and doctor.
- Doctor records individual activation failures and keeps checking neighboring units.
  Destructive reset still stops fail-closed and attempts to restart services after a
  partial quarantine failure.
- Uninstall cleanup attempts every unit disable and file removal, then daemon reload and
  failed-state reset. It reports a bounded aggregate error only after all steps run.
- A verified update commits its transaction before activating the automatic update timer.
  Timer activation failure keeps the verified build, exits non-zero, and uses a dedicated
  diagnostic in terminal and Telegram instead of entering the build rollback path.
- No activation polling was added. The activated long-running services use systemd's
  synchronous `Type=simple` start semantics, and timer start jobs return in their active
  waiting state, so a synthetic `activating` transition would not model these units.

## Aimasters.Me user-feedback backlog (2026-07-28)

- Source evidence, issue triage, source-message links and links to attached screenshots/video are in
  [`notes/backlog/2026-07-28-aimasters-iva-feedback.md`](notes/backlog/2026-07-28-aimasters-iva-feedback.md).

## Release 0.3.4

- Patch version only: no dependency or runtime change is introduced by the release commit.
- The existing Unreleased contributor-audit notes become the dated 0.3.4 changelog.
- Both root README files summarize the same three user-facing themes: model-aware thinking controls, scoped Telegram recovery on Eve 0.27.8, and data/security hardening.
- The Russian README's stale Eve 0.24.4 reference is synchronized to 0.27.8.

## Model-specific reasoning buttons

- Reimplemented the useful part of PR #34 on current `main`, while keeping its author credited in the new draft PR.
- The Telegram wizard remains the only configuration UI. A selected Codex model carries its own live reasoning levels in the in-memory flow state.
- `/models` is fetched once per screen load. No cross-process cache or generated reasoning-level file is introduced.
- Network, empty and malformed Codex catalogs fall back to `low`, `medium`, `high`. Runtime validation accepts the stable protocol set through `max`; `ultra` stays unsupported.
- Non-Codex providers skip the reasoning screen and clear the inactive global effort value when their model is saved.
- Old callbacks are rejected by both Telegram message ID and wizard step, so an earlier screen cannot mutate a later screen in the same edited message.
- Every wizard-owned network result checks object identity on both success and error; a cancelled/replaced flow cannot resurrect itself with a late response.

## Eve 0.27.8 scoped reset

- Scope: upgrade Eve to 0.27.8, preserve deterministic prompt-error terminal classification,
  and replace Telegram-wide workflow quarantine for `/new` with a reset of the exact
  Telegram continuation token.
- `/restart` must first reset the same Telegram session, then restart only `iva.service`.
  `iva reset` remains the explicit global recovery operation.
- The reset endpoint is internal to the Telegram channel and authenticates with
  `TELEGRAM_WEBHOOK_SECRET_TOKEN`; it must not use the generic `eveChannel` reset endpoint.
- The bridge already serializes Telegram updates and persists delivered update IDs. A reset
  request must not mutate run-status or queues until Eve confirms success.
- `/clear` and `/compact` are removed from bridge aliases and public docs because they have
  no distinct semantics.
- Eve 0.27.8 requires `ai ^7.0.34`; the previous 7.0.29 override was upgraded to 7.0.39
  so the framework does not run outside its declared peer contract.
- Successful resets keep an idle token tombstone. This makes a replayed group `/new`
  idempotent after a bridge crash while removing the old session id so late terminal events
  cannot mutate the new conversation state.
- In a group/topic, an explicit reply to Iva's own numeric bot id selects that reply anchor
  ahead of the last stored topic token. Replies to other bots are rejected.
- Telegram queues are keyed by chat/topic, while Eve group sessions also include a reply
  `conversationId`. Private reset clears its queue before publishing idle state; group/forum
  reset preserves the shared queue so messages for other anchors are not lost.
- Queue rewrites use a unique same-directory temp file plus atomic rename. A failed reset
  queue write is reported and leaves the old running status in place; malformed queue JSON
  is strict during reset and quarantined during ordinary polling so the bridge stays live
  without silently overwriting the damaged bytes.
- Run status is stored per chat under `data/run-status.d/`. The old whole-map
  `data/run-status.json` remains a read fallback and each touched key migrates lazily.
  Per-chat O_EXCL locks have bounded waiting and stale-owner recovery; atomic conditional
  updates keep late Eve terminal events from overwriting a reset or a fresh session.
  A malformed per-chat file is quarantined alone, so neighboring chats keep working.
- Global `iva reset` uses one collision-safe quarantine operation stamp for both Eve
  workflow locations, `run-status.d`, legacy `run-status.json`, and
  `telegram-queue.json`. Services are already stopped, every file/directory keeps private
  permissions, and any target failure participates in the existing incomplete reset report.
- Legacy private chats can reconstruct their stable token immediately. A legacy group with
  no stored event token must send `/new` as a reply to Iva's latest message once; future
  events persist the exact token automatically.
