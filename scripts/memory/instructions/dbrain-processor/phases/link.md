# Phase 3: LINK

Wire every card created/updated in Phase 2 into the graph. No orphans.

## Input

- `created` / `updated` card paths from Phase 2.

## Linking protocol (mandatory per card)

1. **Hub link.** Determine the card's domain from its path via schema
   `domain_inference` (`cards/projects/` → work, `cards/notes/` → knowledge, etc.).
   Add the domain hub to a `## Related` section:
   ```markdown
   ## Related
   - [[cards/notes/_index|Knowledge]]
   ```
   The hub is the domain's `_index.md` (created/maintained by `moc.py generate`). If it
   does not exist yet, still link it — the mechanical pass will materialize it.
2. **Neighbor links (2–3).** Find sibling cards of the same type+domain and link the
   2–3 most relevant, each with a short context phrase:
   ```markdown
   - [[cards/projects/iva-memory|Iva memory]] — this decision implements its scheduler
   ```
   Find siblings with:
   ```bash
   grep -rl "type: <type>" vault/cards/<kind>/
   uv run scripts/autograph/graph.py backlinks vault cards/<kind>/<hub> vault/schema.json
   ```
3. **Back-reference.** When a card relates strongly to another, add the reciprocal link
   on the neighbor too (keep the graph undirected where it makes sense).
4. **Touch.** Mark the card as freshly accessed so decay treats it as active:
   ```bash
   uv run scripts/autograph/engine.py touch vault/cards/<kind>/<file>.md
   ```

## Checklist per card

- [ ] Hub linked in `## Related`?
- [ ] ≥2 neighbor links with context phrases?
- [ ] `description` ≠ title repeat?
- [ ] `tags`: 2–5, lowercase, kebab-case?
- [ ] `status` ∈ schema enum for the type?

## Output of this phase

All created/updated cards now have a populated `## Related`. Proceed to SUMMARIZE,
which links the daily-summary down to these cards.
