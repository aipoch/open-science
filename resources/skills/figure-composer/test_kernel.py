import builtins
import importlib.util
import inspect
import json
import os
from pathlib import Path
import tempfile
import unittest

os.environ.setdefault("MPLBACKEND", "Agg")

KERNEL_PATH = Path(__file__).with_name("kernel.py")
DESCRIPTOR_PATH = Path(__file__).with_name("open-science.json")
EXPORTS = tuple(json.loads(DESCRIPTOR_PATH.read_text(encoding="utf-8"))["helpers"][0]["exports"])
SIGNATURES = {
    "figure_outline_schema": "()",
    "validate_figure_outline": "(outline)",
    "grid_geom": "(outline, dpi=300, gutter_mm=4)",
    "panel_px": "(outline, letter, dpi=300, gutter_mm=4)",
    "panel_xy": "(outline, letter, dpi=300, gutter_mm=4)",
    "panel_task": "(outline, letter, fig_label='Figure', rules_ref='(load `figure-style`)')",
    "compose_crops": "(outline, dpi=300, gutter_mm=4, pad_px=4)",
    "compose_figure": "(outline, panel_paths, out_path, dpi=300, gutter_mm=4, letter_font='DejaVuSans-Bold.ttf', letter_pt=9, letter_case='lower')",
    "group_fixes_by_panel": "(review)",
    "review_schema": "(per_panel=True)",
    "composite_review_task": "(composite_vid, outline, rules_vid, prev_vid=None, round_no=1, min_floor=None)",
    "apply_outline_revisions": "(outline, revisions)",
}


def load_kernel():
    spec = importlib.util.spec_from_file_location("figure_composer_kernel", KERNEL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load figure-composer kernel")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def outline():
    return {
        "claim": "The treatment changes all three readouts.",
        "width_mm": 50.8,
        "ncol": 2,
        "row_heights_mm": [25.4, 25.4],
        "panels": [
            {"letter": "A", "role": "schematic", "message": "Design", "chart_family": "diagram", "data_vid": None, "row": 0, "col": 0, "colspan": 2, "ask": "Show the study design."},
            {"letter": "B", "role": "primary", "message": "Primary effect", "chart_family": "bars", "data_vid": "data-version-b", "data_desc": "primary.csv", "row": 1, "col": 0, "colspan": 1, "label_budget": 3, "ask": "Plot the primary response."},
            {"letter": "C", "role": "supporting", "message": "Replication", "chart_family": "points", "data_vid": "data-version-c", "row": 1, "col": 1, "colspan": 1, "ask": "Plot the replication."},
        ],
    }


class FigureComposerKernelContractTests(unittest.TestCase):
    def test_exports_are_deterministic_and_keep_published_signatures(self):
        kernel = load_kernel()
        self.assertEqual(set(SIGNATURES), set(EXPORTS))
        self.assertEqual(
            tuple(name for name in EXPORTS if callable(getattr(kernel, name, None))), EXPORTS
        )
        self.assertEqual(
            {name: str(inspect.signature(getattr(kernel, name))) for name in EXPORTS},
            SIGNATURES,
        )
        self.assertFalse(hasattr(kernel, "fc_sdk"))
        self.assertFalse(hasattr(kernel, "derive_outline"))

        source = KERNEL_PATH.read_text(encoding="utf-8")
        real_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.split(".", 1)[0] in {"host", "PIL"}:
                raise AssertionError(f"control-plane/optional import during initialization: {name}")
            return real_import(name, *args, **kwargs)

        namespace = {"__builtins__": dict(vars(builtins), __import__=guarded_import)}
        exec(compile(source, "<figure-composer-contract>", "exec"), namespace, namespace)

    def test_geometry_tasks_and_review_scope_preserve_the_worked_contract(self):
        kernel = load_kernel()
        plan = outline()
        self.assertIs(kernel.validate_figure_outline(plan), plan)
        self.assertEqual(kernel.grid_geom(plan, dpi=100, gutter_mm=2.54), (200, 2, 95, [100, 100], [0, 110], 10))
        self.assertEqual(kernel.panel_px(plan, "A", dpi=100, gutter_mm=2.54), (200, 100))
        self.assertEqual(kernel.panel_px(plan, "B", dpi=100, gutter_mm=2.54), (95, 100))
        self.assertEqual(kernel.panel_xy(plan, "C", dpi=100, gutter_mm=2.54), (105, 110))
        self.assertEqual(kernel.compose_crops(plan, dpi=100, gutter_mm=2.54, pad_px=4), {
            "A": (0, 0, 200, 104), "B": (0, 106, 99, 210), "C": (101, 106, 200, 210)
        })

        task = kernel.panel_task(plan, "B")
        self.assertIn("{{artifact:data-version-b}}", task)
        self.assertIn("276×300 px", task)
        self.assertIn("≤3", task)
        self.assertIn("load `figure-style`", task)
        self.assertNotIn("host.", task)

        review = {
            "violations": [
                {"severity": "MAJOR", "panel_letter": "B", "rule_ref": "§2", "location": "B title", "finding": "Cryptic", "fix": "Use a claim"},
                {"severity": "MINOR", "panel_letter": "C", "finding": "Tiny", "fix": "Nudge"},
            ]
        }
        self.assertEqual(set(kernel.group_fixes_by_panel(review)), {"B"})
        self.assertEqual(kernel.apply_outline_revisions(plan, [{"affected_panels": ["A", "C"]}]), {"A", "C"})
        self.assertEqual(kernel.review_schema()["properties"]["violations"]["items"]["properties"]["severity"]["enum"], ["BLOCKER", "MAJOR", "MINOR"])
        review_task = kernel.composite_review_task("composite-v2", plan, "rules-v1", "composite-v1", round_no=2, min_floor=4)
        self.assertIn("{{artifact:composite-v2}}", review_task)
        self.assertIn("{{artifact:composite-v1}}", review_task)
        self.assertIn("at least 4 independent rule areas", review_task)
        self.assertIn("{{artifact:data-version-b}}", review_task)
        self.assertIn("zero violations is valid", review_task)

        invalid = outline()
        invalid["panels"][1]["col"] = 1
        invalid["panels"][1]["colspan"] = 2
        with self.assertRaisesRegex(ValueError, "outside the declared grid"):
            kernel.validate_figure_outline(invalid)

        missing_data = outline()
        missing_data["panels"][1].pop("data_vid")
        with self.assertRaisesRegex(ValueError, "requires data_vid"):
            kernel.validate_figure_outline(missing_data)

        empty = outline()
        empty["panels"] = []
        with self.assertRaisesRegex(ValueError, "at least one panel"):
            kernel.validate_figure_outline(empty)

        duplicate = outline()
        duplicate["panels"][2]["letter"] = "b"
        with self.assertRaisesRegex(ValueError, "duplicate panel letter"):
            kernel.validate_figure_outline(duplicate)

    def test_compose_preserves_panel_order_dimensions_pixels_and_crop_geometry(self):
        from PIL import Image

        kernel = load_kernel()
        plan = outline()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sizes = {letter: kernel.panel_px(plan, letter, dpi=100, gutter_mm=2.54) for letter in ("A", "B", "C")}
            colors = {"A": (255, 0, 0, 255), "B": (0, 255, 0, 255), "C": (0, 0, 255, 255)}
            paths = {}
            for letter in ("A", "B", "C"):
                path = root / f"panel-{letter}.png"
                Image.new("RGBA", sizes[letter], colors[letter]).save(path)
                paths[letter] = path
            out = root / "composite.png"
            returned, size = kernel.compose_figure(plan, paths, out, dpi=100, gutter_mm=2.54)
            self.assertEqual(Path(returned), out)
            self.assertEqual(size, (200, 210))
            with Image.open(out) as image:
                self.assertEqual(image.size, (200, 210))
                self.assertEqual(image.getpixel((150, 50)), (255, 0, 0))
                self.assertEqual(image.getpixel((50, 160)), (0, 255, 0))
                self.assertEqual(image.getpixel((150, 160)), (0, 0, 255))
                self.assertAlmostEqual(image.info["dpi"][0], 100, places=1)

            wrong = root / "wrong.png"
            Image.new("RGBA", (1, 1), (255, 0, 0, 255)).save(wrong)
            bad_paths = dict(paths)
            bad_paths["A"] = wrong
            with self.assertRaisesRegex(ValueError, "panel A has size"):
                kernel.compose_figure(plan, bad_paths, root / "bad.png", dpi=100, gutter_mm=2.54)


if __name__ == "__main__":
    unittest.main()
