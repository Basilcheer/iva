---
name: self-map
description: "How to read your own evidence: open one turn of the Trace, follow its events to the cause, tell whose the cause is (owner side, the Version, outside); spend, schedule facts, open failures, the service journal, your docs. Load in an Insight turn that lists failures, and when the owner asks what you did, why something failed, or what was slow or expensive."
---

# Self-map

Paths are relative to the `bash` folder — the running Version
(`~/iva/versions/<v>`; `~/iva/current` points at it). Your own code is here, not
in `~/iva`. Data is `$ASSISTANT_DATA_DIR` (default `./data`). Everything below
only reads.

## Keep the output small

`bash` gives you only the last 30 000 characters of each stream; `read_file`
stops at 24 000. Never `cat` a day file of the Trace or `data/usage.jsonl`:
they run to megabytes. A long turn — print only what is around its failures:

    iva trace show <session>/<turn> | grep -B4 -A2 -e 'failure=' -e 'turn.failed' -e 'step.failed'

## Never in a turn without the owner

- `iva doctor` — blocked: its repairs restart iva.service.
- `iva diagnose` — read-only; in a turn only through `report-problem`.
- `iva logs`, `iva trace tail` — they follow forever and end only on the bash
  timeout. Use `journalctl … --no-pager -n N` and `iva trace show`.
- `iva proactive on|off|set`, `iva jobs ack` — they change state; only on the
  owner's word.

## One turn = session + turn

`turn_N` starts again at `turn_0` in every session, so a turn is named by both:
`<session>/<turn>`, for example `wrun_01M43YEKCW0FRANBS1E510CWX5/turn_0`. Nobody
tells you your own session; find the turn from what you have:

- A line of the failure list in your prompt — it ends with the command; run it.
- A recent turn — `iva trace show` lists the last 20 with their
  `<session>/<turn>`; `iva trace show last` is the last turn of the model.
- A chat message — `iva trace show tg:<chat>:<message>`.
- A time or words — `ts` is UTC, the day file is the local day:
  `grep -l '<words>' data/trace/*.jsonl`, then
  `grep -h '<words>' data/trace/<day>.jsonl | cut -c1-200` shows `turn` and
  `session`.

A turn without a chat (Watch, Brief, Insight, a Reminder) starts with an
`eve.message.received` whose prompt begins `Watch:`, `Brief:`, `Insight:` or
`Reminder`. The lines that sent its answer (`gate.outbound`, `outbox.*`) carry
no session: they are the sends right after its `turn.completed`.

## What the events say

The header: start → end, the duration up to the end of the turn, steps, tools,
failed calls, the outcome (`failed`, `stopped`, `blocked`, `dropped`,
`delivered`, `answered`, `open`).

- `bridge.*`, `inbound.*`, `gate.inbound` — the message came in; the inbound
  Gate passed or blocked it.
- `eve.message.received` — the prompt of the turn.
- `eve.step.started` → `eve.step.completed` — one model call; `usage` = tokens.
- `eve.actions.requested` — you called tools: `actions[]`, their arguments in
  `args[]` in the same order.
- `eve.action.result` — what a tool returned, same `callId`. `failure=` marks a
  failed call: `exit N` (bash, with stderr), `timeout`, `ok:false`, `error`,
  `isError` (the answer was flagged as an error: a subagent, `load_skill`, an
  MCP tool), `status:failed` (the answer named its own error; `errorCode` is
  that code). `result` is the answer as one JSON string, `ok`, `error`,
  `message`, `code` first; `outChars` is how much of it you saw then. For bash
  the Trace keeps the END of `stdout` and `stderr`: `…[truncated]` at the start
  means the head was cut. A failure hidden by a pipe or `2>&1` has no
  `failure=`: read `exitCode` and the end of `stdout`.
- `eve.step.failed`, `eve.turn.failed` — the turn broke: `code`, `message`,
  `details`.
- `eve.compaction.*`, `eve.session.waiting` — after the turn, not its work.
- `gate.outbound` → `outbox.delivered` / `outbox.failed` — the answer after
  secret redaction, and whether Telegram took it.
- `tool.rejected`, `guard.repeat_stop` — the repeat guard saw a failed call /
  stopped a repeat. They carry no turn and no session: match them by `ts` and
  tool.
- `stop.*` — the owner pressed ⏹.

`--full` prints the content whole (as the Trace kept it), `--json` the raw
lines. Lines written before `failure=` existed keep `result`
as an object and have no `failure`.

## Find the cause

1. How it ended: the outcome in the header.
2. The FIRST failure in time, not the last: later ones are often its
   consequence.
3. Its `callId` → the `eve.actions.requested` above it: what you asked for.
4. The reason: `stderr`, `error`, the end of `stdout`, the `message` of a
   failed step.
5. What came next: the same call again with the same error, then
   `guard.repeat_stop` — the loop is part of the cause.

Not every non-zero exit is a failure: `grep` 1 = nothing found, `diff` 1 = the
files differ, `test` 1 = false; those have no `failure=`. «ЗАБЛОКИРОВАНО: …»
from `bash` is the guard doing its job. «The Trace does not show why» is a
correct answer; a guessed reason is not.

## Whose it is

Decide by the tool, the skill and the path in the events, never by a stack: a
stack points into `.output/server/index.mjs` for every kind of code.

- **Outside** — the provider down or busy (`MODEL_CALL_FAILED` with 429, 5xx
  or «no output»), the network, a site, someone else's server timing out.
  Nothing to fix; the same cause over several days is worth one line.
  `MODEL_CALL_FAILED` with 401 or 403 is the owner's key (owner side); with
  another 4xx (400, 404, 422) the provider refused the request Iva built — a
  tool schema, a parameter — that is the Version.
- **Your own call** — a wrong path or argument, an unknown tool name: the error
  text names the right form. Nothing to fix, unless a skill told you the wrong
  form.
- **Owner side** — the Custom layer and the owner's data; it survives
  `iva update`. A tool named `connection__mcp-<plugin>--…` (a plugin);
  `connection__<x>__…` when `data/custom/agent/connections/<x>.ts` exists; a
  skill that `ls data/custom/agent/skills data/custom/plugins/*/skills` lists;
  a script under `data/custom/`, `data/plugin-data/` or
  `data/custom/plugin-drafts/`; the Vault; a key or setting missing from `.env`
  or `data/settings.json`. A fix there holds: a plugin draft, an edit, or one
  line on what to set.
- **The Version** — what `iva update` replaces: `agent/`, `scripts/`,
  `packages/`, eve. A built-in tool (`bash`, `glob`, `grep`, `memory_search`,
  `read_file`, `remind`, `send_file`, `tasks`, `web_fetch`, `web_search`,
  `write_card`, `write_file`, `connection__telegram-userbot__…`) failed with
  `isError` or `status:failed` on arguments that were right; an
  `iva <command>` failed with a stack; a turn or step failed with an `IVA_…`
  code or a provider 4xx above; a built-in skill told you something wrong. A
  patch on the owner's side is wiped by the next update, and a copy of a
  built-in skill freezes it and hides every later fix: this is an issue for
  the developer (`report-problem`), nothing else.

## Answering the owner about yourself

Everything above is for you. The owner is not technical: the answer says in
plain words what happened and what it means for them. No ids, session names,
event names, delivery statuses or commands, unless the owner asks «подробнее».

Bad (a real answer, 06.10.2026): «⚠️ Проблема: вчерашняя проверка сервера
(r-4ba18f, 05.10 09:05) сработала, но сообщение не дошло до чата (статус
доставки пустой, ошибки нет)».

Good:

    Одно сообщение вчера могло до тебя не дойти: утренняя проверка сервера в 09:05.
    Я её выполнила, но не вижу, что Telegram её принял, и сбоя тоже не вижу.
    Остальные 10 сообщений за сутки дошли.

    Разобраться, почему так вышло?

    <tg-button-row><tg-button type="callback_data" data="Да, разберись">Разберись</tg-button><tg-button type="callback_data" data="Не нужно">Не нужно</tg-button></tg-button-row>

## Not in the Trace — say so, do not guess

- The system prompt, CORE, the rules: only file sizes (`context.parts`).
- Money: no prices anywhere; tokens only (`data/usage.jsonl`).
- What the model was thinking: no reasoning events arrive.
- What the night did inside: `data/jobs.json` and `data/rollup-status.json`
  only.
- Which model ran a step: `data/usage.jsonl` has the configured one.
- Anything older than 30 days.
- With `captureContent` off: no prompts, answers or results — only names,
  sizes and `failure=`; the failure list then also counts your own Insight turns.

## Spend, schedule, services

- Spend: `iva usage today|week|month|by-source|by-model` — tokens and turns;
  rows `watch`, `brief`, `insight` from 06.10.2026, earlier ones `background`.
- Spend of one turn, one line out:
  `awk -F'"total":' -v s='"sessionId":"<session>"' 'index($0,s) && /"turnId":"<turn>"/ {split($2,a,/[,}]/); t+=a[1]; n++} END {print n" steps, "t" tokens"}' data/usage.jsonl`
- Schedule runs, 7 days: `data/jobs.json` (name, ok, error, exitCode, tail,
  acked); the `proactive` tick writes only a failure and the first success
  after it — a Watch, Brief or Insight turn itself is in the Trace.
- Open failures: in every turn under «Незакрытые провалы»; closing is the
  owner's `iva jobs ack <name>`.
- Services: `iva status`;
  `journalctl --user -u iva.service --since today -p warning --no-pager -n 200`;
  `systemctl --user list-timers --all --no-legend`;
  `systemctl --user list-units --all --plain --no-legend 'iva-*'`.
- Watch, Brief, Insight: `iva proactive show`; the `insight` key of
  `data/proactive.json`.
- Night: `cat data/rollup-status.json`.
- How a part of you works: `docs/llms.txt`, then `docs/trace.md`,
  `schedules.md`, `plugins.md`, `troubleshooting.md`, `docs/adr/`.
