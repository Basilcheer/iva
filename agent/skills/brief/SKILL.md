---
name: brief
description: "Brief — the owner's day in review: tasks, calendar, mail, Telegram, every Connection and plugin, goals from CORE, weather. Load in a scheduled Brief turn (08:30 and 14:00 by default), on /digest, and when the owner asks for a day plan, a review of the day or their open tasks."
---

# Brief — the owner's day in review

A Brief comes twice a day by schedule (`iva proactive show` → `briefTimes`) and on
`/digest` or a request in chat. Your job is the judgement: what of the day matters
and what the next step is.

## Gather

In a group chat (`/digest` there) other people read the answer: show only the open
tasks (step 1), nothing from mail, calendar, personal Telegram or Connections.

Walk everything the owner has connected, with your own tools, read only:

1. Tasks: load `task-management`, call `tasks` with `action="list"`. Overdue and due
   today first, then high priority, then the rest. Read old relative deadlines from
   `createdAt` as that skill says; an unclear deadline is shown as written, with a
   question, not dropped.
2. Calendar and mail (`google-workspace`), personal Telegram (`telegram-userbot`):
   today's meetings, letters and chats that wait for the owner.
3. Every Connection and plugin: `connection_search` lists them; look at each one for
   what is new or due today.
4. Goals from CORE: one concrete step towards a goal today, if one fits.
5. Weather for the owner's city (from memory, `memory_search`). No city known — ask
   once and save the answer with `write_card`.
6. Habits — only the ones the owner named; never invent a routine.
7. Mail, calendar or Telegram not connected — offer to connect it once and save the
   fact that you offered with `write_card`; next time check memory and do not repeat.
   Do not suggest anything a Card tagged `insight` marks as declined.

## Write

- Unfixed failures from the prompt open the overview, before anything else: one
  point each, in plain words, what broke and the cause. Each then gets its own
  message, the first ones after the overview: the plan of the fix, a question
  line that names the task the way the owner knows it («Починить ночную копию
  рабочей папки?», the unit name stays in the button `data`) and one «Починить»
  button (see the watch skill). In a chat turn their question lines and buttons
  close the one message.
- The first message is the overview: greeting in one line, the day in 5–7 points,
  one sentence with the focus of the day. Too many tasks — the important ones and
  how many more there are.
- After it, one message per item that needs an action from the owner (an answer, a
  decision, a payment), each with its next step and buttons (see `rich-replies`).
  Such a message ends with an empty line and one question line the buttons
  answer, naming the person or the thing: «Оплатить счёт Билайна сегодня?»,
  «Взять ответ Максиму в задачи?». Then an empty line and the buttons.
  Items without an action stay in the overview.
- In a scheduled Brief turn separate the messages with a line `<!-- iva:next -->`.
  In a chat turn (`/digest`, a question) the answer is one message, no separators,
  and no «Я в курсе» button in it: that button removes the whole message.
- The owner is not technical. What works needs no words: no state of the
  dispatcher, no counts of what fired, no ids, codes or service names, no table
  for a list of things.
- The morning Brief (slot 0) always has an answer. A later Brief may return exactly
  `QUIET` when nothing changed since the morning that is worth a message.

Never send anything yourself in a scheduled turn: no Telegram tools, no `iva post`,
no mail. Code sends your final text to the owner's private chat. Never write to
anyone on the owner's behalf.

## Bad → Good

Bad (real lines of a reminders list in the chat, 06.10.2026 — a Brief must not
read like this): «Активных пять, диспетчер работает ✅», a table «Когда · Что ·
Тип», «Сработали за сутки: 10 тестовых напоминаний с кодами (df0e29 …
6143d9)», «⚠️ Проблема: r-4ba18f… статус доставки пустой». The owner gave it 1
out of 10.

Good (the overview, then the failure as its own message):

    Доброе утро! Сегодня одна поломка и одно срочное дело.
    • Ночная копия рабочей папки не сделалась: на диске кончилось место. Как починить — ниже.
    • 09:00 — ответить Максиму Функу по смете для Арбуза.
    • 14:00 — созвон с Анной, ссылка в календаре.
    • Ещё три напоминания на вечер, срочного среди них нет.
    • Погода: +18, без дождя.
    Главное сегодня — ответ Максиму.
    <!-- iva:next -->
    Ночная копия рабочей папки не сделалась: на диске кончилось место.
    Поправлю её, чтобы она хранила копии только за последний месяц, — тогда места хватит.

    Починить ночную копию рабочей папки?

    <tg-button-row><tg-button type="callback_data" data="Починить: backup-work.service">Починить</tg-button></tg-button-row>
