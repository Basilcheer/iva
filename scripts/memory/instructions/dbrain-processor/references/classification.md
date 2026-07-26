# Classification — what becomes a card

Decide per noteworthy item. When unsure, prefer **fewer, richer** cards over many thin
ones. Most transcript lines stay in the transcript and never become cards.

## Map content → type

| Signal in the transcript | type | folder |
|--------------------------|------|--------|
| A person/org that will recur ("met X", "from company Y") | `contact` | `cards/contacts/` |
| Ongoing effort with deliverables ("working on Z", "the X project") | `project` | `cards/projects/` |
| A choice made + reason ("decided to…", "going with… because…") | `decision` | `cards/decisions/` |
| A proposal/hypothesis worth revisiting ("what if…", "idea:") | `idea` | `cards/ideas/` |
| A durable fact / learning / reference ("turns out…", "TIL", a how-to) | `note` | `cards/notes/` |

## Stays in the transcript (do NOT card)

- Logistics, scheduling, acknowledgements, transient status.
- One-off questions already answered inline by Iva with no lasting fact.
- Emotional venting with no decision/idea/fact to keep.
- Anything already represented by an existing card → **update** that card instead.

## Topics (for the daily-summary)

Topics are 2–6 short labels describing what the day was *about* — broader than tags,
narrower than domains. Examples: `iva-memory`, `deepgram`, `vault-schema`, `family`,
`reading`. They populate the summary's `## Topics` and `topics:` frontmatter and are the
primary way weekly/monthly/yearly rollups understand the period.

## Decision vs. idea vs. note

- **decision** — irreversible-ish, has a rationale, can later be `superseded`/`reverted`.
- **idea** — not yet acted on; status `active` → `explored` → `archived`.
- **note** — a fact/learning with no action attached.

## Update vs. create

Update an existing card when the new info is the *same subject*. Signs you should update:
same person, same project, same decision being refined. Append a dated line under a
`## Log` section and sharpen the `description`. Creating a near-duplicate is the most
common mistake — grep first.

## ADD / SUPERSEDE / NOOP (temporal conflict)

For every fact, pick one operation:

- **ADD** — genuinely new subject → create a card (prefer the `write_card` tool; it enforces
  the schema so you can't invent a type or field).
- **NOOP** — already captured and unchanged → do nothing.
- **SUPERSEDE** — the new fact *contradicts* a current value on an existing card (job changed,
  moved city, status flipped). Do NOT just append: **rewrite** the card's current value
  (frontmatter field + top of the description) to the new fact — this is "Compiled Truth", the
  living snapshot of what is true *now* — and move the OLD value to a `## History` section as a
  dated line: `- 2026-03→06: TDI Group`. History is append-only and never edited.
  **Never leave two contradictory current values on the same subject.**
  If a whole card is obsolete (project renamed, decision reverted), set `status: superseded`
  and add `superseded_by: [[new-card]]`.

The deterministic scan `.graph/supersede-candidates.json` lists same-entity cards with
conflicting fields — resolve each by superseding the stale one.

## Confidence

Tag each fact's certainty in frontmatter with `confidence:`:
- **EXTRACTED** — the user stated it directly (assert it when recalling).
- **INFERRED** — you deduced it (hedge when recalling: "похоже, ты…").
- **AMBIGUOUS** — unclear/conflicting source (flag it).
