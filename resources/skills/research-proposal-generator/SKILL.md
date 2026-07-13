---
name: research-proposal-generator
description: Generates a comprehensive research proposal design based on input literature, including hypothesis, mechanism verification, and budget. Use when the user wants to design a research project from a paper.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

# Research Proposal Generator

This skill analyzes a given literature text (paper) and generates a complete research proposal design, including scientific hypothesis, research outline, detailed experimental design, budget, and yearly plan.

## When to Use

- Use this skill when the request matches its documented task boundary.
- Use it when the user can provide the required inputs and expects a structured deliverable.
- Prefer this skill for repeatable, checklist-driven execution rather than open-ended brainstorming.

## Key Features

- Scope-focused workflow aligned to: Generates a comprehensive research proposal design based on input literature, including hypothesis, mechanism verification, and budget. Use when the user wants to design a research project from a paper.
- Documentation-first workflow with no packaged script requirement.
- Reference material available in `references/` for task-specific guidance.
- Structured execution path designed to keep outputs consistent and reviewable.

## Dependencies

- `Python`: `3.10+`. Repository baseline for current packaged skills.
- `Third-party packages`: `not explicitly version-pinned in this skill package`. Add pinned versions if this skill needs stricter environment control.

## Example Usage

See `## Usage` above for related details.

```text
Skill directory: 20260316/scientific-skills/Protocol Design/research-proposal-generator
No packaged executable script was detected.
Use the documented workflow in SKILL.md together with the references/assets in this folder.
```

Example run plan:
1. Read the skill instructions and collect the required inputs.
2. Follow the documented workflow exactly.
3. Use packaged references/assets from this folder when the task needs templates or rules.
4. Return a structured result tied to the requested deliverable.

## Implementation Details

- Execution model: validate the request, choose the packaged workflow, and produce a bounded deliverable.
- Input controls: confirm the source files, scope limits, output format, and acceptance criteria before running any script.
- Primary implementation surface: instruction-only workflow in `SKILL.md`.
- Reference guidance: `references/` contains supporting rules, prompts, or checklists.
- Parameters to clarify first: input path, output path, scope filters, thresholds, and any domain-specific constraints.
- Output discipline: keep results reproducible, identify assumptions explicitly, and avoid undocumented side effects.

## Usage

**Input**: The text content of a scientific paper.

**Output**: A structured research proposal in Markdown format.

## Procedure

Please follow these steps to generate the proposal. Refer to [prompts.md](references/prompts.md) for detailed prompts for each step.

### Step 1: Analysis & Extraction

1.  **Extract Hypothesis**: Analyze the input text to extract the scientific hypothesis and cell phenotype.
2.  **Extract Key Info**: Extract molecular mechanisms, signaling pathways, and regulatory relationships. Identify the "Start Variable" (first gene in results).
3.  **Extract Clinical Info**: Extract clinical questions and their relation to the hypothesis.

### Step 2: Outline Generation

1.  **Generate Outline**: Based on the Hypothesis, Key Info, and Clinical Info, generate a research proposal outline (Section 2. Research Plan).
    *   *Constraint*: The outline should start from bioinformatic screening to mechanism verification.

### Step 3: Detailed Experimental Design

1.  **Identify Molecules**: Scan the outline to identify key genes/molecules.
2.  **Design Experiments**: For each section of the outline, design detailed experiments.
    *   *Requirement*: Include Model, Groups, Sample, Method, Index, Expected Results.
    *   *Rule*: Each part usually studies relationship between two variables.
    *   *Rule*: Animal experiments must start with modeling.
    *   *Reference*: Use the "Design Experiments" prompt in `references/prompts.md`.

### Step 4: Final Compilation

1.  **Generate Overview**: Write Section "1. Overview" (Disease introduction) based on the hypothesis.
2.  **Generate Budget**: Create a budget explanation (Section "3. Budget") for a 3-year plan (RMB).
3.  **Generate Yearly Plan**: Create a 3-year research schedule (Section "4. Yearly Plan").

### Step 5: Output Assembly

Assemble the final report in the following order:
1.  **1. Overview**
2.  **2. Research Plan** (With detailed experiments inserted)
3.  **3. Budget**
4.  **4. Yearly Plan**

---
*Note: This process simulates a multi-step expert workflow. Ensure consistency between the hypothesis and the designed experiments.*

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

## Output Contract

- Return a structured deliverable that is directly usable without reformatting.
- If a file is produced, prefer a deterministic output name such as `research_proposal_generator_result.md` unless the skill documentation defines a better convention.
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


## Input Validation

This skill accepts requests that match the documented purpose of `research-proposal-generator` and include enough context to complete the workflow safely.

Do not continue the workflow when the request is out of scope, missing a critical input, or would require unsupported assumptions. Instead respond:

> `research-proposal-generator` only handles its documented workflow. Please provide the missing required inputs or switch to a more suitable skill.

## Quick Validation

Run this minimal verification path before full execution when possible:

```text
No local script validation step is required for this skill.
```

Expected output format:

```text
Result file: research_proposal_generator_result.md
Validation summary: PASS/FAIL with brief notes
Assumptions: explicit list if any
```
