import time
import unittest

from kernel import extract_dois


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
