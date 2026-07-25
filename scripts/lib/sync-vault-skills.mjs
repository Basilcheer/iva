// Sync vendored skill CODE from vault-template into the live vault.
//
// The live vault is created from vault-template once (init-vault) and then never
// touched by updates — so bugfixes in the vendored autograph scripts were not
// reaching existing vaults (e.g. the frontmatter-writer bug that doubled
// `description` on every rewrite and grew .md files to gigabytes). This helper
// copies ONLY code (`<skill>/scripts/*.py`) — never schema.json, cards or any
// user data — and is called from doctor.ts (nightly), init-vault.mjs and
// `iva update`, so every existing install self-heals without manual steps.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SKILLS_SUBDIR = ".claude/skills";

export function syncVaultSkills({ vaultDir, templateDir }) {
  const updated = [];
  const templateSkills = join(templateDir, SKILLS_SUBDIR);
  if (!existsSync(vaultDir) || !existsSync(templateSkills)) return { updated };

  for (const skill of readdirSync(templateSkills, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const srcScripts = join(templateSkills, skill.name, "scripts");
    if (!existsSync(srcScripts)) continue;
    const dstScripts = join(vaultDir, SKILLS_SUBDIR, skill.name, "scripts");
    mkdirSync(dstScripts, { recursive: true });

    const before = updated.length;
    for (const file of readdirSync(srcScripts)) {
      if (!file.endsWith(".py")) continue;
      const src = join(srcScripts, file);
      const dst = join(dstScripts, file);
      if (existsSync(dst) && readFileSync(dst, "utf8") === readFileSync(src, "utf8")) continue;
      copyFileSync(src, dst);
      updated.push(`${skill.name}/scripts/${file}`);
    }
    // Stale bytecode would keep the old buggy code alive after a sync.
    if (updated.length > before) rmSync(join(dstScripts, "__pycache__"), { recursive: true, force: true });
  }
  return { updated };
}
