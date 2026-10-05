# Native Telegram question previews

The Telegram channel records the
message reference when the Telegram channel posts an `input.requested` question.
After Eve emits its authoritative `input.resolved` event, the channel removes all
choices and shows the accepted selection. This status does not claim that the
subsequent business operation succeeded.

The reference and accepted display status are part of persisted channel state.
If Telegram editing fails, the accepted answer remains accepted; only delivery happens
again when the turn completes, starts, or enters `session.waiting`. No business operation is replayed. A definite Telegram 400 saying the message was
deleted or cannot be edited retires its preview reference; there is nothing left to
deliver there. Transient or ambiguous failures keep the accepted display status. One recovery pass
shares the existing five-second edit deadline across text and keyboard removal. The
first retained failure moves to the end and stops that pass, so a backlog cannot add
five seconds per preview or repeatedly starve later accepted questions. No new queue, TTL or persisted redelivery fields are introduced.
Rich previews are edited without their embedded button tags. Classic previews use
an empty inline keyboard; if text editing fails, keyboard removal is attempted
separately. UI delivery can still fail, so an old-looking preview is not evidence
that its action is available. Existing unresolved questions from before this change
have no recorded reference and cannot be retroactively edited.

Question text remains literal, including native ForceReply and long-message posting.
For long classic questions the recorded first message owns the keyboard; adding a
status can exceed Telegram's text limit, in which case only keyboard removal may
succeed. Once Telegram definitively rejects the status as too long and keyboard
removal is confirmed, that preview reference is retired rather than retried forever.
If keyboard removal is still uncertain, the reference remains recoverable.
Freeform answers are never echoed in the status because they can contain
credentials or personal data.

Eve 0.51.1 already produces `input.resolved` but does not expose it in the public
channel-handler event list. Iva backports that exposure through the existing
patch-package mechanism. An upstream implementation should add the same event to
Eve's public channel definition and Telegram event types rather than mutate a
compiled adapter at runtime. Normal question resolution still belongs to Eve.

Upstream already implemented public `input.resolved` exposure in
[vercel/eve#4028](https://github.com/vercel/eve/pull/4028), commit
[`9c36b7c`](https://github.com/vercel/eve/blob/9c36b7c280fda89ae678cabfd8d906f4bde2216f/packages/eve/src/public/definitions/channel.ts).
Remove the three exposure hunks from `patches/eve+0.51.1.patch` when the pinned Eve
version exposes the public generic and Telegram event types and the adapter boundary
test passes without them. Keep Iva's question preview delivery: the upstream change
exposes the event and does not implement that UI. The unpatched 0.51.1 boundary test
fails because Eve silently drops this handler. This is one channel mechanism for
all providers, as required by ADR-0019.

The existing Compaction lifecycle (ADR-0021) keeps ownership of the chat. Normal
turn completion still finishes its status and closes the Compaction turn even if
preview delivery fails. On `session.waiting`, Eve's Compaction request and claim
happen before preview recovery. An edit cannot release that claim, repeat the request,
or replay an accepted answer.

Group and forum rich questions update the same conversation anchor as Eve's native
`post()` and rekey through the public continuation operations using Eve's exported
`telegramContinuationToken`. This keeps a button's callback attached to the session
waiting for its answer. If public continuation routing is unavailable, groups use
native posting. Private questions do not rekey.

Native posting preserves Eve's formatting and ForceReply. Rich questions fall back
to native posting only after a definite Bot API request rejection. Network failures,
timeouts and missing message IDs do not trigger another post, because delivery may
already have happened. Failed rich edits never switch to HTML or post a replacement:
the old embedded buttons must be removed by editing that same rich message.

Adapted from @mamysh's independent question-preview prototype in issue #272.
Plugin-owned screens and the proposal in #274 are outside this change.

Reverting to released Iva requires no data migration. Additional channel-state
fields are unused there, and automatic preview settling is unavailable again.
