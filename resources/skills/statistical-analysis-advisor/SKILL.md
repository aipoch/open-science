---
name: statistical-analysis-advisor
description: Recommends appropriate statistical methods (T-test vs ANOVA, etc.) based.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

# Statistical Analysis Advisor

Intelligent statistical test recommendation engine that guides users through selecting the right statistical methods for their data.

## When to Use

- Use this skill when the task needs Recommends appropriate statistical methods (T-test vs ANOVA, etc.) based.
- Use this skill for data analysis tasks that require explicit assumptions, bounded scope, and a reproducible output format.
- Use this skill when you need a documented fallback path for missing inputs, execution errors, or partial evidence.

## Key Features

- Scope-focused workflow aligned to: Recommends appropriate statistical methods (T-test vs ANOVA, etc.) based.
- Packaged executable path(s): `scripts/main.py`.
- Reference material available in `references/` for task-specific guidance.
- Structured execution path designed to keep outputs consistent and reviewable.

## Dependencies

See `## Prerequisites` above for related details.

- `Python`: `3.10+`. Repository baseline for current packaged skills.
- `dataclasses`: `unspecified`. Declared in `requirements.txt`.
- `enum`: `unspecified`. Declared in `requirements.txt`.

## Example Usage

See `## Usage` above for related details.

```bash
cd "20260318/scientific-skills/Data Analytics/statistical-analysis-advisor"
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
python scripts/main.py
```

## Workflow

1. Confirm the user objective, required inputs, and non-negotiable constraints before doing detailed work.
2. Validate that the request matches the documented scope and stop early if the task would require unsupported assumptions.
3. Use the packaged script path or the documented reasoning path with only the inputs that are actually available.
4. Return a structured result that separates assumptions, deliverables, risks, and unresolved items.
5. If execution fails or inputs are incomplete, switch to the fallback path and state exactly what blocked full completion.

## Capabilities

1. **Statistical Test Selection**
   - Compares and recommends between T-test, ANOVA, Chi-square, Mann-Whitney, Kruskal-Wallis, etc.
   - Considers data type, distribution, sample size, and research question
   - Provides decision tree logic for test selection

2. **Assumption Checking**
   - Normality tests (Shapiro-Wilk, Kolmogorov-Smirnov)
   - Homogeneity of variance (Levene's test, Bartlett's test)
   - Independence verification
   - Outlier detection guidance

3. **Power Analysis & Sample Size**
   - Effect size estimation (Cohen's d, eta-squared, Cramér's V)
   - Sample size calculations for desired power
   - Post-hoc power analysis

## Usage

```python
from scripts.main import StatisticalAdvisor

advisor = StatisticalAdvisor()

# Get test recommendation
recommendation = advisor.recommend_test(
    data_type="continuous",
    groups=2,
    independent=True,
    distribution="normal"
)

# Check assumptions
assumptions = advisor.check_assumptions(
    data=[group1, group2],
    test_type="independent_ttest"
)

# Power analysis
power = advisor.calculate_power(
    effect_size=0.5,
    alpha=0.05,
    sample_size=30
)
```

## Input Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| data_type | str | "continuous", "categorical", "ordinal" |
| groups | int | Number of groups/comparison levels |
| independent | bool | Independent or paired/related samples |
| distribution | str | "normal", "non-normal", "unknown" |
| sample_size | int | Current or planned sample size |

## Technical Difficulty: High ⚠️

**Warning**: Statistical recommendations have significant implications for research validity. This skill requires human verification of all recommendations before application in published research.

## References

- See `references/statistical_tests_guide.md` for detailed test selection criteria
- See `references/assumption_tests.md` for assumption checking procedures
- See `references/power_analysis_guide.md` for power calculation methods

## Limitations

- Does not perform actual data analysis (recommendations only)
- Cannot access raw data directly
- Complex multivariate designs may require specialized consultation
- Bayesian alternatives not covered comprehensively

## Risk Assessment

| Risk Indicator | Assessment | Level |
|----------------|------------|-------|
| Code Execution | Python/R scripts executed locally | Medium |
| Network Access | No external API calls | Low |
| File System Access | Read input files, write output files | Medium |
| Instruction Tampering | Standard prompt guidelines | Low |
| Data Exposure | Output files saved to workspace | Low |

## Security Checklist

- [ ] No hardcoded credentials or API keys
- [ ] No unauthorized file system access (../)
- [ ] Output does not expose sensitive information
- [ ] Prompt injection protections in place
- [ ] Input file paths validated (no ../ traversal)
- [ ] Output directory restricted to workspace
- [ ] Script execution in sandboxed environment
- [ ] Error messages sanitized (no stack traces exposed)
- [ ] Dependencies audited

## Prerequisites

```text

# Python dependencies
pip install -r requirements.txt
```

## Evaluation Criteria

### Success Metrics
- [ ] Successfully executes main functionality
- [ ] Output meets quality standards
- [ ] Handles edge cases gracefully
- [ ] Performance is acceptable

### Test Cases
1. **Basic Functionality**: Standard input → Expected output
2. **Edge Case**: Invalid input → Graceful error handling
3. **Performance**: Large dataset → Acceptable processing time

## Lifecycle Status

- **Current Stage**: Draft
- **Next Review Date**: 2026-03-06
- **Known Issues**: None
- **Planned Improvements**: 
  - Performance optimization
  - Additional feature support

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

This skill accepts requests that match the documented purpose of `statistical-analysis-advisor` and include enough context to complete the workflow safely.

Do not continue the workflow when the request is out of scope, missing a critical input, or would require unsupported assumptions. Instead respond:

> `statistical-analysis-advisor` only handles its documented workflow. Please provide the missing required inputs or switch to a more suitable skill.

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
