import unittest
from copy import deepcopy

from kernel import composite_review_task, composition_task, figure_outline_schema, panel_task


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
        self.assertIn("Do not search for, load, or read any `SKILL.md`", task)
        self.assertIn('"kernelSkillIds":["figure-style"]', task)
        self.assertIn("await host.submitOutput", task)
        self.assertIn("Do not merely print the JSON", task)
        self.assertNotIn("Load `figure-style`", task)
        self.assertIn("one targeted correction and re-save once", task)
        self.assertIn("at most two `notebook_execute` calls total", task)
        self.assertIn("Do not use\n  intermediate diagnostic notebook calls", task)
        self.assertIn("Do not start an\n  open-ended visual QA loop", task)
        self.assertIn("Do not call `host.viewImage`, `view_image`", task)

    def test_outline_contract_is_explicit_and_invalid_geometry_is_actionable(self) -> None:
        schema = figure_outline_schema()
        panel_properties = schema["properties"]["panels"]["items"]["properties"]

        self.assertEqual(panel_properties["row"]["minimum"], 0)
        self.assertIn("Zero-based", panel_properties["row"]["description"])
        self.assertIn(
            "physical height",
            schema["properties"]["row_heights_mm"]["description"].lower(),
        )
        self.assertIn("exact listed panel set", schema["properties"]["fixed_panel_set"]["description"])

        one_based = deepcopy(OUTLINE)
        one_based["panels"][0]["row"] = 1
        with self.assertRaisesRegex(ValueError, "zero-based index in 0\\.\\.0"):
            panel_task(one_based, "A")

        outside_grid = deepcopy(OUTLINE)
        outside_grid["panels"][1]["col"] = 12
        with self.assertRaisesRegex(ValueError, "zero-based index in 0\\.\\.11"):
            panel_task(outside_grid, "B")

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
        self.assertIn('kernelSkillIds` to `["figure-composer"]', task)
        self.assertNotIn("load `figure-composer`", task)
        self.assertIn("do not perform panel-level style review or pixel-by-pixel QA", task)

    def test_reviewer_uses_a_self_contained_bounded_rubric(self) -> None:
        fixed_outline = {**OUTLINE, "fixed_panel_set": True}
        task = composite_review_task("composite-version", fixed_outline)

        self.assertIn("Do not search for, load, or read any `SKILL.md`", task)
        self.assertIn("fixed rubric below", task)
        self.assertNotIn("load and apply the `figure-style` Skill directly", task)
        self.assertNotIn("artifact:None", task)
        self.assertIn("two image-view calls total", task)
        self.assertIn('await host.artifactPath("composite-version")', task)
        self.assertIn("do not search the filesystem", task)
        self.assertIn("Never create or view per-panel zooms", task)
        self.assertIn("without creating\nadditional image views", task)
        self.assertIn("return an empty `violations` array when none exists", task)
        self.assertIn("There is no violation quota", task)
        self.assertNotIn("minimum 5", task)
        self.assertIn("await host.submitOutput(review)", task)
        self.assertIn("accepted: true", task)
        self.assertIn("only after the submission is accepted", task)
        self.assertIn("Do not merely print or return the JSON", task)
        self.assertIn("Do not propose adding, removing, merging, or renaming panels", task)


if __name__ == "__main__":
    unittest.main()
