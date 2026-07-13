---
name: experiment-design
description: Design scientific experiments including sample size calculation, randomization, control groups, blinding, and study protocols. Covers RCTs, quasi-experiments, factorial designs, A/B tests, survey design, and observational studies. Use when user asks to design an experiment, ca...
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)


# Experiment Design

Scientific experiment planning, power analysis, and protocol development.

## Design Selection Guide

| Research Question | Recommended Design |
|---|---|
| Does X cause Y? | RCT (gold standard) |
| Does X cause Y? (can't randomize) | Quasi-experiment, natural experiment |
| How do factors interact? | Factorial design |
| Which version performs better? | A/B test |
| What is the prevalence/association? | Cross-sectional survey |
| How does outcome change over time? | Longitudinal / cohort study |
| What is the lived experience? | Qualitative (interviews, ethnography) |
| Does intervention work in practice? | Pragmatic trial |

## Power Analysis & Sample Size

```python
source /Users/zhangmingda/clawd/.venv/bin/activate
python3 << 'EOF'
from scipy import stats
import numpy as np

# --- Two-sample t-test ---
def sample_size_ttest(effect_size, alpha=0.05, power=0.80):
    """Cohen's d effect sizes: small=0.2, medium=0.5, large=0.8"""
    from scipy.stats import norm
    z_alpha = norm.ppf(1 - alpha/2)
    z_beta = norm.ppf(power)
    n = 2 * ((z_alpha + z_beta) / effect_size) ** 2
    return int(np.ceil(n))

# --- Chi-square test ---
def sample_size_chi2(effect_size, alpha=0.05, power=0.80, df=1):
    """Cohen's w effect sizes: small=0.1, medium=0.3, large=0.5"""
    from scipy.stats import norm, chi2
    z_beta = norm.ppf(power)
    z_alpha = norm.ppf(1 - alpha)
    n = ((z_alpha + z_beta) / effect_size) ** 2
    return int(np.ceil(n))

# --- Correlation ---
def sample_size_correlation(r, alpha=0.05, power=0.80):
    from scipy.stats import norm
    z_alpha = norm.ppf(1 - alpha/2)
    z_beta = norm.ppf(power)
    z_r = 0.5 * np.log((1+r)/(1-r))  # Fisher's z
    n = ((z_alpha + z_beta) / z_r) ** 2 + 3
    return int(np.ceil(n))

# Examples
print(f"t-test (d=0.5): n={sample_size_ttest(0.5)} per group")
print(f"t-test (d=0.3): n={sample_size_ttest(0.3)} per group")
print(f"Chi-square (w=0.3): n={sample_size_chi2(0.3)}")
print(f"Correlation (r=0.3): n={sample_size_correlation(0.3)}")
EOF
```

## Key Design Principles

### Controls
- **Positive control**: Known to produce effect (validates method works)
- **Negative control**: Known to produce no effect (validates baseline)
- **Placebo control**: Inert treatment (controls for expectation effects)
- **Active control**: Existing standard treatment (for superiority/non-inferiority)

### Randomization
- **Simple**: Coin flip / random number
- **Block**: Ensures equal groups per block
- **Stratified**: Randomize within strata (age, sex, severity)
- **Cluster**: Randomize groups, not individuals

### Blinding
- **Single-blind**: Participants don't know assignment
- **Double-blind**: Participants and researchers don't know
- **Triple-blind**: Participants, researchers, and analysts don't know

### Bias Mitigation
| Bias | Mitigation |
|------|-----------|
| Selection bias | Random sampling, clear inclusion criteria |
| Allocation bias | Random assignment, concealed allocation |
| Performance bias | Blinding, standardized protocols |
| Detection bias | Blinded outcome assessment |
| Attrition bias | ITT analysis, minimize dropout |
| Reporting bias | Pre-registration, analysis plan |

## Study Protocol Template

```markdown
# Study Protocol: [Title]

## 1. Background & Rationale
## 2. Objectives & Hypotheses
  - Primary: 
  - Secondary:
## 3. Study Design
  - Type: [RCT / quasi-experiment / observational / ...]
  - Duration:
## 4. Participants
  - Population:
  - Inclusion criteria:
  - Exclusion criteria:
  - Sample size: N = [calculated], power = 0.80, α = 0.05
## 5. Intervention / Exposure
## 6. Outcome Measures
  - Primary:
  - Secondary:
## 7. Randomization & Blinding
## 8. Data Collection Procedures
## 9. Statistical Analysis Plan
  - Primary analysis:
  - Secondary analyses:
  - Handling of missing data:
## 10. Ethical Considerations
  - IRB/Ethics approval:
  - Informed consent:
  - Data privacy:
## 11. Timeline
## 12. Budget
```

## Pre-registration

Recommend pre-registration for confirmatory studies:
- **OSF**: osf.io (general)
- **ClinicalTrials.gov**: clinical trials
- **PROSPERO**: systematic reviews
- **AsPredicted**: aspredicted.org (quick)

## Tips
- Always justify sample size with power analysis
- Pre-register hypotheses and analysis plan
- Plan for 10-20% attrition in sample size calculation
- Document all deviations from protocol
- Consider pilot study for novel methods

## Error Handling

- If required inputs are missing, state exactly which fields are missing and request only the minimum additional information.
- If the task goes outside the documented scope, stop instead of guessing or silently widening the assignment.
- If execution fails, report the failure point, summarize what can still be completed safely, and provide a manual fallback.
- Do not fabricate files, citations, data, search results, or execution outcomes.

## Input Validation

This skill accepts requests that match the documented purpose of `experiment-design` and include enough context to complete the workflow safely.

Do not continue the workflow when the request is out of scope, missing a critical input, or would require unsupported assumptions. Instead respond:

> `experiment-design` only handles its documented workflow. Please provide the missing required inputs or switch to a more suitable skill.
