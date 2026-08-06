# Contributing to Iva

Iva gets better because people run it on real servers with real messages. A bug report
from an actual install is worth more than a drive-by PR, so start wherever you are.

## Reporting a bug

Open an [issue](https://github.com/smixs/iva/issues/new/choose) and include the version
(`iva version`), how you installed, and what you expected instead. If it involves a
message the assistant handled, the relevant lines from `journalctl --user -u iva-bridge`
usually contain the answer — strip your tokens first.

Security problems do not go in issues. See [SECURITY.md](SECURITY.md).

## Before you write code

Read [docs/philosophy.md](docs/philosophy.md). The recurring answer in this codebase is
that a new behaviour should be a skill (a markdown file the agent reads), not a new
mechanism in TypeScript. A PR that adds a subsystem where a skill would do gets sent
back, and that is not a comment on the code.

[AGENTS.md](AGENTS.md) is the working contract: layout, the `#*` import alias, the
review rules that also apply to humans — secrets never land in tracked files, auth
gates only ever get narrower, user data stays out of the repo, and anything under
`agent/` needs a rebuild before it does anything.

## Local setup

Node 24 is required — the project uses the built-in SQLite and native TypeScript
loading.

```bash
git clone https://github.com/smixs/iva.git ~/iva && cd ~/iva
npm install
cp .env.example .env     # fill in a bot token and one model provider
npm run build            # eve build — needed after every agent/ change
npm start
```

`npm run dev` runs the agent with reload. `eve start` does **not** rebuild, so if a
change under `agent/` seems to do nothing, you skipped `npm run build`.

## What CI will check

Run this before pushing and there are no surprises:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
```

CI also runs the coverage baseline (`npm run test:coverage`), the security suite
(`npm run test:security`), the userbot guardrail tests, the autograph Python tests, and
a replica smoke test that installs Iva from scratch against a mock provider. Coverage
thresholds are floors: they may rise, they do not fall.

New Node source and tests are TypeScript. The only `.mjs` files in the tree are five
logic-free entry shims; do not add a sixth.

## Pull requests

- One change per PR. A rename, a refactor and a feature in one diff cannot be reviewed.
- Commit messages describe the code change and nothing else — no AI or tool
  attribution, no "generated with" footers.
- Tests come with the change. Bug fixes get a test that fails without the fix.
- Touching the update path (`iva update`, `data/settings.json`, anything persisted)?
  Say in the PR how an older install upgrades. Self-hosters arrive from arbitrary old
  versions, and the update runs under the *previous* CLI.
- Docs live in `docs/`. A user-visible change that is not documented is unfinished.

## Adding a skill or an MCP server

Most useful contributions are one file. `agent/skills/<name>.md` describes a procedure
in prose; the agent picks it up without any code change. MCP servers are wired through
config with keys in `.env`. See [docs/extending.md](docs/extending.md).

## Translations

The README and `docs/` ship in English and Russian (`docs/ru/`). If you change a
user-facing document, change both or say plainly in the PR that the other one still
needs doing — a stale translation is worse than an obvious gap.
