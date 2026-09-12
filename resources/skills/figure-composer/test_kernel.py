"""Run: python -m unittest discover -s resources/skills/figure-composer -v.

Requires Pillow and Matplotlib. Exercises real PNG pixels and generated code.
"""
import copy
import io
from pathlib import Path
import re
import tempfile
import unittest

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image

from kernel import compose_crops, compose_figure, grid_geom, panel_px, panel_task


class ComposerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.outline = {"claim": "test", "width_mm": 50.8, "ncol": 2,
                        "row_heights_mm": [25.4], "panels": [
                            {"letter": "a", "row": 0, "col": 0, "colspan": 1,
                             "role": "primary", "message": "test", "chart_family": "scatter", "ask": "plot"},
                            {"letter": "b", "row": 0, "col": 1, "colspan": 1,
                             "role": "primary", "message": "test", "chart_family": "scatter", "ask": "plot"}]}

    def tearDown(self):
        plt.close("all")
        self.tmp.cleanup()

    def make_panels(self):
        paths = {}
        for letter, color in (("a", "red"), ("b", "blue")):
            path = self.root / (letter + ".png")
            Image.new("RGB", panel_px(self.outline, letter, dpi=100), color).save(path)
            paths[letter] = path
        return paths

    def test_valid_layout_preserves_panel_pixels_and_crops(self):
        target = self.root / "result.png"
        compose_figure(self.outline, self.make_panels(), target, dpi=100)
        with Image.open(target) as result:
            self.assertEqual(result.size, (200, 100))
            self.assertEqual(result.getpixel((40, 50)), (255, 0, 0))
            self.assertEqual(result.getpixel((150, 50)), (0, 0, 255))
        self.assertEqual(set(compose_crops(self.outline, dpi=100)), {"a", "b"})

    def test_invalid_layouts_fail_before_output_is_overwritten(self):
        paths = self.make_panels()
        cases = ({"col": 0}, {"col": 2}, {"col": -1}, {"row": 1}, {"rowspan": 2},
                 {"colspan": 0}, {"colspan": 2}, {"row": 0.5}, {"letter": "a"}, {"letter": "A"})
        for change in cases:
            with self.subTest(change=change):
                outline = copy.deepcopy(self.outline)
                outline["panels"][1].update(change)
                target = self.root / "existing.png"
                target.write_bytes(b"preserve existing output")
                with self.assertRaises(ValueError):
                    compose_figure(outline, paths, target, dpi=100)
                self.assertEqual(target.read_bytes(), b"preserve existing output")
                with self.assertRaises(ValueError):
                    compose_crops(outline, dpi=100)

    def test_mismatched_image_is_rejected_without_resizing_or_overwriting(self):
        paths = self.make_panels()
        Image.new("RGB", (100, 100), "blue").save(paths["b"])
        target = self.root / "existing.png"
        target.write_bytes(b"preserve existing output")
        with self.assertRaisesRegex(ValueError, "expected"):
            compose_figure(self.outline, paths, target, dpi=100)
        self.assertEqual(target.read_bytes(), b"preserve existing output")
        with Image.open(paths["b"]) as source:
            self.assertEqual(source.size, (100, 100))

    def test_invalid_grid_dimensions_are_rejected(self):
        for change in ({"ncol": 0}, {"ncol": True}, {"width_mm": float("nan")},
                       {"width_mm": 1}, {"row_heights_mm": []}, {"row_heights_mm": [0.001]}):
            with self.subTest(change=change):
                outline = copy.deepcopy(self.outline)
                outline.update(change)
                with self.assertRaises(ValueError):
                    grid_geom(outline)
        for dpi, gutter in ((0, 4), (float("inf"), 4), (300, -1)):
            with self.subTest(dpi=dpi, gutter=gutter):
                with self.assertRaises(ValueError):
                    grid_geom(self.outline, dpi=dpi, gutter_mm=gutter)

    def test_nonoverlapping_spans_remain_valid(self):
        outline = copy.deepcopy(self.outline)
        outline["row_heights_mm"] = [25.4, 25.4]
        outline["panels"][0]["rowspan"] = 2
        outline["panels"][1]["row"] = 1
        crops = compose_crops(outline, dpi=100, pad_px=0)
        self.assertEqual(crops["a"], (0, 0, 92, 215))
        self.assertEqual(crops["b"], (107, 115, 199, 215))

    def test_generated_instructions_save_exact_pixel_dimensions(self):
        for width, height, columns in ((180, 40, 12), (85, 60, 1), (180, 46, 7)):
            with self.subTest(width=width, height=height, columns=columns):
                outline = copy.deepcopy(self.outline)
                outline.update(width_mm=width, ncol=columns, row_heights_mm=[height])
                outline["panels"] = [outline["panels"][0]]
                expected = panel_px(outline, "a")
                task = panel_task(outline, "a")
                code = re.search(r"`(import math; fig = plt.figure\([^`]+)`,?;", task)
                self.assertIsNotNone(code)
                with matplotlib.rc_context({"savefig.bbox": None}):
                    namespace = {"plt": plt}
                    exec(code.group(1), namespace)
                    data = io.BytesIO()
                    namespace["fig"].savefig(data, dpi=300)
                    data.seek(0)
                    with Image.open(data) as result:
                        self.assertEqual(result.size, expected)


if __name__ == "__main__":
    unittest.main()
