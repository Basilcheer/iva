# /// script
# requires-python = ">=3.11"
# dependencies = ["hypothesis>=6,<7"]
# ///

"""Recovery and fault-injection tests for destructive CRM thinning."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from hypothesis import given, seed, settings, strategies as st

AUTOGRAPH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTOGRAPH_DIR))

from common import write_card  # noqa: E402
from dedup import RecoveryError, apply_manifest, thin_crm_overlay  # noqa: E402


SAFE_TEXT = st.text(
    alphabet=st.characters(blacklist_categories=("Cs",)),
    min_size=1,
    max_size=200,
)


def card(unique: str) -> str:
    return (
        "---\n"
        "type: contact\n"
        "status: active\n"
        "tags: [crm]\n"
        "---\n"
        "# Alice\n\n"
        f"Unique CRM evidence: {unique}\n"
    )


def recovery_files(trash_dir: Path) -> list[Path]:
    return sorted(path for path in trash_dir.rglob("*") if path.is_file())


class DedupRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="iva-dedup-recovery-")
        self.vault = Path(self.tmp.name)
        self.relative = "cards/crm/alice.md"
        self.source = self.vault / self.relative
        self.source.parent.mkdir(parents=True)
        self.trash = self.vault / ".trash/dedup-test"

    def tearDown(self):
        self.tmp.cleanup()

    def write_source(self, unique: str) -> bytes:
        original = card(unique).encode("utf-8")
        self.source.write_bytes(original)
        return original

    def assert_recoverable(self, original: bytes):
        candidates = [self.source, *recovery_files(self.trash)]
        self.assertTrue(
            any(path.read_bytes() == original for path in candidates if path.exists()),
            "the only exact source copy was lost",
        )

    def reset_recovery(self):
        if self.trash.exists():
            shutil.rmtree(self.trash)

    def test_backup_precedes_replace_and_repeat_noop_creates_nothing(self):
        original = self.write_source("contract-anchor")
        changed = thin_crm_overlay(
            self.vault,
            self.relative,
            "contacts/alice.md",
            trash_dir=self.trash,
        )
        self.assertTrue(changed)
        backups = recovery_files(self.trash)
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original)
        self.assertNotEqual(self.source.read_bytes(), original)

        self.assertFalse(
            thin_crm_overlay(
                self.vault,
                self.relative,
                "contacts/alice.md",
                trash_dir=self.trash,
            )
        )
        self.assertEqual(recovery_files(self.trash), backups)

    def test_every_recovery_parent_is_fsynced_before_write(self):
        self.write_source("parent-chain")
        synced = set()
        fsync_count_at_write = None

        def recording_fsync(fd):
            stats = os.fstat(fd)
            synced.add((stats.st_dev, stats.st_ino))
            os.fsync(fd)

        def recording_write(path, text):
            nonlocal fsync_count_at_write
            fsync_count_at_write = len(synced)
            write_card(path, text)

        thin_crm_overlay(
            self.vault,
            self.relative,
            "contacts/alice.md",
            trash_dir=self.trash,
            fsync_impl=recording_fsync,
            write_impl=recording_write,
        )
        expected_directories = [
            self.vault,
            self.vault / ".trash",
            self.trash,
            self.trash / "cards",
            self.trash / "cards/crm",
        ]
        expected = {
            (path.stat().st_dev, path.stat().st_ino) for path in expected_directories
        }
        self.assertTrue(expected.issubset(synced))
        self.assertIsNotNone(fsync_count_at_write)

    def test_changed_source_gets_new_backup_without_overwriting_first(self):
        first = self.write_source("first-version")
        self.assertTrue(
            thin_crm_overlay(
                self.vault,
                self.relative,
                "contacts/alice.md",
                trash_dir=self.trash,
            )
        )
        first_backup = recovery_files(self.trash)[0]
        self.assertEqual(first_backup.read_bytes(), first)

        second = self.write_source("second-version")
        self.assertTrue(
            thin_crm_overlay(
                self.vault,
                self.relative,
                "contacts/alice.md",
                trash_dir=self.trash,
            )
        )
        backups = recovery_files(self.trash)
        self.assertEqual(len(backups), 2)
        self.assertEqual(first_backup.read_bytes(), first)
        self.assertIn(second, [path.read_bytes() for path in backups])

    def test_symlink_to_live_source_is_never_accepted_as_recovery(self):
        original = self.write_source("symlink-is-not-recovery")
        hostile = self.trash / self.relative
        hostile.parent.mkdir(parents=True)
        hostile.symlink_to(self.source)

        self.assertTrue(
            thin_crm_overlay(
                self.vault,
                self.relative,
                "contacts/alice.md",
                trash_dir=self.trash,
            )
        )
        durable = [
            path
            for path in recovery_files(self.trash)
            if not path.is_symlink() and path.read_bytes() == original
        ]
        self.assertEqual(len(durable), 1)
        self.assertNotEqual(hostile.read_bytes(), original)

    def test_symlink_component_cannot_escape_recovery_tree(self):
        original = self.write_source("parent-symlink-escape")
        outside_tmp = tempfile.TemporaryDirectory(prefix="iva-dedup-outside-")
        self.addCleanup(outside_tmp.cleanup)
        outside = Path(outside_tmp.name)
        (self.vault / ".trash").symlink_to(outside, target_is_directory=True)

        with self.assertRaises(RecoveryError):
            thin_crm_overlay(
                self.vault,
                self.relative,
                "contacts/alice.md",
                trash_dir=self.trash,
            )
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(list(outside.rglob("*")), [])

    def test_approved_manifest_still_creates_recovery_copy(self):
        original = self.write_source("approved-is-not-recovery")
        manifest = self.vault / "approved.json"
        manifest.write_text(
            json.dumps(
                {
                    "clusters": [
                        {
                            "approved": True,
                            "action": "thin_crm_overlay",
                            "slug": "alice",
                            "canonical": "contacts/alice.md",
                            "extras": [self.relative],
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        result = apply_manifest(self.vault, manifest, schema={})
        self.assertEqual(result["thinned"], 1)
        dated_trash = self.vault / ".trash"
        backups = [path for path in dated_trash.rglob("*") if path.is_file()]
        self.assertIn(original, [path.read_bytes() for path in backups])

        second = apply_manifest(self.vault, manifest, schema={})
        self.assertEqual(second["thinned"], 0)
        self.assertEqual(
            [path.read_bytes() for path in dated_trash.rglob("*") if path.is_file()],
            [path.read_bytes() for path in backups],
        )

    @seed(18708)
    @settings(max_examples=150, deadline=None)
    @given(SAFE_TEXT)
    def test_every_arbitrary_source_remains_live_or_recoverable(self, unique):
        self.reset_recovery()
        original = self.write_source(unique)
        thin_crm_overlay(
            self.vault,
            self.relative,
            "contacts/alice.md",
            trash_dir=self.trash,
        )
        self.assert_recoverable(original)

    @seed(18708)
    @settings(max_examples=120, deadline=None)
    @given(
        SAFE_TEXT,
        st.sampled_from(
            ["link", "write_before", "write_after"]
        ),
    )
    def test_fault_at_any_transition_keeps_an_exact_copy(self, unique, phase):
        self.reset_recovery()
        original = self.write_source(unique)

        def injected_fsync(fd):
            os.fsync(fd)

        def injected_link(source, destination):
            if phase == "link":
                raise OSError("link fault")
            os.link(source, destination)

        def injected_write(path, text):
            if phase == "write_before":
                raise OSError("write-before fault")
            write_card(path, text)
            if phase == "write_after":
                raise OSError("write-after fault")

        with self.assertRaises((OSError, RecoveryError)):
            thin_crm_overlay(
                self.vault,
                self.relative,
                "contacts/alice.md",
                trash_dir=self.trash,
                link_impl=injected_link,
                fsync_impl=injected_fsync,
                write_impl=injected_write,
            )
        self.assert_recoverable(original)

    @seed(18708)
    @settings(max_examples=100, deadline=None)
    @given(SAFE_TEXT, st.integers(min_value=1, max_value=10))
    def test_fault_at_each_parent_chain_fsync_keeps_live_or_recovery(
        self, unique, fail_at
    ):
        self.reset_recovery()
        original = self.write_source(unique)
        calls = 0

        def injected_fsync(fd):
            nonlocal calls
            calls += 1
            if calls == fail_at:
                raise OSError(f"fsync fault {fail_at}")
            os.fsync(fd)

        with self.assertRaises(OSError):
            thin_crm_overlay(
                self.vault,
                self.relative,
                "contacts/alice.md",
                trash_dir=self.trash,
                fsync_impl=injected_fsync,
            )
        self.assert_recoverable(original)


if __name__ == "__main__":
    unittest.main()
