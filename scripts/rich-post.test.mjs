// Интеграционные тесты send_rich.py (subprocess): офлайновый dry-run, гейт --allow-upload,
// allowlist получателей, отсутствие --token, отказ на путях вне разрешённых корней.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "agent/skills/rich-post/scripts/send_rich.py");

// Чистое окружение: реальные TELEGRAM_*-переменные процесса не должны утекать в тест;
// RICH_POST_ENV указывает на подставной .env с известным allowlist'ом.
function runScript(args, { env = {}, allowlist = "111 222", digest = "999" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rich-post-"));
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    `TELEGRAM_ALLOWED_USER_IDS=${allowlist}\nTELEGRAM_DIGEST_CHAT_ID=${digest}\n`,
  );
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME, RICH_POST_ENV: envFile, ...env };
  const r = spawnSync("python3", [SCRIPT, ...args], { env: clean, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("dry-run с локальной картинкой офлайнов: перечисляет, но не грузит", () => {
  const img = join(ROOT, "README.md"); // существующий файл внутри репо сойдёт за «картинку»
  const r = runScript(["--md", `text ![](file:${img}) more`, "--dry-run"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /would upload/, "dry-run обязан лишь перечислить кандидатов");
  assert.doesNotMatch(r.stdout + r.stderr, /uploaded /, "никаких реальных загрузок в dry-run");
  assert.ok(r.stdout.includes(`file:${img}`), "markdown печатается без подмены URL");
});

test("локальная картинка без --allow-upload и без dry-run — отказ с подсказкой", () => {
  const img = join(ROOT, "README.md");
  const r = runScript(["--md", `![](file:${img})`, "--chat", "111"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--allow-upload/);
  assert.match(r.stderr, /tmpfiles\.org/i, "пользователь должен видеть, КУДА уйдёт файл");
});

test("чужой --chat вне allowlist — отказ без отправки", () => {
  const r = runScript(["--md", "hello", "--chat", "555000"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /allowlist/);
});

test("картинка вне разрешённых корней — отказ (анти-эксфильтрация)", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const img = join(outside, "x.jpg");
  writeFileSync(img, "fake");
  const r = runScript(["--md", `![](file:${img})`, "--dry-run"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /allowed roots/);
});

test("без токена — понятная ошибка (и никакого --token в CLI)", () => {
  const r = runScript(["--md", "hello", "--chat", "111"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no token/);
  const help = runScript(["--help"]);
  assert.doesNotMatch(help.stdout, /--token/, "флага --token быть не должно — argv виден в ps");
});
