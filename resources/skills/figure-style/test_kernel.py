"""Run: python -m unittest discover -s resources/skills/figure-style -v.

Requires NumPy, SciPy and Matplotlib; no GUI backend or scVI installation is needed.
"""
import unittest

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from kernel import bar_with_points, end_of_line_labels, focal_palette, panel_crops, panel_letter, strip_with_median


class GroupPlotTests(unittest.TestCase):
    def setUp(self):
        self.fig, self.ax = plt.subplots()

    def tearDown(self):
        plt.close(self.fig)

    def assert_unmodified(self):
        self.assertEqual(len(self.ax.patches), 0)
        self.assertEqual(len(self.ax.collections), 0)
        self.assertEqual(len(self.ax.lines), 0)
        np.testing.assert_array_equal(self.ax.get_xticks(), self.ticks)

    def test_strip_empty_colors_use_default_gray_without_losing_groups(self):
        for colors in (None, [], iter([]), np.array([])):
            with self.subTest(colors=type(colors).__name__):
                self.ax.clear()
                result = strip_with_median(self.ax, iter(["A", "B"]), iter([[1, 3], [4, 8]]), colors, jitter=0)
                self.assertIs(result, self.ax)
                self.assertEqual(len(self.ax.collections), 2)
                self.assertEqual(len(self.ax.lines), 2)
                self.assertEqual([t.get_text() for t in self.ax.get_xticklabels()], ["A", "B"])
                for collection in self.ax.collections:
                    np.testing.assert_allclose(collection.get_facecolors(),
                                               [matplotlib.colors.to_rgba("#444444", alpha=0.6)])
                np.testing.assert_array_equal(self.ax.collections[1].get_offsets(), [[1, 4], [1, 8]])
                np.testing.assert_array_equal(self.ax.lines[1].get_ydata(), [6, 6])

    def test_strip_cycles_colors_without_losing_groups(self):
        for colors, expected in ((["blue"], ["blue"] * 3),
                                 (["blue", "red"], ["blue", "red", "blue"]),
                                 (["purple", "orange", "green"], ["purple", "orange", "green"]),
                                 (["blue", "red", "green", "orange"], ["blue", "red", "green"])):
            with self.subTest(colors=colors):
                self.ax.clear()
                strip_with_median(self.ax, ["A", "B", "C"], [[1, 3], [4, 8], [2, 4]],
                                  iter(colors), jitter=0)
                self.assertEqual(len(self.ax.collections), 3)
                self.assertEqual(len(self.ax.lines), 3)
                self.assertEqual([t.get_text() for t in self.ax.get_xticklabels()], ["A", "B", "C"])
                for i, color in enumerate(expected):
                    np.testing.assert_allclose(self.ax.collections[i].get_facecolors(),
                                               [matplotlib.colors.to_rgba(color, alpha=0.6)])
                np.testing.assert_array_equal(self.ax.collections[2].get_offsets(), [[2, 2], [2, 4]])
                np.testing.assert_array_equal(self.ax.lines[2].get_ydata(), [3, 3])

    def test_strip_allows_no_groups_with_empty_colors(self):
        strip_with_median(self.ax, [], [], [], jitter=0)
        self.assertEqual(len(self.ax.collections), 0)
        self.assertEqual(len(self.ax.lines), 0)

    def test_strip_rejects_both_directions_of_group_mismatch(self):
        self.ticks = self.ax.get_xticks().copy()
        for groups, values in ((["A"], [[1], [2]]), (["A", "B"], [[1]])):
            with self.subTest(groups=groups):
                with self.assertRaisesRegex(ValueError, "groups and values"):
                    strip_with_median(self.ax, groups, values)
                self.assert_unmodified()

    def test_bar_rejects_broadcast_and_other_group_mismatches_before_drawing(self):
        self.ticks = self.ax.get_xticks().copy()
        cases = (([0, 1], [[1, 3]], ["A", "B"]),
                 ([0], [[1, 3], [4, 8]], ["A"]),
                 ([0, 1], [[1, 3], [4, 8]], ["A"]),
                 ([0], [[1, 3]], ["A", "B"]))
        for x, values, labels in cases:
            for show_points in (True, False):
                with self.subTest(x=x, labels=labels, show_points=show_points):
                    with self.assertRaisesRegex(ValueError, "equal lengths"):
                        bar_with_points(self.ax, x, values, labels, ["blue"], show_points=show_points)
                    self.assert_unmodified()

    def test_bar_preserves_means_points_and_color_cycling(self):
        result = bar_with_points(self.ax, [0, 1, 2], iter([[1, 3], [4, 8], [2, 4]]),
                                 iter(["A", "B", "C"]), ["blue", "red"], jitter=0)
        self.assertIs(result, self.ax)
        self.assertEqual([p.get_height() for p in self.ax.patches], [2, 6, 3])
        self.assertEqual(len(self.ax.collections), 3)
        np.testing.assert_array_equal(self.ax.collections[1].get_offsets(), [[1, 4], [1, 8]])
        self.assertEqual(self.ax.patches[0].get_facecolor(), self.ax.patches[2].get_facecolor())
        self.assertEqual([t.get_text() for t in self.ax.get_xticklabels()], ["A", "B", "C"])

    def test_bar_preserves_sd_interval(self):
        bar_with_points(self.ax, [0], [[1, 3]], ["A"], None, show_points=False, errorbar="sd")
        bars = next(c for c in self.ax.containers if hasattr(c, "patches"))
        segment = bars.errorbar.lines[2][0].get_segments()[0]
        np.testing.assert_allclose(segment[:, 1], [2 - np.sqrt(2), 2 + np.sqrt(2)])

    def test_invalid_groups_are_rejected_before_any_marks(self):
        self.ticks = self.ax.get_xticks().copy()
        for invalid in ([], [1, np.nan], [1, np.inf], [1, -np.inf], [[1, 2]], [1+2j], ["1"]):
            for kind in ("bar", "strip"):
                with self.subTest(invalid=invalid, kind=kind):
                    with self.assertRaisesRegex(ValueError, "group 1"):
                        if kind == "bar":
                            bar_with_points(self.ax, [0, 1], [[1, 3], invalid], ["A", "B"], None)
                        else:
                            strip_with_median(self.ax, ["A", "B"], [[1, 3], invalid])
                    self.assert_unmodified()

    def test_single_observation_cannot_create_an_interval(self):
        self.ticks = self.ax.get_xticks().copy()
        for interval in ("sd", "ci95"):
            with self.subTest(interval=interval):
                with self.assertRaisesRegex(ValueError, "cannot be estimated"):
                    bar_with_points(self.ax, [0, 1], [[1, 3], [5]], ["A", "B"], None,
                                    show_points=False, errorbar=interval)
                self.assert_unmodified()
        bar_with_points(self.ax, [0], [[5]], ["A"], None)
        self.assertEqual(self.ax.patches[0].get_height(), 5)
        np.testing.assert_array_equal(self.ax.collections[0].get_offsets()[:, 1], [5])

    def test_valid_ci_matches_known_t_interval(self):
        bar_with_points(self.ax, [0], [[1, 2, 3]], ["A"], None, show_points=False, errorbar="ci95")
        bars = next(c for c in self.ax.containers if hasattr(c, "patches"))
        np.testing.assert_allclose(bars.errorbar.lines[2][0].get_segments()[0][:, 1],
                                   [-0.48413771, 4.48413771], atol=1e-7)

    def test_empty_bar_colors_remain_visible_using_default_color(self):
        expected = None
        for colors in (None, [], iter([]), np.array([])):
            with self.subTest(colors=type(colors).__name__):
                self.ax.clear()
                bar_with_points(self.ax, [0, 1], [[1, 3], [4, 6]], ["A", "B"], colors,
                                show_points=False)
                actual = [p.get_facecolor() for p in self.ax.patches]
                if expected is None:
                    expected = actual
                self.assertEqual(actual, expected)
                self.assertTrue(all(c[3] == 1 for c in actual))

    def test_empty_base_palette_uses_default_cycle(self):
        expected = focal_palette(["A", "B", "C"], "A", "purple")
        for colors in ([], iter([]), np.array([])):
            with self.subTest(colors=type(colors).__name__):
                self.assertEqual(focal_palette(["A", "B", "C"], "A", "purple", base_colors=colors), expected)


class LineLabelTests(unittest.TestCase):
    def setUp(self):
        self.fig, self.ax = plt.subplots()
        self.xs = [[0, 1], [0, 2], [0, 3]]
        self.ys = [[1, 2], [3, 4], [5, 6]]
        for x, y in zip(self.xs, self.ys):
            self.ax.plot(x, y)
        self.ax.set_xlim(0, 10)

    def tearDown(self):
        plt.close(self.fig)

    def test_cycles_arbitrary_colors_and_preserves_every_label_and_line(self):
        end_of_line_labels(self.ax, iter(self.xs), iter(self.ys), iter(["A", "B", "C"]),
                           iter(["purple", "orange"]), dx=0.02, fontsize=9)
        self.assertEqual([t.get_text() for t in self.ax.texts], ["A", "B", "C"])
        self.assertEqual([t.get_color() for t in self.ax.texts], ["purple", "orange", "purple"])
        self.assertEqual([t.get_fontsize() for t in self.ax.texts], [9, 9, 9])
        np.testing.assert_allclose([t.get_position() for t in self.ax.texts],
                                   [[1.2, 2], [2.2, 4], [3.2, 6]])
        self.assertEqual(len(self.ax.lines), 3)
        for line, y in zip(self.ax.lines, self.ys):
            np.testing.assert_array_equal(line.get_ydata(), y)

    def test_missing_and_empty_colors_use_current_default_text_color(self):
        with matplotlib.rc_context({"text.color": "green"}):
            for colors in (None, [], iter([]), np.array([])):
                with self.subTest(colors=type(colors).__name__):
                    start = len(self.ax.texts)
                    end_of_line_labels(self.ax, self.xs, self.ys, ["A", "B", "C"], colors)
                    texts = list(self.ax.texts)[start:]
                    self.assertEqual([t.get_text() for t in texts], ["A", "B", "C"])
                    self.assertEqual([t.get_color() for t in texts], ["green"] * 3)

    def test_single_and_extra_colors_do_not_change_label_count(self):
        for colors, expected in ((["gray"], ["gray"] * 3),
                                 (["purple", "orange", "green", "black"], ["purple", "orange", "green"])):
            with self.subTest(colors=colors):
                start = len(self.ax.texts)
                end_of_line_labels(self.ax, self.xs, self.ys, ["A", "B", "C"], colors)
                texts = list(self.ax.texts)[start:]
                self.assertEqual([t.get_color() for t in texts], expected)

    def test_mismatched_inputs_fail_before_any_label_is_added(self):
        for xs, ys, labels in ((self.xs[:2], self.ys, ["A", "B", "C"]),
                               (self.xs, self.ys[:2], ["A", "B", "C"]),
                               (self.xs, self.ys, ["A", "B"]),
                               (self.xs, self.ys, ["A", "B", "C", "D"]),
                               ([[0, 1], []], [[1, 2], []], ["A", "B"]),
                               ([[0, 1], [0, 1]], [[1, 2], [3]], ["A", "B"])):
            with self.subTest(xs=xs, ys=ys, labels=labels):
                with self.assertRaises(ValueError):
                    end_of_line_labels(self.ax, xs, ys, labels)
                self.assertEqual(len(self.ax.texts), 0)
                self.assertEqual(len(self.ax.lines), 3)

    def test_no_series_is_a_noop(self):
        end_of_line_labels(self.ax, [], [], [], [])
        self.assertEqual(len(self.ax.texts), 0)
        self.assertEqual(len(self.ax.lines), 3)

    def test_nonfinite_endpoints_fail_before_any_label(self):
        for value in (np.nan, np.inf, -np.inf):
            for xs, ys in (([[0, 1], [0, value]], [[1, 2], [3, 4]]),
                           ([[0, 1], [0, 1]], [[1, 2], [3, value]])):
                with self.subTest(value=value, xs=xs):
                    with self.assertRaisesRegex(ValueError, "endpoints must be finite"):
                        end_of_line_labels(self.ax, xs, ys, ["A", "B"])
                    self.assertEqual(len(self.ax.texts), 0)

    def test_endpoint_lookup_does_not_iterate_or_copy_long_series(self):
        class EndpointOnly:
            def __len__(self):
                return 10_000_000

            def __getitem__(self, index):
                if index != -1:
                    raise AssertionError("Only the endpoint should be read")
                return 7

            def __iter__(self):
                raise AssertionError("Do not copy the whole sequence")

        end_of_line_labels(self.ax, [EndpointOnly()], [EndpointOnly()], ["A"])
        np.testing.assert_allclose(self.ax.texts[0].get_position(), [7.1, 7])


class PanelCropTests(unittest.TestCase):
    def tearDown(self):
        plt.close("all")

    def test_duplicate_letters_are_rejected(self):
        fig, axes = plt.subplots(1, 2)
        for ax in axes:
            ax.plot([0, 1], [0, 1])
            panel_letter(ax, "a")
        with self.assertRaisesRegex(ValueError, "Duplicate panel letter"):
            panel_crops(fig)

    def test_distinct_letters_preserve_all_crops(self):
        fig, axes = plt.subplots(1, 2)
        for ax, letter in zip(axes, ["a", "b"]):
            ax.plot([0, 1], [0, 1])
            panel_letter(ax, letter)
        crops = panel_crops(fig)
        self.assertEqual(set(crops), {"a", "b"})
        for left, top, right, bottom in crops.values():
            self.assertLess(left, right)
            self.assertLess(top, bottom)


if __name__ == "__main__":
    unittest.main()
