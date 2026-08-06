# Security policy

Iva holds a Telegram bot token, your model-provider keys, optionally a Google OAuth
token and — if you enable the userbot — a session for your personal Telegram account.
Vulnerabilities here are worth reporting properly.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private channel: [Report a vulnerability](https://github.com/smixs/iva/security/advisories/new).
It creates a draft advisory only the maintainer can see.

If that page is unavailable to you, email **mixshima@gmail.com** with `iva security` in
the subject.

What helps:

- Iva version (`iva version`) and how it was installed.
- What an attacker can reach — vault contents, keys, the Telegram account, the host.
- Reproduction steps, or the smallest input that triggers it.

Expect a first reply within a few days — if a week passes in silence, ping again. Once a
fix ships, the advisory is published and you are credited unless you ask otherwise.

## Supported versions

Only the latest release gets fixes. Iva updates itself in place (`iva update`, or the
Update button in Telegram) — running an old tag is not a supported configuration.

## What is in scope

- Prompt injection that survives the inbound sanitizer and makes the agent act.
- Secret leakage past the redaction gate — into chat, logs or vault files.
- The allowlist letting a non-listed Telegram user through.
- Privilege escalation on the host from anything the agent processes.
- Anything that bypasses the userbot anti-ban guardrail from inside the agent.
- The install and update path — anything that gets code onto a host through
  `install.sh` or `iva update`, including the spend governor and the restart guard.

## What is not in scope

- Attacks that require an attacker who already has shell or root on your server.
- Vulnerabilities in the model, transcription or search providers you choose.
- Telegram account limits or bans that follow from using the userbot: automating a
  personal account is against Telegram's ToS, that risk is documented and accepted by
  you when you opt in.
- Self-hosting mistakes — an exposed `.env`, a world-readable vault, a shared VPS.

## The honest boundary

Your vault is a private git repo on your own server. The model and transcription are
cloud APIs you pick and pay for: their operators see the text you send them. Iva does
not phone home, and no telemetry is collected.
