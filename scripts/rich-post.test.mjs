// Интеграционные тесты send_rich.py (subprocess): офлайновый dry-run, гейт --allow-upload,
// media-гейт (только картинки/видео из разрешённых корней), allowlist получателей,
// отсутствие --token.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "agent/skills/rich-post/scripts/send_rich.py");

// Чистое окружение: реальные TELEGRAM_*-переменные процесса не должны утекать в тест.
// RICH_POST_ENV указывает на подставной .env; ASSISTANT_DATA_DIR — временная директория,
// куда тесты кладут «картинки» (media-гейт пускает только разрешённые корни).
function makeCtx({ allowlist = "111 222", digest = "999", token = "123:FAKE" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rich-post-"));
  const envFile = join(dir, ".env");
  const tokenLine = token ? `TELEGRAM_BOT_TOKEN=${token}\n` : "";
  writeFileSync(
    envFile,
    `${tokenLine}TELEGRAM_ALLOWED_USER_IDS=${allowlist}\nTELEGRAM_DIGEST_CHAT_ID=${digest}\nASSISTANT_DATA_DIR=${dir}\n`,
  );
  return { dir, envFile };
}

function runScript(args, ctx = makeCtx()) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, RICH_POST_ENV: ctx.envFile };
  const r = spawnSync("python3", [SCRIPT, ...args], { env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("dry-run с локальной картинкой офлайнов: перечисляет, но не грузит", () => {
  const ctx = makeCtx();
  const img = join(ctx.dir, "cover.png");
  writeFileSync(img, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]));
  const r = runScript(["--md", `text ![](file:${img}) more`, "--dry-run"], ctx);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /would upload/, "dry-run обязан лишь перечислить кандидатов");
  assert.doesNotMatch(r.stdout + r.stderr, /uploaded /, "никаких реальных загрузок в dry-run");
  assert.ok(r.stdout.includes(`file:${img}`), "markdown печатается без подмены URL");
});

test("локальная картинка без --allow-upload и без dry-run — отказ с подсказкой", () => {
  const ctx = makeCtx();
  const img = join(ctx.dir, "cover.jpg");
  writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
  const r = runScript(["--md", `![](file:${img})`, "--chat", "111"], ctx);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--allow-upload/);
  assert.match(r.stderr, /tmpfiles\.org/i, "пользователь должен видеть, КУДА уйдёт файл");
});

test("не-media файл (например .env) не грузится даже из разрешённого корня", () => {
  const ctx = makeCtx();
  const r = runScript(["--md", `![](file:${ctx.envFile})`, "--dry-run"], ctx);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /non-media|dot-path/, "секреты не должны проходить media-гейт");
});

test("чужой --chat вне allowlist — отказ без отправки", () => {
  const r = runScript(["--md", "hello", "--chat", "555000"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /allowlist/);
});

test("картинка вне разрешённых корней — отказ (анти-эксфильтрация)", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const img = join(outside, "x.jpg");
  writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
  const r = runScript(["--md", `![](file:${img})`, "--dry-run"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /allowed roots/);
});

test("без токена — понятная ошибка ДО каких-либо загрузок (и никакого --token в CLI)", () => {
  const r = runScript(["--md", "hello", "--chat", "111"], makeCtx({ token: "" }));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no token/);
  const help = runScript(["--help"]);
  assert.doesNotMatch(help.stdout, /--token/, "флага --token быть не должно — argv виден в ps");
});

test("порядок: без токена даже --allow-upload не доходит до загрузки", () => {
  const ctx = makeCtx({ token: "" });
  const img = join(ctx.dir, "cover.png");
  writeFileSync(img, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]));
  const r = runScript(["--md", `![](file:${img})`, "--chat", "111", "--allow-upload"], ctx);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no token/, "валидация конфига обязана идти раньше upload-ветки");
  assert.doesNotMatch(r.stdout + r.stderr, /uploaded /, "ни одной загрузки при сломанном конфиге");
});

test("текстовый секрет, переименованный в .png, не проходит magic-гейт", () => {
  const ctx = makeCtx();
  const img = join(ctx.dir, "copied-secret.png");
  writeFileSync(img, "TELEGRAM_BOT_TOKEN=123:SECRET");
  const r = runScript(["--md", `![](file:${img})`, "--dry-run"], ctx);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /magic bytes/, "расширение подделать тривиально — заголовок обязан проверяться");
});

test("общий лимит 50 медиа считает и удалённые URL", () => {
  const md = Array.from({ length: 51 }, (_, i) => `![](https://example.com/${i}.jpg)`).join(" ");
  const r = runScript(["--md", md, "--dry-run"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /too many media/);
});
