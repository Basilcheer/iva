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


def scan_local_images(md, env_file):
    """Validate every file: reference: it must exist and live under an allowed root
    (repo or data dir) - anything else would let a message exfiltrate arbitrary
    readable files from the VPS through a public host."""
    roots = allowed_image_roots(env_file)
    paths = []
    for m in IMG_RE.finditer(md):
        path = _local_path(m.group(1))
        if not os.path.exists(path):
            sys.exit(f"local image not found: {path}")
        real = os.path.realpath(path)
        if not any(real == r or real.startswith(r + os.sep) for r in roots):
            sys.exit(f"refusing local image outside the allowed roots ({', '.join(roots)}): {path}")
        paths.append(path)
    return paths


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


def resolve_local_images(md):
    """Replace ![](file:/path "cap") with ![](public_url "cap"). Upload-bearing:
    call only after the --allow-upload gate."""
    def repl(m):
        cap = m.group(2) or ""
        path = _local_path(m.group(1))
        url = upload_tmpfiles(path)
        sys.stderr.write(f"uploaded {path} -> {url}\n")
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

    chat = resolve_chat(a.chat, env_file)

    if local_images and not a.allow_upload:
        sys.exit(
            "markdown references local images, and Telegram needs a public URL for them. "
            "Re-run with --allow-upload to publish them on tmpfiles.org (a PUBLIC anonymous "
            "host - anyone with the link can view them), or switch to already-public URLs."
        )
    if local_images:
        md = resolve_local_images(md)

    token = get_token(env_file)
    send(token, chat, md, silent=a.silent, thread_id=a.thread_id)


if __name__ == "__main__":
    main()
