"""Run: python -m unittest discover -s resources/skills/figure-style -v.

Requires NumPy and Matplotlib; no GUI backend or scVI installation is needed.
"""
import unittest

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from kernel import bar_with_points, strip_with_median


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

    def test_strip_rejects_short_long_and_empty_colors_before_drawing(self):
        self.ticks = self.ax.get_xticks().copy()
        for colors in (["blue"], [], ["blue", "red", "green"]):
            with self.subTest(colors=colors):
                with self.assertRaisesRegex(ValueError, "one color per group"):
                    strip_with_median(self.ax, ["A", "B"], [[1, 3], [4, 8]], colors)
                self.assert_unmodified()

    def test_strip_rejects_both_directions_of_group_mismatch(self):
        self.ticks = self.ax.get_xticks().copy()
        for groups, values in ((["A"], [[1], [2]]), (["A", "B"], [[1]])):
            with self.subTest(groups=groups):
                with self.assertRaisesRegex(ValueError, "groups and values"):
                    strip_with_median(self.ax, groups, values)
                self.assert_unmodified()

    def test_strip_preserves_points_medians_and_labels_with_default_colors(self):
        result = strip_with_median(self.ax, iter(["A", "B"]), iter([[1, 3], [4, 8]]), jitter=0)
        self.assertIs(result, self.ax)
        self.assertEqual([t.get_text() for t in self.ax.get_xticklabels()], ["A", "B"])
        self.assertEqual(len(self.ax.collections), 2)
        np.testing.assert_array_equal(self.ax.collections[0].get_offsets(), [[0, 1], [0, 3]])
        np.testing.assert_array_equal(self.ax.collections[1].get_offsets(), [[1, 4], [1, 8]])
        np.testing.assert_array_equal(self.ax.lines[0].get_ydata(), [2, 2])
        np.testing.assert_array_equal(self.ax.lines[1].get_ydata(), [6, 6])

    def test_strip_preserves_explicit_colors(self):
        strip_with_median(self.ax, ["A", "B"], [[1], [2]], iter(["blue", "red"]), jitter=0)
        np.testing.assert_array_equal(self.ax.collections[0].get_facecolors(), [[0, 0, 1, 0.6]])
        np.testing.assert_array_equal(self.ax.collections[1].get_facecolors(), [[1, 0, 0, 0.6]])

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


if __name__ == "__main__":
    unittest.main()
