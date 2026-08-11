#!/usr/bin/env python3
"""
autograph enforce — validate and fix vault cards against schema.

Usage:
  python3 enforce.py <vault-dir> <schema.json>              # dry run
  python3 enforce.py <vault-dir> <schema.json> --apply       # apply fixes
  python3 enforce.py <vault-dir> <schema.json> --verbose
"""

import json
import re
import sys
from pathlib import Path
from datetime import date
from collections import defaultdict

from common import (
    load_schema, parse_frontmatter, write_frontmatter, format_field,
    walk_vault, rel_path, infer_domain, infer_type, IGNORE_DIRS,
    get_type_aliases, get_field_fixes, get_node_types, get_status_defaults,
    collect_duplicate_groups, collapse_repeated_description, cap_description, DESC_CAP
)

ENFORCE_MAX_FILE_BYTES = 10 * 1024 * 1024
# cleanup.py owns bounded-memory repair; enforce only handles ordinary-sized cards.

RELATED_HEADING_RE = re.compile(r'^##\s+Related\s*$', re.IGNORECASE)
UPDATE_HEADING_RE = re.compile(
    r'^##\s+(?:Обновление|Update)\s+(\d{4}-\d{2}-\d{2})\s*$', re.IGNORECASE)
LOG_HEADING_RE = re.compile(r'^##\s+Log\s*$', re.IGNORECASE)
H1_H2_RE = re.compile(r'^#{1,2}\s+')
WIKILINK_RE = re.compile(r'\[\[([^\]]+)\]\]')


def _outside_fences(lines: list[str]) -> list[bool]:
    outside = [True] * len(lines)
    fence_char = None
    fence_len = 0
    for index, line in enumerate(lines):
        if fence_char:
            outside[index] = False
            close = re.match(r'^ {0,3}(`{3,}|~{3,})\s*$', line)
            if close and close.group(1)[0] == fence_char and len(close.group(1)) >= fence_len:
                fence_char = None
                fence_len = 0
            continue
        opened = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if not opened or (opened.group(1)[0] == '`' and '`' in opened.group(2)):
            continue
        outside[index] = False
        fence_char = opened.group(1)[0]
        fence_len = len(opened.group(1))
    return outside


def _sections(lines: list[str], matcher: re.Pattern) -> list[tuple[int, int, re.Match]]:
    outside = _outside_fences(lines)
    starts = [
        (i, matcher.match(line.strip()))
        for i, line in enumerate(lines)
        if outside[i] and len(line) - len(line.lstrip(' ')) <= 3
    ]
    starts = [(i, match) for i, match in starts if match]
    result = []
    for start, match in starts:
        end = len(lines)
        for index in range(start + 1, len(lines)):
            if (outside[index]
                    and len(lines[index]) - len(lines[index].lstrip(' ')) <= 3
                    and H1_H2_RE.match(lines[index].lstrip(' '))):
                end = index
                break
        result.append((start, end, match))
    return result


def _replace_ranges(lines: list[str], ranges: list[tuple[int, int]],
                    replacement: list[str], insert_at: int) -> list[str]:
    by_start = {start: end for start, end in ranges}
    output = []
    index = 0
    while index < len(lines):
        end = by_start.get(index)
        if end is not None:
            if index == insert_at:
                output.extend(replacement)
            index = end
            continue
        output.append(lines[index])
        index += 1
    return output


def _related_target(raw: str) -> str:
    return raw.split('|', 1)[0].split('#', 1)[0].strip().lower()


def _simple_log_update_sections(
        lines: list[str], sections: list[tuple[int, int, str, re.Match]]) -> bool:
    """True only when Log/Update sections can be flattened without losing layout."""
    outside = _outside_fences(lines)
    markdown_block = re.compile(r'^(?:[-*+] |\d+[.)] |>|#{1,6}\s|\||`{3,}|~{3,})')
    for start, end, kind, _ in sections:
        indexes = list(range(start + 1, end))
        while indexes and not lines[indexes[0]].strip():
            indexes.pop(0)
        while indexes and not lines[indexes[-1]].strip():
            indexes.pop()
        if any(not outside[index] for index in indexes):
            return False
        content = [lines[index] for index in indexes]
        if any(not line.strip() for line in content):
            return False
        if kind == 'log':
            if any(not re.match(r'^-\s+\S', line) for line in content):
                return False
        elif any(line != line.strip() or markdown_block.match(line) for line in content):
            return False
    return True


def cleanup_card_body(body: str) -> tuple[str, dict, bool]:
    """Repair only unambiguous structural drift in a cards/** body."""
    fixes = defaultdict(int)
    compile_candidate = False
    lines = body.split('\n')

    # Legacy dated H2 updates become entries under one Log section. Empty update
    # headings disappear. Existing Log content is preserved in source order.
    updates = _sections(lines, UPDATE_HEADING_RE)
    logs = _sections(lines, LOG_HEADING_RE)
    if updates or len(logs) > 1:
        combined = sorted(
            [(start, end, 'update', match) for start, end, match in updates]
            + [(start, end, 'log', match) for start, end, match in logs],
            key=lambda item: item[0],
        )
        nonempty_update = any(
            any(line.strip() for line in lines[start + 1:end])
            for start, end, kind, _ in combined if kind == 'update'
        )
        if nonempty_update:
            # Moving chronology into Log cannot repair stale Compiled Truth. Queue
            # the card for a semantic rollup pass even when migration is safe.
            compile_candidate = True

        if not _simple_log_update_sections(lines, combined):
            # Fences, nested blocks, indentation and paragraph breaks carry layout
            # semantics. Leave the whole Log/Update cluster byte-identical.
            compile_candidate = True
        else:
            content = []
            for start, end, kind, match in combined:
                section_lines = [line for line in lines[start + 1:end] if line.strip()]
                if kind == 'log':
                    content.extend(section_lines)
                    continue
                if not section_lines:
                    fixes['empty_updates_removed'] += 1
                    continue
                day = match.group(1)
                if len(section_lines) == 1:
                    content.append(f'- {day}: {section_lines[0].strip()}')
                else:
                    content.append(f'- {day}:')
                    content.extend(f'  {line}' for line in section_lines)
                fixes['updates_migrated_to_log'] += 1

            ranges = [(start, end) for start, end, _, _ in combined]
            insert_at = combined[0][0]
            keep_log = bool(content) or bool(logs)
            replacement = ['## Log', *content] if keep_log else []
            if len(logs) > 1:
                fixes['log_sections_merged'] += len(logs) - 1
            lines = _replace_ranges(lines, ranges, replacement, insert_at)

    # Duplicate Related blocks are merged only when every non-empty line is a
    # link-only list item. Prose-bearing duplicates stay byte-identical and are
    # queued for the next semantic rollup pass.
    related = _sections(lines, RELATED_HEADING_RE)
    if len(related) > 1:
        safe = True
        targets = []
        seen = set()
        duplicate_links = 0
        for start, end, _ in related:
            for line in lines[start + 1:end]:
                if not line.strip():
                    continue
                matches = WIKILINK_RE.findall(line)
                remainder = WIKILINK_RE.sub('', line)
                remainder = re.sub(r'[-*·,;:\s]', '', remainder)
                if not matches or remainder:
                    safe = False
                    break
                for raw in matches:
                    target = _related_target(raw)
                    if not target or target in seen:
                        duplicate_links += 1
                        continue
                    seen.add(target)
                    targets.append(raw.strip())
            if not safe:
                break

        if safe:
            ranges = [(start, end) for start, end, _ in related]
            replacement = ['## Related', *(f'- [[{target}]]' for target in targets)]
            lines = _replace_ranges(lines, ranges, replacement, related[0][0])
            fixes['related_sections_merged'] += len(related) - 1
            fixes['related_links_deduped'] += duplicate_links
        else:
            compile_candidate = True

    cleaned = '\n'.join(lines)
    return cleaned, dict(fixes), compile_candidate


def enforce(vault_dir: Path, schema: dict, apply=False, verbose=False):
    node_types = schema['node_types']
    type_aliases = get_type_aliases(schema)
    field_fixes = get_field_fixes(schema)
    region_fixes = schema.get('region_fixes', {})

    stats = {
        'total': 0, 'valid': 0, 'fixed': 0, 'needs_review': 0,
        'no_fm': 0, 'skipped_oversize': 0,
        'fixes': defaultdict(int), 'review_items': [], 'compile_candidates': []
    }
    eligible_files = []
    for md in walk_vault(vault_dir):
        rp = rel_path(md, vault_dir)
        stats['total'] += 1

        try:
            if md.stat().st_size > ENFORCE_MAX_FILE_BYTES:
                stats['skipped_oversize'] += 1
                print(f"  WARNING: skipping oversized file: {rp}")
                continue
            content = md.read_text(errors='replace')
        except Exception:
            continue
        eligible_files.append(md)

        fields, body, orig_lines = parse_frontmatter(content)
        if fields is None:
            stats['no_fm'] += 1
            continue

        changed = False
        issues = []

        if rp.startswith('cards/'):
            cleaned_body, body_fixes, compile_candidate = cleanup_card_body(body)
            if cleaned_body != body:
                body = cleaned_body
                changed = True
            for name, count in body_fixes.items():
                stats['fixes'][name] += count
            if compile_candidate:
                stats['compile_candidates'].append(rp)
                issues.append('semantic card compile required')

        # --- TYPE ---
        t = fields.get('type', '')
        if t in type_aliases:
            fields['type'] = type_aliases[t]
            changed = True
            stats['fixes']['type_alias'] += 1
        t = fields.get('type', '')
        if not t or t not in node_types:
            fields['type'] = infer_type(rp, schema)
            changed = True
            stats['fixes']['type_inferred'] += 1
        t = fields['type']
        tdef = node_types.get(t, {})

        # --- STATUS ---
        valid_s = tdef.get('status', [])
        cur_s = fields.get('status', '')
        # Apply field_fixes for status
        status_fixes = field_fixes.get('status', {})
        if cur_s and cur_s.lower() in status_fixes:
            fields['status'] = status_fixes[cur_s.lower()]
            changed = True
            stats['fixes']['status_fix'] += 1
            cur_s = fields['status']
        # Validate
        if valid_s and cur_s and cur_s not in valid_s:
            # Fall back to first valid status for this type
            fields['status'] = valid_s[0]
            changed = True
            stats['fixes']['status_remap'] += 1
        if not cur_s and valid_s:
            # Use status_defaults from schema, or first valid status
            defaults = get_status_defaults(schema)
            fields['status'] = defaults.get(t, defaults.get('default', valid_s[0]))
            changed = True
            stats['fixes']['status_default'] += 1

        # --- PRIORITY ---
        pri = fields.get('priority', '')
        priority_fixes = field_fixes.get('priority', {})
        if pri and pri.lower() in priority_fixes:
            fields['priority'] = priority_fixes[pri.lower()]
            changed = True
            stats['fixes']['priority_fix'] += 1

        # --- POTENTIAL ---
        pot = fields.get('potential', '')
        potential_fixes = field_fixes.get('potential', {})
        if pot and pot.lower() in potential_fixes:
            fields['potential'] = potential_fixes[pot.lower()]
            changed = True
            stats['fixes']['potential_fix'] += 1

        # --- REGION ---
        reg = fields.get('region', '')
        if isinstance(reg, str) and reg in region_fixes:
            fields['region'] = region_fixes[reg]
            changed = True
            stats['fixes']['region_fix'] += 1

        # --- DOMAIN ---
        if 'domain' not in fields or not fields['domain']:
            fields['domain'] = infer_domain(rp, schema)
            changed = True
            stats['fixes']['domain_add'] += 1

        # --- DESCRIPTION ---
        desc = fields.get('description', '')
        if not desc:
            first = body.strip().split('\n')[0].strip().lstrip('#').strip() if body.strip() else ''
            if first and 10 < len(first) < 200:
                fields['description'] = first
                changed = True
                stats['fixes']['desc_inferred'] += 1
            else:
                issues.append('missing description')
        elif isinstance(desc, str) and len(desc) > 20:
            collapsed = collapse_repeated_description(desc)
            if len(collapsed) < len(desc.strip()):
                fields['description'] = collapsed
                changed = True
                stats['fixes']['desc_dedup'] += 1
            # Hard cap — even a non-periodic bloated description must not survive.
            if len(fields['description']) > DESC_CAP:
                fields['description'] = cap_description(fields['description'])
                changed = True
                stats['fixes']['desc_truncated'] += 1

        # --- TAGS ---
        tags = fields.get('tags', '')
        if not tags or (isinstance(tags, list) and len(tags) == 0):
            issues.append('missing tags')

        # --- SYSTEM FIELDS ---
        today_str = date.today().isoformat()
        for sf, default in [('last_accessed', today_str), ('tier', 'warm'), ('relevance', 0.5)]:
            if sf not in fields or not fields[sf]:
                fields[sf] = default
                changed = True
                stats['fixes'][f'{sf}_add'] += 1

        # --- WRITE ---
        if changed and apply:
            new_fm = write_frontmatter(fields, orig_lines)
            md.write_text(f"---\n{new_fm}\n---\n{body}")

        if changed:
            stats['fixed'] += 1
        if issues:
            stats['needs_review'] += 1
            if verbose:
                for i in issues:
                    stats['review_items'].append(f"{rp}: {i}")
        if not changed and not issues:
            stats['valid'] += 1

    dupes = (collect_duplicate_groups(vault_dir, schema, files=eligible_files)
             if eligible_files else {})
    return stats, dupes


def health_score(stats, dupes):
    total = max(stats['total'], 1)
    fm_ok = 1 - stats['no_fm'] / total
    valid_rate = (stats['valid'] + stats['fixed']) / total
    desc_miss = stats['fixes'].get('desc_inferred', 0) + len([r for r in stats.get('review_items', []) if 'description' in r])
    tags_miss = len([r for r in stats.get('review_items', []) if 'tags' in r])
    dup_count = sum(len(p) - 1 for p in dupes.values())

    score = 100.0
    score -= (1 - fm_ok) * 10
    score -= (1 - valid_rate) * 25
    score -= (desc_miss / total) * 20
    score -= (tags_miss / total) * 15
    score -= min(dup_count, 50) * 0.3
    score -= stats['needs_review'] / total * 10
    return max(0, round(score, 1))


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage: enforce.py <vault-dir> <schema.json> [--apply] [--verbose]", file=sys.stderr)
        sys.exit(1)

    vault_dir = Path(args[0])
    schema_path = Path(args[1])
    apply = '--apply' in args
    verbose = '--verbose' in args

    schema = load_schema(schema_path)
    stats, dupes = enforce(vault_dir, schema, apply=apply, verbose=verbose)
    score = health_score(stats, dupes)

    mode = "APPLIED" if apply else "DRY RUN"
    print(f"\n{'='*55}")
    print(f"  AUTOGRAPH ENFORCE — {mode}")
    print(f"{'='*55}")
    print(f"  Total:          {stats['total']}")
    print(f"  Valid:           {stats['valid']}")
    print(f"  Auto-fixed:      {stats['fixed']}")
    print(f"  Needs review:    {stats['needs_review']}")
    print(f"  No frontmatter:  {stats['no_fm']}")
    print(f"  Oversize skipped:{stats['skipped_oversize']:>4}")
    print(f"\n  Fixes:")
    for k, v in sorted(stats['fixes'].items(), key=lambda x: -x[1]):
        print(f"    {k}: {v}")
    if dupes:
        dup_total = sum(len(p) - 1 for p in dupes.values())
        print(f"\n  Duplicates: {len(dupes)} slugs ({dup_total} extra files)")
        for (slug, domain, card_type), paths in sorted(dupes.items(), key=lambda x: -len(x[1]))[:15]:
            print(f"    {slug} [{domain}/{card_type}] ({len(paths)}x)")
    if verbose and stats.get('review_items'):
        print(f"\n  Review ({len(stats['review_items'])}):")
        for r in stats['review_items'][:20]:
            print(f"    {r}")

    print(f"\n  {'='*40}")
    print(f"  SCHEMA COMPLIANCE: {score}/100")
    print(f"  {'='*40}")

    out = vault_dir / '.graph' / 'enforce-report.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({
        'score': score, 'total': stats['total'], 'valid': stats['valid'],
        'fixed': stats['fixed'], 'review': stats['needs_review'],
        'skipped_oversize': stats['skipped_oversize'],
        'duplicates': len(dupes), 'mode': mode,
        'fixes': dict(stats['fixes']),
        'compile_candidates': sorted(stats['compile_candidates']),
    }, indent=2))
    print(f"  Report: {out}")


if __name__ == '__main__':
    main()
