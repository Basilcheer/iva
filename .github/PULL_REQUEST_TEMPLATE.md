<!--
One change per PR. Commit messages describe the code change only — no AI or tool
attribution. Full contract: CONTRIBUTING.md and AGENTS.md.
-->

## What this changes

<!-- One paragraph. What behaviour is different after this merges. -->

## Why

<!-- The situation that made it necessary. Link the issue if there is one. -->

## How it was verified

<!-- Commands you ran, and what you saw on a real install if you have one. -->

- [ ] `npm run lint` / `npm run format:check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Ran it against a live bot (say which provider)

## Self-host impact

- [ ] Touches `agent/` — the change only takes effect after `eve build`
- [ ] Touches the update path or a persisted format (`data/settings.json`, vault
      layout) — upgrade path from older versions described above
- [ ] User-visible change — `docs/` updated (and `docs/ru/`, or noted as pending)
- [ ] No secrets, no machine-specific absolute paths, no files from `data/`,
      `attachments/` or a vault
