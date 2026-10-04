# Schedules — what runs on its own, and what happens when it fails

Iva runs its background work as in-process Eve schedules: one `memory-night`
pipeline at 04:00, the half-hourly
`proactive` tick (Watch and the Brief), the daily `jobs-watchdog`, and the reminder dispatcher that ticks every
minute. Each scheduled job is a thin spawner — the work itself lives in
`scripts/` (see `docs/deploy.md`).

## Every run leaves a fact

One row per run, in `data/jobs.json`: name, started/finished time, ok, the reason
of a failure, the exit code, and the tail of the run's error output (last 20 lines
of `stderr`, cut by the same rule the evidence package uses — the report a script
prints to `stdout` stays out of the row and out of the agent's turn). Rows older than seven days are
dropped on the next write. `data/rollup-status.json` keeps only "in progress" and
"last success" for the double-run guards — the history is `jobs.json`.

## The agent wakes up with the fact

Right after a run, `schedule-runner` starts `scripts/jobs/wake.ts <name>
<startedAt>` in the background. That child reads the row, opens an ordinary agent
turn and:

- on success the turn says "nothing is broken — answer with an empty message",
  and an empty answer sends nothing;
- on failure the agent is asked to try to fix it (restart the job, repair the
  file) and then tell the owner what broke and what it did.

Only a non-empty answer is sent to your Telegram chat. The outcome of the turn
(answered / empty / failed) is written back into the same row.

## Where to look

- `iva doctor` → the schedules section: the last run of every name (ok or
  failure, when) and the open failures. The same command reports the minute
  dispatcher's pulse in its reminders section.
- Every agent turn carries a short "open failures of the last 24h" block, so the
  agent sees a broken schedule even before you ask.
- `iva jobs ack <name>` closes an open failure you decided not to fix. A later
  successful run closes one by itself.
- If the agent cannot wake at all (the turn fails every time), one message per day
  reaches the owner: "scheduled jobs failed in the last 24h: N; the agent is not
  responding; run: iva doctor". A table nobody can read is the same case and gets
  its own reason, because the agent cannot wake with a fact it cannot read.
  `data/jobs-watchdog.json` remembers the last message.

## If something broke anyway

The raw run log is the service journal:

```bash
journalctl --user -u iva.service -n 200 --no-pager | grep schedule-runner
```
