# AGENTS.md — Iva

## Local-First Mode - Highest Priority

- Team: Shima and the active agent. Work directly in the current checkout and branch.
- Develop, inspect, build, review, and test locally. Never use GitHub Actions, CI services, pull requests, merge gates, branch protection, CodeRabbit, review bots, or external SDLC pipelines.
- GitHub is only a direct sync target when Shima explicitly asks to commit or push.
- Skip ceremony-only plans, implementation journals, checklists, handoffs, and remote review loops unless explicitly requested.
- Every behavior change gets relevant hostile local tests: malformed or junk input, repeated user actions, duplicate/stale/out-of-order events, races, interruption, retry, restart, timeout, partial writes, missing dependencies, stale generated output, and broken or partial builds. Randomized tests expose their seed.

Iva is a self-hosted personal Telegram assistant built on the eve agent framework
(TypeScript ESM). Core runtime lives in `agent/` (import alias `#*` → `./agent/*`),
operational scripts in `scripts/`, CLI entry in `bin/iva.mjs`.

Design philosophy (skill vs code, thin harness, the wheel principle): docs/philosophy.md.
Before wiring a new feature into code, check it against that document — most
recurring problems should become skills, not mechanisms.

Build: `npm run build` (materializes `data/custom/agent` in a disposable tree) or
`npm run build:core` for a maintainer-only core build. A build is required after any authored
agent change; `eve start` does NOT rebuild. Typecheck: `npm run typecheck`. Tests: `node --test` over
`*.test.ts` (see `test:security`, `test:update-ui` scripts).

All new Node.js source and tests must be TypeScript. The only tracked `.mjs` files
are the five permanent, logic-free external entry shims: `bin/iva.mjs` and
`scripts/{telegram-poll,check-update,setup,init-vault}.mjs`. Their implementations
live in the adjacent TypeScript modules; do not add new `.mjs` files or move those
stable entry paths.

Commit messages must describe only the code change — no AI/tool attribution of any
kind (no Co-Authored-By bots, no "Generated with" footers). See CLAUDE.md.

## Local Reliability Rules

- **Secrets and machine-specific paths.** Credentials must never live in tracked
  files. Telegram bot tokens, API keys, and session strings load only from a
  local, untracked, gitignored `.env` or from runtime data outside the repo;
  `data/`, `attachments/`, and the vault stay untracked. `.gitignore` must keep
  ignoring `.env`, `.env.*`, `data`, and `/vault/` — reject local changes that remove or
  narrow these entries, and reject files from these paths if they appear in
  Git's index. Also flag any hardcoded secret, token-looking literal, or absolute
  path from a specific machine (e.g. `/home/<user>/...`).
- **Auth and permission gates.** `agent/lib/eve-auth.*` and `scripts/lib/*auth*`,
  `scripts/lib/listener-security.*` define who may talk to the assistant and which
  chats may trigger actions. Flag any change that widens an allow-list, removes a
  chat-type check (secrets/settings must stay private-chat-only), or bypasses these
  gates from a new code path.
- **User data stays out of the repo.** Runtime user data belongs to the vault and
  `data/` (both untracked). Flag code that writes user content, chat logs, or
  generated files into tracked repo paths, and any staged change that includes files from
  `data/`, `attachments/`, or a vault.
- **Self-host update path.** `iva update` runs under the OLD installed CLI: new
  update-flow steps only take effect starting from the NEXT release. Flag update
  logic that assumes the just-pulled code is already executing, and any change to
  `data/settings.json` or other persisted formats that is not
  backward-compatible — self-host users upgrade from arbitrary older versions.
- **Rebuild-sensitive changes.** Changes under `agent/` alter runtime behavior only
  after `npm run build` (`eve start` does not rebuild). Any change touching `agent/*` must
  account for a rebuild in its deploy/testing story; flag runtime-testing claims
  for `agent/*` changes that lack a rebuild step, and update-flow or deploy scripts
  that start the service after changing `agent/*` without running `npm run build`.
- **Tool inputs are validated — and constrained.** Agent tools take zod-validated
  inputs, but schema validation alone is not input safety: a validated string can
  still carry command injection or path traversal. Flag new or changed tool
  parameters that skip zod validation; enum-like parameters without an allowlist
  of accepted values; file-path parameters not resolved and bounds-checked against
  their allowed base directory; and any handler that interpolates user-controlled
  strings into shell commands instead of passing them as arguments.

Safe areas needing no deep inspection: `docs/` static site, `README*` wording,
`deploy/*.service` unit descriptions. Mechanical style checks run locally.
