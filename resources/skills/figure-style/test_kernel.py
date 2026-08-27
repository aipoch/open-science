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
DESCRIPTOR = json.loads(DESCRIPTOR_PATH.read_text(encoding="utf-8"))["helpers"][0]
EXPORTS = tuple(DESCRIPTOR["exports"])
SIGNATURES = {
    "apply_figure_style": "(*, frame='open', font=None, sizes=(8, 7, 6), grid=False)",
    "set_frame": "(ax, style='open')",
    "panel_letter": "(ax, letter, dx=-0.18, dy=1.02, case='lower', fontsize=None)",
    "focal_palette": "(labels, focal, focal_color, other='muted', base_colors=None)",
    "bar_with_points": "(ax, x, ymat, labels, colors, jitter=0.08, show_points=True, errorbar=None, point_alpha=0.5, point_size=8)",
    "strip_with_median": "(ax, groups, values, colors=None, jitter=0.12)",
    "goodness_arrow": "(ax, text='higher = better', loc='upper left', axis='y', fontsize=None)",
    "two_tier_label": "(name, meta)",
    "end_of_line_labels": "(ax, xs, ys, labels, colors=None, dx=0.01, fontsize=None)",
    "panel_crops": "(fig, dpi=None, pad_px=6, bbox_inches=None, pad_inches=None)",
}


def load_kernel():
    spec = importlib.util.spec_from_file_location("figure_style_kernel", KERNEL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load figure-style kernel")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FigureStyleKernelContractTests(unittest.TestCase):
    def test_exports_keep_the_published_signatures(self) -> None:
        kernel = load_kernel()

        self.assertEqual(set(SIGNATURES), set(EXPORTS))
        self.assertEqual(tuple(name for name in EXPORTS if callable(getattr(kernel, name, None))), EXPORTS)
        self.assertEqual(
            {name: str(inspect.signature(getattr(kernel, name))) for name in EXPORTS},
            SIGNATURES,
        )

    def test_module_initialization_does_not_import_optional_plotting_packages(self) -> None:
        source = KERNEL_PATH.read_text(encoding="utf-8")
        real_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.split(".", 1)[0] in {"matplotlib", "numpy", "PIL", "scipy"}:
                raise AssertionError(f"optional plotting import during initialization: {name}")
            return real_import(name, *args, **kwargs)

        namespace = {"__builtins__": dict(vars(builtins), __import__=guarded_import)}
        exec(compile(source, "<figure-style-contract>", "exec"), namespace, namespace)

        self.assertEqual(namespace["two_tier_label"]("Accuracy", "n=6"), "Accuracy\nn=6")

    def test_plotting_helpers_preserve_returns_errors_and_artist_semantics(self) -> None:
        import matplotlib as mpl
        import matplotlib.pyplot as plt
        import numpy as np

        kernel = load_kernel()
        self.assertIsNone(kernel.apply_figure_style(frame="open", sizes=(9, 8, 7), grid=True))
        self.assertEqual(mpl.rcParams["font.size"], 9)
        self.assertEqual(mpl.rcParams["legend.fontsize"], 8)
        self.assertEqual(mpl.rcParams["xtick.labelsize"], 7)
        self.assertEqual(mpl.rcParams["savefig.dpi"], 300)
        with self.assertRaisesRegex(ValueError, "frame must be"):
            kernel.apply_figure_style(frame="broken")

        labels = ["Baseline", "Focal", "Comparator"]
        colors = kernel.focal_palette(
            labels,
            "Focal",
            "#0066CC",
            other="grey",
            base_colors=["#111111"],
        )
        self.assertEqual(colors, ["#BCBCBC", "#0066CC", "#BCBCBC"])
        with self.assertRaisesRegex(ValueError, "not found in labels"):
            kernel.focal_palette(labels, "Missing", "#0066CC")
        with self.assertRaisesRegex(ValueError, "other must be"):
            kernel.focal_palette(labels, "Focal", "#0066CC", other="typo")

        np.random.seed(7)
        fig, (bar_ax, strip_ax) = plt.subplots(1, 2, figsize=(6, 3))
        self.assertIs(
            kernel.bar_with_points(
                bar_ax,
                [0, 1, 2],
                [[1, 2, 3], [3, 4, 5], [2, 3, 4]],
                labels,
                colors,
            ),
            bar_ax,
        )
        self.assertEqual(len(bar_ax.patches), 3)
        self.assertEqual(sum(len(collection.get_offsets()) for collection in bar_ax.collections), 9)
        single_fig, single_ax = plt.subplots()
        kernel.bar_with_points(single_ax, [0], [[4.2]], ["Only"], ["#0066CC"])
        self.assertEqual(sum(len(collection.get_offsets()) for collection in single_ax.collections), 1)
        with self.assertRaisesRegex(TypeError, "numeric positions"):
            kernel.bar_with_points(single_ax, ["Only"], [[4.2]], ["Only"], ["#0066CC"])
        plt.close(single_fig)
        self.assertIs(
            kernel.strip_with_median(
                strip_ax,
                ["A", "B"],
                [[1, 2, 3], [4, 5, 6]],
                ["#444444", "#0066CC"],
            ),
            strip_ax,
        )
        self.assertEqual(len(strip_ax.lines), 2)

        self.assertIsNone(kernel.set_frame(bar_ax, "boxed"))
        self.assertTrue(all(spine.get_visible() for spine in bar_ax.spines.values()))
        with self.assertRaises(KeyError):
            kernel.set_frame(bar_ax, "broken")
        self.assertIsNone(kernel.panel_letter(bar_ax, "a", case="upper"))
        self.assertEqual(bar_ax.texts[-1].get_text(), "A")
        self.assertIsNone(kernel.goodness_arrow(bar_ax, axis="x"))
        self.assertEqual(bar_ax.texts[-1].get_text(), "→ higher = better")
        self.assertEqual(kernel.two_tier_label("Accuracy", "n=6"), "Accuracy\nn=6")
        self.assertIsNone(
            kernel.end_of_line_labels(
                bar_ax,
                [[0, 1], [0, 1]],
                [[1, 2], [2, 3]],
                ["Control", "Treatment"],
                colors=["#888888", "#0066CC"],
            )
        )
        self.assertEqual([text.get_text() for text in bar_ax.texts[-2:]], ["Control", "Treatment"])

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp, "contract.png")
            fig.savefig(output)
            crops = kernel.panel_crops(fig)
            from PIL import Image

            with Image.open(output) as image:
                width, height = image.size
            self.assertEqual(set(crops), {"A"})
            x0, y0, x1, y1 = crops["A"]
            self.assertTrue(0 <= x0 < x1 <= width)
            self.assertTrue(0 <= y0 < y1 <= height)
        plt.close(fig)

        plain_fig, plain_ax = plt.subplots()
        plain_ax.text(0.5, 0.5, "x", fontweight="bold")
        self.assertEqual(set(kernel.panel_crops(plain_fig)), {"0"})
        with self.assertRaisesRegex(TypeError, "bbox_inches"):
            kernel.panel_crops(plain_fig, bbox_inches="invalid")
        with self.assertRaisesRegex(TypeError, "pad_px"):
            kernel.panel_crops(plain_fig, pad_px=0.5)
        plt.close(plain_fig)

    def test_parallel_sequences_preserve_source_zip_truncation(self) -> None:
        import matplotlib.pyplot as plt

        kernel = load_kernel()
        fig, (bar_ax, strip_ax, line_ax) = plt.subplots(1, 3)

        kernel.bar_with_points(
            bar_ax,
            [0, 1],
            [[1, 2], [3, 4]],
            ["A", "B"],
            ["#111111", "#222222", "#333333"],
        )
        kernel.strip_with_median(
            strip_ax,
            ["A", "B"],
            [[1, 2], [3, 4]],
            ["#111111"],
        )
        kernel.end_of_line_labels(
            line_ax,
            [[0, 1], [0, 1]],
            [[1, 2], [2, 3]],
            ["only-first"],
            ["#111111", "#222222"],
        )

        self.assertEqual(len(bar_ax.patches), 2)
        self.assertEqual(len(strip_ax.collections), 1)
        self.assertEqual(len(strip_ax.lines), 1)
        self.assertEqual([text.get_text() for text in line_ax.texts], ["only-first"])
        plt.close(fig)


if __name__ == "__main__":
    unittest.main()
