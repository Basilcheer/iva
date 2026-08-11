# Linking protocol

Orphan cards are wasted knowledge. Every card gets a hub + 2–3 neighbors before the day
is done.

## 1. Hub (domain index)

Resolve domain from path via schema `domain_inference`:

| Path               | domain    | hub                         |
| ------------------ | --------- | --------------------------- |
| `cards/projects/`  | work      | `cards/projects/_index.md`  |
| `cards/decisions/` | work      | `cards/decisions/_index.md` |
| `cards/contacts/`  | personal  | `cards/contacts/_index.md`  |
| `cards/notes/`     | knowledge | `cards/notes/_index.md`     |
| `cards/ideas/`     | knowledge | `cards/ideas/_index.md`     |

Hubs (`_index.md`) are generated/maintained by
`uv run scripts/autograph/moc.py generate vault vault/schema.json`. Link the hub even if it
does not exist yet — the mechanical pass materializes it.

## 2. Neighbors (2–3)

Find siblings of the same type+domain:

```bash
grep -rl "type: <type>" vault/cards/<kind>/
uv run scripts/autograph/graph.py backlinks vault cards/<kind>/_index vault/schema.json
```

Link the 2–3 most relevant, each with a context phrase explaining the relationship:

```markdown
## Related

- [[cards/projects/_index|Projects]]
- [[cards/projects/iva-memory|Iva memory]] — this decision picks its scheduler
- [[cards/notes/deepgram-nova3-multi|Deepgram nova-3 multi]] — feeds the same pipeline
```

## 3. Reciprocity

If A strongly relates to B, add the reverse link on B too. Keep the graph navigable in
both directions.

## 4. Touch & verify

```bash
uv run scripts/autograph/engine.py touch vault/cards/<kind>/<file>.md
uv run scripts/autograph/graph.py health vault vault/schema.json   # broken links should be 0
```

## Wiki-link form (Obsidian)

- `[[path/to/card|Display Text]]` — path is vault-relative, no `.md`.
- Inside tables, escape the pipe: `[[path\|Display]]`.
- See `scripts/autograph/docs/references/` for the autograph formatting references.
