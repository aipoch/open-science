import unittest

from kernel import composite_review_task, composition_task, panel_task


OUTLINE = {
    "claim": "Input becomes a result.",
    "width_mm": 180,
    "ncol": 12,
    "row_heights_mm": [42],
    "panels": [
        {
            "letter": "A",
            "role": "schematic",
            "message": "Input flows into analysis.",
            "chart_family": "schematic",
            "row": 0,
            "col": 0,
            "colspan": 6,
            "ask": "Show input and analysis.",
        },
        {
            "letter": "B",
            "role": "primary",
            "message": "Analysis flows into a result.",
            "chart_family": "schematic",
            "row": 0,
            "col": 6,
            "colspan": 6,
            "ask": "Show analysis and result.",
        },
    ],
}


class FigureComposerKernelTests(unittest.TestCase):
    def test_panel_task_uses_exact_pixel_ratio_figsize(self) -> None:
        task = panel_task(OUTLINE, "A")

        self.assertIn("figsize=(1039/300,496/300)", task)
        self.assertNotIn("figsize=(3.463,1.653)", task)
        self.assertIn("Image.open('panel_A.png').size==(1039,496)", task)

    def test_composition_task_preserves_finalized_version_contract(self) -> None:
        task = composition_task(
            OUTLINE,
            [
                {"letter": "A", "versionId": "version-a"},
                {"letter": "B", "versionId": "version-b"},
            ],
        )

        self.assertIn("do not call `host.delegate`", task)
        self.assertIn("host.artifactPath(versionId)", task)
        self.assertIn("artifactVersionInputs", task)
        self.assertIn("host.submitOutput({compositeVersionId})", task)
        self.assertIn('"versionId": "version-a"', task)
        self.assertIn('"versionId": "version-b"', task)

    def test_reviewer_can_use_figure_style_without_pending_rules_artifact(self) -> None:
        task = composite_review_task("composite-version", OUTLINE)

        self.assertIn("load and apply the `figure-style` Skill directly", task)
        self.assertNotIn("artifact:None", task)
        self.assertIn("await host.submitOutput(review)", task)
        self.assertIn("accepted: true", task)
        self.assertIn("only after the submission is accepted", task)
        self.assertIn("Do not merely print or return the JSON", task)


if __name__ == "__main__":
    unittest.main()
