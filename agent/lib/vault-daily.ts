// Всё, что входящее сообщение оставляет в Vault: реплика в дневном файле
// (`## HH:MM [type]` + контент, формат d_brain) и блоб вложения рядом с ней.
// Дата и время — в часовом поясе пользователя (ASSISTANT_TIMEZONE, иначе
// локальный TZ), поэтому один и тот же день не разъезжается между записями.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type VaultStamp = { date: string; hhmm: string; hhmmss: string };

export function localStamp(): VaultStamp {
  const tz = process.env.ASSISTANT_TIMEZONE || undefined;
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const hhmmss = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(/:/g, "");
  return { date, hhmm, hhmmss };
}

// Возвращает путь дневного файла: он же ссылка на полную запись, когда гейт
// усёк вход для модели.
export function appendDaily(type: string, content: string): string {
  const { date, hhmm } = localStamp();
  const dir = join(process.env.ASSISTANT_VAULT_DIR || "vault", "daily");
  mkdirSync(dir, { recursive: true });
  // Append-only: существующие записи никогда не переписываются.
  const path = join(dir, `${date}.md`);
  appendFileSync(path, `\n## ${hhmm} ${type}\n${content}\n`, "utf8");
  return path;
}

// Расширение из имени → mediaType → дефолт по виду.
function attExt(
  name: string | undefined,
  mediaType: string | undefined,
  kind: string,
): string {
  const m = name && /\.([a-z0-9]{1,8})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  const sub = mediaType?.includes("/") ? mediaType.split("/")[1] : "";
  if (/^[a-z0-9.+-]{1,8}$/i.test(sub))
    return sub.toLowerCase().replace("+xml", "");
  return kind === "photo" ? "jpg" : "bin";
}

// Сохраняет блоб в vault/attachments/<date>/<name>, возвращает rel-путь для Obsidian-embed.
// Имя берём из присланного (санитизируем), иначе <kind>-<hhmmss>.<ext>; коллизии нумеруем.
export function saveBlob(
  bytes: ArrayBuffer,
  name: string | undefined,
  kind: string,
  mediaType: string | undefined,
  stamp: Pick<VaultStamp, "date" | "hhmmss">,
): string {
  const ext = attExt(name, mediaType, kind);
  const safe = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  let fname =
    safe && /\.[a-z0-9]+$/.test(safe) ? safe : `${kind}-${stamp.hhmmss}.${ext}`;
  const dir = join(
    process.env.ASSISTANT_VAULT_DIR || "vault",
    "attachments",
    stamp.date,
  );
  mkdirSync(dir, { recursive: true });
  const dot = fname.lastIndexOf(".");
  const base = dot > 0 ? fname.slice(0, dot) : fname;
  const tail = dot > 0 ? fname.slice(dot) : "";
  let i = 1;
  while (existsSync(join(dir, fname))) fname = `${base}-${i++}${tail}`;
  writeFileSync(join(dir, fname), Buffer.from(bytes));
  return `attachments/${stamp.date}/${fname}`;
}
