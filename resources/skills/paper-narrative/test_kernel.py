"""Public contract tests for the deterministic paper-narrative helper."""

import inspect
import json
from pathlib import Path

from kernel import narrative_review_schema, narrative_review_task, paper_brief_schema


DESCRIPTOR_PATH = Path(__file__).with_name("open-science.json")
EXPORTS = tuple(json.loads(DESCRIPTOR_PATH.read_text(encoding="utf-8"))["helpers"][0]["exports"])


def assert_required_fields(schema, value):
    missing = [name for name in schema.get("required", []) if name not in value]
    if missing:
        raise ValueError("missing required fields: " + ", ".join(missing))


def test_public_signatures():
    assert EXPORTS == (
        "paper_brief_schema",
        "narrative_review_schema",
        "narrative_review_task",
    )
    assert str(inspect.signature(paper_brief_schema)) == "()"
    assert str(inspect.signature(narrative_review_schema)) == "()"
    assert str(inspect.signature(narrative_review_task)) == "(brief, deck_vid, rules_vid)"


def test_paper_brief_schema_preserves_editorial_fields():
    schema = paper_brief_schema()
    assert schema["type"] == "object"
    assert schema["required"] == ["pitch", "vision", "figures"]
    assert set(schema["properties"]) == {
        "pitch",
        "vision",
        "audience",
        "most_arresting_asset",
        "figures",
    }
    figure = schema["properties"]["figures"]["items"]
    assert figure["required"] == ["key", "claim"]
    assert set(figure["properties"]) == {"key", "claim", "composite_vid"}
    json.dumps(schema)


def test_review_schema_preserves_story_decisions_and_convergence_fields():
    schema = narrative_review_schema()
    assert schema["required"] == [
        "hook_verdict",
        "figure_moves",
        "missing_panels",
        "kill_list",
        "arc",
        "boldest_defensible_fig1",
    ]
    props = schema["properties"]
    assert props["hook_verdict"]["properties"]["would_send_for_review"]["enum"] == [
        "yes",
        "weak",
        "no",
    ]
    assert props["hook_verdict"]["required"] == [
        "would_send_for_review",
        "why",
        "fig1_is",
        "fig1_should_be",
    ]
    assert props["missing_panels"]["items"]["required"] == [
        "target_fig",
        "what_to_show",
        "analysis_needed",
        "data_hint",
    ]
    assert props["arc"]["items"]["properties"]["role"]["enum"] == [
        "hook",
        "mechanism",
        "evidence",
        "application",
        "supplement",
    ]
    assert props["kill_list"]["items"]["properties"]["demote_to"]["enum"] == [
        "supplement",
        "caption",
        "delete",
    ]
    json.dumps(schema)

    try:
        assert_required_fields(
            props["hook_verdict"],
            {"would_send_for_review": "yes", "why": "clear", "fig1_should_be": "the hook"},
        )
    except ValueError as error:
        assert "fig1_is" in str(error)
    else:
        raise AssertionError("hook verdict without fig1_is must be rejected")

    try:
        assert_required_fields(
            props["missing_panels"]["items"],
            {
                "target_fig": "Fig2",
                "what_to_show": "dose response",
                "analysis_needed": "fit EC50",
            },
        )
    except ValueError as error:
        assert "data_hint" in str(error)
    else:
        raise AssertionError("missing panel without data_hint must be rejected")


def test_review_task_names_artifacts_claims_and_every_editorial_move():
    task = narrative_review_task(
        {
            "pitch": "Treatment restores function.",
            "vision": "Readers can select responders.",
            "audience": "translational scientists",
            "most_arresting_asset": "Figure 1B",
            "figures": [
                {"key": "Fig1", "claim": "Treatment restores function"},
                {"key": "Fig2", "caption": "Mechanism is receptor dependent"},
            ],
        },
        "deck-v7",
        "rules-v2",
    )
    for expected in [
        "Treatment restores function.",
        "Readers can select responders.",
        "translational scientists",
        "Figure 1B",
        "{{artifact:deck-v7}}",
        "{{artifact:rules-v2}}",
        "Fig1: Treatment restores function",
        "Fig2: Mechanism is receptor dependent",
        "Hook test",
        "arc",
        "move content between figures",
        "missing panels",
        "kill list",
        "boldest defensible Fig 1",
        "Return ONLY structured output",
    ]:
        assert expected in task


if __name__ == "__main__":
    test_public_signatures()
    test_paper_brief_schema_preserves_editorial_fields()
    test_review_schema_preserves_story_decisions_and_convergence_fields()
    test_review_task_names_artifacts_claims_and_every_editorial_move()
