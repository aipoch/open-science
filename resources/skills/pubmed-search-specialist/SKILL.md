---
name: pubmed-search-specialist
description: Build complex Boolean query strings for precise PubMed/MEDLINE literature retrieval. Trigger when user needs MeSH term mapping, Boolean query construction, advanced PubMed filters, citation searching, systematic review search strategy, or clinical query optimization.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

# PubMed Search Specialist

Expert tool for constructing sophisticated Boolean queries to search PubMed/MEDLINE database with precision.

## When to Use

- Use this skill when the task needs Build complex Boolean query strings for precise PubMed/MEDLINE literature retrieval. Trigger when user needs MeSH term mapping, Boolean query construction, advanced PubMed filters, citation searching, systematic review search strategy, or clinical query optimization.
- Use this skill for evidence insight tasks that require explicit assumptions, bounded scope, and a reproducible output format.
- Use this skill when you need a documented fallback path for missing inputs, execution errors, or partial evidence.

## Key Features

- Scope-focused workflow aligned to: Build complex Boolean query strings for precise PubMed/MEDLINE literature retrieval. Trigger when user needs MeSH term mapping, Boolean query construction, advanced PubMed filters, citation searching, systematic review search strategy, or clinical query optimization.
- Packaged executable path(s): `scripts/main.py`.
- Reference material available in `references/` for task-specific guidance.
- Structured execution path designed to keep outputs consistent and reviewable.

## Dependencies

See `## Prerequisites` above for related details.

- `Python`: `3.10+`. Repository baseline for current packaged skills.
- `dataclasses`: `unspecified`. Declared in `requirements.txt`.
- `requests`: `unspecified`. Declared in `requirements.txt`.

## Example Usage

```bash
cd "20260318/scientific-skills/Evidence Insight/pubmed-search-specialist"
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

## Core Capabilities

- **MeSH Term Mapping**: Convert natural language concepts to standardized Medical Subject Headings
- **Boolean Query Builder**: Construct complex nested queries with AND/OR/NOT operators
- **Advanced Filters**: Apply study type, date, language, age, and species filters
- **Search Strategy Optimization**: Refine sensitivity vs specificity trade-offs

## Usage Workflow

### 1. Concept Extraction
Extract key concepts from user's research question using PICO framework:
- **P**opulation/Problem
- **I**ntervention
- **C**omparison
- **O**utcome

### 2. MeSH Term Mapping
For each concept, identify appropriate MeSH terms:
- Preferred terms (mapped to MeSH hierarchy)
- Entry terms (synonyms mapped to preferred)
- Subheadings for precision
- Explode vs Focus options

### 3. Boolean Construction
Build query strings following PubMed syntax:
```
("Term"[MeSH Terms] OR "Term"[Title/Abstract] OR synonym[Title/Abstract])
```

### 4. Filter Application
Append filters as needed:
- Publication dates: `from 2020 to 2024`
- Article types: `Clinical Trial`, `Review`, `Meta-Analysis`
- Species: `humans[MeSH Terms]` or `animals[MeSH Terms]`
- Languages: `english[Language]`
- Age groups: `adult[MeSH Terms]`, `aged[MeSH Terms]`

### 5. Search Strategy Output
Provide complete, copy-paste ready PubMed search string with:
- Line-by-line breakdown
- Estimated result count guidance
- Alternative strategies for sensitivity/specificity balance

## Key MeSH Features

| Feature | Syntax | Use Case |
|---------|--------|----------|
| MeSH Terms | `"Diabetes Mellitus"[MeSH Terms]` | Subject heading search |
| MeSH Major Topic | `"Diabetes Mellitus"[MeSH Major Topic]` | Core focus articles |
| Explode | `"Diabetes Mellitus"[MeSH Terms:noexp]` | Exclude subcategories |
| Subheadings | `"Diabetes Mellitus/drug therapy"[MeSH Terms]` | Specific aspects |
| Entry Terms | `"Blood Sugar"[Title/Abstract]` | Non-MeSH synonyms |

## Boolean Operators

- **AND**: Both terms must appear (narrows search)
- **OR**: Either term may appear (broadens search)
- **NOT**: Exclude terms (use sparingly)

**Operator Precedence**: Use parentheses to control evaluation order.

## Field Tags Reference

| Tag | Field | Example |
|-----|-------|---------|
| `[MeSH Terms]` | Medical Subject Headings | `"Hypertension"[MeSH Terms]` |
| `[Title]` | Article title only | `"stroke"[Title]` |
| `[Title/Abstract]` | Title and abstract | `"aspirin"[Title/Abstract]` |
| `[Author]` | Author name | `"Smith J"[Author]` |
| `[Journal]` | Journal name | `"Lancet"[Journal]` |
| `[Publication Date]` | Date range | `2020:2024[Publication Date]` |
| `[Language]` | Article language | `english[Language]` |
| `[Publication Type]` | Article type | `clinical trial[Publication Type]` |

## Clinical Query Filters

### Therapy
```
(randomized controlled trial[Publication Type] OR (randomized[Title/Abstract] AND controlled[Title/Abstract] AND trial[Title/Abstract]))
```

### Diagnosis
```
(sensitivity and specificity[MeSH Terms] OR sensitivity[Title/Abstract] OR specificity[Title/Abstract] OR diagnostic accuracy[Title/Abstract])
```

### Prognosis
```
(incidence[MeSH Terms] OR mortality[MeSH Terms] OR follow-up studies[MeSH Terms] OR prognos*[Title/Abstract] OR predict*[Title/Abstract])
```

### Etiology
```
(risk[MeSH Terms] OR (risk factors[MeSH Terms]) OR (risk[Title/Abstract] AND factor*[Title/Abstract]))
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--population` | str | Required | Population/Problem |
| `--intervention` | str | Required | Intervention |
| `--comparison` | str | Required | Comparison |
| `--outcome` | str | Required | Outcome |
| `--study-type` | str | Required | Clinical query category |
| `--format` | str | 'lines' | Output format |

## Example: Complete Search Strategy

**Research Question**: Does aspirin reduce stroke risk in diabetic patients?

**Line 1 - Population**:
```
("Diabetes Mellitus"[MeSH Terms] OR "Diabetic"[Title/Abstract] OR "Diabetics"[Title/Abstract])
```

**Line 2 - Intervention**:
```
("Aspirin"[MeSH Terms] OR "Acetylsalicylic Acid"[Title/Abstract] OR "aspirin"[Title/Abstract])
```

**Line 3 - Outcome**:
```
("Stroke"[MeSH Terms] OR "Cerebrovascular Accident"[Title/Abstract] OR "stroke"[Title/Abstract] OR "cerebrovascular"[Title/Abstract])
```

**Line 4 - Study Type Filter**:
```
(randomized controlled trial[Publication Type] OR systematic review[Publication Type] OR meta-analysis[Publication Type])
```

**Final Query**:
```
(("Diabetes Mellitus"[MeSH Terms] OR "Diabetic"[Title/Abstract] OR "Diabetics"[Title/Abstract]) AND ("Aspirin"[MeSH Terms] OR "Acetylsalicylic Acid"[Title/Abstract] OR "aspirin"[Title/Abstract]) AND ("Stroke"[MeSH Terms] OR "Cerebrovascular Accident"[Title/Abstract] OR "stroke"[Title/Abstract] OR "cerebrovascular"[Title/Abstract]) AND (randomized controlled trial[Publication Type] OR systematic review[Publication Type] OR meta-analysis[Publication Type]))
```

## MeSH Browser Usage

When mapping terms:
1. Check MeSH Browser for exact term hierarchy
2. Note tree numbers for related terms
3. Identify entry terms (synonyms)
4. Consider subheadings for precision
5. Decide on explode vs noexp based on scope needs

## Quality Checklist

Before finalizing query:
- [ ] All concepts covered with OR within, AND between groups
- [ ] MeSH terms verified against current MeSH database
- [ ] Free-text synonyms included for completeness
- [ ] Filters appropriate for research question
- [ ] Parentheses balanced and precedence correct
- [ ] Copy-paste ready for PubMed search box

## Technical Difficulty

🔴 **High** - Requires understanding of:
- MeSH hierarchical structure and term relationships
- Boolean logic and operator precedence
- Field tag semantics and limitations
- Search sensitivity vs specificity trade-offs
- Clinical query methodology

⚠️ **Verification Required**: MeSH terms change annually. Always verify current MeSH version at https://meshb.nlm.nih.gov/

## References

See `references/mesh-structure.md` for detailed MeSH hierarchy guidance.
See `references/boolean-examples.md` for categorized query templates.

## Risk Assessment

| Risk Indicator | Assessment | Level |
|----------------|------------|-------|
| Code Execution | Python scripts executed locally | Medium |
| Network Access | PubMed E-utilities API calls | High |
| File System Access | Read/write search strategies | Low |
| Instruction Tampering | Query construction guidelines | Low |
| Data Exposure | Search terms logged locally | Low |

## Security Checklist

- [ ] No hardcoded credentials or API keys
- [ ] NCBI API requests use HTTPS only
- [ ] API rate limits respected (max 3 requests/second without API key)
- [ ] Input validation for search terms (injection prevention)
- [ ] Output directory restricted to workspace
- [ ] Error messages sanitized (no internal paths exposed)
- [ ] API timeout and retry mechanisms implemented
- [ ] No exposure of internal service architecture

## Prerequisites

```text

# Python dependencies
pip install -r requirements.txt

# Optional: NCBI API key for higher rate limits

# Set as environment variable: NCBI_API_KEY
```

## Evaluation Criteria

### Success Metrics
- [ ] Successfully constructs valid PubMed Boolean queries
- [ ] MeSH term mapping is accurate and current
- [ ] Query syntax is copy-paste ready for PubMed
- [ ] Provides sensitivity/specificity trade-off options
- [ ] Handles complex multi-concept research questions
- [ ] Estimated result counts are reasonable

### Test Cases
1. **Basic Query**: "diabetes treatment" → Valid MeSH-based query
2. **PICO Framework**: Complex clinical question → Complete search strategy
3. **MeSH Mapping**: Free-text term → Correct MeSH term identification
4. **Boolean Logic**: Multiple concepts → Properly nested AND/OR/NOT
5. **Clinical Query**: Therapy-focused question → Includes appropriate filters
6. **API Integration**: Execute search via E-utilities → Successful retrieval
7. **Error Handling**: Invalid search term → Graceful error with suggestions

## Lifecycle Status

- **Current Stage**: Draft
- **Next Review Date**: 2026-03-06
- **Known Issues**: 
  - MeSH terms updated annually, may need periodic validation
  - API rate limits without key
- **Planned Improvements**:
  - Integration with NCBI API key support for higher rate limits
  - Automatic MeSH term validation against current database
  - Support for additional databases (Embase, Cochrane)

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

This skill accepts requests that match the documented purpose of `pubmed-search-specialist` and include enough context to complete the workflow safely.

Do not continue the workflow when the request is out of scope, missing a critical input, or would require unsupported assumptions. Instead respond:

> `pubmed-search-specialist` only handles its documented workflow. Please provide the missing required inputs or switch to a more suitable skill.

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
