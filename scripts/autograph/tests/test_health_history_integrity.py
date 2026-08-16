# /// script
# requires-python = ">=3.11"
# dependencies = ["hypothesis>=6,<7"]
# ///

"""M3: corrupt health history is detected, preserved, and replaced durably."""

import json
import math
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from hypothesis import assume, given, seed, settings, strategies as st

AUTOGRAPH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTOGRAPH_DIR))

import graph  # noqa: E402


def valid_history(raw: bytes) -> bool:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(value, list):
        return False
    for entry in value:
        if not isinstance(entry, dict):
            return False
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", entry.get("date", "")) is None:
            return False
        try:
            date.fromisoformat(entry.get("date", ""))
        except (TypeError, ValueError):
            return False
        score = entry.get("health_score")
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            return False
        if not math.isfinite(score):
            return False
    return True


class HealthHistoryIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name) / "vault"
        self.graph_dir = self.vault / ".graph"
        self.graph_dir.mkdir(parents=True)
        self.history = self.graph_dir / "health-history.json"
        self.stats = {"health_score": 83}

    def assert_corrupt_unchanged(self, raw: bytes):
        self.history.write_bytes(raw)
        with self.assertRaisesRegex(RuntimeError, "health history is corrupt"):
            graph.update_history(self.vault, self.stats)
        self.assertEqual(self.history.read_bytes(), raw)

    def test_missing_history_is_created(self):
        graph.update_history(self.vault, self.stats)
        value = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual(len(value), 1)
        self.assertEqual(value[0]["health_score"], 83)
        date.fromisoformat(value[0]["date"])

    def test_valid_history_is_appended(self):
        original = [{"date": "2026-08-15", "health_score": 84}]
        self.history.write_text(json.dumps(original), encoding="utf-8")
        graph.update_history(self.vault, self.stats)
        value = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual(value[0], original[0])
        self.assertEqual(value[1]["health_score"], 83)

    def test_truncated_history_is_preserved(self):
        self.assert_corrupt_unchanged(b'[{"date":"2026-08-15"')

    def test_invalid_utf8_history_is_preserved(self):
        self.assert_corrupt_unchanged(
            b'[{"date":"2026-08-15","health_score":8\xff}]'
        )

    def test_wrong_schema_history_is_preserved(self):
        self.assert_corrupt_unchanged(b'[{"health_score":84}]')
        self.assert_corrupt_unchanged(
            b'[{"date":"20260815","health_score":84}]'
        )

    def test_graph_returns_nonzero_for_corrupt_history(self):
        raw = b'[{"date":"2026-08-15"'
        self.history.write_bytes(raw)
        result = subprocess.run(
            [
                sys.executable,
                str(AUTOGRAPH_DIR / "graph.py"),
                "health",
                str(self.vault),
                "--as-of",
                "2026-08-16",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("health history is corrupt", result.stderr)
        self.assertEqual(self.history.read_bytes(), raw)

    @seed(18803)
    @settings(max_examples=200, deadline=None)
    @given(st.binary(max_size=128))
    def test_arbitrary_corrupt_bytes_are_preserved(self, raw):
        assume(not valid_history(raw))
        self.assert_corrupt_unchanged(raw)

    def test_replace_fault_keeps_old_bytes(self):
        raw = b'[{"date":"2026-08-15","health_score":84}]'
        self.history.write_bytes(raw)
        with patch.object(graph.os, "replace", side_effect=OSError("replace fault")):
            with self.assertRaisesRegex(OSError, "replace fault"):
                graph.update_history(self.vault, self.stats)
        self.assertEqual(self.history.read_bytes(), raw)
        self.assertEqual(list(self.graph_dir.glob("*.tmp")), [])

    def test_writer_fsyncs_file_and_directory(self):
        calls = []
        real_fsync = graph.os.fsync

        def record_fsync(fd):
            calls.append(fd)
            return real_fsync(fd)

        with patch.object(graph.os, "fsync", side_effect=record_fsync):
            graph.update_history(self.vault, self.stats)
        self.assertEqual(len(calls), 2)

    def test_directory_fsync_fault_leaves_complete_json(self):
        raw = b'[{"date":"2026-08-15","health_score":84}]'
        self.history.write_bytes(raw)
        real_fsync = graph.os.fsync
        calls = 0

        def fail_directory_fsync(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("directory fsync fault")
            return real_fsync(fd)

        with patch.object(graph.os, "fsync", side_effect=fail_directory_fsync):
            with self.assertRaisesRegex(OSError, "directory fsync fault"):
                graph.update_history(self.vault, self.stats)
        self.assertTrue(valid_history(self.history.read_bytes()))
        self.assertEqual(list(self.graph_dir.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
