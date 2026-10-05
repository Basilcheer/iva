---
name: self-map
description: "Where Iva's own evidence lives and how to read it: the Trace, the spend file, schedule facts, open failures, the service journal, her own docs. Load in an Insight turn, and when the owner asks how Iva works, why something failed or what she does slowly, expensively or with errors."
---

# Self-map

Paths are relative to the working directory of the running version; data is
`$ASSISTANT_DATA_DIR` (default `./data`). Everything below only reads.

## Never in a turn without the owner

- `iva doctor` — blocked: its repairs restart iva.service.
- `iva diagnose` — read-only: the same checks as doctor, no repairs; in a turn
  only through report-problem.
- `iva logs`, `iva trace tail` — they follow forever and end only on the bash
  timeout. Use `journalctl … --no-pager -n N` and `iva trace show`.
- `iva proactive on|off|set`, `iva jobs ack` — they change state; only on the
  owner's word.

## Where to look

| Question                                   | Command                                                                                                                                              | What it shows                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which turns went, how long, how they ended | `iva trace show`                                                                                                                                     | the last 20 turns: time, source, steps, tools, duration, outcome                                                                                                                     |
| One turn in full                           | `iva trace show <selector>`, add `--full` or `--json`                                                                                                | its events in time order; the selector is `turn_N`, `tg:<chat>:<msg>`, a session id or `last`                                                                                        |
| Failed turns and steps                     | `grep -r -e '"name":"turn.failed"' -e '"name":"step.failed"' data/trace/`                                                                            | code and message of the failure                                                                                                                                                      |
| Tool errors                                | `grep -rE '"name":"action.result".*"isError":true' data/trace/`                                                                                      | tool name, error code                                                                                                                                                                |
| Undelivered answers                        | `grep -r '"kind":"outbox","name":"failed"' data/trace/`                                                                                              | error, characters, ms                                                                                                                                                                |
| Spend: today, 7 days, month                | `iva usage today`, `iva usage week`, `iva usage month`                                                                                               | tokens in/out, turns, by source and model                                                                                                                                            |
| Spend by source or model                   | `iva usage by-source`, `iva usage by-model`                                                                                                          | the `background` row = turns without a chat (Watch, Brief, Insight, Signal, Reminders); `memory-night` = night                                                                       |
| Spend of one turn                          | `grep '"sessionId":"<id>"' data/usage.jsonl`, sum `total`                                                                                            | `in` already includes cache reads                                                                                                                                                    |
| Schedule runs, 7 days                      | `data/jobs.json`                                                                                                                                     | per run: name, ok, error, exitCode, tail, acked; the `proactive` tick (Watch, Brief, Insight) only a failure and the first success after it — an Insight turn itself is in the Trace |
| Open failures                              | they arrive in every turn under «Незакрытые провалы»; the full list is the latest row per name in `data/jobs.json` with `ok` false and `acked` false | closing is the owner's `iva jobs ack <name>`                                                                                                                                         |
| Services                                   | `iva status`; `journalctl --user -u iva.service --since today -p warning --no-pager -n 200`                                                          | the service journal                                                                                                                                                                  |
| Failed timers and plugin units             | `systemctl --user list-timers --all --no-legend`; `systemctl --user list-units --all --plain --no-legend 'iva-*'`                                    | failed units, restart loops                                                                                                                                                          |
| Watch, Brief, Insight today                | `iva proactive show`; the `insight` key of `data/proactive.json`                                                                                     | settings and today's counters; the last Insight day, its draft (`?` — a name that did not count as a plugin), misses in a row, pause end in ms                                       |
| Night                                      | `cat data/rollup-status.json`                                                                                                                        | the last pass per schedule                                                                                                                                                           |
| How a part of Iva works                    | `docs/llms.txt` (one line per doc), then the doc                                                                                                     | `trace.md`, `schedules.md`, `plugins.md`, `configuration.md`, `troubleshooting.md`, `docs/adr/`                                                                                      |

## Slow, expensive, with errors

- Slow: the duration column of `iva trace show`; inside a turn the gap between
  `step.started` and `step.completed` is the model, between
  `actions.requested` and `action.result` is the tool.
- Expensive: `iva usage week` by source; one turn is all spend rows of its
  session id. A turn without a chat is found by its first `message.received`:
  the prompt starts with `Watch:`, `Brief:` or `Insight:`.
- Errors: failed turns and steps, tool results with `isError`, `outbox.failed`,
  rows of `jobs.json` with `ok` false, the service journal at `-p warning`.
- The Trace keeps 14 days; the spend file keeps its last 2–4 MB, so `week` and
  `month` may start later — the report says "since <date>".
