# /// script
# requires-python = ">=3.11"
# dependencies = ["hypothesis>=6,<7"]
# ///

"""M2: damaged Cards stay byte-identical and become structured Supersede skips."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hypothesis import given, seed, settings, strategies as st

AUTOGRAPH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTOGRAPH_DIR))

from supersede import CardRead, CardSkip, read_candidate, scan  # noqa: E402


def card(company: str, updated: str) -> bytes:
    return (
        "---\n"
        "type: note\n"
        f"company: {company}\n"
        f"updated: {updated}\n"
        "---\n"
        "# Same entity\n"
    ).encode("utf-8")


class SupersedeIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="iva-supersede-integrity-")
        self.vault = Path(self.tmp.name)
        (self.vault / "one").mkdir()
        (self.vault / "two").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_invalid_utf8_is_a_structured_skip_and_bytes_do_not_change(self):
        path = self.vault / "one/same.md"
        original = b"---\ntype: note\n---\n\xff\xfe"
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/same.md", reason="invalid_utf8"),
        )
        self.assertEqual(path.read_bytes(), original)

    def test_malformed_frontmatter_is_a_structured_skip_and_bytes_do_not_change(self):
        path = self.vault / "one/same.md"
        original = b'---\ntype: note\ntags: ["unterminated]\n---\nbody\n'
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/same.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    def test_unclosed_frontmatter_is_a_structured_skip_and_bytes_do_not_change(self):
        path = self.vault / "one/same.md"
        original = b"---\ntype: note\ncompany: Private\n# closing fence is missing\n"
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/same.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    def test_permission_error_is_a_structured_skip(self):
        path = self.vault / "one/same.md"
        path.write_bytes(card("Old", "2026-01-01"))
        original = path.read_bytes()

        with patch.object(Path, "read_text", side_effect=PermissionError("denied")):
            result = read_candidate(self.vault, path)

        self.assertEqual(result, CardSkip(path="one/same.md", reason="read_error"))
        self.assertEqual(path.read_bytes(), original)

    def test_valid_cards_keep_the_existing_candidate_result_and_bytes(self):
        old = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        old.write_bytes(card("Old", "2026-01-01"))
        current.write_bytes(card("New", "2026-02-01"))
        before = {path: path.read_bytes() for path in (old, current)}

        valid = read_candidate(self.vault, current)
        report = scan(self.vault, {})

        self.assertIsInstance(valid, CardRead)
        self.assertEqual(report.skipped, [])
        self.assertEqual(len(report.candidates), 1)
        self.assertEqual(report.candidates[0]["current"], "two/same.md")
        self.assertEqual(
            report.candidates[0]["superseded_candidates"],
            ["one/same.md"],
        )
        self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_cli_keeps_candidates_compatible_and_lists_skipped_paths(self):
        valid = self.vault / "one/valid.md"
        broken = self.vault / "two/broken.md"
        valid.write_bytes(card("Valid", "2026-01-01"))
        broken_bytes = b"---\ntype: note\nprivate: bytes\n"
        broken.write_bytes(broken_bytes)

        result = subprocess.run(
            [sys.executable, str(AUTOGRAPH_DIR / "supersede.py"), str(self.vault)],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        candidates = json.loads(
            (self.vault / ".graph/supersede-candidates.json").read_text()
        )
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertIsInstance(candidates, list)
        self.assertEqual(
            report["skipped"],
            [{"path": "two/broken.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(broken.read_bytes(), broken_bytes)

    def test_apply_never_rewrites_a_prefix_pseudo_fence(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: Old\n"
            b"updated: 2026-01-01\n"
            b"---not-a-fence\n"
            b"# Private bytes\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)
        self.assertNotIn("status: superseded", older.read_text())

    def test_apply_never_rewrites_a_bare_pseudo_fence_inside_frontmatter(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: Old\n"
            b"---not-a-fence\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"# Private bytes\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)

    def test_apply_never_rewrites_an_unexpected_indented_root_key(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: Old\n"
            b" updated: 2026-01-01\n"
            b"---\n"
            b"# Private bytes\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)

    def test_block_scalar_continuation_remains_valid(self):
        path = self.vault / "one/block.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"summary: |-\n"
            b"  ---not-a-fence\n"
            b"  example: [broken\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"body\n"
        )
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertIsInstance(result, CardRead)
        self.assertEqual(path.read_bytes(), original)

    def test_all_skipped_cards_do_not_reenter_duplicate_collection(self):
        invalid_utf8 = self.vault / "one/same.md"
        unclosed = self.vault / "two/same.md"
        unreadable_dir = self.vault / "three"
        unreadable_dir.mkdir()
        unreadable = unreadable_dir / "same.md"
        invalid_utf8.write_bytes(b"---\ntype: note\n---\n\xff")
        unclosed.write_bytes(b"---\ntype: note\nprivate: bytes\n")
        unreadable.write_bytes(card("Private", "2026-01-01"))
        originals = {path: path.read_bytes() for path in (invalid_utf8, unclosed, unreadable)}
        original_read_text = Path.read_text

        def guarded_read_text(path, *args, **kwargs):
            if path == unreadable:
                raise PermissionError("denied")
            return original_read_text(path, *args, **kwargs)

        with patch.object(Path, "read_text", guarded_read_text):
            report = scan(self.vault, {})

        self.assertEqual(report.candidates, [])
        self.assertEqual(
            report.skipped,
            [
                CardSkip(path="one/same.md", reason="invalid_utf8"),
                CardSkip(path="three/same.md", reason="read_error"),
                CardSkip(path="two/same.md", reason="malformed_frontmatter"),
            ],
        )
        self.assertEqual(
            {path: path.read_bytes() for path in originals},
            originals,
        )

    def test_malformed_quoted_scalar_is_a_structured_skip(self):
        path = self.vault / "one/same.md"
        original = b'---\ntype: note\ncompany: "unterminated\n---\nbody\n'
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/same.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    def test_apply_never_rewrites_frontmatter_with_a_raw_nul(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: Old\n"
            b"private: \x00bytes\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"body\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)

    def test_apply_never_rewrites_duplicate_root_keys(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: SecretCorp\n"
            b"company: Old\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"body\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)

    def test_apply_never_rewrites_an_unterminated_quoted_root_key(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b'"unterminated-key: secret\n'
            b"company: Old\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"body\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)

    def test_apply_never_rewrites_a_collection_indicator_root_key(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"{broken: secret\n"
            b"company: Old\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"body\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)

    def test_plain_key_dialect_accepts_unknowns_and_rejects_indicator_starts(self):
        accepted = (
            "legacy.field",
            "custom/key",
            "owner's_note",
            "owners'",
            'legacy"',
            "-legacy",
            "?legacy",
        )
        for index, key in enumerate(accepted):
            path = self.vault / "one" / f"accepted-{index}.md"
            path.write_text(f"---\n{key}: private\ntype: note\n---\nbody\n")
            self.assertIsInstance(read_candidate(self.vault, path), CardRead, key)

        rejected = tuple(f"{prefix}broken" for prefix in "[]{},&*!|>'\"%@`") + (
            "- bad",
            "? bad",
        )
        for index, key in enumerate(rejected):
            path = self.vault / "two" / f"rejected-{index}.md"
            original = f"---\n{key}: private\ntype: note\n---\nbody\n".encode()
            path.write_bytes(original)
            self.assertEqual(
                read_candidate(self.vault, path),
                CardSkip(
                    path=f"two/rejected-{index}.md",
                    reason="malformed_frontmatter",
                ),
                key,
            )
            self.assertEqual(path.read_bytes(), original)

        comment = self.vault / "one/comment.md"
        comment.write_text("---\n# comment: not a key\ntype: note\n---\nbody\n")
        self.assertIsInstance(read_candidate(self.vault, comment), CardRead)

    @seed(18828)
    @settings(max_examples=200, deadline=None)
    @given(
        st.sampled_from(tuple("[]{},&*!|>'\"%@`")),
        st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789_.-", max_size=16),
    )
    def test_forbidden_plain_key_starts_always_skip_unchanged(self, prefix, suffix):
        path = self.vault / "one/invalid-key.md"
        original = f"---\n{prefix}{suffix}: private\ntype: note\n---\nbody\n".encode()
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/invalid-key.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    def test_unknown_dotted_root_key_remains_a_valid_candidate(self):
        old = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        old_bytes = card("Old", "2026-01-01").replace(
            b"company: Old\n", b"company: Old\nlegacy.field: private\n"
        )
        current_bytes = card("New", "2026-02-01").replace(
            b"company: New\n", b"company: New\nlegacy.field: current\n"
        )
        old.write_bytes(old_bytes)
        current.write_bytes(current_bytes)

        report = scan(self.vault, {})

        self.assertEqual(report.skipped, [])
        self.assertEqual(len(report.candidates), 1)
        self.assertEqual(old.read_bytes(), old_bytes)
        self.assertEqual(current.read_bytes(), current_bytes)

    @seed(18827)
    @settings(max_examples=200, deadline=None)
    @given(
        st.text(alphabet="abcdefghijklmnopqrstuvwxyz", min_size=1, max_size=16),
        st.text(alphabet="abc XYZ0123", max_size=24),
        st.text(alphabet="abc XYZ0123", max_size=24),
    )
    def test_duplicate_normalized_root_keys_always_skip_unchanged(
        self, key, first, second
    ):
        path = self.vault / "one/duplicate.md"
        original = (
            f"---\n{key}: {first}\n{key}  : {second}\n---\nbody\n"
        ).encode()
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/duplicate.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    @seed(18826)
    @settings(max_examples=200, deadline=None)
    @given(
        st.text(alphabet="abc XYZ0123", max_size=32),
        st.sampled_from(
            tuple(chr(value) for value in (*range(9), 11, 12, *range(14, 32), 127))
        ),
        st.text(alphabet="abc XYZ0123", max_size=32),
    )
    def test_forbidden_frontmatter_controls_always_skip_unchanged(
        self, prefix, control, suffix
    ):
        path = self.vault / "one/control.md"
        original = (
            f"---\ntype: note\nprivate: {prefix}{control}{suffix}\n---\nbody\n"
        ).encode()
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/control.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    def test_apply_never_rewrites_an_unterminated_flow_list(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: Old\n"
            b"tags: [unterminated\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"# Private bytes\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)
        self.assertNotIn("status: superseded", older.read_text())

    def test_unterminated_flow_mapping_is_a_structured_skip(self):
        path = self.vault / "one/same.md"
        original = b'---\ntype: note\nmetadata: {"private": 1\n---\nbody\n'
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/same.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    def test_apply_never_rewrites_mismatched_nested_flow_delimiters(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: Old\n"
            b"tags: [one, {broken]\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"# Private bytes\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)
        self.assertNotIn("status: superseded", older.read_text())

    def test_apply_never_rewrites_flow_value_with_trailing_scalar(self):
        older = self.vault / "one/same.md"
        current = self.vault / "two/same.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"company: Old\n"
            b"tags: [one] garbage\n"
            b"updated: 2026-01-01\n"
            b"---\n"
            b"# Private bytes\n"
        )
        older.write_bytes(original)
        current.write_bytes(card("New", "2026-02-01"))

        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "supersede.py"),
                str(self.vault),
                "--apply",
            ],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(
            (self.vault / ".graph/supersede-report.json").read_text()
        )
        self.assertEqual(
            report["skipped"],
            [{"path": "one/same.md", "reason": "malformed_frontmatter"}],
        )
        self.assertEqual(older.read_bytes(), original)
        self.assertNotIn("status: superseded", older.read_text())

    def test_balanced_single_quoted_delimiters_remain_valid(self):
        path = self.vault / "one/quoted.md"
        original = (
            b"---\n"
            b"type: note\n"
            b"tags: ['[', ']', '{', '}', 'O''Brien']\n"
            b"---\n"
            b"body\n"
        )
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertIsInstance(result, CardRead)
        self.assertEqual(path.read_bytes(), original)

    @seed(18823)
    @settings(max_examples=200, deadline=None)
    @given(
        st.lists(
            st.text(alphabet='[]{}abc,"\\# ', max_size=24),
            max_size=12,
        ),
        st.sampled_from(("list", "mapping")),
        st.sampled_from(("", "   ", " # quoted tail ignores ] and {")),
    )
    def test_balanced_flow_values_preserve_quoted_delimiter_bytes(
        self, values, shape, trailing
    ):
        path = self.vault / "one/quoted.md"
        value = values if shape == "list" else {"value": values}
        encoded = json.dumps(value, ensure_ascii=False) + trailing
        original = f"---\ntype: note\nmetadata: {encoded}\n---\nbody\n".encode()
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertIsInstance(result, CardRead)
        self.assertEqual(path.read_bytes(), original)

    @seed(18825)
    @settings(max_examples=200, deadline=None)
    @given(
        st.lists(
            st.text(alphabet='[]{}abc,"\\# ', max_size=24),
            max_size=12,
        ),
        st.sampled_from((" garbage", " [two]", " }")),
    )
    def test_non_comment_bytes_after_root_flow_close_always_skip(
        self, values, trailing
    ):
        path = self.vault / "one/random.md"
        value = json.dumps(values, ensure_ascii=False) + trailing
        original = f"---\ntype: note\ntags: {value}\n---\nbody\n".encode()
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/random.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    @seed(18824)
    @settings(max_examples=200, deadline=None)
    @given(
        st.text(alphabet='[]{}abc,"\\# ', max_size=24),
        st.sampled_from((("[", "{", "]"), ("{", "[", "}"))),
    )
    def test_mismatched_nested_flow_delimiters_always_skip(
        self, quoted_value, delimiters
    ):
        path = self.vault / "one/random.md"
        outer, nested, wrong_closer = delimiters
        value = f"{outer}{json.dumps(quoted_value)}, {nested}broken{wrong_closer}"
        original = f"---\ntype: note\ntags: {value}\n---\nbody\n".encode()
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertEqual(
            result,
            CardSkip(path="one/random.md", reason="malformed_frontmatter"),
        )
        self.assertEqual(path.read_bytes(), original)

    @seed(18822)
    @settings(max_examples=300, deadline=None)
    @given(st.binary(max_size=256), st.binary(max_size=256))
    def test_arbitrary_corrupt_bytes_are_structured_and_unchanged(self, prefix, suffix):
        path = self.vault / "one/random.md"
        original = prefix + b"\xff" + suffix
        path.write_bytes(original)

        result = read_candidate(self.vault, path)

        self.assertIsInstance(result, CardSkip)
        self.assertEqual(result.reason, "invalid_utf8")
        self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
