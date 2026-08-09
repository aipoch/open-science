# Evaluation schemas

These versioned JSON documents are the exchange contract between Skill Creator scripts, evaluation
runs, graders, and the review UI. Producers must preserve the field names below.

## `trigger-evals.json`

Use this smaller contract only to review whether a Skill should trigger. It is not a replacement for
the output-evaluation suite below.

```json
{
  "schema_version": 1,
  "kind": "trigger",
  "cases": [
    { "id": "create-skill", "query": "Create a reusable Skill.", "should_trigger": true },
    { "id": "near-miss", "query": "Write a poem.", "should_trigger": false }
  ]
}
```

## `evals/evals.json`

```json
{
  "schema_version": 1,
  "skill_id": "personal-example-skill",
  "source_revision": "revision-or-content-digest",
  "evals": [
    {
      "id": "extract-table",
      "prompt": "Extract the table and save it as CSV.",
      "expected_output": "A CSV with the source rows and headers.",
      "files": ["evals/files/input.pdf"],
      "expectations": ["The CSV contains every source row."]
    }
  ]
}
```

## `eval_metadata.json`

```json
{
  "schema_version": 1,
  "eval_id": "extract-table",
  "eval_name": "extract-table",
  "prompt": "Extract the table and save it as CSV.",
  "expectations": ["The CSV contains every source row."]
}
```

## `timing.json`

```json
{
  "provider_model": "provider/model",
  "capability_snapshot": { "skills": ["example-skill"], "connectors": [] },
  "total_tokens": 84852,
  "duration_ms": 23332
}
```

## `grading.json`

```json
{
  "expectations": [
    {
      "text": "The CSV contains every source row.",
      "passed": true,
      "evidence": "output.csv contains 18 data rows, matching the input."
    }
  ],
  "summary": { "passed": 1, "failed": 0, "total": 1, "pass_rate": 1 },
  "execution_metrics": {
    "tool_calls": 6,
    "errors_encountered": 0,
    "output_chars": 12450
  },
  "timing": { "total_tokens": 84852, "duration_ms": 23332 },
  "claims": [],
  "eval_feedback": { "suggestions": [], "overall": "No material gaps found." }
}
```

## `benchmark.json`

```json
{
  "schema_version": 1,
  "metadata": {
    "skill_id": "personal-example-skill",
    "source_revision": "revision-or-content-digest",
    "provider_model": "provider/model",
    "evals_run": ["extract-table"],
    "runs_per_configuration": 3
  },
  "runs": [
    {
      "eval_id": "extract-table",
      "eval_name": "extract-table",
      "configuration": "with_skill",
      "run_number": 1,
      "result": {
        "pass_rate": 1,
        "passed": 1,
        "failed": 0,
        "total": 1,
        "time_seconds": 23.3,
        "tokens": 84852,
        "tool_calls": 6,
        "errors": 0
      },
      "expectations": [],
      "notes": []
    }
  ],
  "run_summary": {
    "with_skill": {},
    "without_skill": {},
    "delta": {}
  },
  "notes": []
}
```

The viewer requires `configuration` to be exactly `with_skill`, `without_skill`, or `old_skill`, and
requires metrics under `result`.

## `comparison.json`

```json
{
  "winner": "A",
  "reasoning": "A completed every expectation and preserved the requested format.",
  "rubric": { "A": {}, "B": {} },
  "output_quality": { "A": {}, "B": {} },
  "expectation_results": { "A": {}, "B": {} }
}
```

## `analysis.json`

```json
{
  "comparison_summary": {
    "winner": "A",
    "winner_skill_id": "personal-example-skill",
    "loser_skill_id": "baseline",
    "reasoning": "The winner used the supplied validation workflow."
  },
  "winner_strengths": [],
  "loser_weaknesses": [],
  "instruction_following": {},
  "improvement_suggestions": [],
  "transcript_insights": {}
}
```

## `feedback.json`

```json
{
  "schema_version": 1,
  "reviews": [
    { "run_id": "extract-table-with_skill-1", "feedback": "", "timestamp": "2026-08-09T00:00:00Z" }
  ],
  "status": "complete"
}
```
