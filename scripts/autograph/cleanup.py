#!/usr/bin/env python3
"""
autograph cleanup — surgical, bounded-memory repair of bug-bloated cards.

A historic write_frontmatter bug doubled the folded (>-) `description` value on
every rewrite, growing .md files to hundreds of MB / GBs. Such files OOM-kill
everything that reads them whole (enforce, graph, the agent itself), so this
cleaner NEVER loads a file into memory: it streams the frontmatter line-wise
with a hard per-line cap, collapses the repeated garbage in the description
block, and copies the body byte-for-byte. Nothing else in the file is touched.

Usage:
  python3 cleanup.py <vault-dir>            # dry run: report what would change
  python3 cleanup.py <vault-dir> --apply    # rewrite bloated files in place
  python3 cleanup.py <vault-dir> --verbose
"""

import os
import sys
import tempfile
from pathlib import Path

from common import (
    walk_vault, rel_path, format_field,
    collapse_repeated_description, cap_description,
)

CHUNK = 1 << 20          # streaming read size
LINE_CAP = 1 << 16       # a frontmatter line longer than this is bug garbage
BLOCK_SMALL = 4096       # description lines below this are handled as normal text
FM_MAX_LINES = 10_000    # sanity: give up on a "frontmatter" that never closes


class LineStream:
    """\\n-line reader with a hard per-line cap and access to the unread tail.

    Lines longer than the cap yield only their head (truncated=True); the rest
    of the line is drained chunk-wise and discarded, so memory stays bounded
    no matter how large the file is. After the caller stops (e.g. at the
    frontmatter closing ---), `self.buf` holds the already-read unconsumed
    bytes — together with the rest of the file handle that is the exact body.
    """

    def __init__(self, f, line_cap=LINE_CAP, chunk=CHUNK):
        self.f, self.line_cap, self.chunk = f, line_cap, chunk
        self.buf = b''
        self.eof = False

    def next_line(self):
        """Return (line_bytes, truncated) or None at end of file."""
        head = None
        while True:
            nl = self.buf.find(b'\n')
            if nl >= 0:
                line = (head, True) if head is not None else (self.buf[:nl], False)
                self.buf = self.buf[nl + 1:]
                return line
            if head is None and len(self.buf) > self.line_cap:
                head, self.buf = self.buf[:self.line_cap], b''
            elif head is not None:
                self.buf = b''
            if self.eof:
                if head is not None:
                    return head, True
                if self.buf:
                    line = (self.buf, False)
                    self.buf = b''
                    return line
                return None
            data = self.f.read(self.chunk)
            if not data:
                self.eof = True
            else:
                self.buf += data


def decode_fm_line(raw_line: bytes, truncated: bool) -> str | None:
    """Frontmatter line as STRICT utf-8, or None when those bytes are not utf-8.

    cleanup runs FIRST at night (brain.ts: cleanup → enforce → … → decay) and rewrites
    the frontmatter it parsed. Decoding with errors='ignore' silently dropped every byte
    it could not read and then wrote the result back over the card: the bytes were gone
    before any later step could refuse to touch them (ADR-0002). A line we cannot decode
    means the whole file is left alone — the body is copied verbatim anyway, so only the
    frontmatter is ever read as text.
    """
    try:
        return raw_line.decode('utf-8')
    except UnicodeDecodeError:
        pass
    if truncated:
        # Обрезка по LINE_CAP режет по БАЙТУ и может разрубить символ на конце строки.
        # Это артефакт чтения, а не порча файла: отбрасываем хвост (максимум 3 байта —
        # длина символа utf-8 минус один) и пробуем снова. Если не помогло — байты
        # действительно не utf-8.
        for cut in (1, 2, 3):
            try:
                return raw_line[:-cut].decode('utf-8')
            except UnicodeDecodeError:
                continue
    return None


def collapse_from_sample(sample: str) -> str:
    """Recover the repeated unit from the head of a giant description value.
    The sample is an exact prefix of the value; the full tail was already
    discarded as garbage, so a non-periodic sample just gets capped."""
    sample = sample.strip()
    probe = sample[:200]
    idx = sample.find(probe, 1)
    if idx > 20:
        unit = sample[:idx].rstrip()
        tiled = (unit + ' ') * (len(sample) // (len(unit) + 1) + 2)
        if sample == tiled[:len(sample)]:
            return cap_description(unit)
    return cap_description(sample)


def clean_file(md: Path, apply: bool):
    """Returns (old_size, new_size) when the file was/would be cleaned, else None."""
    old_size = md.stat().st_size
    with open(md, 'rb') as f:
        ls = LineStream(f)
        first = ls.next_line()
        if first is None or first[1] or first[0].strip() != b'---':
            return None

        out = []            # processed frontmatter lines (always small)
        changed = False
        desc_lines = []     # small lines of the current description block
        desc_sample = None  # head of the first giant line in the block
        in_desc = False
        closed = False

        def flush_desc():
            nonlocal changed
            if desc_sample is not None:
                out.append(format_field('description', collapse_from_sample(desc_sample)))
                changed = True
                return
            raw = ' '.join(desc_lines).strip()
            value = cap_description(collapse_repeated_description(raw))
            if value == raw:
                out.append('description: >-' if raw else 'description:')
                out.extend('  ' + l for l in desc_lines)
                return
            out.append(format_field('description', value))
            changed = True

        while True:
            item = ls.next_line()
            if item is None:
                break
            if len(out) + len(desc_lines) > FM_MAX_LINES:
                return None  # not a sane frontmatter — leave the file alone
            raw_line, truncated = item
            line = decode_fm_line(raw_line, truncated)
            if line is None:
                print(f"  WARNING: skipping file that is not valid utf-8 "
                      f"(left untouched): {md}", file=sys.stderr)
                return None
            stripped = line.strip()
            # Keep parity with the canonical TS/Python frontmatter parsers:
            # YAML block continuations may use a single leading space.
            indented = line.startswith((' ', '\t'))

            if in_desc and (indented or truncated):
                if truncated or len(line) > BLOCK_SMALL:
                    if desc_sample is None:
                        desc_sample = stripped
                elif desc_sample is None:
                    desc_lines.append(stripped)
                continue
            if in_desc:
                flush_desc()
                in_desc = False
                desc_lines, desc_sample = [], None

            if stripped == '---':
                closed = True
                break
            if truncated:
                # A giant line outside a description block is not ours to judge.
                return None
            if stripped.startswith('description:'):
                val = stripped.partition(':')[2].strip()
                if val in ('>-', '>', '|-', '|', ''):
                    in_desc = True
                    continue
                bare = val.strip('\'"')
                collapsed = cap_description(collapse_repeated_description(bare))
                if collapsed != bare:
                    out.append(format_field('description', collapsed))
                    changed = True
                    continue
            out.append(line)

        if in_desc:
            flush_desc()
        if not closed or not changed:
            return None

        fm_bytes = sum(len(l.encode('utf-8')) + 1 for l in out) + 8
        if not apply:
            body_left = len(ls.buf) + max(0, old_size - f.tell())
            return (old_size, fm_bytes + body_left)

        fd, tmp = tempfile.mkstemp(dir=str(md.parent), suffix='.tmp')
        try:
            with os.fdopen(fd, 'wb') as w:
                w.write(b'---\n')
                for l in out:
                    w.write(l.encode('utf-8') + b'\n')
                w.write(b'---\n')
                w.write(ls.buf)  # body bytes already read past the frontmatter
                while True:
                    data = f.read(CHUNK)
                    if not data:
                        break
                    w.write(data)
            os.replace(tmp, md)
        except BaseException:
            os.unlink(tmp)
            raise
    return (old_size, md.stat().st_size)


def main():
    args = sys.argv[1:]
    apply = '--apply' in args
    verbose = '--verbose' in args
    pos = [a for a in args if not a.startswith('--')]
    if not pos:
        print(__doc__)
        sys.exit(1)
    vault_dir = Path(pos[0]).resolve()

    cleaned, saved = 0, 0
    for md in walk_vault(vault_dir):
        try:
            result = clean_file(md, apply)
        except Exception as e:
            print(f"  ! {rel_path(md, vault_dir)}: {e}")
            continue
        if result is None:
            continue
        old, new = result
        cleaned += 1
        saved += old - new
        if verbose or old > 1_000_000:
            print(f"  {'cleaned' if apply else 'would clean'} {rel_path(md, vault_dir)}: "
                  f"{old:,} → {new:,} bytes")
    mode = 'applied' if apply else 'dry-run'
    print(f"cleanup ({mode}): {cleaned} file(s), {saved:,} bytes of bug garbage"
          + ('' if apply else ' — run with --apply to fix'))


if __name__ == '__main__':
    main()
