---
name: mindmap
description: Generate mindmaps locally/offline with native HTML/CSS/JS (no external libraries); use when you need to parse Plain Text node structures or map LLM outputs into an on-device visualization.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

## When to Use

- You need to render mindmaps in **offline**, air-gapped, or internal-network environments where CDN access is unavailable.
- You want a **zero-dependency** renderer using only **native HTML/CSS/JS** (no third-party visualization libraries).
- You need to **parse a Plain Text mindmap format** into a node tree and render it locally.
- You want to **stream or incrementally update** mindmap content (e.g., from LLM output) and visualize it in a browser.
- You need a **single-file HTML template** that can be reused across projects with minimal integration overhead.

## Key Features

- Local mindmap rendering using a **single HTML file**: `assets/local-mindmap/index.html`.
- **Plain Text → node structure** parsing (format and rules defined in the reference document).
- Customizable parsing rules and layout parameters while keeping **no external library dependencies**.
- Designed for **streaming-friendly** workflows (generate/parse/update content progressively).

## Dependencies

- **Python**: None (no required packages at present).
- **Runtime**: Any modern web browser capable of running standard HTML/CSS/JS.
- **External JS/CSS libraries**: None (by design).

## Example Usage

The following example is a complete, runnable workflow that renders a mindmap locally using the provided single-file template.

1) **Create a Plain Text mindmap file** (example: `mindmap.txt`)

```txt
Mindmap Demo
  Goals
    Offline rendering
    Zero dependencies
  Inputs
    Plain Text nodes
    LLM streaming output
  Output
    Local HTML visualization
```

2) **Open the renderer template**

- Open `assets/local-mindmap/index.html` in your browser.

3) **Load/insert the Plain Text content**

- Follow the Plain Text format and loading instructions described in:
  - `references/streaming-implementation.md`

> Note: If you add any Python scripts under `scripts/` (e.g., to transform LLM output into the Plain Text format), invoke them consistently as:
>
> ```bash
> python scripts/<task_name>.py
> ```

## Implementation Details

- **Rendering template**: The renderer is implemented as a reusable single-file HTML template:
  - `assets/local-mindmap/index.html`
- **Data format**: The mindmap structure is represented in a **Plain Text** specification:
  - See `references/streaming-implementation.md` for the exact format, examples, and constraints.
- **Parsing rules**: The parser converts Plain Text into a hierarchical node tree. You may adjust:
  - indentation/marker rules (to match your input style),
  - node labeling rules (to sanitize or normalize text),
  - streaming/incremental update behavior (if applicable),
  while preserving the **no external dependency** requirement.
- **Layout parameters**: Layout and styling are controlled within the HTML/CSS/JS template. Tune spacing, alignment, and node styling as needed, referencing:
  - `references/streaming-implementation.md`
- **Script/config conventions** (if you extend with scripts):
  - Put configuration constants at the top of each script (avoid excessive CLI flags).
  - Keep invocation consistent: `python scripts/<task_name>.py`.
  - If any Python packages are introduced, list them (with versions) in the **Dependencies** section above.

## When Not to Use

- Do not use this skill when the required source data, identifiers, files, or credentials are missing.
- Do not use this skill when the user asks for fabricated results, unsupported claims, or out-of-scope conclusions.
- Do not use this skill when a simpler direct answer is more appropriate than the documented workflow.

## Required Inputs

- A clearly specified task goal aligned with the documented scope.
- All required files, identifiers, parameters, or environment variables before execution.
- Any domain constraints, formatting requirements, and expected output destination if applicable.

## Recommended Workflow

1. Validate the request against the skill boundary and confirm all required inputs are present.
2. Select the documented execution path and prefer the simplest supported command or procedure.
3. Produce the expected output using the documented file format, schema, or narrative structure.
4. Run a final validation pass for completeness, consistency, and safety before returning the result.

## Deterministic Output Rules

- Use the same section order for every supported request of this skill.
- Keep output field names stable and do not rename documented keys across examples.
- If a value is unavailable, emit an explicit placeholder instead of omitting the field.

## Output Contract

- Return a structured deliverable that is directly usable without reformatting.
- If a file is produced, prefer a deterministic output name such as `mindmap_result.md` unless the skill documentation defines a better convention.
- Include a short validation summary describing what was checked, what assumptions were made, and any remaining limitations.

## Validation and Safety Rules

- Validate required inputs before execution and stop early when mandatory fields or files are missing.
- Do not fabricate measurements, references, findings, or conclusions that are not supported by the provided source material.
- Emit a clear warning when credentials, privacy constraints, safety boundaries, or unsupported requests affect the result.
- Keep the output safe, reproducible, and within the documented scope at all times.

## Failure Handling

- If validation fails, explain the exact missing field, file, or parameter and show the minimum fix required.
- If an external dependency or script fails, surface the command path, likely cause, and the next recovery step.
- If partial output is returned, label it clearly and identify which checks could not be completed.

## Completion Checklist

- Confirm all required inputs were present and valid.
- Confirm the supported execution path completed without unresolved errors.
- Confirm the final deliverable matches the documented format exactly.
- Confirm assumptions, limitations, and warnings are surfaced explicitly.

## Quick Validation

Run this minimal verification path before full execution when possible:

```text
No local script validation step is required for this skill.
```

Expected output format:

```text
Result file: mindmap_result.md
Validation summary: PASS/FAIL with brief notes
Assumptions: explicit list if any
```

## Scope Reminder

- Core purpose: Generate mindmaps locally/offline with native HTML/CSS/JS (no external libraries); use when you need to parse Plain Text node structures or map LLM outputs into an on-device visualization.
