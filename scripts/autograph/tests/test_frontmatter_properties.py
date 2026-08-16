# /// script
# requires-python = ">=3.11"
# dependencies = ["hypothesis>=6,<7"]
# ///

"""Property tests for the shared Python/TypeScript frontmatter contract."""

import json
import sys
import unittest
from pathlib import Path

from hypothesis import given, seed, settings, strategies as st

AUTOGRAPH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTOGRAPH_DIR))

from common import (  # noqa: E402
    FrontmatterParseError,
    format_field,
    parse_frontmatter,
)

CORPUS_PATH = Path(__file__).parent / "golden/frontmatter/scalar-corpus.cases.json"
CORPUS = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))


def parse_value(encoded: str):
    fields, _, _ = parse_frontmatter(f"---\nvalue: {encoded}\n---\n")
    return fields["value"]


def json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class FrontmatterCorpusTests(unittest.TestCase):
    def test_shared_corpus(self):
        for value in CORPUS["scalars"]:
            with self.subTest(value=value):
                self.assertEqual(format_field("value", value), f"value: {json_string(value)}")
                self.assertEqual(parse_value(json_string(value)), value)
                values = [value, "sentinel, [x]", "O'Brien"]
                encoded = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
                self.assertEqual(format_field("items", values), f"items: {encoded}")
                self.assertEqual(parse_value(encoded), values)

        for case in CORPUS["legacy_single_quoted"]:
            self.assertEqual(parse_value(case["encoded"]), case["decoded"])
            self.assertEqual(parse_value(f'[{case["encoded"]}]'), [case["decoded"]])

        for garbage in CORPUS["garbage"]:
            try:
                parse_value(garbage)
            except FrontmatterParseError:
                pass
            except Exception as error:
                self.fail(f"raw parser crash: {type(error).__name__}: {error}")

        for garbage in CORPUS["controlled_errors"]:
            with self.assertRaises(FrontmatterParseError):
                parse_value(garbage)

    @seed(18706)
    @settings(max_examples=300, deadline=None)
    @given(st.lists(st.text(), max_size=30))
    def test_list_round_trip(self, values):
        encoded = format_field("value", values)
        fields, _, _ = parse_frontmatter(f"---\n{encoded}\n---\n")
        self.assertEqual(fields["value"], values)

    @seed(18713)
    @settings(max_examples=300, deadline=None)
    @given(st.text())
    def test_scalar_round_trip(self, value):
        encoded = format_field("value", value)
        self.assertEqual(encoded, f"value: {json_string(value)}")
        fields, _, _ = parse_frontmatter(f"---\n{encoded}\n---\n")
        self.assertEqual(fields["value"], value)

    @seed(18714)
    @settings(max_examples=300, deadline=None)
    @given(st.text(alphabet=st.characters(exclude_characters="\r\n")))
    def test_legacy_apostrophe_round_trip(self, value):
        legacy = "'" + value.replace("'", "''") + "'"
        self.assertEqual(parse_value(legacy), value)
        self.assertEqual(parse_value(f"[{legacy}]"), [value])

    @seed(18714)
    @settings(max_examples=300, deadline=None)
    @given(st.text())
    def test_arbitrary_input_is_value_or_controlled_error(self, garbage):
        try:
            parse_value(garbage)
        except FrontmatterParseError:
            pass
        except Exception as error:  # pragma: no cover - assertion reports raw crash
            self.fail(f"raw parser crash: {type(error).__name__}: {error}")


if __name__ == "__main__":
    unittest.main()
