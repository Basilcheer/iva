# Implementation notes

## Telegram direct-delivery acceptance (#87 / #91)

- Every bridge-originated message update, including reply-to-bot bypasses and the
  memory-distillation synthetic, carries an authored receipt through
  `/eve/v1/telegram/accepted`. HTTP 204 is success only with a `turn` or `handled`
  acceptance header. Callback queries remain on `/eve/v1/telegram`: the authored
  acceptance wrapper observes `onMessage` and `send()`, not `onCallbackQuery`.
- Acceptance HTTP 503 means the authored webhook finished without a successful Eve
  dispatch. It uses the existing bounded-drop retry count even though an ordinary
  503 remains a transient unbounded retry. Authentication and route failures keep
  their long-lived configuration retry, while other server failures keep the normal
  transient policy. A missing acceptance header and an explicit acceptance timeout
  also use bounded-drop handling.
- Direct delivery intentionally supplies no short client timeout. The acceptance
  handler waits for the real turn start, which may be slower than the durable drain's
  five-second fairness budget. Queue timeouts retain the on-disk head for a later pass
  and do not run direct-ingress cleanup.
- A definitive direct failure compares the current run status with the generation
  seen before delivery. Only a newer, session-less early ingress whose timestamp falls
  inside that attempt is changed to idle, using a CAS over generation, update time and
  ingress ID. Each failed retry cleans its own working status, while the chat receives
  one retry-or-`/new` notice for the whole direct delivery.

## Telegram stale-run reaper (#85 / #87 / #91)

- Each polling pass scans only per-chat records in `data/run-status.d`; the legacy
  whole-map remains read-only compatibility state.
- A stale `running` record is retired with a generation and timestamp CAS. A refresh
  or terminal event that wins the per-chat lock makes the reaper skip all side effects.
- The reaper calls Eve's scoped Telegram reset route only to release the recorded
  continuation token. It preserves the durable queue and all vault and daily state.
- Any chat present in the queue drain's in-memory gate is skipped for that pass. After
  a successful CAS, reset, notification, and working-message cleanup are isolated so
  one failed best-effort operation cannot stop the polling loop.

## Explicit inbound truncation (IVA-013 / #59)

- `sanitizeInbound()` keeps the 50,000-character safety cap, applies it on
  Unicode code-point boundaries, and reports the exact number of omitted code
  points as `truncatedChars`.
- Telegram model context adds a clear truncation notice for sanitized queued
  messages, media transcripts, captions, and security-flagged ordinary text.
  The notice includes the full daily-record path only after that complete source
  has been appended successfully.
- Queued compatibility input is appended verbatim before its model copy is
  sanitized. Media bytes, full transcripts/captions, and ordinary messages keep
  their existing append-only storage behavior.
- Clean ordinary Telegram text retains Eve's original pass-through path, so a
  harmless long message does not gain a synthetic context marker.

## Strict live model validation (IVA-005 / #55)

- Ollama Cloud, OpenCode Go and Codex selections come only from a successful, non-empty
  live catalog. Static IDs remain suggestions and cannot resurrect a retired model.
- OpenRouter uses the same shared validator with a minimal chat request carrying a
  `ping` function definition. Any HTTP 200 accepts the key, slug and tools request even
  when a reasoning model exhausts the small probe budget before visible output.
- Telegram shows a stale configured model for reference but never as a button, rejects
  forged indices, and validates again before one atomic provider/model/effort/key update.
- A newly entered key stays in wizard memory until the model passes validation. Network,
  authentication, empty/malformed catalog and changed-catalog failures leave `.env`
  untouched and render Retry/Back controls, including the `/think` catalog path.
- Interactive setup calls the same validator immediately before its atomic full-file
  write, so a provider change during later setup steps cannot persist a stale selection.
  Keeping byte-equivalent existing settings skips that rewrite; any changed keep-path
  value validates the configured model first.

## Real userbot health (IVA-010 / #58)

- The runtime probe will query a read-only health route on the already-running proxy.
  It must never import or open another Telethon client or session.
- The public states are limited to `off`, `starting`, `unreachable`, `unauthorized`,
  and `ready`. A rejected local bearer maps to `unreachable` with a fixed reason,
  while `unauthorized` is reserved for the Telegram account login state.
- The whole probe, including systemd and HTTP checks, shares one 1.5-second deadline.
  Results contain only fixed state and reason values, so command output cannot echo
  bearer tokens, subprocess output, URLs, or transport exceptions.
- Telegram setup remains asynchronous to keep the polling loop responsive. A non-zero
  child exit now becomes a bounded, redacted error and is rendered back into the menu.

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

## IVA-001 bash process lifecycle

- Host bash runs in its own POSIX process group with stdin closed. Timeout sends `SIGTERM`,
  waits 400 ms, then sends `SIGKILL` and waits another bounded 400 ms. Timeout classification
  checks the root process state, so a delayed Node exit event does not produce a false timeout.
  A per-call worker observes the monotonic deadline and enforces it even while the main Node
  event loop is blocked. Linux uses `/proc` for root state; macOS uses the POSIX `ps` state
  so an exited zombie is not reported as timed out. If neither probe can establish state,
  cleanup fails closed with an explicit error.
- The schema and runtime accept deadlines from 100 through 2,147,483,647 ms. The lower bound
  gives a newly started worker time to observe the process; the upper bound matches Node's
  maximum timer delay and prevents overflow warnings and a hot rescheduling loop.
- Spawn resource failures are handled before PID, stream, worker or timer setup and return a
  bounded structured error; an `EMFILE` condition cannot crash the host process.
- Lifecycle handlers and the main-thread deadline are armed before the optional deadline
  worker. If worker initialization fails under resource pressure, execution continues with
  the main-thread deadline fallback and cannot orphan the spawned process group.
- The same group cleanup runs after a normal shell exit, so background descendants cannot
  outlive the tool call while they remain in that group. A process which deliberately creates
  a new session with `setsid`, or a manager-owned job such as `systemd-run`, has its own
  lifecycle outside this process-group contract.
- Stdout and stderr are consumed as streams while retaining the existing last-30,000-character
  result contract, cwd reporting and truncation marker. After bounded group cleanup, inherited
  output pipes are closed so a process outside the owned group cannot hold the tool call open.

## IVA-008 durable Telegram follow-up FIFO

- Busy-time follow-ups are stored in `data/telegram-queue.json` as schema version 1.
  Every FIFO item has its own version, the Telegram `update_id`, enqueue time, and the
  untouched raw update. The bridge does not download files or reconstruct quoted data
  while queueing.
- A queue write stages a unique 0600 file, fsyncs it, renames it atomically, and fsyncs
  the parent directory. Write, rename, and durability failures propagate to the polling
  loop. The Telegram offset advances only after enqueue succeeds. A duplicate retry also
  repeats the atomic write, closing the window where rename was visible but directory
  durability was not yet confirmed.
- Delivery is at-least-once. Queued replay uses an authenticated authored route which
  runs Eve's production Telegram handler and returns HTTP 204 only after its deferred
  `send()` has resolved, or after the authored `onMessage` explicitly resolves to `null`
  for a marked queue replay (for example a location saved to the daily log or a silent
  sticker). The random replay marker exists only in the outbound copy and is removed
  before authored message handling. Throws, malformed input, unmarked no-send paths and
  rejected `send()` calls do not produce a receipt. The durable head stays present until
  that receipt; an ordinary webhook HTTP 200 is not acceptance. A crash after acceptance
  and before the removal write can replay that one head; later items cannot pass it. If
  Before publishing an acknowledgement removal, the bridge fsyncs the original document
  as a pending-ack backup beside the queue. Successful acknowledgement durably removes
  that backup. Startup and every queue load restore any surviving backup first, closing
  the SIGKILL window between removal rename and directory fsync. A failed rollback raises
  a fatal durability error and stops polling.
- The bridge drains one eligible head per idle private chat, group, or forum topic per
  pass. One five-second budget covers the whole pass, and the next pass rotates past the
  last attempted key, so many stalled heads cannot multiply polling latency or starve a
  later chat. A failing head stays durable for a later pass. A short long-poll while
  queues exist observes terminal events quickly. A stale run-status also becomes
  drainable through the existing `isRunning()` TTL.
- `turn.started` publishes `running` before the Bot API working-status request. After an
  accepted queued turn, an in-memory per-key gate must observe that `running` state and
  its later idle transition before the next FIFO head can start. Every per-chat status
  write advances a generation, so a running-to-idle cycle completed between bridge polls
  also releases the gate. If no status write is observable, the gate uses the same bounded
  stale-run horizon as `isRunning()` and still refuses release while a run is visible.
  Intentionally handled no-send updates are identified by the authored acceptance route
  and bypass this turn gate.
- Private `/new` and `/restart` write and fsync a per-chat reset intent before asking Eve
  to reset. Queue cleanup and the idle tombstone happen after remote success, then the
  intent is durably removed. Startup reconciles every remaining intent before polling or
  queue draining, so a crash or ambiguous response after remote success cannot release
  messages from the retired private session.
- New updates join an existing FIFO even during the idle transition, preserving arrival
  order. Replies to bot messages and callbacks retain their immediate HITL path.
- Queue admission is fail-closed on `TELEGRAM_ALLOWED_USER_IDS`. Private owner messages
  are eligible; group/topic messages additionally need a bot command or mention.
  Mentions match the exact Telegram username with Unicode-aware token boundaries and
  validated UTF-16 Telegram entities. Unaddressed group traffic is consumed without
  entering later model context.
- Each successful enqueue gets a reaction plus an explicit per-chat/topic queue count.
  The count is sent after the durable write and offset update.
- Legacy `{chatKey: string[]}` files migrate atomically. Each string becomes a versioned
  item with a stable synthetic update id and remains present until accepted by Eve.
  Group/topic text whose sender was not recorded is published to a unique, fsynced
  `.legacy-unattributed-*` sidecar through a no-clobber hard link; the exact path is
  logged and a later migration cannot overwrite an earlier archive.
- Queue maps use own data properties for every chat key, including `__proto__`, so JSON
  migration, enqueue, reload, and acknowledgement cannot silently lose that key.

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

## Transactional configuration apply

- `iva config` writes the interactive result to a private temporary candidate. The live
  `.env` remains untouched until the user confirms apply and the shared live model
  validator accepts the final provider/model selection again.
- Apply persists a versioned 0600 rollback snapshot, atomically replaces `.env`,
  regenerates the port-bearing units, restarts both the agent and Telegram poller through
  the checked systemd adapter, and waits for local `GET /eve/v1/health`.
- Any write, restart, health, or commit failure restores the exact previous bytes and
  restarts the old setup. A failed rollback keeps the durable snapshot and reports
  `iva config --recover`; the next `iva config` also reconciles it before showing setup.
- Snapshot and provider errors are redacted using secret-bearing env keys. Temporary
  candidate data is mode-protected and removed when the config command returns.
- An occupied unchanged port is no longer attributed to Iva heuristically. The setup
  requires an explicit negative-default confirmation before reusing it, otherwise it
  offers the nearest free port.

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

## Continuation-token namespace on reset (#110)

- Eve exposes the same continuation token in two shapes, and only a real reset tells them
  apart. Event `data` for `session.waiting` carries the channel-local token
  (`<chatId>:<thread>:<conv>`); `channel.continuationToken` inside event handlers carries the
  namespaced one (`telegram:<chatId>:<thread>:<conv>`), because Eve builds it from
  `ctx.session.continuationToken`.
- The channel-owned reset route prepends the channel name itself. A namespaced token reaching
  `/eve/v1/telegram/reset` therefore resolves as `telegram:telegram:…`, finds no owner and
  returns the idempotent `no_active_session` — which the bridge correctly treats as success.
  That is how `/new` reported a cleared context while the session kept its whole history.
- Everything Iva persists in `data/run-status.d/` and sends to reset must be channel-local.
  `toChannelLocalToken()` strips exactly the known `telegram:` prefix — not a guessed leading
  segment, because group chat ids are negative and the token shape is Eve's contract, not our
  heuristic. It is idempotent, so it can be applied at every boundary:
  - on write — `agent/channels/telegram.ts` (turn start, turn finish, `session.waiting`),
    `scripts/lib/telegram-turn-start.mjs` (both the claim and the adoption path) and the
    reset tombstone in `completeScopedResetState`;
  - on read — `continuationTokenForControl`, the stale-run reaper (which reads
    `status.continuationToken` directly) and `reconcileScopedResetIntents` (a durable intent
    may have been written by an older version).
    Statuses poisoned by earlier versions therefore heal on the next turn or `/new` instead of
    needing a migration.
- On an Eve bump: re-check what `channel.continuationToken` yields in event handlers. If Eve
  ever hands out the channel-local token there, the helper stays correct (it is idempotent),
  but `scripts/lib/telegram-reset.test.mjs` is the place that pins the expectation. If the
  channel name ever changes, `NAMESPACE` in `scripts/lib/telegram-continuation-token.mjs`
  must change with it.
- The reaper fixture in `scripts/telegram-poll.test.mjs` deliberately keeps a namespaced
  `continuationToken`: that is what pre-fix versions wrote, and the assertion pins that a
  reset goes out channel-local anyway.
- A token that does not look channel-local after the strip (`^-?\d+(:|$)`) is reported to the
  bridge log instead of throwing, so the next change of token shape shows up in `journalctl`
  rather than repeating #110 silently. `CHANNEL_LOCAL_SHAPE` and `NAMESPACE` describe the same
  contract — change them together.
- The bridge logs every reset outcome (`reset for chat <key> -> <status> (token <token>)`) on
  both the `/new` path and intent reconciliation. `reset` and `no_active_session` deliberately
  share one user-facing message — the second status is the legitimate idempotent repeat — so
  the log is where the two are told apart.

## Usage accounting keys (#110)

- One line per model step in `data/usage.jsonl`, grouped into turns. `sessionId:turnId` is not
  unique on its own: Eve numbers turns per session as `turn_<sequence>`, so a week-old `turn_0`
  and today's `turn_0` look identical, and an inline subagent restarts the counter while the
  hook records its steps under the _parent_ `sessionId`.
- The write side removes the ambiguity: a subagent step is logged with the parent's turn id and
  a suffix, `<parent turnId>#<subagentName>` (`agent/hooks/usage.ts`). The key is unique by
  construction, and the part before `#` keeps the step attached to the parent turn, so the
  subagent's spend still counts towards that turn's total.
- The reader groups by the part before `#` and takes the context from the last record without a
  suffix — the main session's own step. The `subagent` field is checked too, as defence in depth
  for records written before this invariant (there are none in production).
- `contextFromSubagent` marks the honest fallback: a turn made only of subagent records (the
  outer turn was cancelled or failed) renders as `context ~19 800 (subagent step)` instead of
  passing a subagent's input off as the chat context.
- `scripts/replica-smoke.mjs` runs a reset canary against the real framework: seed a marker,
  `session.reset()`, return with the same continuation token and assert the marker is gone.
  It guards Eve's documented contract ("reset retires a session so its continuation starts
  fresh"), which 0.27.13 honours — the `/new` failure was Iva's token shape, not Eve's reset.

## Telegram event identity (v0.3.11)

- `file_unique_id` keys only the reusable blob and derived vision/transcript data. A new
  `update_id` still appends a new daily reference and starts a new turn.
- The completed-update ledger is written after authored `turn` or `handled` acceptance.
  The narrow crash window before that atomic write remains intentionally at-least-once.
  Deduplication requires the configured webhook secret and a matching
  `x-telegram-bot-api-secret-token`. A missing configured secret disables deduplication and is
  reported once. The ledger is scoped to the numeric, non-secret bot id from the bot token, so
  replacing a bot cannot suppress an unrelated update with the same id. It keeps the latest
  200 ids; an older replay starts a new turn. A simultaneous duplicate can also run before
  either acceptance is recorded; the normal durable queue serializes deliveries, and
  exactly-once is out of scope.
- Invalid JSON is quarantined; invalid parsed schema is logged. Both cases recover to an empty
  bot-scoped ledger and rewrite a clean file. Operational read failures still propagate. A
  post-acceptance ledger-write failure is logged while the 204 receipt is preserved, preventing
  a successful turn from entering a deterministic retry loop.
- Media-cache reads are optional at the processing boundary. An operational read failure is
  logged and treated as a miss, while the incoming media continues through download and
  derivation.
- A thrown vision or transcription derivation stores the reusable blob path without that
  derivation field. A later delivery reuses the blob and retries the provider, while the
  presence of an empty string records a successful empty result.
- Both stores use the existing JSON-store primitives and bounded JSON files under
  `ASSISTANT_DATA_DIR`; no delivery timeout or direct-delivery policy changed.

## Rollup writer safety (v0.3.11)

- База ветки: `origin/main` (`b464b74a22eb4f2c0dce4ab888d2a9b62bad0658`).
- Fresh retry сохраняет прежнюю единственную попытку только для явно отклонённого `send` или терминально подтверждённой отмены.
- Зависший до разрешения `send` считается потенциально принятым сервером: ответ `cancel: accepted` только принимает сигнал и не разрешает retry. Безопасную границу подтверждает `no_active_turn` либо событие `turn.cancelled` в дочитанном потоке.
- При неподтверждённой отмене сохранённый курсор остаётся на диске, а исходная ошибка выходит наверх.

## Security honesty and documentation sync (v0.3.11)

- Media-processing errors use the same token-redacted detail in user messages and model
  context. A regression drives the real Telegram webhook path and inspects Bot API output.
- The security skill now names only `security-gate.ts` as runtime enforcement. Its Python
  utilities and JSON patterns are documented as manual tools; reminder-related patterns
  were removed and no patterns were added to `bash.ts`.
- Runtime topology, Eve version, schedule cadence, skill count, Google Tasks support and
  open-task menu counting are synchronized across the requested documentation surfaces.
- The flat `documents` skill uses only installed system tools and an ephemeral `openpyxl`
  environment. Failed PDF text extraction is reported honestly; optional library imports are
  split into searchable chunks capped at 8000 characters.
- Telegram's automatic `attachments` and `daily` ingress archive is now distinguished from an
  explicit library import. The skill pins ephemeral `openpyxl` 3.1.5 and serializes document
  frontmatter through the existing `formatField` helper, including hostile scalar edge cases.
- Telegram error redaction runs before the 200-character bound, and the acceptance test checks
  both the user reply and model context when a token crosses that boundary in a multipart update.
- Media error reporting also handles arbitrary JavaScript throw values, including `null` and
  `undefined`, without replacing the original failure with a secondary property-access error.
- Owner-explicit local paths remain supported as required by the document-skill contract. A
  vault-only path allowlist was rejected because it would remove that requested capability.
- CLI documentation keeps topology distinct from command coverage: `iva doctor` reads the
  four memory-schedule status records, while `iva status` reports systemd units only.
- PHILOSOPHY.md now records the project boundary rules and explicit removal points for
  local workarounds.

## Memory and configuration integrity (v0.3.11)

- TypeScript and Python frontmatter parsers keep blank lines inside block scalars. Strings
  containing newlines are serialized as literal blocks so parse-write-parse is lossless.
- One Intl-backed timezone validator is shared by setup, startup instrumentation, and the
  CLI unit generator. Runtime TZ is always assigned a validated zone or UTC.
- Per-chat run-status quarantines only JSON/schema corruption. Filesystem failures remain
  visible to callers and leave the original status path untouched.
- The real chmod-based EACCES regression is skipped under UID 0 because root bypasses
  discretionary permission bits; ordinary users and CI still exercise the filesystem path.
- CORE truncation removes a mutable bullet when fewer than two marker characters survive;
  a complete `-` plus its following space may still receive the ellipsis. Pointers remain
  immutable.

## Telegram offset durability (v0.3.11)

- Only ENOENT represents first run. Existing JSON, schema, permission, and I/O failures stop
  the bridge before `deleteWebhook(drop_pending=true)` or `getUpdates(-1)`, preserving
  Telegram's backlog for the systemd restart.
- Offset publication uses a private same-directory tmp file and one rename. Any save failure
  reaches the top-level fatal handler; the bridge never reports an unsaved cursor as durable.
- The first-run tail lookup also fails closed on Telegram or response-shape errors; falling
  back to offset 0 after such an error could replay the installation backlog. An actually empty
  Telegram result still stores offset 0. Per-call tmp suffixes avoid overlap.

## Schedule migration durability (v0.3.11)

- Memory catch-up baselines are seeded per key under the shared status lock. Existing
  digest state can no longer disable first-run storm protection for memory schedules.
- The seed transaction commits before legacy timer teardown; a failed seed leaves the
  retired persistent units available for another boot.
- Reservations record the owner process. A confirmed-dead owner is recovered immediately,
  while old ownerless markers keep the time-based compatibility rule.
- Completion and cleanup mutate status only while holding the status lock and keep a
  reservation marked locally until its removal write succeeds.

## fix/reminder-node-runtime

- Kept the security gate deterministic and dependency-free.
- Made the pure JavaScript module canonical so operational `.mjs` scripts work
  with stock Node runtimes that do not load TypeScript.
- Preserved the agent import contract through a thin TypeScript re-export.
- Reminder persistence across reboot remains tracked separately in issue #117.

## fix/memory-health-contract

- Health quality is scoped by the existing `node_types` and `path_type_hints`; raw
  transcripts remain append-only graph nodes and require no schema migration.
- Existing structural totals remain visible. Managed-card counters drive the score,
  while the general description ratio is exposed separately as `all_desc_coverage`.
- Future parents are recognized only for exact daily-to-weekly, weekly-to-monthly,
  and monthly-to-yearly relationships, including their scheduled creation day.
- An absent parent becomes broken the day after its rollup was scheduled to run.
- Audio embeds accepted by Telegram (`.ogg`, `.opus`, `.m4a`, `.wav`) are excluded
  from broken-link checks; similarly named Markdown files remain graph targets.
- `graph.py` discovers `<vault>/schema.json` for legacy CLI calls and falls back to
  all-node health only when no schema exists.
- Future rollup classification is structural even under legacy schemas; managed scope
  affects scoring, not whether an exact pending parent is considered broken.
- Doctor supplies its timezone-aware local day through `--as-of`, avoiding midnight
  disagreements between the Node orchestrator and Python graph process.
- A not-yet-materialized exact parent supplies a virtual incoming signal only for
  orphan scoring; persisted graph edges still contain resolved files exclusively.
- Wiki targets resolve before the audio-embed exemption, so a real `voice.ogg.md`
  note remains linkable while a missing `voice.ogg` attachment stays ignored.
- The full Node matrix initially hit the existing deadline-probe timing test once;
  its isolated rerun and the complete 568-test rerun both passed.

## Rollup card invariants (v0.3.11)

- `write_card` now accepts an explicit `ADD | UPDATE | SUPERSEDE | NOOP` decision.
  UPDATE owns one Log, SUPERSEDE owns Compiled Truth plus preserved History, and
  relations enter through one canonical Related section.
- Related identity ignores aliases and anchors. Links elsewhere in prose do not
  suppress a relation, and `body` cannot provide its own Related heading.
- SUPERSEDE replaces only Compiled Truth: old Log, History and Related content
  survives, newly supplied relations merge into that preserved graph structure, and
  custom H2 sections survive unless the replacement explicitly supplies the same heading.
- `enforce.py` repairs only unambiguous drift under `cards/`: dated update blocks
  migrate into Log, empty update headings disappear, and link-only Related blocks
  merge idempotently. Non-empty dated updates and ambiguous Markdown structures are
  reported as semantic compile candidates; complex/fenced blocks remain byte-identical.
- Raw daily transcripts and rollup summaries stay outside this cleanup scope.
- TypeScript and Python section scanners ignore fenced code, so documentation
  examples containing structural headings remain byte-identical.
- The dbrain skill chooses semantic operations, rereads every touched card, and
  consumes compile candidates; deterministic code keeps structural invariants.

## TypeScript migration (PR-0 through PR-12)

### 2026-08-06 (Asia/Tashkent)

- Bootstrap completed on `main` at `d099da5`: `npm ci`, `npm run typecheck`, and
  `npm run build` passed. The approved handoff plan remains an untracked local
  file at `notes/plans/2026-08-06-ts-migration.md` and is excluded from migration
  commits.
- The factual PR-0 baseline is 160 tracked `.mjs` files and 73 tracked
  `*.test.mjs` files. PR #151 added `scripts/golden-parsers.test.mjs` after the
  handoff recorded 159 and 72, so discovery equivalence uses 73 files.
- `@eslint/js` and `globals` are direct development dependencies because the flat
  config imports both. TypeScript is constrained to `~6.0.3`, matching
  typescript-eslint's `<6.1.0` peer range. A newly disclosed transitive
  `brace-expansion` audit finding was cleared by resolving its patched 5.0.9
  release before the dependency commit.
- Prettier uses its defaults because the plan sets no style overrides. The local,
  untracked handoff path is ignored so `npm run format` and `format:check` do not
  rewrite or reject that approved input.
- PR-0 must add `eslint.config.mjs`, increasing the post-infrastructure tracked
  count from 160 to 161. The PR-0 ratchet therefore starts at the factual 161;
  PR-12 will convert the config to `eslint.config.ts` so the final five-file
  acceptance remains reachable.
- The underspecified and overlapping conversion layers are partitioned uniquely:
  PR-1 handles the first 13 `scripts/lib` leaves; PR-2 the next 13; PR-3 the final
  nine leaves plus four menu leaves. PR-4 owns six middle core modules, six menu
  screens, and poller config. PR-5 owns six middle runtime modules, two menu
  screens, and poller transport/offset. PR-6 owns only the seven remaining poller
  modules and two fixtures; PR-7 owns the remaining menu service/index pair.
- Because PR-6's `poller/control.ts` must import the still-JavaScript menu hub, PR-6
  will add a narrow temporary `menu/index.d.mts` declaration and PR-7 will remove
  it with the real `index.ts`. This preserves the approved ordering and runtime
  import semantics.
- Final `.mjs` reference verification treats references to the five approved shim
  paths as an explicit allowlist. Install scripts, units, package metadata, and
  runtime string paths must keep those references; every other live `.mjs`
  reference must be removed.
- While starting PR-0, the existing implementation notes were accidentally
  replaced locally. They were restored byte-for-byte from `HEAD` before any
  commit, this append-only section was added, and the local rule now requires an
  additions-only diff check before committing notes.
- Typed lint exposed unchecked JSON and framework boundaries in existing
  TypeScript. Valid payload behavior is unchanged; malformed Telegram collector
  parts are now filtered, nonnumeric Telegram `message_id` values are ignored,
  and malformed persisted graph/schema/session/history objects take their
  existing empty/fallback paths. Non-finite persisted numeric values are also
  rejected. A regression test covers malformed collector entries.
- The existing run-status lock-timeout text includes its resolved lock path.
  PR-0 preserves that diagnostic to keep lint cleanup behavior-neutral and drops
  the caught OS error from `cause`; sanitizing the legacy message is deferred as
  a separate behavior change.
- The first post-Prettier full suite exposed that
  `scripts/autograph/tests/golden/` contains byte-significant parser fixtures.
  Seventeen formatted fixtures were restored from pre-migration `main`, and the
  directory is now ignored by Prettier. The same run also hit the existing
  `timeout leaves no TERM-resistant child PID behind` timing test once; that
  isolated test must pass before treating it as a blocker.
- The old explicit CI globs and Node 24 default discovery both select the same 73
  tracked test files. Both commands completed with 595 passing tests, so `npm
test` now uses `node --test`.
- Native Node coverage measured 72.62% lines, 79.13-79.15% branches, and 71.59%
  functions across repeated full runs. Integer floors of 72, 79, and 71 are the
  initial deterministic CI thresholds; later migration batches may only raise
  them.
- A local reproduction of the CI userbot gate creates `.venv-userbot/` in the
  repository root. Prettier traversed that generated environment on later local
  runs, so the environment is now explicitly ignored.
- PR-1 converts 13 leaf modules and 10 dedicated tests, removes three superseded
  declarations, and lowers the `.mjs` ratchet from 161 to 138. `core-cap`,
  `model-summary`, and `progress` already have characterization coverage through
  `core-clamp.test.mjs` and `update-ui.test.mjs`; no pre-conversion test gap was
  present in this batch.
- PR-1 keeps permissive runtime coercion at the core-interview and mock-provider
  fixture boundaries while exposing strict types to callers. Narrow lint
  suppressions document those two legacy coercions; application JSON boundaries
  use `unknown` and explicit record guards.
- PR-1 review identified three pre-existing behavior gaps, deliberately deferred
  from the conversion commit: the oversize-memory scan omits files present only
  in the Git index, the synchronous Docker port probe has no timeout, and
  `upsertEnv` accepts key names outside its parser grammar. Each requires its own
  regression test and behavior commit.
- 2026-08-06: PR-2 converts 13 additional leaf modules and 11 related tests, removes five
  superseded declarations, and lowers the `.mjs` ratchet from 138 to 114.
  `reasoning-levels` is characterized through the model and OAuth suites, while
  `telegram-reset-intent` was already exercised through the poller queue suites.
  A separate pre-conversion characterization commit adds its direct durable
  lifecycle, invalid-record, and filename-integrity cases so the native branch
  coverage gate has deterministic headroom.
- 2026-08-06: `telegram-queue.test.ts` still imports the eternal `telegram-poll.mjs` shim
  before the poller implementation moves to TypeScript. PR-2 adds the narrow
  temporary `scripts/telegram-poll.d.mts` bridge for the two exports that test
  consumes; PR-6 must delete it when the poller and shim boundary are converted.
- 2026-08-06: PR-2 typing review found five pre-existing behavior defects and leaves them for
  separate TDD fixes: quiz answer lookup accepts inherited/array property names
  such as `"length"` despite documenting invalid answers as neutral; quiz summary
  and persona fallback select the WVPF card but still crash on an unknown code;
  Telegram Markdown placeholder restoration can delete ordinary text matching
  two spaces, digits, two spaces; the Telegram HTML sanitizer preserves unsafe
  `javascript:` and `data:` anchor schemes; and outbound security findings retain
  the first 12 characters of matched credentials in `preview`.
- 2026-08-06: The first full PR-2 suite, run concurrently with the full typed
  linter, hit the unrelated timing-sensitive `minimum deadline is enforced while
the Node event loop is blocked` assertion once. Two later sequential suites hit
  the same assertion while unrelated VPS builds drove the load average above 11;
  every isolated rerun passed. The conversion does not touch the bash tool, and a
  complete clean suite is still required before push.
- 2026-08-06 07:02 Asia/Tashkent: The first full Node 24 suite after transfer to
  macOS exposed two pre-existing portability gaps. Rich-post compared realpath
  candidates against a symlinked `/var` data root, and two Linux process-group
  tests assumed `setsid` existed. Separate commits `59be5e7` and `63536a6`
  normalize the media roots and skip only those two cases when `setsid` is absent;
  the staged PR-2 conversion remained byte-identical at its handoff SHA-256.
- 2026-08-06 07:02 Asia/Tashkent: The next complete local suite passed cleanly
  after transfer: 594 passed, zero failed, and four expected platform skips (two
  existing `flock` skips plus the two unavailable-`setsid` cases).
- 2026-08-06 07:08 Asia/Tashkent: The first post-rebase full-suite retry hit the
  pre-existing 1.5-second `userbot-health-cli` probe budget once, returning
  `probe_timeout` under full-suite load. The PR-2 conversion does not touch that
  path; three immediate isolated reruns passed in 675, 590, and 584 ms. A clean
  full-suite retry remains required before push.
- 2026-08-06 Asia/Tashkent: PR-2 deliberately keeps `security-gate.mjs` and
  `telegram-format.mjs` canonical, with their `.d.mts` declarations and the
  agent's thin typed security-gate re-export. One-shot reminder timers still run
  `telegram-send.mjs` under stock system Node; converting either shared module
  before that entry point would recreate the 0.3.12 failure where bare Node loads
  TypeScript before sending. Their production conversion moves with
  `telegram-send` to preserve the runtime boundary; `security-gate.test.ts` stays
  converted and exercises the canonical JS module through its restored
  declaration. The corrected PR-2 scope is 11 production modules, 12 test files,
  three removed declarations, and an `.mjs` budget of 116.
- 2026-08-06 Asia/Tashkent: Full-suite discovery on the high-core local machine
  intermittently starved the existing 1.5-second `userbot-health-cli` integration
  probe even though repeated isolated runs completed in 584-675 ms. Both Node
  test scripts now cap file concurrency at four: this preserves automatic test
  discovery and the production timeout while preventing unrelated test workers
  from turning the timing assertion into a load-dependent failure. Two
  successive bounded full suites passed all 598 tests with the four expected
  platform skips.
- 2026-08-06 Asia/Tashkent: Independent post-conversion review found that the
  typed `systemd-control` cleanup helper had narrowed the legacy diagnostic
  fallback from duck-typed `cause.message || String(cause)` to
  `Error.message`. A separate regression fix restores the original behavior for
  error-like objects and empty `Error` messages; focused tests now preserve both
  cases without changing cleanup control flow.
- 2026-08-06 Asia/Tashkent: Review also found that converting
  `schedule-runner.d.mts` into the implementation had accidentally made the
  options argument optional to TypeScript callers. An exported overload restores
  the declaration's required options contract while the implementation keeps its
  pre-existing runtime default for untyped JavaScript callers. A compile-time
  regression assertion guards both sides of that compatibility boundary.
- 2026-08-06 Asia/Tashkent: Review confirmed a pre-existing search-key probe
  leak: Node removes `Authorization` on a cross-origin redirect but forwards the
  custom Brave and Exa/Parallel credential headers. A separate security commit
  sets `redirect: "error"`; the existing soft network-failure policy still
  returns `null`. The same response lifecycle now cancels unread bodies without
  allowing cancellation failures to change the probe result.
- 2026-08-06 Asia/Tashkent: The shared Telegram queue options had long accepted
  a nonce factory for quarantine paths, but atomic queue writes interpolated the
  function object instead of invoking it. A separate regression fix normalizes
  string and factory nonces at the write boundary; a direct test proves that
  each write asks the factory for a fresh value.
- 2026-08-06 Asia/Tashkent: Final PR-2 verification after all review fixes is
  clean: the exact suite reports 601 tests, 597 passed, zero failed, and four
  expected macOS skips. Coverage is 73.46% lines, 79.22% branches, and 71.69%
  functions; the delta from PR-1 is +0.64, +0.18, and +0.16 percentage points.
  Lint, formatting, the 116/116 `.mjs` ratchet, typecheck, build, replica,
  autograph 343/343, security-defense 45/45, deterministic userbot lock, and
  Python 3.12 userbot guardrail/health/compile gates all pass.
- 2026-08-06 Asia/Tashkent: Final adversarial review found three queue catch
  sites where TypeScript assertions had removed the source module's null-safe
  `error?.code` access at runtime. The separate compatibility fix restores
  optional access and directly proves that nullish injected filesystem/link
  failures are rethrown unchanged.
- 2026-08-06 Asia/Tashkent: Native TypeScript stripping had materialized
  type-only Error properties before their constructors ran, changing enumerable
  key order from the source JavaScript. `declare` keeps the fields type-only;
  constructor assignments now reproduce the original Rollup and systemd error
  serialization order, covered by direct regression assertions.
- 2026-08-06 Asia/Tashkent: The earlier PR-2 entries reporting 13 production
  modules / 11 tests / budget 114 and later 601-test verification are historical
  pre-boundary and pre-final-review snapshots, not the merge result. The final
  confirmed scope is 11 production modules, 12 converted test files, three
  removed declarations, and budget 116. After the last compatibility tests the
  exact suite is 604 tests, 600 passed, zero failed, and four expected macOS
  skips; coverage is 73.48% lines, 79.27% branches, and 71.64% functions, a
  +0.66 / +0.23 / +0.11 percentage-point delta from PR-1. Every remaining local
  and Python 3.12 gate was repeated successfully on this final tree.
- 2026-08-06 Asia/Tashkent: A second coverage run on the same final tree kept
  the stable 604 / 600 / 0 / 4 test result but reported 73.46% lines, 79.29%
  branches, and 71.64% functions. The preceding percentages are therefore one
  observed run, not invariant values: the verified range is 73.46-73.48% lines,
  79.27-79.29% branches, and 71.64% functions, with a conservative delta from
  PR-1 of at least +0.64 / +0.23 / +0.11 percentage points. Every observation
  remains above the enforced coverage baseline.
- 2026-08-06 Asia/Tashkent: PR-3 adds characterization tests for the four leaf
  modules that lacked direct coverage before conversion: update-channel,
  ts-esm-hooks, menu/root, and menu/skills. They are isolated in three atomic
  test commits and pass 26/26 on Node 24.19.0 before any production rename.
- 2026-08-06 Asia/Tashkent: PR-3 conversion work is partitioned into three
  file-owned local worktrees (core resolver/channel, runtime data helpers, and
  menu leaves). Only the final integrated branch will reach GitHub. This keeps
  the required PR sequence intact and avoids spending CodeRabbit's five-PR-per-
  hour allowance on intermediate work; no manual bot review pings are used.
- 2026-08-06 Asia/Tashkent: The core worktree transport branch was accidentally
  pushed to origin despite the local-only integration boundary. It never had a
  PR and therefore triggered no CodeRabbit review; the exact remote branch was
  verified and deleted immediately after its commit was integrated locally.
- 2026-08-06 Asia/Tashkent: Lead review of the integrated PR-3 conversion found
  type-only contract narrowing that the green runtime suite could not expose:
  `UsageRecord` had become readonly and `summarize` no longer accepted the
  declaration's dynamic string window. The implementation now preserves those
  public TypeScript contracts while retaining precise overloads; direct compile-
  time/runtime tests cover mutable records, dynamic windows, and the legacy
  missing-source fallback. The same review removed conversion-only optional
  child-stream/kill guards and restored exact null-safe coercion semantics at
  the usage and workflow-store boundaries.
- 2026-08-06 Asia/Tashkent: Final pre-commit PR-3 verification is clean on Node
  24.19.0: 632 tests, 628 passed, zero failed, and four expected macOS skips.
  Coverage is 74.14% lines, 79.52% branches, and 71.87% functions, a conservative
  increase of at least +0.66 / +0.23 / +0.23 percentage points over the highest
  observed merged PR-2 baseline. Lint, formatting, the exact 95/95 `.mjs`
  ratchet, typecheck, build, replica, autograph 343/343, security-defense 45/45,
  deterministic userbot lock, and Python 3.12 userbot guardrail/health/compile
  gates all pass. Scope is 13 production modules, 12 converted test files, and
  three removed declarations.
- 2026-08-06 Asia/Tashkent: `origin/main` remained at the PR-2 merge during the
  required PR-3 rebase. Every local and Python 3.12 gate was repeated on the
  committed tree. The second coverage run again reports 632 / 628 / 0 / 4 and
  74.16% lines, 79.55% branches, 71.87% functions. The verified PR-3 coverage
  range is therefore 74.14-74.16% lines, 79.52-79.55% branches, and 71.87%
  functions, with conservative improvement over PR-2 of at least
  +0.66 / +0.23 / +0.23 percentage points.
- 2026-08-06 Asia/Tashkent: CodeRabbit identified a pre-existing service-runner
  defect outside the conversion itself: `Promise.resolve(onFinish())` evaluates
  a synchronous callback before the promise exists, so a thrown completion hook
  could escape a child-process event and crash the bridge. A separate bugfix
  invokes the hook inside `.then()` and retains the rejection catch. The focused
  regression test failed on the inherited implementation and passes after the
  fix; the conversion commit remains unchanged. Post-fix verification is clean:
  633 tests, 629 passed, zero failed, and four expected macOS skips; coverage is
  74.14% lines, 79.55% branches, and 71.97% functions, with a conservative
  PR-2 delta of at least +0.66 / +0.23 / +0.33 percentage points. Lint,
  formatting, the exact 95/95 `.mjs` ratchet, typecheck, build, replica,
  autograph 343/343, security-defense 45/45, deterministic userbot lock, and
  Python 3.12 userbot guardrail/health/compile gates all pass. CodeRabbit's
  incremental review also noted that the first regression could pass without
  proving the hook ran; the test now records and asserts the callback invocation
  before checking that its synchronous failure was contained. The strengthened
  test leaves the suite at 633 / 629 / 0 / 4; its final coverage run reports
  74.14% lines, 79.56% branches, and 71.97% functions, extending the verified
  PR-3 range to 74.14-74.16 / 79.52-79.56 / 71.87-71.97%.
- 2026-08-06 Asia/Tashkent: PR-3 merged as #155 with merge commit `8c538dc`
  after CI passed, CodeRabbit approved the final head, and both review threads
  were resolved. The review cadence was checked against current CodeRabbit Pro
  documentation: the allowance is five PR review runs per developer in a rolling
  hour, and automatic incremental reviews after pushes consume the same allowance.
  PR-4 therefore stays local until its complete gate set passes; findings from its
  first hosted review will be batched into one fix push where possible.
- 2026-08-06 Asia/Tashkent: PR-4 follows the partition already fixed above: six
  middle core modules (`codex-oauth`, `model-catalog`, `model-validation`,
  `config-transaction`, `schedule-migration`, `memory/core-clamp`), six menu
  screens (`character`, `core`, `crons`, `gws`, `lang`, `search`), and
  `poller/config`. Direct TypeScript characterization is being added first for
  the three modules without a focused direct suite: menu core, menu language,
  and poller config. Three isolated worktrees own those tests; production code,
  the ratchet, and this log remain lead-owned until integration.
- 2026-08-06 Asia/Tashkent: PR-4's missing direct coverage was established before
  conversion in three atomic characterization commits: menu core (three tests),
  menu language (four tests), and poller config (four tests). All 11 tests passed
  against the original JavaScript modules before the production renames.
- 2026-08-06 Asia/Tashkent: The conversion integrates 13 production modules and
  nine existing test-file conversions, removes five superseded declarations,
  and lowers the `.mjs` budget from 95 to the exact tracked count of 73. All
  importer, tripwire, runtime-comment, and current deployment-document paths
  were updated in the same commit; historical CHANGELOG and notes references
  remain intentionally unchanged.
- 2026-08-06 Asia/Tashkent: Three independent adversarial reviews covered the
  core/auth, menu, and poller groups. They found conversion-only semantic drift
  at JavaScript exception and persistence boundaries: nullish transaction
  causes had lost optional `message` access, three menu screens had started
  coercing primitive errors, cron completion had narrowed legacy truthiness to
  boolean `true`, and valid JSON primitives had moved from GWS shape validation
  into the parse-error branch. The conversion now preserves the exact source
  semantics, and focused regression coverage passes 19/19. Review also confirmed
  the former declaration contracts, native Node 24 loading, and absence of live
  imports of the removed `.mjs` paths.
- 2026-08-06 Asia/Tashkent: Final pre-rebase PR-4 verification is clean on Node
  24.19.0: 648 tests, 644 passed, zero failed, and four expected macOS skips.
  Coverage is 74.99% lines, 79.22% branches, and 72.84% functions; versus the
  highest observed merged PR-3 values this is +0.83 / -0.34 / +0.87 percentage
  points, with all enforced 72/79/71 thresholds still satisfied. Lint,
  formatting, the exact 73/73 `.mjs` ratchet, typecheck, build, replica,
  autograph 343/343, security-defense 45/45, the deterministic userbot lock,
  and Python 3.12 userbot guardrail/health/compile gates all pass. The Python
  dependency gates used CI's pinned uv 0.8.3 rather than the host uv 0.8.4.
- 2026-08-06 Asia/Tashkent: `origin/main` remained at the PR-3 merge during the
  required PR-4 rebase. After a clean Node 24 `npm ci`, every local and Python
  gate was repeated on the committed tree. The second coverage run again reports
  648 / 644 / 0 / 4 and 75.03% lines, 79.29% branches, and 72.84% functions.
  The verified PR-4 coverage range is therefore 74.99-75.03 / 79.22-79.29 /
  72.84%, with a conservative merged-PR-3 delta of +0.83 / -0.34 / +0.87
  percentage points. The exact PR diff check remains clean, and only the two
  approved untracked handoff files remain outside Git.
- 2026-08-06 Asia/Tashkent: PR-4's first hosted CodeRabbit run produced six
  comments. Two requests to restore `.test.mjs` entry points conflict with the
  approved migration plan and are deferred to the planned PR-12 convention
  update. The request to make schedule-migration error normalization null-safe
  would change the source module's direct `error.message` behavior and was also
  rejected as conversion scope drift. The token-shaped poller fixture was
  cleaned up without changing its value. Two valid pre-existing boundary bugs
  were fixed in separate commits: Codex JWT account claims now accept only
  non-empty strings, and search-provider inputs now require own catalog keys
  instead of accepting inherited names such as `toString`.
- 2026-08-06 Asia/Tashkent: Post-review verification is clean: 650 tests, 646
  passed, zero failed, and four expected macOS skips. Coverage is 75.18% lines,
  79.27% branches, and 73.11% functions. Lint, formatting, 73/73 ratchet,
  typecheck, build, replica, autograph 343/343, security-defense 45/45,
  deterministic userbot lock, and Python 3.12 userbot gates all pass. The three
  review fixes will be delivered in one incremental push to conserve the Pro
  review allowance.
- 2026-08-06 Asia/Tashkent: PR-4 merged as #156 with merge commit `0723365`
  after the single batched review-fix push passed CI, CodeRabbit approved the
  final head, and all six review threads were resolved. Final scope is 13
  production conversions, nine existing test-file conversions, three new
  characterization files, five removed declarations, and `.mjs` budget 73.
- 2026-08-06 Asia/Tashkent: PR-5 is partitioned into ten production conversions:
  six middle runtime modules, menu status/userbot, and poller transport/offset.
  Seven existing `.mjs` tests move with them, two declarations are removed, and
  the derived target budget is 56. Three isolated worktrees own delivery/turn,
  update runtime/UI, and reset/menu/poller respectively. The third group must
  commit direct menu-status and poller-transport characterization against the
  original JavaScript before its conversion; the lead retains the ratchet,
  integration notes, shared `update-flow` transport specifier, and final review.
- 2026-08-06 Asia/Tashkent: PR-5 characterization landed before conversion in
  two atomic commits: menu status covers fast initial rendering and stale async
  edit suppression, while poller transport covers the exact byte cap, oversize
  cancellation, and reader failure. The five direct tests passed against the
  original `.mjs` implementations. Three isolated conversion worktrees were
  then integrated without retaining their intermediate worker commits, so the
  branch has one shared conversion commit after the two characterization
  commits.
- 2026-08-06 Asia/Tashkent: Independent cross-review found two behavior drifts
  in the update-runtime partition before commit. Telegram status had normalized
  a structurally valid thrown `{ message, status }` value into a generic Error,
  losing the HTTP status used for custom-emoji fallback. Stable-version parsing
  had also stopped applying the original JavaScript `String(value ?? "")`
  coercion. Both source behaviors were restored and protected by direct
  regression tests. The shared poller transport specifier and two live design
  references were updated from `.mjs` to `.ts`; active-code stale-import scans
  are empty.
- 2026-08-06 Asia/Tashkent: PR-5 conversion commit `e6e2591` contains ten
  production conversions, seven existing test-file conversions, two removed
  declarations, and the required importer updates. The ratchet is exactly
  56/56. The focused conversion suite passed 68/68; the full suite passed 657
  total, 653 passed, zero failed, and four expected macOS skips. Coverage is
  75.91% lines, 79.06% branches, and 73.56% functions, a delta of +0.73 / -0.21
  / +0.45 percentage points from the final merged PR-4 result. Lint, formatting,
  typecheck, build, replica, Autograph 343/343, security-defense 45/45, pinned
  uv 0.8.3 lock reproduction, and Python 3.12 userbot guardrail/health/compile
  gates all pass. One typecheck invocation briefly failed to resolve the
  installed `eve/hooks` export; an unchanged immediate rerun passed, so it was
  recorded as a transient local dependency-resolution event rather than a code
  failure.
- 2026-08-06 Asia/Tashkent: `origin/main` remained at the PR-4 merge during the
  required pre-push pull/rebase. The entire gate set was repeated on the
  committed post-pull tree: 657 / 653 / 0 / 4, coverage 75.91% lines, 79.08%
  branches, and 73.56% functions, exact 56/56 ratchet, lint, formatting,
  typecheck, build, replica, both Python test suites, deterministic userbot
  lock, and all Python 3.12 userbot checks are green. The PR diff check is clean,
  and the two approved untracked handoff files remain outside Git.
- 2026-08-06 Asia/Tashkent: PR-5's first hosted CodeRabbit run found one valid
  minor coverage gap and no production defect: the exact transport byte-cap
  characterization used only ASCII. A separate test-only commit retains that
  assertion and adds an exact three-byte UTF-8 `€` case. The docstring-coverage
  warning is a repository-wide optional finishing touch, not an inline code
  finding or a migration acceptance gate. The fix will be delivered in the
  single incremental push allotted to this review batch.
- 2026-08-06 Asia/Tashkent: PR-5 merged as #157 with merge commit `5182f01`
  after one batched test-only review fix, a green repeated CI run, CodeRabbit
  approval, and the sole review thread resolved. Final scope is ten production
  conversions, seven existing test-file conversions, two new characterization
  files, two removed declarations, and `.mjs` budget 56. Final coverage is
  75.91% lines, 79.08% branches, and 73.56% functions.
- 2026-08-06 Asia/Tashkent: PR-6 starts from `5182f01`. The already-converted
  poller config/transport/offset leaves seven production `.mjs` modules in the
  cluster. The derived batch also converts two spawned fixtures and three
  poller integration tests while preserving `scripts/telegram-poll.mjs` as the
  permanent compatibility shim, for a target ratchet of 44. Three isolated
  worktrees own queue/routing/delivery plus fixtures, control/update/wizards,
  and main/shim respectively; the lead owns cross-partition specifiers, ratchet,
  integration review, and final gates.
- 2026-08-06 Asia/Tashkent: PR-6 characterization is committed separately from
  conversion. Direct tests cover the main import contract; control's
  delete-before-download secret flow; stale update cleanup; wizard guards,
  selection, and stale async results; queue reset normalization; busy routing
  enqueue/ack; and delivery acceptance receipts. The focused original-runtime
  groups passed 35/35 and 16/16 before any corresponding source rename.
- 2026-08-06 Asia/Tashkent: The first broad parallel conversion attempt exposed
  too many simultaneous strict-type errors to review safely, so ownership was
  repartitioned to one production module per worker. No `any`, `@ts-nocheck`,
  `@ts-ignore`, or `@ts-expect-error` escape hatch is accepted. Completed lanes
  are independently rechecked by the lead before integration; update-flow,
  wizards, main/shim, delivery, and the reset integration test are now converted.
  A short-lived `.mjs` re-export for delivery remains only until routing and
  control switch to their final `.ts` imports within this PR.
- 2026-08-06 Asia/Tashkent: Independent semantic cross-review rejected three
  integration drifts before finalization. Main's control importer was switched
  to the renamed `.ts` module. Wizard callback handling again preserves an
  absent chat ID instead of substituting zero, and wizard error copy again uses
  the thrown value's `message` field rather than the full Error string. Delivery
  again passes the configured secret value through unchanged; a type assertion,
  not a runtime empty-string fallback, satisfies the Fetch header contract.
- 2026-08-06 Asia/Tashkent: A second cross-review found the converted crash-child
  fixture's remaining caller in `telegram-queue.test.ts`; it now launches the
  `.ts` path. Review also found that queue typing had replaced the original
  subtraction-time coercion of `status.updatedAt` with a number-only fallback;
  the source expression was restored with a type-only assertion. Queue,
  routing, and both fixtures otherwise preserve the original runtime behavior.
- 2026-08-06 Asia/Tashkent: PR-6 integration now contains all seven remaining
  production poller conversions, two fixture conversions, and all three planned
  test conversions. The permanent `scripts/telegram-poll.mjs` shim is exactly
  ten lines; the temporary delivery re-export is removed. All active importer
  tripwires point at `.ts`, and the derived ratchet is exactly 44.
- 2026-08-06 Asia/Tashkent: The final pre-pull PR-6 gate set is green. The clean
  Node 24 full suite reports 667 total, 663 passed, zero failed, and four expected
  macOS skips. Coverage is 75.57% lines, 79.11% branches, and 73.01% functions,
  a PR-5 delta of -0.34 / +0.03 / -0.55 percentage points. Lint, formatting,
  exact 44/44 ratchet, ten-line shim check, typecheck, build, and replica all
  exited zero. Replica still prints its pre-existing known-issue notice for
  cross-restart session resume, then proves reset retirement and finishes `OK`
  with five provider requests; no PR-6 poller path is implicated.
- 2026-08-06 Asia/Tashkent: CI-equivalent Python gates pass under Python 3.12:
  Autograph 343/343, security-defense 45/45, deterministic userbot lock with
  pinned uv 0.8.3, strict hashed environment sync, guardrails, health, and
  py_compile. The committed diff from the PR-5 merge and the working diff are
  whitespace-clean; the two approved untracked handoff files remain outside Git.
- 2026-08-06 Asia/Tashkent: `origin/main` remained at the PR-5 merge during the
  required pull/rebase, so no commits were rewritten. The entire gate set was
  repeated on the committed post-pull tree: Node 24 reports 667 total, 663
  passed, zero failed, and four expected macOS skips; coverage is 75.57% lines,
  79.12% branches, and 73.01% functions. Against PR-5 this is -0.34 / +0.04 /
  -0.55 percentage points. Lint, formatting, exact 44/44 ratchet, the ten-line
  shim check, typecheck, build, replica, Autograph 343/343, security-defense
  45/45, uv 0.8.3 lock reproduction, and Python 3.12.13 userbot
  guardrail/health/compile checks all pass. Replica again emitted only its
  documented cross-restart known-issue notice before the successful reset and
  final `OK`; the process exited zero. Two independent final read-only reviews
  found no scope, semantics, stale-import, attribution, or diff-integrity
  blocker.
- 2026-08-06 Asia/Tashkent: PR-6's first hosted CodeRabbit run produced four
  comments. Two valid test-only findings were fixed together: the update-flow
  characterization now removes its temporary directory, and direct delivery
  coverage proves that HTTP 204 without an acceptance receipt returns false
  after one non-retrying request. Two production suggestions were declined
  after independent verification. Replacing every dynamic-import façade with
  `typeof import()` exposes three existing incompatible Telegram update shapes
  and is not strict-clean without masking casts; aligning those domain types is
  separate work. Normalizing non-object rejection values would change the
  original `.mjs` exception identity and strict-mode failure behavior, contrary
  to this batch's behavior-preserving conversion contract. The focused review
  suite passed 17/17. The complete post-review gate set is also green: 667
  total, 663 passed, zero failed, four expected macOS skips; coverage 75.62%
  lines, 79.15% branches, and 73.01% functions; lint, formatting, typecheck,
  exact 44/44 ratchet, ten-line shim, build, replica, both Python suites, pinned
  uv 0.8.3 lock reproduction, and all Python 3.12 userbot checks.
- 2026-08-06 Asia/Tashkent: PR-7 starts from PR-6 merge `b1b1b27`. Earlier
  batches already converted twelve of the fourteen planned menu production
  modules, leaving only `menu/index.mjs` and `menu/service.mjs`, plus
  `service.test.mjs`. Their direct pre-conversion suites cover 29/29 behaviors,
  so no new characterization commit is required. Separate worktrees own the
  two production modules and their direct test changes; the lead owns the
  cross-lane `index -> service` link, the poller menu importer, stale-reference
  scan, ratchet reduction from 44 to 41, integration review, and full gates.
- 2026-08-06 Asia/Tashkent: PR-7 index lane converts only the menu registry and
  its dynamic-import test path. `service.mjs` remains in the neighbouring lane,
  so index loads that existing path through a typed dynamic-import boundary
  rather than adding a stale declaration or changing the service module. The
  registry keeps the prior runtime function guards while gaining strict local
  structural types; no menu behavior is intentionally changed.
- 2026-08-06 Asia/Tashkent: Independent PR-7 semantic review found one small but
  observable conversion drift in the service renderer. Replacing the original
  `async render()` body with `Promise.resolve().then()` delayed `currentRun()`
  until the next microtask. A regression test first demonstrated the changed
  snapshot, then the implementation restored the original synchronous
  pre-await read with one narrow `require-await` exception. The combined direct
  menu suites now pass 30/30; no other behavior or import drift was found.
- 2026-08-06 Asia/Tashkent: The final pre-pull PR-7 gate set is green. Node 24
  reports 668 total tests, 664 passed, zero failed, and four expected macOS
  skips. Coverage is 75.78% lines, 79.20% branches, and 73.03% functions, a
  final PR-6 delta of +0.16 / +0.05 / +0.02 percentage points. Lint,
  formatting, typecheck, build, exact 41/41 ratchet, absence of tracked menu
  `.mjs`, Autograph 343/343, security-defense 45/45, pinned uv 0.8.3 lock
  reproduction, and all Python 3.12.13 userbot guardrail, health, and compile
  checks pass. Replica exits zero after its documented cross-restart
  known-issue notice, proves reset retirement, and finishes `OK` with five
  provider requests. The two approved untracked handoff files remain outside
  Git, and the five PR-7 commits contain no AI attribution.
- 2026-08-06 Asia/Tashkent: The required pull/rebase found `origin/main` still
  at the PR-6 merge, so PR-7 commits were not rewritten. The complete gate set
  was repeated on the committed post-pull tree: Node 24 again reports 668
  total, 664 passed, zero failed, and four expected macOS skips; coverage again
  measures 75.78% lines, 79.20% branches, and 73.03% functions. Lint,
  formatting, typecheck, build, exact 41/41 ratchet, no tracked menu `.mjs`,
  Autograph 343/343, and security-defense 45/45 pass. The userbot lock was
  reproduced with the CI-pinned uv 0.8.3, then synced and tested under Python
  3.12.13; guardrail, health, and py_compile checks pass. Replica repeated the
  same documented cross-restart known-issue notice, proved reset retirement,
  printed final `OK`, and exited zero.
- 2026-08-06 Asia/Tashkent: PR-7 merged as #159 at `d083bcc` after green hosted
  CI. CodeRabbit returned a successful status context but did not perform a
  review because the Pro account was under an adaptive fair-use limit; the bot
  reported a 23-minute wait. Two independent local semantic reviews and a
  separate hosted-diff audit supplied the review evidence instead.
- 2026-08-06 Asia/Tashkent: A hosted-history audit completed just after PR-7 was
  merged and identified a process deviation: the two parallel menu conversion
  commits and their following integration/fix commits formed a clean final
  tree, but the intermediate conversion commits were not independently
  runnable because cross-lane import rewrites landed later. Rewriting merged
  `main` is not safe. From PR-8 onward, every conversion commit must include all
  importer rewrites needed for its owned modules and pass its focused suite in
  isolation before integration; cross-lane shared importers belong in one
  explicitly runnable integration commit.
- 2026-08-06 Asia/Tashkent: PR-8 starts from the PR-7 merge `d083bcc`. It owns
  five shared `agent/lib` runtime modules, four colocated test conversions,
  `schedule-paths.mts -> .ts`, five declaration removals, and all cross-boundary
  import rewrites. The exact ratchet target is 32. `schedule-paths.mts` has no
  direct behavioral test, so its cwd/data/status/lock/job contract is being
  characterized in a separate commit before any conversion. Two later
  worktrees will own non-overlapping language/settings/schedules and
  run-status/Telegram boundaries; the lead owns shared poller/channel importers,
  the ratchet, and final review.
- 2026-08-06 Asia/Tashkent: The new schedule-paths characterization first
  exposed only macOS `/var` versus `/private/var` fixture canonicalization; the
  test now compares real paths and proves all four original-runtime behaviors.
  The two conversion lanes then passed independently before integration:
  language/settings/schedules passed 76 focused tests, while run-status and the
  Telegram acceptance/continuation boundary passed 118. Raw Node consumers use
  `.ts` specifiers; compiled agent consumers retain NodeNext `.js` specifiers.
  In particular, raw `#lib/i18n.ts` must import `./settings.ts`: a `.js`
  specifier fails under stock Node before the Eve build exists.
- 2026-08-06 Asia/Tashkent: Integration resolved the two shared poller importers
  as the exact union of both lanes and immediately passed raw imports of all
  five shared modules, 219 focused tests plus two expected platform skips,
  typecheck, and build. Both conversion commits remain independently runnable.
  The finalization commit changes only stale path comments and the ratchet from
  41 to the exact tracked count of 32. All five obsolete PR-8 declarations are
  gone; the three remaining `.d.mts` files belong to later compatibility work.
- 2026-08-06 Asia/Tashkent: Independent semantic review found one strict typing
  blocker that runtime tests could not expose: the converted Telegram acceptance
  wrapper had erased Eve's generic `RouteHandlerArgs<TState>` contract through
  `never`. A separate atomic fix restores the generic handler and args, makes the
  wrapped object typechecked, and removes the remaining unsafe test-fixture cast.
  Direct acceptance coverage passes 11/11. Two follow-up read-only reviews found
  no remaining behavior, import, scope, commit-integrity, or attribution blocker.
- 2026-08-06 Asia/Tashkent: The final pre-pull PR-8 gate set is green. Node 24
  reports 672 total tests, 668 passed, zero failed, and four expected macOS
  skips. Coverage is 75.92% lines, 79.01% branches, and 73.22% functions, a
  PR-7 delta of +0.14 / -0.19 / +0.19 percentage points. Lint, formatting,
  typecheck, build, exact 32/32 ratchet, stale-reference scans, Autograph
  343/343, security-defense 45/45, the CI-pinned uv 0.8.3 lock reproduction,
  and all Python 3.12 userbot guardrail, health, and compile checks pass.
  Replica exits zero after its documented cross-restart known-issue notice,
  proves reset retirement, and finishes `OK` with five provider requests. The
  two approved untracked handoff files remain outside Git.
- 2026-08-06 Asia/Tashkent: The required fetch and pull/rebase found
  `origin/main` still at the PR-7 merge `d083bcc`, so no PR-8 commit was
  rewritten. The complete post-pull gate set is green on the committed tree:
  Node 24 again reports 672 total, 668 passed, zero failed, and four expected
  macOS skips; coverage is 75.92% lines, 79.05% branches, and 73.22% functions,
  a PR-7 delta of +0.14 / -0.15 / +0.19 percentage points. Lint, formatting,
  typecheck, build, exact 32/32 ratchet, stale-reference and diff checks,
  replica, Autograph 343/343, security-defense 45/45, pinned uv 0.8.3 lock
  reproduction, and all Python 3.12 userbot checks pass. An independent final
  range audit found no behavior, scope, history, protected-file, or attribution
  blocker.
- 2026-08-06 Asia/Tashkent: PR-8 merged as #160 with merge commit `5985f22`
  after green hosted CI and an approved CodeRabbit Pro review. CodeRabbit
  reviewed the full range and produced no actionable comment; its only warning
  was the repository-wide optional docstring-coverage check. Final scope is six
  production conversions, four existing test-file conversions, one new
  characterization file, five removed declarations, and `.mjs` budget 32.
  Hosted coverage is 75.92% lines, 79.05% branches, and 73.22% functions.
- 2026-08-06 Asia/Tashkent: PR-9 starts from the PR-8 merge `5985f22`. It owns
  the two deferred canonical leaves `security-gate` and `telegram-format`; the
  permanent `setup`, `init-vault`, and `check-update` compatibility shims with
  their logic extracted to TypeScript; four internal entrypoint renames
  (`check-bash-cwd`, `check-port`, `check-reasoning-strip`, `replica-smoke`);
  and eighteen remaining non-bin test-file conversions. The bin-coupled
  `security-migration.test.mjs` and `userbot-health-cli.test.mjs` stay for the
  PR-10/11 CLI work. Together these changes reduce the exact tracked `.mjs`
  count from 32 to 8.
- 2026-08-06 Asia/Tashkent: PR-9 preparation found three runtime boundaries
  that must remain explicit. Security and Telegram formatting feed both the Eve
  bundle and raw Node 24 scripts, so every importer moves in the same conversion
  commit and build plus raw-import smoke are mandatory. Setup and init-vault
  keep their installer-visible `.mjs` paths and move behavior behind `.ts`
  implementations; replica must prove the init-vault shim. Check-update likewise
  keeps the systemd unit path and importable test contract while moving its
  implementation to `.ts`. Three non-overlapping worktrees own security/format,
  setup/init-vault, and internal entries/tests; the lead owns check-update,
  ratchet integration, cross-lane review, and final gates. Missing direct
  behavior is characterized against the original `.mjs` before each conversion.
- 2026-08-06 Asia/Tashkent: PR-9 integration completed the planned source set:
  `security-gate` and `telegram-format` are canonical TypeScript; `setup`,
  `init-vault`, and `check-update` retain their permanent `.mjs` entry paths
  over TypeScript implementations; four internal utility entrypoints and all
  eighteen remaining non-bin test files were renamed to `.ts`. Direct
  characterization was added before the `init-vault` and `check-port`
  conversions. The exact tracked `.mjs` count is now eight, matching the PR-9
  ratchet target; the only two bin-coupled `.mjs` tests remain assigned to
  PR-10 and PR-11.
- 2026-08-06 Asia/Tashkent: Cross-lane review rejected several seemingly safer
  conversion changes because they altered malformed-input or thrown-value
  behavior. Setup provider/Telegram JSON access, check-update diagnostics,
  check-port diagnostics, replica process shutdown and diagnostics, and the
  reasoning-strip fixtures now preserve the original JavaScript operations and
  coercion exactly through type-only boundaries. Independent differential
  review matched 8,852 OpenRouter shapes and representative security/Telegram
  formatting inputs. The overdue temporary `telegram-poll.d.mts` bridge was
  removed after its two typed test consumers switched to explicit dynamic
  module boundaries; no tracked `.d.mts` or `.mts` declaration remains.
