"""Regression tests for figure composition tasks and review instructions."""

import copy
from pathlib import Path
import tempfile
import unittest

try:
    from PIL import Image
except ImportError:
    Image = None

from kernel import (
    apply_outline_revisions,
    compose_figure,
    composite_review_task,
    composition_task,
    panel_px,
    panel_task,
)


OUTLINE = {
    "claim": "Treatment improves survival",
    "width_mm": 180,
    "ncol": 12,
    "row_heights_mm": [40],
    "panels": [
        {"letter": "a", "role": "schematic", "row": 0, "col": 0, "colspan": 6,
         "chart_family": "diagram", "message": "design", "ask": "show groups"},
        {"letter": "b", "role": "primary", "row": 0, "col": 6, "colspan": 6,
         "chart_family": "survival curve", "message": "effect", "ask": "plot outcome",
         "data_vid": "data-version"},
    ],
}


class FigureComposerTasksTest(unittest.TestCase):
    def test_composition_orders_versions_and_preserves_provenance_contract(self):
        task = composition_task(OUTLINE, [
            {"letter": "b", "versionId": "panel-b-version"},
            {"letter": "a", "versionId": "panel-a-version"},
        ])
        versions_section = task.split("Ordered panel Versions:", 1)[1]
        self.assertLess(versions_section.index("panel-a-version"),
                        versions_section.index("panel-b-version"))
        self.assertIn('host.artifactPath(versionId)', task)
        self.assertIn('artifactVersionInputs', task)
        self.assertIn('producerRunId', task)
        self.assertIn('host.submitOutput({compositeVersionId: version_id})', task)

    def test_composition_rejects_missing_duplicate_or_unknown_panel_versions(self):
        valid = [{"letter": "a", "versionId": "one"},
                 {"letter": "b", "versionId": "two"}]
        for bad in (valid[:1], valid + [valid[0]],
                    valid[:1] + [{"letter": "c", "versionId": "two"}],
                    valid[:1] + [{"letter": "b", "versionId": ""}]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                composition_task(OUTLINE, bad)

    def test_panel_requires_structured_submission(self):
        task = panel_task(OUTLINE, "b")
        self.assertIn("panel_b.png", task)
        self.assertIn('host.submitOutput({panelVersionId: version_id, labelsUsed})', task)
        self.assertIn("accepted: true", task)

    def test_review_has_no_finding_quota_and_optional_rules(self):
        task = composite_review_task("composite-version", OUTLINE)
        self.assertNotIn("artifact:None", task)
        self.assertIn("zero findings is valid", task)
        self.assertIn("host.submitOutput(review)", task)
        fixed = copy.deepcopy(OUTLINE)
        fixed["fixed_panel_set"] = True
        fixed_task = composite_review_task("composite-version", fixed, "rules-version")
        self.assertIn("user requires exactly these panels", fixed_task)
        self.assertIn("artifact:rules-version", fixed_task)

    def test_shared_row_resize_regenerates_every_changed_panel(self):
        revised = copy.deepcopy(OUTLINE)
        revised["row_heights_mm"] = [45]
        affected = apply_outline_revisions(
            revised, [{"affected_panels": ["a"]}], previous_outline=OUTLINE
        )
        self.assertEqual(affected, {"a", "b"})

    @unittest.skipIf(Image is None, "Pillow is unavailable to the test runner")
    def test_composition_preserves_pixels_and_rejects_size_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {}
            for letter, color in (("a", "red"), ("b", "blue")):
                path = root / f"{letter}.png"
                Image.new("RGB", panel_px(OUTLINE, letter, dpi=100), color).save(path)
                paths[letter] = path
            output = root / "figure.png"
            compose_figure(OUTLINE, paths, output, dpi=100)
            with Image.open(output) as image:
                self.assertEqual(image.getpixel((100, 75)), (255, 0, 0))
                self.assertEqual(image.getpixel((600, 75)), (0, 0, 255))
            original = output.read_bytes()
            Image.new("RGB", (1, 1), "blue").save(paths["b"])
            with self.assertRaisesRegex(ValueError, "expected"):
                compose_figure(OUTLINE, paths, output, dpi=100)
            self.assertEqual(output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
