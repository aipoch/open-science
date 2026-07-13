---
name: citation-formatter
description: Use when formatting references for journal submission, converting between citation styles (APA, MLA, Vancouver, Chicago), generating bibliographies for manuscripts, or ensuring consistent reference formatting. Automatically formats citations and bibliographies in 1000+ academi...
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

# Academic Citation Style Formatter and Converter

## When to Use

- Use this skill when the task needs Use when formatting references for journal submission, converting between citation styles (APA, MLA, Vancouver, Chicago), generating bibliographies for manuscripts, or ensuring consistent reference formatting. Automatically formats citations and bibliographies in 1000+ academic styles. Ensures reference accuracy, completeness, and compliance with journal requirements. Supports batch conversion and integration with reference managers.
- Use this skill for academic writing tasks that require explicit assumptions, bounded scope, and a reproducible output format.
- Use this skill when you need a documented fallback path for missing inputs, execution errors, or partial evidence.

## Key Features

- Scope-focused workflow aligned to: Use when formatting references for journal submission, converting between citation styles (APA, MLA, Vancouver, Chicago), generating bibliographies for manuscripts, or ensuring consistent reference formatting. Automatically formats citations and bibliographies in 1000+ academic styles. Ensures reference accuracy, completeness, and compliance with journal requirements. Supports batch conversion and integration with reference managers.
- Packaged executable path(s): `scripts/main.py`.
- Reference material available in `references/` for task-specific guidance.
- Structured execution path designed to keep outputs consistent and reviewable.

## Dependencies

- `Python`: `3.10+`. Repository baseline for current packaged skills.
- `Third-party packages`: `not explicitly version-pinned in this skill package`. Add pinned versions if this skill needs stricter environment control.

## Example Usage

```bash
cd "20260318/scientific-skills/Academic Writing/citation-formatter"
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
python scripts/main.py --input "Audit validation sample with explicit symptoms, history, assessment, and next-step plan." --format json
```

## Workflow

1. Confirm the user objective, required inputs, and non-negotiable constraints before doing detailed work.
2. Validate that the request matches the documented scope and stop early if the task would require unsupported assumptions.
3. Use the packaged script path or the documented reasoning path with only the inputs that are actually available.
4. Return a structured result that separates assumptions, deliverables, risks, and unresolved items.
5. If execution fails or inputs are incomplete, switch to the fallback path and state exactly what blocked full completion.

## When to Use This Skill

- formatting references for journal submission
- converting between citation styles (APA, MLA, Vancouver, Chicago)
- generating bibliographies for manuscripts
- ensuring consistent reference formatting
- checking reference completeness and accuracy
- preparing grant proposal reference sections

## Quick Start

```python
from scripts.main import CitationFormatter

# Initialize the tool
tool = CitationFormatter()

from scripts.citation_formatter import CitationFormatter

formatter = CitationFormatter()

# Format references for specific journal
formatted_refs = formatter.format_references(
    references=raw_references,
    target_style="Nature Medicine",
    output_format="docx"
)

# Convert between styles
converted = formatter.convert_style(
    bibliography=apa_bibliography,
    from_style="APA 7th",
    to_style="Vancouver",
    include_doi=True,
    include_pmids=True
)

# Validate reference completeness
validation = formatter.validate_references(
    references=reference_list,
    required_fields=["authors", "title", "journal", "year", "volume", "pages", "doi"]
)

print(f"Validation results:")
print(f"  Complete: {validation.complete_count}")
print(f"  Missing fields: {validation.incomplete_count}")
print(f"  Invalid DOIs: {len(validation.invalid_dois)}")

# Generate in-text citations
in_text = formatter.generate_in_text_citations(
    citations=[
        {"author": "Smith", "year": 2023, "type": "paren"},
        {"author": "Jones et al.", "year": 2022, "type": "narrative"}
    ],
    style="APA"
)

# Batch process multiple documents
batch_results = formatter.batch_format(
    files=["chapter1.docx", "chapter2.docx"],
    style="AMA",
    output_dir="formatted/"
)
```

## Core Capabilities

### 1. Format citations in 1000+ academic styles

```python

# Format functionality
result = tool.execute(data)
```

### 2. Convert seamlessly between citation formats

```python

# Convert functionality
result = tool.execute(data)
```

### 3. Validate reference completeness and accuracy

```python

# Validate functionality
result = tool.execute(data)
```

### 4. Batch process large reference collections

```python

# Batch functionality
result = tool.execute(data)
```

## Command Line Usage

```text
python scripts/main.py --input references.bib --from-style APA --to-style Vancouver --output formatted.docx --validate
```

## Best Practices

- Always validate DOIs and URLs before submission
- Check journal-specific requirements beyond standard style
- Maintain original reference database for updates
- Review formatting of special cases (websites, preprints)

## Quality Checklist

Before using this skill, ensure you have:
- [ ] Clear understanding of your objectives
- [ ] Necessary input data prepared and validated
- [ ] Output requirements defined
- [ ] Reviewed relevant documentation

After using this skill, verify:
- [ ] Results meet your quality standards
- [ ] Outputs are properly formatted
- [ ] Any errors or warnings have been addressed
- [ ] Results are documented appropriately

## References

- `references/guide.md` - Comprehensive user guide
- `references/examples/` - Working code examples
- `references/api-docs/` - Complete API documentation

---

**Skill ID**: 625 | **Version**: 1.0 | **License**: MIT

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

This skill accepts requests that match the documented purpose of `citation-formatter` and include enough context to complete the workflow safely.

Do not continue the workflow when the request is out of scope, missing a critical input, or would require unsupported assumptions. Instead respond:

> `citation-formatter` only handles its documented workflow. Please provide the missing required inputs or switch to a more suitable skill.

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
