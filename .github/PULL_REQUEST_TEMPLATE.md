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

## This PR touches

- [ ] `agent/` — takes effect only after `npm run build`
- [ ] The update path or a persisted format (`data/settings.json`, vault layout) —
      the upgrade path from older versions is described above
- [ ] Something user-visible

## I confirm

- [ ] Docs updated for any user-visible change (`docs/`, and `docs/ru/` if that page
      exists in Russian — or said above that it is still pending)
- [ ] No secrets, no machine-specific absolute paths, no files from `data/`,
      `attachments/` or a vault
