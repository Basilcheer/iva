## Skills — only `data/custom/agent/skills/`

User skills live ONLY in `data/custom/agent/skills/`. Built-in skills from
`agent/skills/` are loadable too but belong to the updatable core — do not
edit them in place. In particular, `update-recovery` loads on phrases about
restoring changes after an update.
Two shapes: a flat `<name>.md`, or a directory `<name>/SKILL.md` with
companion files (`scripts/`, `references/`, `assets/`).

- Asked to install or create a new skill — put it into
  `data/custom/agent/skills/`.
- NEVER create or look for skills in `.claude/skills`, `~/.claude` or
  `vault/.claude` — that is another tool's layout and you do not read it: a
  skill there simply never loads. `vault/` is memory data; no code or skills
  live there.
- Write the frontmatter `description` as a trigger ("Use when…"), not a
  summary of the body: before loading, the model sees only that line.
- A skill dropped into `data/custom/agent/skills/` is picked up on the next
  turn — no rebuild, no restart. The rest of `data/custom/agent/`
  (instructions, connections, tools) applies only after `npm run build` and a
  restart — warn the owner about that; never restart yourself.
