# Phase 4: SUMMARIZE

Write the daily-summary card — the day's node in the rollup chain. Then run the mechanical
autograph pass and mark the transcript processed.

## 1. Write `summaries/daily/YYYY-MM-DD.md`

Template, MOC contract and the quiet-day rule: section daily-format. The file already exists
(an earlier part, a rerun) → reconcile it: refresh `## Topics`, add the new cards, keep
`## Navigation`; never write a second file.

## 2. Mark the transcript processed

After each part of a large day, append the part marker (section memory-processor, «Parts») — the summary
above already carries that part:

```markdown
<!-- processed-through: HH:MM -->
```

When the whole day is done, append to the **end** of `daily/YYYY-MM-DD.md` (never edit
existing entries):

```markdown
<!-- processed: YYYY-MM-DDTHH:MM -->

---

processed: YYYY-MM-DDTHH:MM
cards: <N>
summary: summaries/daily/YYYY-MM-DD.md
---
```

## 3. Mechanical autograph pass

From the project root, with the vault as an argument (dry-run, then `--apply`):

```bash
uv run scripts/autograph/cleanup.py vault --apply
uv run scripts/autograph/enforce.py vault vault/schema.json --apply
uv run scripts/autograph/graph.py fix vault vault/schema.json --apply
uv run scripts/autograph/engine.py touch vault/summaries/daily/YYYY-MM-DD.md
uv run scripts/autograph/moc.py generate vault vault/schema.json
uv run scripts/autograph/engine.py decay vault
uv run scripts/autograph/graph.py health vault vault/schema.json
```
