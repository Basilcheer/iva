# Extending

Everything Iva does is a file in an `agent/` tree. The bundled files in `agent/` belong to the updateable
core; your authored layer lives in `data/custom/agent/`. `npm run build` combines both in a disposable
tree, then `iva restart` activates the result ([cli.md](./cli.md)). The live source checkout stays clean,
so an update cannot be blocked by a customized skill or HTML file. Existing local edits in the authored
paths are migrated automatically on the first update.

## Adding a skill

Skills are markdown procedures in `data/custom/agent/skills/` that the model loads on demand. The
frontmatter `description` is the only part the model sees before loading - write it as a trigger
condition ("Use when…"), not a summary. Two shapes work: a flat `<name>.md`, or a `<name>/` directory
with a `SKILL.md` plus supporting files. Iva loads both your custom skills and the bundled skills in
`agent/skills/`; bundled skills are read-only templates, simplest first:

- 📋 **morning-digest.md** — one tool call (`tasks`), grouping rules, output format. Copy this for any "call a tool, format the result" job.
- 🔎 **web-research.md** — a 4-step chain: `web_search` → pick 2–4 sources → `web_fetch` each → synthesize with links.
- 🌐 **agent-browser/** — directory skill wrapping a CLI the model drives through `bash`.
- 🛡 **security-defense/** — the full shape: `SKILL.md`, bundled scripts, a patterns file.
- 📮 **google-workspace.md** — one CLI surface covering Gmail, Calendar, Drive, Sheets, Docs and Tasks.
- 📄 **documents.md** — local PDF, DOCX and XLSX extraction, one-file answers and optional library import.
- 📡 **telegram-userbot/** — a guarded personal-account workflow with a separate safety reference.
- 🎨 **rich-post/** — a directory skill for rich Telegram posts with supporting references.
- 🩹 **update-recovery/** — merges customizations an update left in `data/update-conflicts/`; triggered by "restore my update changes".

⚠️ Your skills go in `data/custom/agent/skills/` and nowhere else - never in a `.claude/` directory
(`~/.claude/skills/`, `vault/.claude/skills/`). That is a different tool's layout; Iva does not read it.

If Iva should reach for your skill unprompted, name it in
`data/custom/agent/instructions.md`. Copy `agent/instructions.md` there before the first edit if the
custom file does not exist yet.

## MCP connections

Drop `data/custom/agent/connections/<name>.ts` - the filename becomes the connection name.
`agent/connections/example.ts.txt` is the inert bundled template (the `.txt` suffix keeps eve from
loading it half-configured):

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.example.com/sse", // Streamable HTTP or SSE endpoint
  description: "What this server does — the model reads this.",
  auth: {
    getToken: async () => ({ token: process.env.EXAMPLE_MCP_TOKEN ?? "" }),
  },
  // tools: { allow: ["search", "get_item"] },  // optional: restrict, add approval
});
```

The model discovers the server's tools through the built-in `connection_search` and calls them as `connection__<name>__<tool>`. The URL and token stay on the runtime side: keys live in `.env` and are never visible to the model.

## Custom tools

Put a tool in `data/custom/agent/tools/<name>.ts`. Use the bundled files in `agent/tools/` as
read-only examples. Every input must have a zod schema, enum-like values need explicit allowlists,
and file paths must be resolved and bounded to their permitted root. Keep credentials in `.env`.
The disposable build compiles custom tools together with core tools without copying their source into
the live checkout.

## Subagents

A subagent is `data/custom/agent/subagents/<name>/` with an `agent.ts` and its own `instructions.md`.
The bundled `agent/subagents/planner` is the pattern: its `description` tells the main agent when to
delegate ("break a large goal into steps"), and a zod `outputSchema` forces a structured, validated
reply instead of prose:

```ts
outputSchema: z.object({
  goal: z.string(),
  steps: z.array(z.object({
    title: z.string(), detail: z.string(), priority: z.enum(["low", "med", "high"]),
  })),
}),
```

A subagent brings its own provider and model: the planner pins Ollama Cloud (`OLLAMA_API_KEY` / `OLLAMA_MODEL`) in its `agent.ts`, independent of the main agent's `MODEL_PROVIDER` — so a cheap model for a narrow job costs nothing extra to wire.

## Changing the character

Iva's voice lives in exactly one customizable file: `data/custom/agent/instructions.md` - tone, rules,
tool preferences and hard limits. Start by copying the bundled `agent/instructions.md`. The reply
language still comes from `AGENT_LANGUAGE` in `.env`. The files in `agent/instructions/` are core
machinery and are not part of the customization layer.

If an upstream edit overlaps yours, Iva activates the new core and saves all three versions under
`data/update-conflicts/`. Tell Iva "restore my update changes" or «верни мои изменения после
обновления» to load the recovery skill and merge them from chat.

What Iva knows about _you_ is memory, not code — that's `CORE.md` in the vault ([memory.md](./memory.md)).

## Local development

```bash
npm ci        # postinstall applies patches/eve+0.30.8.patch
npm run dev   # eve dev TUI, server on http://127.0.0.1:2000
npm run build:core  # maintainer build of the current source tree
npm exec -- eve dev --no-ui --logs all   # headless
```

The TUI is a full chat — skills, tools and subagents all work without Telegram. To smoke-test the tool loop from a script, drive the dev server with `eve/client`:

```js
import { Client } from "eve/client";
const session = new Client({ host: "http://127.0.0.1:2000" }).session();
const res = await session.send("Add a task: buy coffee, high priority.");
console.log((await res.result()).message);
```

One gotcha — Iva runs eve **0.30.8**:

- 🩹 **patch-package** — `patches/eve+0.30.8.patch` makes deterministic model-call errors (invalid prompt, unknown tool) fail fast instead of parking a poisoned session; upstream still classifies them as recoverable in 0.30.8. If you bump Eve, regenerate the patch (re-apply the edit to `node_modules/eve/dist/src/harness/model-call-error.js`, then `npx patch-package eve`) or drop it only after the targeted classification test passes against upstream.

The Eve 0.11.4 schedule crash (`eve dev` dying when a schedule handler imported another authored module) is fixed since 0.27.8. Iva now ships five `agent/schedules/*.ts` handlers: four memory rollups and the opt-in digest. On a VPS they run in the `iva.service` process; the two remaining systemd timers are watchdogs for doctor and update-check ([deploy.md](./deploy.md)).
