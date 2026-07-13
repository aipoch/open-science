# Statistical Tests Guide

## Overview

This guide provides detailed criteria for selecting appropriate statistical tests based on research design, data characteristics, and distributional assumptions.

## 1. Two-Group Comparisons

### 1.1 Independent Samples

#### T-Test (Independent)
**Use when:**
- Continuous outcome variable
- Two independent groups
- Approximately normal distribution
- Homogeneity of variances (can use Welch's if violated)

**Formula:**
```
t = (M1 - M2) / sqrt(((s1²/n1) + (s2²/n2)))
```

**Assumptions:**
1. Independence of observations
2. Normality (robust to violations with n > 30 per group)
3. Homogeneity of variance (use Welch's t-test if violated)

#### Mann-Whitney U Test (Wilcoxon Rank-Sum)
**Use when:**
- Ordinal or continuous non-normal data
- Two independent groups
- Assumption of normality severely violated
- Outliers present

**Advantages:**
- Robust to outliers
- No distributional assumptions
- Works with ordinal data

**Disadvantages:**
- Less powerful than t-test when normality holds
- Tests different null hypothesis (distribution equality vs. mean equality)

### 1.2 Paired/Related Samples

#### Paired T-Test
**Use when:**
- Same subjects measured twice
- Matched pairs design
- Differences are approximately normal

**Formula:**
```
t = M_diff / (SD_diff / sqrt(n))
```

#### Wilcoxon Signed-Rank Test
**Use when:**
- Paired design with non-normal differences
- Ordinal paired data
- Robust alternative to paired t-test

## 2. Three or More Groups (ANOVA Family)

### 2.1 One-Way ANOVA
**Use when:**
- Continuous outcome
- Three or more independent groups
- Normal distribution within each group
- Homogeneity of variances

**Formula:**
```
F = MS_between / MS_within
```

**Post-hoc tests:**
- Tukey HSD (all pairwise comparisons)
- Bonferroni (conservative, planned comparisons)
- Scheffé (complex comparisons)

### 2.2 Welch's ANOVA
**Use when:**
- Heterogeneous variances across groups
- More robust than standard ANOVA

### 2.3 Kruskal-Wallis H Test
**Use when:**
- Non-normal distributions
- Ordinal data with 3+ groups
- Non-parametric alternative to one-way ANOVA

**Post-hoc:** Dunn's test with Bonferroni correction

### 2.4 Repeated Measures ANOVA
**Use when:**
- Same subjects measured at multiple time points
- Assesses within-subject effects

**Assumptions:**
1. Sphericity (Mauchly's test)
2. Normality of residuals
3. No significant outliers

**Correction for sphericity violation:**
- Greenhouse-Geisser (conservative)
- Huynh-Feldt (less conservative)

### 2.5 Friedman Test
**Use when:**
- Repeated measures with non-normal data
- Non-parametric alternative to repeated measures ANOVA

## 3. Categorical Data Analysis

### 3.1 Chi-Square Test of Independence
**Use when:**
- Two categorical variables
- Independent observations
- Expected frequencies ≥ 5

**Formula:**
```
χ² = Σ((O - E)² / E)
```

**Requirements:**
- No more than 20% of cells with expected count < 5
- No cells with expected count < 1

### 3.2 Fisher's Exact Test
**Use when:**
- Small sample sizes
- Expected cell counts < 5
- 2×2 contingency tables

**Advantages:**
- Exact p-values (not approximate)
- Valid for any sample size

**Limitations:**
- Computationally intensive for large tables

### 3.3 McNemar's Test
**Use when:**
- Paired categorical data
- Before/after design with binary outcome
- Matched case-control studies

## 4. Correlation Analysis

### 4.1 Pearson Correlation
**Use when:**
- Two continuous variables
- Linear relationship
- Bivariate normality

### 4.2 Spearman's Rank Correlation
**Use when:**
- Ordinal data
- Non-linear monotonic relationship
- Outliers present
- Non-normal distributions

### 4.3 Kendall's Tau
**Use when:**
- Small sample sizes
- Tied ranks present
- More robust than Spearman

## 5. Regression Analysis

### 5.1 Linear Regression
**Use when:**
- Continuous outcome
- Linear relationship with predictors
- Independent errors

**Assumptions:**
1. Linearity
2. Independence of errors
3. Homoscedasticity
4. Normality of residuals
5. No multicollinearity

### 5.2 Logistic Regression
**Use when:**
- Binary outcome variable
- Predicting probability of event

### 5.3 Poisson Regression
**Use when:**
- Count data as outcome
- Rate/ratio outcomes

## 6. Decision Tree Summary

```
Data Type?
├── Continuous
│   ├── 2 Groups
│   │   ├── Independent → T-Test / Mann-Whitney
│   │   └── Paired → Paired T-Test / Wilcoxon
│   └── 3+ Groups
│       ├── Independent → ANOVA / Kruskal-Wallis
│       └── Repeated → RM-ANOVA / Friedman
├── Categorical
│   ├── 2×2 Table → Chi-Square / Fisher's Exact
│   └── Larger Table → Chi-Square
└── Ordinal
    └── Non-parametric tests (Mann-Whitney, Kruskal-Wallis)
```

## 7. Effect Size Measures

| Test | Effect Size | Small | Medium | Large |
|------|-------------|-------|--------|-------|
| T-Test | Cohen's d | 0.2 | 0.5 | 0.8 |
| ANOVA | η² (eta-squared) | 0.01 | 0.06 | 0.14 |
| ANOVA | f | 0.1 | 0.25 | 0.4 |
| Chi-Square | Cramér's V | 0.1 | 0.3 | 0.5 |
| Correlation | r | 0.1 | 0.3 | 0.5 |

## 8. Software Implementation

### Python
```python
import scipy.stats as stats

# T-Test
stats.ttest_ind(group1, group2)
stats.ttest_ind(group1, group2, equal_var=False)  # Welch's

# ANOVA
stats.f_oneway(group1, group2, group3)

# Non-parametric
stats.mannwhitneyu(group1, group2)
stats.kruskal(group1, group2, group3)

# Chi-Square
stats.chi2_contingency(contingency_table)
```

### R
```r
# T-Test
t.test(outcome ~ group, data = df)
t.test(outcome ~ group, data = df, var.equal = FALSE)  # Welch's

# ANOVA
aov(outcome ~ group, data = df)

# Non-parametric
wilcox.test(outcome ~ group, data = df)
kruskal.test(outcome ~ group, data = df)

# Chi-Square
chisq.test(table)
fisher.test(table)
```

## References

1. Field, A. (2018). Discovering Statistics Using IBM SPSS Statistics (5th ed.). SAGE.
2. Cohen, J. (1988). Statistical Power Analysis for the Behavioral Sciences (2nd ed.).
3. Wilcox, R. R. (2012). Introduction to Robust Estimation and Hypothesis Testing.
