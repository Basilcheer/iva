#!/usr/bin/env python3
"""
Send a Telegram rich message (Bot API 10.1 sendRichMessage) via the Iva bot.

Rich messages put text, inline images, tables, headings, lists, quotes,
collapsible blocks and formulas into ONE message bubble - unlike albums
(one caption, no text between images).

Local images: write them in the markdown as ![](file:/abs/path "caption").
Telegram REQUIRES a public URL for rich-message media, so local files must be
uploaded somewhere public first. That upload goes to tmpfiles.org - an
anonymous public host - and therefore ONLY happens with an explicit
--allow-upload flag. Without the flag, local images are an error.

Recipient policy: the destination is NOT the model's choice. By default the
message goes to TELEGRAM_DIGEST_CHAT_ID; an explicit --chat is accepted only
if it is in the allowlist (TELEGRAM_ALLOWED_USER_IDS + TELEGRAM_DIGEST_CHAT_ID).

Token resolution: $TELEGRAM_BOT_TOKEN > .env ($RICH_POST_ENV or the repo root).
There is deliberately NO --token flag: argv is visible in the process list.

Usage:
  python3 send_rich.py --md-file post.md                      # to the digest chat
  python3 send_rich.py --chat <allowlisted id> --md-file -    # explicit recipient
  python3 send_rich.py --md-file post.md --dry-run            # offline check
"""
import argparse, json, os, re, sys, urllib.request, urllib.parse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# agent/skills/rich-post/scripts -> repo root is four levels up.
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))

IMG_RE = re.compile(r'!\[[^\]]*\]\(\s*(file://\S+|file:/\S+)(\s+"[^"]*")?\s*\)')


def read_env_file():
    """KEY=VALUE pairs from $RICH_POST_ENV or the repo's .env (never other projects)."""
    path = os.environ.get("RICH_POST_ENV") or os.path.join(REPO_ROOT, ".env")
    out = {}
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def env_value(name, env_file):
    return os.environ.get(name) or env_file.get(name) or ""


def get_token(env_file):
    token = env_value("TELEGRAM_BOT_TOKEN", env_file)
    if not token:
        sys.exit("no token: set $TELEGRAM_BOT_TOKEN or put TELEGRAM_BOT_TOKEN= in the repo .env")
    return token


def resolve_chat(arg_chat, env_file):
    """Default: the digest chat. An explicit --chat must be allowlisted - the model
    must not be able to pick an arbitrary recipient for a report."""
    digest = env_value("TELEGRAM_DIGEST_CHAT_ID", env_file)
    if not arg_chat:
        if not digest:
            sys.exit("no recipient: set TELEGRAM_DIGEST_CHAT_ID in .env or pass an allowlisted --chat")
        return digest
    allowed = set(re.split(r"[,\s]+", env_value("TELEGRAM_ALLOWED_USER_IDS", env_file)))
    allowed.discard("")
    if digest:
        allowed.add(digest)
    if str(arg_chat) not in allowed:
        sys.exit(
            f"refusing to send: chat {arg_chat} is not in the allowlist "
            "(TELEGRAM_ALLOWED_USER_IDS + TELEGRAM_DIGEST_CHAT_ID)"
        )
    return arg_chat


def allowed_image_roots(env_file):
    data_dir = env_value("ASSISTANT_DATA_DIR", env_file) or "data"
    if not os.path.isabs(data_dir):
        data_dir = os.path.join(REPO_ROOT, data_dir)
    return [REPO_ROOT, os.path.abspath(data_dir)]


def _local_path(raw):
    return os.path.abspath(raw[len("file://"):] if raw.startswith("file://") else raw[len("file:"):])


# Only real media may leave the box: .env, OAuth json, logs, vault .md and any other
# text/secret file is NOT uploadable even with --allow-upload.
MEDIA_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov", ".mp3", ".ogg", ".m4a"}
# Любая markdown-картинка (и file:, и https:) — для общего лимита Telegram в 50 медиа.
ANY_IMG_RE = re.compile(r"!\[[^\]]*\]\(")


def _looks_like_media(path):
    """Magic-bytes check: расширение подделать тривиально (cp .env x.png), заголовок
    настоящего медиафайла — нет. Проверяем стандартные сигнатуры stdlib-ом."""
    try:
        with open(path, "rb") as f:
            h = f.read(16)
    except OSError:
        return False
    if h.startswith(b"\xff\xd8\xff"):  # jpeg
        return True
    if h.startswith(b"\x89PNG\r\n\x1a\n"):  # png
        return True
    if h.startswith((b"GIF87a", b"GIF89a")):  # gif
        return True
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":  # webp
        return True
    if h[4:8] == b"ftyp":  # mp4 / mov / m4a
        return True
    if h.startswith(b"\x1a\x45\xdf\xa3"):  # webm/mkv (EBML)
        return True
    if h.startswith(b"OggS"):  # ogg
        return True
    if h.startswith(b"ID3") or (len(h) >= 2 and h[0] == 0xFF and (h[1] & 0xE0) == 0xE0):  # mp3
        return True
    return False


def scan_local_images(md, env_file):
    """Validate every file: reference. Allowed: an existing REGULAR file whose extension
    AND magic bytes look like media, under the repo or data dir, with no dot-segment
    (.env, .config, .eve) anywhere in its path. Everything else is refused: otherwise a
    message could exfiltrate secrets through a public host. Returns the RESOLVED real
    paths — the upload step must use exactly what was validated (no symlink re-swap)."""
    roots = allowed_image_roots(env_file)
    resolved = {}
    for m in IMG_RE.finditer(md):
        path = _local_path(m.group(1))
        if not os.path.exists(path):
            sys.exit(f"local image not found: {path}")
        real = os.path.realpath(path)
        if not os.path.isfile(real):
            sys.exit(f"not a regular file: {path}")
        if not any(real == r or real.startswith(r + os.sep) for r in roots):
            sys.exit(f"refusing local image outside the allowed roots ({', '.join(roots)}): {path}")
        if os.path.splitext(real)[1].lower() not in MEDIA_EXT:
            sys.exit(
                f"refusing non-media file (extension not in {sorted(MEDIA_EXT)}): {path} — "
                "only images/video/audio may be uploaded"
            )
        if any(seg.startswith(".") for seg in real.split(os.sep) if seg):
            sys.exit(f"refusing dot-path (hidden/config file or directory): {path}")
        if not _looks_like_media(real):
            sys.exit(f"refusing file that does not look like media (magic bytes): {path}")
        resolved[path] = real
    total_media = len(ANY_IMG_RE.findall(md))
    if total_media > 50:
        sys.exit(f"too many media attachments: {total_media} > 50 (Telegram rich-message limit)")
    return resolved


def upload_tmpfiles(path):
    """Upload a local file to tmpfiles.org (a PUBLIC, anonymous host!), return a
    direct-download URL. Only reachable behind --allow-upload."""
    import subprocess
    out = subprocess.run(
        ["curl", "-s", "-F", f"file=@{path}", "https://tmpfiles.org/api/v1/upload"],
        capture_output=True, text=True, timeout=120,
    ).stdout
    try:
        url = json.loads(out)["data"]["url"]
    except Exception:
        sys.exit(f"image upload failed for {path}: {out[:200]}")
    # viewer URL -> direct-download URL
    return url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)


def resolve_local_images(md, resolved):
    """Replace ![](file:/path "cap") with ![](public_url "cap"). Upload-bearing:
    call only after the --allow-upload gate. Uploads ONLY the realpath validated by
    scan_local_images — swapping the symlink after validation changes nothing."""
    def repl(m):
        cap = m.group(2) or ""
        path = _local_path(m.group(1))
        real = resolved.get(path)
        if real is None:
            sys.exit(f"internal error: unvalidated image reference {path}")
        url = upload_tmpfiles(real)
        sys.stderr.write(f"uploaded {real} -> {url}\n")
        return f"![]({url}{cap})"
    return IMG_RE.sub(repl, md)


def send(token, chat, md, silent=False, thread_id=None):
    payload = {
        "chat_id": str(chat),
        "rich_message": json.dumps({"markdown": md}, ensure_ascii=False),
    }
    if silent:
        payload["disable_notification"] = "true"
    if thread_id:
        payload["message_thread_id"] = str(thread_id)
    data = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendRichMessage", data=data
    )
    try:
        r = urllib.request.urlopen(req, timeout=60)
        res = json.loads(r.read().decode())
        print(f"OK message_id={res['result']['message_id']} -> {chat}")
        return res
    except urllib.error.HTTPError as e:
        sys.exit(f"send failed {e.code}: {e.read().decode()[:500]}")
    except (urllib.error.URLError, TimeoutError) as e:
        sys.exit(f"send failed (network/timeout): {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chat", help="recipient (allowlisted id; default: TELEGRAM_DIGEST_CHAT_ID)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--md", help="markdown text")
    g.add_argument("--md-file", help="path to markdown file, or - for stdin")
    ap.add_argument("--silent", action="store_true", help="send without sound")
    ap.add_argument("--thread-id", help="forum topic / thread id")
    ap.add_argument(
        "--allow-upload", action="store_true",
        help="allow uploading local file: images to tmpfiles.org (a PUBLIC anonymous host)",
    )
    ap.add_argument(
        "--dry-run", action="store_true",
        help="validate offline and print the markdown; NOTHING is uploaded or sent",
    )
    a = ap.parse_args()

    if a.md is not None:
        md = a.md
    elif a.md_file == "-":
        md = sys.stdin.read()
    else:
        md = open(a.md_file, encoding="utf-8").read()

    env_file = read_env_file()
    local_images = scan_local_images(md, env_file)

    if len(md) > 32768:
        sys.exit(f"rich message too long: {len(md)} > 32768 chars")

    if a.dry_run:
        # Fully offline: no uploads, no network - just validation and a preview.
        for p in local_images:
            sys.stderr.write(f"would upload (with --allow-upload): {p}\n")
        print(md)
        return

    # Recipient and token are validated BEFORE any upload: local media must not land on
    # a public host only for the send to fail on config afterwards.
    chat = resolve_chat(a.chat, env_file)
    token = get_token(env_file)

    if local_images and not a.allow_upload:
        sys.exit(
            "markdown references local images, and Telegram needs a public URL for them. "
            "Re-run with --allow-upload to publish them on tmpfiles.org (a PUBLIC anonymous "
            "host - anyone with the link can view them), or switch to already-public URLs."
        )
    if local_images:
        md = resolve_local_images(md, local_images)
        if len(md) > 32768:
            sys.exit(f"rich message too long after image URL substitution: {len(md)} > 32768 chars")

    send(token, chat, md, silent=a.silent, thread_id=a.thread_id)


if __name__ == "__main__":
    main()
