# Power Analysis Guide

## Overview

Statistical power is the probability of correctly rejecting a false null hypothesis (1 - β). This guide covers power analysis for common statistical tests and sample size determination.

## 1. Key Concepts

### 1.1 Components of Power Analysis

| Component | Symbol | Description |
|-----------|--------|-------------|
| Significance Level | α | Probability of Type I error (typically 0.05) |
| Power | 1-β | Probability of detecting true effect (typically 0.80) |
| Effect Size | d, f, r | Standardized magnitude of effect |
| Sample Size | n | Number of observations |

### 1.2 Effect Size Conventions

#### Cohen's d (for t-tests)
```
d = (M1 - M2) / SD_pooled
```

| Effect Size | d | Interpretation |
|-------------|---|----------------|
| Small | 0.2 | Barely perceptible |
| Medium | 0.5 | Observable difference |
| Large | 0.8 | Obvious difference |

#### Cohen's f (for ANOVA)
```
f = σ_means / σ_within
```

| Effect Size | f | η² |
|-------------|---|-----|
| Small | 0.1 | 0.01 |
| Medium | 0.25 | 0.06 |
| Large | 0.4 | 0.14 |

#### Cramér's V (for Chi-Square)
```
V = sqrt(χ² / (n * (k - 1)))
```

| Effect Size | V |
|-------------|---|
| Small | 0.1 |
| Medium | 0.3 |
| Large | 0.5 |

## 2. Power Calculation Methods

### 2.1 Analytical Approach

#### Two-Sample T-Test
```python
import scipy.stats as stats
import numpy as np

def power_ttest(effect_size, n_per_group, alpha=0.05):
    """Calculate power for independent t-test."""
    # Non-centrality parameter
    ncp = effect_size * np.sqrt(n_per_group / 2)
    
    # Critical t-value
    df = 2 * n_per_group - 2
    t_crit = stats.t.ppf(1 - alpha/2, df)
    
    # Power calculation
    power = 1 - stats.nct.cdf(t_crit, df, ncp) + stats.nct.cdf(-t_crit, df, ncp)
    return power
```

#### Sample Size Formula (Two-Sample T-Test)
```python
def sample_size_ttest(effect_size, power=0.8, alpha=0.05):
    """Calculate required sample size per group."""
    z_alpha = stats.norm.ppf(1 - alpha/2)
    z_beta = stats.norm.ppf(power)
    
    n = 2 * ((z_alpha + z_beta) / effect_size) ** 2
    return int(np.ceil(n))
```

### 2.2 Simulation Approach

```python
def power_by_simulation(effect_size, n_per_group, n_simulations=10000, alpha=0.05):
    """
    Estimate power through Monte Carlo simulation.
    More flexible for complex designs.
    """
    significant_results = 0
    
    for _ in range(n_simulations):
        # Simulate data under alternative hypothesis
        group1 = np.random.normal(0, 1, n_per_group)
        group2 = np.random.normal(effect_size, 1, n_per_group)
        
        # Perform test
        _, p_value = stats.ttest_ind(group1, group2)
        
        if p_value < alpha:
            significant_results += 1
    
    return significant_results / n_simulations
```

## 3. Practical Power Analysis Examples

### 3.1 Two-Sample T-Test

```python
from statsmodels.stats.power import TTestIndPower

power_analysis = TTestIndPower()

# Calculate power
effect_size = 0.5  # Medium effect
alpha = 0.05
n_per_group = 30

power = power_analysis.power(effect_size=effect_size, 
                             nobs1=n_per_group, 
                             alpha=alpha)
print(f"Power: {power:.2%}")

# Calculate sample size
required_n = power_analysis.solve_power(effect_size=effect_size,
                                         power=0.8,
                                         alpha=alpha)
print(f"Required n per group: {int(np.ceil(required_n))}")
```

### 3.2 One-Way ANOVA

```python
from statsmodels.stats.power import FTestAnovaPower

power_analysis = FTestAnovaPower()

# Calculate power for 3 groups
effect_size = 0.25  # f = 0.25 (medium)
alpha = 0.05
n_per_group = 20
k_groups = 3

power = power_analysis.power(effect_size=effect_size,
                             nobs=n_per_group,
                             alpha=alpha,
                             k_groups=k_groups)

# Calculate sample size
required_n = power_analysis.solve_power(effect_size=effect_size,
                                        power=0.8,
                                        alpha=alpha,
                                        k_groups=k_groups)
```

### 3.3 Chi-Square Test

```python
def power_chi_square(effect_size, n, df=1, alpha=0.05):
    """
    Approximate power for chi-square test.
    effect_size: Cramér's V or phi coefficient
    """
    # Non-centrality parameter
    ncp = n * effect_size ** 2
    
    # Critical value
    crit = stats.chi2.ppf(1 - alpha, df)
    
    # Power
    power = 1 - stats.ncx2.cdf(crit, df, ncp)
    return power
```

## 4. Sample Size Determination

### 4.1 Planning Table: T-Test

| Effect Size | Power = 0.80 | Power = 0.90 | Power = 0.95 |
|-------------|--------------|--------------|--------------|
| Small (d=0.2) | 393/group | 526/group | 651/group |
| Medium (d=0.5) | 64/group | 86/group | 105/group |
| Large (d=0.8) | 26/group | 34/group | 42/group |

### 4.2 Planning Table: ANOVA (3 groups)

| Effect Size | Power = 0.80 | Power = 0.90 |
|-------------|--------------|--------------|
| Small (f=0.1) | 109/group | 145/group |
| Medium (f=0.25) | 18/group | 24/group |
| Large (f=0.4) | 8/group | 10/group |

### 4.3 Accounting for Attrition

```python
def adjust_for_attrition(n_required, attrition_rate=0.20):
    """
    Adjust sample size for expected dropout.
    
    Parameters:
    -----------
    n_required : int
        Required completers
    attrition_rate : float
        Expected dropout rate (0.20 = 20%)
    
    Returns:
    --------
    int : Adjusted enrollment target
    """
    n_enroll = int(np.ceil(n_required / (1 - attrition_rate)))
    return n_enroll

# Example
n_needed = 64  # Completers needed
n_enroll = adjust_for_attrition(n_needed, attrition_rate=0.20)
print(f"Enroll {n_enroll} to get {n_needed} completers with 20% attrition")
```

## 5. Power Curves

```python
import matplotlib.pyplot as plt

def plot_power_curve(effect_sizes, sample_sizes, alpha=0.05):
    """Generate power curves for different sample sizes."""
    fig, ax = plt.subplots(figsize=(10, 6))
    
    for n in sample_sizes:
        powers = []
        for es in effect_sizes:
            power = power_analysis.power(effect_size=es, nobs1=n, alpha=alpha)
            powers.append(power)
        ax.plot(effect_sizes, powers, label=f'n={n}', marker='o')
    
    ax.axhline(y=0.8, color='r', linestyle='--', label='Target Power (80%)')
    ax.set_xlabel('Effect Size (Cohen\'s d)')
    ax.set_ylabel('Power')
    ax.set_title('Power Curves for Independent T-Test')
    ax.legend()
    ax.grid(True, alpha=0.3)
    
    return fig

# Generate curve
effect_sizes = np.arange(0.1, 1.0, 0.1)
sample_sizes = [20, 30, 50, 100]
plot_power_curve(effect_sizes, sample_sizes)
```

## 6. Post-Hoc Power Analysis

**Warning:** Post-hoc power analysis is controversial. Better to report:
- Observed effect size
- Confidence interval
- p-value

If you must calculate observed power:

```python
def observed_power_from_pvalue(p_value, n_per_group, alpha=0.05):
    """
    Calculate observed power from obtained p-value.
    Not recommended for general use.
    """
    # Back-calculate effect size from p-value
    df = 2 * n_per_group - 2
    t_observed = stats.t.ppf(1 - p_value/2, df)
    
    # Approximate effect size
    d_observed = t_observed * np.sqrt(2/n_per_group)
    
    # Calculate power at observed effect
    power = power_analysis.power(effect_size=d_observed, 
                                 nobs1=n_per_group, 
                                 alpha=alpha)
    return power, d_observed
```

## 7. Sensitivity Analysis

```python
def sensitivity_analysis(n_per_group, min_power=0.8, alpha=0.05):
    """
    Determine minimum detectable effect size for given sample.
    """
    # Binary search for effect size that achieves target power
    low, high = 0.01, 2.0
    
    while high - low > 0.001:
        mid = (low + high) / 2
        power = power_analysis.power(effect_size=mid, 
                                     nobs1=n_per_group, 
                                     alpha=alpha)
        if power < min_power:
            low = mid
        else:
            high = mid
    
    return mid

# Example: What effect size can we detect with n=50?
mde = sensitivity_analysis(50, min_power=0.8)
print(f"Minimum detectable effect size (d): {mde:.2f}")
```

## 8. Multiplicity Corrections

When conducting multiple tests, adjust sample size calculations:

```python
def bonferroni_adjusted_alpha(alpha, n_tests):
    """Conservative correction for multiple comparisons."""
    return alpha / n_tests

def fdr_adjusted_sample_size(n_original, n_tests, alpha=0.05):
    """
    Approximate adjustment for FDR control.
    Conservative approach: increase sample size by factor.
    """
    # Benjamini-Hochberg adjustment factor (approximate)
    adjustment = np.sum(1 / np.arange(1, n_tests + 1))
    return int(np.ceil(n_original * adjustment))
```

## 9. Equivalence and Non-Inferiority

```python
def sample_size_equivalence(margin, sd, alpha=0.05, power=0.8):
    """
    Sample size for equivalence test (TOST).
    
    Parameters:
    -----------
    margin : float
        Equivalence margin
    sd : float
        Standard deviation
    """
    # Two one-sided tests approach
    z_alpha = stats.norm.ppf(1 - alpha)
    z_beta = stats.norm.ppf(power)
    
    n = 2 * ((z_alpha + z_beta) * sd / margin) ** 2
    return int(np.ceil(n))
```

## 10. Reporting Guidelines

Include in methods section:

```
Sample size was determined based on a power analysis for a 
independent samples t-test. With an expected medium effect 
size (Cohen's d = 0.5), α = 0.05, and desired power of 0.80, 
a minimum of 64 participants per group (128 total) was required. 
To account for an anticipated 15% attrition rate, we aimed to 
enroll 150 participants.
```

## 11. Software Comparison

| Software | Function/Package | Pros | Cons |
|----------|-----------------|------|------|
| Python | statsmodels | Free, flexible | Requires coding |
| R | pwr package | Comprehensive | Learning curve |
| G*Power | GUI application | User-friendly | Limited customization |
| Stata | power command | Integrated | Commercial |

## References

1. Cohen, J. (1988). Statistical Power Analysis for the Behavioral Sciences (2nd ed.).
2. Faul, F., et al. (2009). G*Power 3.1. Behavior Research Methods, 41(4), 1149-1160.
3. Perugini, M., et al. (2018). A Practical Primer To Power Analysis.
4. Lakens, D. (2021). Sample Size Justification. PsyArXiv.
