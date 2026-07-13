---
name: literature-close-read
description: Produce a structured close-reading report from a paper's full PDF-to-Markdown text (with `## Page XX` pagination and image references) when you need to systematically extract background, research questions, methods, results, limitations, and reproducible experimental details.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)


# Literature Close Reading

## When to Use

- When you have a full paper converted from PDF to Markdown and need a structured, in-depth interpretation rather than a brief abstract-style summary.
- When you must extract reproducible experimental details (datasets, settings, controls, metrics, statistics) for replication or reimplementation.
- When you need to map the paper's logical chain (motivation → problem → method → experiments → conclusions) and identify missing links or ambiguities.
- When you want a systematic list of limitations, threats to validity, and follow-up research questions grounded strictly in the text.
- When figures/tables are referenced via Markdown images and you need them incorporated into the interpretation without guessing beyond what is shown.

## Key Features

- Reads the entire Markdown paper text, prioritizing **Methods** and **Results** for technical fidelity.
- Produces a **structured close-reading report** in Markdown (UTF-8), following a predefined template.
- Extracts and organizes:
  - research background and problem statement
  - methodological details and experimental design
  - key results and statistical evidence (as explicitly stated)
  - limitations and threats to validity
  - reproducible points and follow-up questions
- Supports Markdown inputs that include pagination headers like `## Page XX` and image references such as `![page-01](...)`.
- Enforces a strict constraint: **summarize only what is explicitly present in the text/images; do not infer or speculate**.
- Uses external guidance and templates:
  - Requirements/checklist: `references/guide.md`
  - Output template: `assets/deep_reading_template.md`

## Dependencies

- `pdf-extract` (version: not specified) — used only when the source is PDF and must be converted to Markdown first.

## Example Usage

```bash
# 1) (Optional) Convert PDF to Markdown if you only have a PDF
# Note: exact command/options depend on your local pdf-extract installation.
pdf-extract paper.pdf > paper.md

# 2) Run the close-reading process (manual or via your orchestration tool):
# Input: paper.md (full text converted from PDF, may include `## Page XX` and images)
# Guidance: references/guide.md
# Template: assets/deep_reading_template.md

# 3) Save the final report as UTF-8 Markdown under outputs/
mkdir -p outputs
# Example output file name:
# outputs/paper_close_reading.md
```

Minimal expected I/O contract:

- **Input**: a single `.md` file containing the full paper text (PDF-to-Markdown), optionally with:
  - page headers like `## Page 01`
  - image references like `![page-01](...)`
- **Output**: one UTF-8 encoded `.md` report saved to `outputs/`, formatted according to `assets/deep_reading_template.md`.
- **Language**: default output is Chinese; if the user specifies a language, output in that language.

## Implementation Details

- **Input reading rules**
  - Treat the Markdown as the authoritative source of truth.
  - Pagination markers (e.g., `## Page XX`) may be used for navigation and citation, but should not alter meaning.
  - Image references may be used to interpret figures/tables only to the extent that the content is explicitly visible/legible.

- **Extraction and summarization rules**
  - Focus on **Methods** and **Results** first; then connect to background, problem statement, and conclusions.
  - Capture experimental details precisely: datasets, splits, baselines, ablations, hyperparameters, training/inference settings, evaluation metrics, and statistical tests—only if stated.
  - If a required field in the template cannot be filled from the text, write **"Not specified"**.

- **Quality constraints**
  - No speculation: do not add assumptions, unstated motivations, or inferred mechanisms.
  - Maintain traceability: ensure each claim in the report can be traced back to explicit paper content (text or figure/table).
  - Output must be valid Markdown and saved in **UTF-8** to avoid encoding issues.

- **Files used**
  - Requirements and checklist: `references/guide.md`
  - Output template: `assets/deep_reading_template.md`
  - Output directory: `outputs/` (create if missing)

## When Not to Use

- Do not use this skill when the required source data, identifiers, files, or credentials are missing.
- Do not use this skill when the user asks for fabricated results, unsupported claims, or out-of-scope conclusions.
- Do not use this skill when a simpler direct answer is more appropriate than the documented workflow.

## Required Inputs

- A clearly specified task goal aligned with the documented scope.
- All required files, identifiers, parameters, or environment variables before execution.
- Any domain constraints, formatting requirements, and expected output destination if applicable.

## Agent Execution Workflow

Follow these steps in order when the user provides a paper for close reading.

### Step 1: Validate Input
- Confirm the user has provided the paper content (paste, file path, or PDF path).
- If PDF, inform the user it must be converted to Markdown first.
- Required: The paper text as Markdown. Optional: specific focus areas.

### Step 2: Read and Parse the Full Text
- Read the entire Markdown content. Use `## Page XX` markers for navigation.
- Identify major sections: Introduction, Methods, Results, Discussion, Limitations.
- Prioritize **Methods** and **Results** for detailed extraction.

### Step 3: Extract Methods Details
- Capture: datasets, splits, baselines, ablations, hyperparameters, settings, metrics, tests.
- If any field is not explicitly stated, write **"Not specified"** — do NOT infer.
- Record exact values as stated.

### Step 4: Extract Results and Evidence
- Capture key quantitative results (metrics, scores, p-values, confidence intervals).
- Note which figures/tables contain the supporting data.
- Report only what is explicitly stated or clearly visible.

### Step 5: Identify Limitations
- Extract each stated limitation from the Limitations section.
- Note obvious unstated limitations (small sample, single-center, etc.).
- Distinguish author-stated from critically-identified.

### Step 6: Fill the Report Template
- Use `assets/deep_reading_template.md` as your output structure.
- Fill each section with extracted information.
- For missing info, write **"Not specified"** — never fabricate.
- Default output language: Chinese. Override if user specifies another.

### Step 7: Quality Check
- Verify every claim traces back to explicit paper content.
- Ensure no speculative content was added.
- Confirm valid Markdown, UTF-8 encoded.
- Save to `outputs/literature_close_read_result.md`.

## Output Contract

- Return a structured deliverable that is directly usable without reformatting.
- If a file is produced, prefer a deterministic output name such as `literature_close_read_result.md` unless the skill documentation defines a better convention.
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

This skill accepts requests that match the documented purpose of `literature-close-read` and include enough context to complete the workflow safely.

Do not continue the workflow when the request is out of scope, missing a critical input, or would require unsupported assumptions. Instead respond:

> `literature-close-read` only handles its documented workflow. Please provide the missing required inputs or switch to a more suitable skill.

## Quick Validation

Run this minimal verification path before full execution when possible:

```text
No local script validation step is required for this skill.
```

Expected output format:

```text
Result file: literature_close_read_result.md
Validation summary: PASS/FAIL with brief notes
Assumptions: explicit list if any
```

## User Checkpoints

- Before executing batch processing, overwriting files, long-running searches, or multi-stage generation, confirm scope and output format with the user.
- Before proceeding when a key judgment is ambiguous, evidence is insufficient, or the workflow is entering the next stage, confirm with the user.
