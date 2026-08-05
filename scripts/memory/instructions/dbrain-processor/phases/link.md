# Phase 3: LINK

Wire every card created/updated in Phase 2 into the graph. No orphans.

## Input

- `created` / `updated` card paths from Phase 2.

## Linking protocol (mandatory per card)

1. **Hub link.** Determine the card's domain from its path via schema
   `domain_inference` (`cards/projects/` → work, `cards/notes/` → knowledge, etc.).
   Add the domain hub through the `write_card` tool's `related` argument, for
   example `cards/notes/_index|Knowledge`. Never place a `## Related` heading in
   `body`; the tool owns the section.
   The hub is the domain's `_index.md` (created/maintained by `moc.py generate`). If it
   does not exist yet, still link it — the mechanical pass will materialize it.
2. **Neighbor links (2–3).** Find sibling cards of the same type+domain and pass the
   2–3 most relevant targets through `related` (an Obsidian alias is allowed):
   Find siblings with:
   ```bash
   grep -rl "type: <type>" vault/cards/<kind>/
   uv run scripts/autograph/graph.py backlinks vault cards/<kind>/<hub> vault/schema.json
   ```
3. **Back-reference.** When a card relates strongly to another, add the reciprocal link
   on the neighbor too (keep the graph undirected where it makes sense). For a
   relation-only UPDATE, reread the neighbor and pass a body fact that is already
   present verbatim; the idempotence check prevents a new Log entry while `related`
   is canonicalized.
4. **Touch.** Mark the card as freshly accessed so decay treats it as active:
   ```bash
   uv run scripts/autograph/engine.py touch vault/cards/<kind>/<file>.md
   ```

## Checklist per card

- [ ] Hub linked in `## Related`?
- [ ] ≥2 neighbor links?
- [ ] `description` ≠ title repeat?
- [ ] `tags`: 2–5, lowercase, kebab-case?
- [ ] `status` ∈ schema enum for the type?

## Output of this phase

All created/updated cards now have a populated `## Related`. Proceed to SUMMARIZE,
which links the daily-summary down to these cards.

Before proceeding, reread every touched card. Each must have exactly one
`## Related`, at most one `## Log`, no dated update heading, and current Compiled
Truth. Fix any violation now; do not defer it to the next nightly pass.
