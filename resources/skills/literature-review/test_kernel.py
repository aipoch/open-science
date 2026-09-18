import time
import unittest
from unittest.mock import patch

from kernel import extract_dois, verify_dois


class VerifyDoisRetractionTests(unittest.TestCase):
    def test_retraction_markers_and_non_retraction_updates(self) -> None:
        cases = [
            ({"updated-by": [{"type": "expression_of_concern"},
                             {"type": "retraction", "DOI": "10.1126/science.1124926"}]}, True),
            ({"updated-by": [{"type": "retraction", "source": "publisher"},
                             {"type": "retraction", "source": "retraction-watch"}]}, True),
            ({"updated-by": [{"type": "Retraction"}]}, True),
            ({"updated-by": [{"type": "correction"}]}, False),
            ({"updated-by": [{"type": "expression_of_concern"}]}, False),
            ({"updated-by": [{}]}, False),
            ({"updated-by": None, "update-to": None}, False),
            ({}, False),
            ({"update-to": [{"type": "retraction"}]}, True),
            ({"subtype": "retraction"}, True),
            ({"title": ["RETRACTED ARTICLE: Example"]}, True),
        ]
        doi = "10.1126/science.1112286"
        for fields, expected in cases:
            with self.subTest(fields=fields), \
                 patch("kernel.litrev_get", return_value={"message": {
                     "title": ["Example"], **fields
                 }}) as fetch, \
                 patch("kernel.litrev_head") as head, \
                 patch("kernel.time.sleep"):
                result = verify_dois([doi])[doi]
                self.assertIs(result["retracted"], expected)
                self.assertIs(result["ok"], True)
                self.assertEqual(result["registry"], "crossref")
                fetch.assert_called_once()
                head.assert_not_called()

    def test_resolver_fallback_keeps_unknown_retraction_status(self) -> None:
        for status, ok in [(302, True), (None, None)]:
            with self.subTest(status=status), \
                 patch("kernel.litrev_get", return_value=None), \
                 patch("kernel.litrev_head", return_value=status), \
                 patch("kernel.time.sleep"):
                result = verify_dois(["10.1234/example"])["10.1234/example"]
                self.assertIs(result["ok"], ok)
                self.assertIsNone(result["retracted"])


class ExtractDoisTests(unittest.TestCase):
    def test_strips_trailing_markdown_emphasis(self) -> None:
        self.assertEqual(extract_dois("**10.1234/foo**"), ["10.1234/foo"])

    def test_rejecting_a_long_markdown_like_suffix_stays_fast(self) -> None:
        candidate = "10.1234/" + "*" * 8_000 + "A"

        started = time.monotonic()
        result = extract_dois(candidate)
        elapsed = time.monotonic() - started

        self.assertEqual(result, [candidate])
        self.assertLess(elapsed, 0.25)


if __name__ == "__main__":
    unittest.main()
