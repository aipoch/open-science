---
name: abstract-summarizer
description: Transform lengthy academic papers into concise, structured 250-word abstracts.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

# Abstract Summarizer

## When to Use

- Use this skill when the task needs Transform lengthy academic papers into concise, structured 250-word abstracts.
- Use this skill for academic writing tasks that require explicit assumptions, bounded scope, and a reproducible output format.
- Use this skill when you need a documented fallback path for missing inputs, execution errors, or partial evidence.

## Key Features

- Scope-focused workflow aligned to: Transform lengthy academic papers into concise, structured 250-word abstracts.
- Packaged executable path(s): `scripts/main.py`.
- Reference material available in `references/` for task-specific guidance.
- Structured execution path designed to keep outputs consistent and reviewable.

## Dependencies

- `Python`: `3.10+`. Repository baseline for current packaged skills.
- `pypdf2`: `unspecified`. Declared in `requirements.txt`.
- `requests`: `unspecified`. Declared in `requirements.txt`.

## Example Usage

```bash
cd "20260318/scientific-skills/Academic Writing/abstract-summarizer"
python -m py_compile scripts/main.py
python scripts/main.py --help
```

Example run plan:
1. Confirm the user input, output path, and any required config values.
2. Edit the in-file `CONFIG` block or documented parameters if the script uses fixed settings.
3. Run `python scripts/main.py` with the validated inputs.
4. Review the generated output and return the final artifact with any assumptions called out.

## Implementation Details

See `## Workflow` above for related details.

- Execution model: validate the request, choose the packaged workflow, and produce a bounded deliverable.
- Input controls: confirm the source files, scope limits, output format, and acceptance criteria before running any script.
- Primary implementation surface: `scripts/main.py`.
- Reference guidance: `references/` contains supporting rules, prompts, or checklists.
- Parameters to clarify first: input path, output path, scope filters, thresholds, and any domain-specific constraints.
- Output discipline: keep results reproducible, identify assumptions explicitly, and avoid undocumented side effects.

## Quick Check

Use this command to verify that the packaged script entry point can be parsed before deeper execution.

```bash
python -m py_compile scripts/main.py
```

## Audit-Ready Commands

Use these concrete commands for validation. They are intentionally self-contained and avoid placeholder paths.

```bash
python -m py_compile scripts/main.py
python scripts/main.py --help
```

## Workflow

1. Confirm the user objective, required inputs, and non-negotiable constraints before doing detailed work.
2. Validate that the request matches the documented scope and stop early if the task would require unsupported assumptions.
3. Use the packaged script path or the documented reasoning path with only the inputs that are actually available.
4. Return a structured result that separates assumptions, deliverables, risks, and unresolved items.
5. If execution fails or inputs are incomplete, switch to the fallback path and state exactly what blocked full completion.

## Overview

AI-powered academic summarization tool that condenses complex research papers into publication-ready structured abstracts while preserving scientific accuracy and key findings.

**Key Capabilities:**
- **Multi-Format Input**: Process PDFs, text, URLs, or clipboard content
- **Structured Output**: Background, Objective, Methods, Results, Conclusion format
- **Word Count Enforcement**: Strict 250-word limit with validation
- **Quantitative Preservation**: Retains key numbers, statistics, and effect sizes
- **Discipline Adaptation**: Optimized for STEM, medical, and social sciences
- **Batch Processing**: Summarize multiple papers efficiently

## Core Capabilities

### 1. Structured Abstract Generation

Extract and condense key sections into standard format:

```python
from scripts.summarizer import AbstractSummarizer

summarizer = AbstractSummarizer()

# Generate from PDF
abstract = summarizer.summarize(
    source="paper.pdf",
    format="structured",  # structured, plain, or executive
    word_limit=250,
    discipline="biomedical"  # affects terminology handling
)

print(abstract.text)

# Output: Background → Objective → Methods → Results → Conclusion
```

**Output Structure:**
```
**Background**: [Context and problem statement]
**Objective**: [Research goal and hypotheses]
**Methods**: [Study design, sample, key methods]
**Results**: [Primary findings with statistics]
**Conclusion**: [Implications and significance]

---
Word count: 247/250
```

### 2. Quantitative Data Preservation

Ensure numbers and statistics are accurately retained:

```python

# Extract and verify quantitative results
quant_results = summarizer.extract_quantitative(
    text=paper_content,
    priority="high"  # keep all numbers vs. representative samples
)

# Validate against original
validation = summarizer.verify_accuracy(
    abstract=abstract,
    source=paper_content
)
```

**Preserves:**
- Sample sizes (n=128)
- Effect sizes (Cohen's d = 0.82)
- P-values (p < 0.001)
- Confidence intervals (95% CI: [0.45, 0.78])
- Percentages and absolute numbers

### 3. Multi-Disciplinary Adaptation

Adjust extraction strategy by field:

```text

# Biomedical paper
python scripts/main.py --input paper.pdf --field biomedical

# Physics paper  
python scripts/main.py --input paper.pdf --field physics

# Social science paper
python scripts/main.py --input paper.pdf --field social-science
```

**Field-Specific Handling:**
| Field | Focus Areas | Special Handling |
|-------|-------------|------------------|
| **Biomedical** | Study design, statistical significance, clinical relevance | Preserve P-values, effect sizes |
| **Physics** | Theoretical framework, experimental setup, precision | Keep measurement uncertainties |
| **CS/Engineering** | Algorithm performance, benchmarks, complexity | Retain accuracy percentages |
| **Social Science** | Methodology, sample demographics, theoretical contribution | Preserve effect descriptions |

### 4. Batch Literature Processing

Summarize multiple papers for systematic reviews:

```python
from scripts.batch import BatchProcessor

batch = BatchProcessor()

# Process directory of papers
summaries = batch.summarize_directory(
    directory="literature_review/",
    output_format="csv",  # or json, markdown
    include_metadata=True  # title, authors, year
)

# Generate review matrix
matrix = batch.create_summary_matrix(summaries)
matrix.save("review_matrix.csv")
```

**Output:**
- Individual abstract files
- Comparative summary table
- Key findings synthesis document

## Quality Checklist

**Pre-Summarization:**
- [ ] Source document is complete (not truncated)
- [ ] PDF/text is machine-readable (not scanned images)
- [ ] Document is research paper (not editorial, review, or news)

**During Summarization:**
- [ ] All key sections identified (don't miss Results)
- [ ] Quantitative data preserved accurately
- [ ] Statistical significance indicators kept
- [ ] No interpretation added beyond source

**Post-Summarization:**
- [ ] Word count ≤ 250
- [ ] All 5 sections present
- [ ] **CRITICAL**: Numbers match source document
- [ ] Standalone comprehensibility (makes sense without paper)
- [ ] No citations or references in abstract
- [ ] Technical terms used correctly

**Before Use:**
- [ ] **CRITICAL**: Fact-check all numbers against original
- [ ] Verify author names and affiliations correct
- [ ] Ensure conclusions don't overstate findings

## Common Pitfalls

**Accuracy Issues:**
- ❌ **Misrepresenting statistics** → "Significant improvement" when p>0.05
  - ✅ Preserve exact P-values and confidence intervals
  
- ❌ **Oversimplifying complex findings** → "Drug works" vs nuanced efficacy data
  - ✅ Include effect sizes and confidence intervals

- ❌ **Missing adverse events** → Only reporting positive results
  - ✅ Include safety data for clinical studies

**Structure Issues:**
- ❌ **Methods too detailed** → Protocol steps in abstract
  - ✅ High-level study design only

- ❌ **Results without context** → Numbers without interpretation
  - ✅ Brief clinical/scientific significance

- ❌ **Conclusion overstates** → "Cure for cancer" from preclinical data
  - ✅ Match conclusion to evidence level

**Word Count Issues:**
- ❌ **Exceeding 250 words** → Journal rejection
  - ✅ Strict enforcement with real-time counter

- ❌ **Too short (<150 words)** → Missing key information
  - ✅ Minimum thresholds by section

## References

Available in `references/` directory:

- `abstract_templates.md` - Discipline-specific abstract formats
- `quantitative_checklist.md` - Number verification guidelines  
- `disciplinary_guidelines.md` - Field-specific conventions
- `journal_requirements.md` - Word limits by publisher
- `example_abstracts.md` - High-quality examples by type

## Scripts

Located in `scripts/` directory:

- `main.py` - CLI interface for summarization
- `summarizer.py` - Core abstract generation engine
- `extractor.py` - PDF and text extraction
- `validator.py` - Accuracy checking and verification
- `batch_processor.py` - Multi-document processing
- `adapter.py` - Journal-specific formatting

## Limitations

- **Language**: Optimized for English-language papers
- **Length**: Papers >50 pages may need section-by-section processing
- **Complexity**: Highly mathematical content may lose nuance
- **Figures**: Cannot interpret images, charts, or graphs (text only)
- **Domain**: Best for empirical research; struggles with pure theory papers
- **Context**: May miss field-specific conventions without discipline flag

---

**📝 Note: This tool generates draft abstracts for efficiency, but all summaries require human review before submission. Always verify that numbers, statistics, and conclusions accurately reflect the original paper.**

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--input` | str | Required |  |
| `--text` | str | Required | Direct text input |
| `--url` | str | Required | URL to fetch paper from |
| `--output` | str | Required | Output file path |
| `--format` | str | 'structured' | Output format |

## Output Requirements

Every final response should make these items explicit when they are relevant:

- Objective or requested deliverable
- Inputs used and assumptions introduced
- Workflow or decision path
- Core result, recommendation, or artifact
- Constraints, risks, caveats, or validation needs
- Unresolved items and next-step checks

## Error Handling

- If required inputs are missing, state exactly which fields are missing and request only the minimum additional information.
- If the task goes outside the documented scope, stop instead of guessing or silently widening the assignment.
- If `scripts/main.py` fails, report the failure point, summarize what still can be completed safely, and provide a manual fallback.
- Do not fabricate files, citations, data, search results, or execution outcomes.

## Input Validation

This skill accepts requests that match the documented purpose of `abstract-summarizer` and include enough context to complete the workflow safely.

Do not continue the workflow when the request is out of scope, missing a critical input, or would require unsupported assumptions. Instead respond:

> `abstract-summarizer` only handles its documented workflow. Please provide the missing required inputs or switch to a more suitable skill.

## Response Template

Use the following fixed structure for non-trivial requests:

1. Objective
2. Inputs Received
3. Assumptions
4. Workflow
5. Deliverable
6. Risks and Limits
7. Next Checks

If the request is simple, you may compress the structure, but still keep assumptions and limits explicit when they affect correctness.
