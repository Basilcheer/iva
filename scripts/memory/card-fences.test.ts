import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanUnclosedFenceCards } from "./card-fences.ts";

void test("unclosed fence scan lists user cards only and never touches them", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "iva-fence-vault-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  await mkdir(join(vault, "cards", "notes"), { recursive: true });
  await mkdir(join(vault, ".graph"), { recursive: true });

  const broken =
    "---\ntype: note\n---\n\n# Broken\n\n```yaml\nowner: Alice\n\n## History\n\n- 2026-01-01: Owner Zed\n";
  await writeFile(join(vault, "cards", "notes", "broken.md"), broken);
  // Закрытый фенс, фенс с отступом до 3 и ~~~ - валидные карточки, в отчёт не идут.
  await writeFile(
    join(vault, "cards", "notes", "fine.md"),
    "---\ntype: note\n---\n\n# Fine\n\n   ```yaml\nowner: Alice\n```\n\n~~~\nx\n~~~\n",
  );
  // Фенс, открытый в frontmatter-скаляре, телом не является.
  await writeFile(
    join(vault, "cards", "notes", "frontmatter.md"),
    '---\ntype: note\ndescription: "```"\n---\n\n# Frontmatter only\n',
  );
  await writeFile(join(vault, ".graph", "report.md"), "```\nservice output\n");
  await writeFile(join(vault, "cards", "notes", "not-markdown.txt"), "```\n");
  // Сырой транскрипт вне cards/: write_card его не пишет, алерт про него был бы ложным.
  await mkdir(join(vault, "daily"), { recursive: true });
  await writeFile(join(vault, "daily", "2026-08-10.md"), "```\nвойс\n");

  assert.deepEqual(scanUnclosedFenceCards(vault), ["cards/notes/broken.md"]);
  assert.equal(
    await readFile(join(vault, "cards", "notes", "broken.md"), "utf8"),
    broken,
  );
  assert.deepEqual(scanUnclosedFenceCards(join(vault, "missing")), []);
});
