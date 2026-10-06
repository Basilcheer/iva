---
name: report-problem
description: "Something broke, the user complains, or the owner tapped «Разработчику <name>» / «To developer <name>» under an Insight: gather evidence and offer an issue or the support chat"
---

# Report a problem

Call this skill when the user complains about Iva ("you did not remind me again", "you do not answer"),
when a schedule, a tool or a delivery failed on its own, after three failed attempts in a row, and after
a tap «Разработчику <name>» / «To developer <name>» under an Insight.

1. Collect the evidence: run `iva diagnose` in bash; when you know the turn (`<session>/<turn>` from the
   Insight Card, from `iva trace show` or the `self-map` skill), run `iva diagnose --turn <session>/<turn>`.
   It writes `data/diagnose/<date>.md`, prints the path and, with `--turn`, a line `issue-url: …`. Read the
   package up to `## Host` (`sed '/^## Host/q' <path>`): its header — the third line says what was cut and
   by what list — the versions and the skeleton of that turn (event names, tools, failure classes, codes,
   timings, error lines; no messages, answers or arguments). Open the rest (doctor, the journal, reminders,
   failures, custom-layer names) only when the turn does not explain the trouble — with `grep`, not whole.
2. Tell the owner what happened in two lines of plain words: what broke and what it means for them. Nothing
   broke — say so in one sentence. A doubt goes first, with the step that settles it for the owner. No
   path, no version numbers, no list of checks, no count of cut keys unless the owner asks for details. Do
   not paste the package into the chat.
3. Offer the two ways out and wait for an explicit "yes" — publishing is the owner's move. When nothing
   broke, one button sends the file, and the two ways come after its tap (the sample below). A tap
   «Разработчику <name>» is that yes for the issue: give its link at once.
   - **Issue**: a question line «Открыть issue для разработчика?» and a `url` button (`rich-replies`)
     whose `url` is the `issue-url:` line exactly as `iva diagnose --turn` printed it — code built the
     title and the body from the package after cutting secrets; never build or edit it yourself. Without
     a turn there is no such line: a `url` button to `https://github.com/smixs/iva-agent/issues/new` with
     no body, and the package path in the message. One line under the button: GitHub shows the whole
     text before it is sent, the issue is public, the full package stays in `data/diagnose/`.
   - **Support chat**: the address is the `SUPPORT_CHAT_URL` setting in `.env`. Give the owner the text to
     paste: the two lines of substance, the package path, and one line about the redaction, taken from the
     package's own header (`N values from .env, pattern rules always on`). No `SUPPORT_CHAT_URL` — say the
     address is not configured and the owner should ask the admin.
4. Send nothing yourself: no issue, no message, no webhook, no `gh`. Cutting secrets is the code's work, not
   yours: never retype lines of the Trace or the package into a link. The owner sends the issue from GitHub,
   and the file stays on the machine until the owner attaches it.
5. **When the package says `.env not found`** (or `iva diagnose` warned about it in the terminal), only the
   pattern rules ran — bot tokens, keys of known formats (`sk-…`, `ghp_…`, `xox…-`, `AKIA…`, `AIza…`, JWT,
   `Bearer …`), labelled telegram ids and e-mail addresses — and the values of the keys could not be cut at
   all. Never promise "no secrets" in that case: say plainly that the package was
   collected without the `.env` list, suggest fixing `.env` (or `iva config`) and running `iva diagnose`
   again before publishing, and let the owner decide.

## Bad → Good

Bad (a real answer to «собери диагностику», 06.10.2026): the file path with its size, «iva doctor: 23
проверки пройдены», versions of Iva, eve and Node, free disk, the night and the schedules one by one, «16
штук» of cut keys, then two numbered ways out. Nothing was broken, and the owner gave it 1 out of 10.

Good (the line about passwords only when the package was cut by the `.env` list, step 5):

    Не уверена, что до тебя дошла вчерашняя утренняя проверка сервера в 09:05.
    Остальное работает, за сутки ничего не сломалось.
    Файл для разработчика Ивы собрала, пароли и ключи из него вырезала.

    Проверить сервер ещё раз или отправить файл разработчику Ивы?

    <tg-button-row><tg-button type="callback_data" data="Проверь сервер сейчас">Проверить сервер</tg-button></tg-button-row>
    Проверю сейчас и пришлю, что увижу.

    <tg-button-row><tg-button type="callback_data" data="Отправь файл разработчику Ивы">Отправить файл</tg-button></tg-button-row>
    Покажу, как его отправить; сама ничего не отправляю.
