# Assumption Checking Procedures

## Overview

Statistical tests rely on specific assumptions. This guide provides systematic procedures for checking these assumptions and actions to take when assumptions are violated.

## 1. Normality Assumption

### 1.1 Visual Methods

#### Histogram with Normal Overlay
```python
import matplotlib.pyplot as plt
import numpy as np
from scipy import stats

def plot_normality_check(data, title="Normality Check"):
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    
    # Histogram
    axes[0].hist(data, bins='auto', density=True, alpha=0.7)
    mu, sigma = np.mean(data), np.std(data)
    x = np.linspace(min(data), max(data), 100)
    axes[0].plot(x, stats.norm.pdf(x, mu, sigma), 'r-', lw=2)
    axes[0].set_title(f'Histogram (μ={mu:.2f}, σ={sigma:.2f})')
    
    # Q-Q Plot
    stats.probplot(data, dist="norm", plot=axes[1])
    axes[1].set_title('Q-Q Plot')
    
    plt.suptitle(title)
    plt.tight_layout()
    return fig
```

#### Q-Q Plot Interpretation
- **Points on diagonal line**: Normal distribution
- **S-shape**: Skewness present
- **Inverted U**: Light-tailed distribution
- **U-shape**: Heavy-tailed distribution

### 1.2 Statistical Tests

#### Shapiro-Wilk Test
**Best for:** n < 50

```python
from scipy import stats

statistic, p_value = stats.shapiro(data)
# H0: Data comes from normal distribution
# If p < 0.05, reject normality
```

**Properties:**
- Most powerful normality test
- Sensitive to small sample sizes
- Recommended for n < 50

#### Kolmogorov-Smirnov Test
**Best for:** Larger samples, comparing to theoretical distribution

```python
statistic, p_value = stats.kstest(data, 'norm', args=(mean, std))
```

**Note:** Lass powerful than Shapiro-Wilk for normality testing.

#### Anderson-Darling Test
**Best for:** Detecting tail deviations

```python
result = stats.anderson(data, dist='norm')
# Compare statistic to critical values at different significance levels
```

### 1.3 When to Care About Normality

| Test | Normality Importance | Sample Size Robustness |
|------|---------------------|----------------------|
| T-Test | Moderate | Robust with n > 30 per group |
| ANOVA | Moderate-High | Robust with balanced n > 30 |
| Regression | High (residuals) | Depends on design |

### 1.4 Actions if Normality Violated

1. **Transform data:**
   - Log transformation (right skew)
   - Square root transformation (count data)
   - Box-Cox transformation (find optimal λ)

2. **Use non-parametric alternative:**
   - Mann-Whitney U instead of t-test
   - Kruskal-Wallis instead of ANOVA

3. **Use robust methods:**
   - Trimmed means
   - Bootstrap confidence intervals

## 2. Homogeneity of Variance (Homoscedasticity)

### 2.1 Levene's Test
**Recommended for:** Non-normal distributions

```python
from scipy import stats

statistic, p_value = stats.levene(group1, group2, group3)
# H0: Equal variances across groups
# If p < 0.05, variances are unequal
```

### 2.2 Bartlett's Test
**Recommended for:** Normal distributions (more powerful)

```python
statistic, p_value = stats.bartlett(group1, group2, group3)
```

**Caution:** Sensitive to non-normality.

### 2.3 Fligner-Killeen Test
**Recommended for:** Non-normal data, very robust

```python
statistic, p_value = stats.fligner(group1, group2, group3)
```

### 2.4 Actions if Homogeneity Violated

| Test | Alternative |
|------|-------------|
| Independent T-Test | Welch's T-Test |
| One-Way ANOVA | Welch's ANOVA |
| Repeated Measures | Use mixed models |

## 3. Independence Assumption

### 3.1 Checking Independence

**Study Design Review:**
- Were subjects randomly assigned?
- Are measurements truly independent?
- Any clustering/nesting present?

### 3.2 Durbin-Watson Test (for regression/time series)
```python
from statsmodels.stats.stattools import durbin_watson

dw_stat = durbin_watson(residuals)
# ~2: No autocorrelation
# < 1.5 or > 2.5: Possible autocorrelation
```

### 3.3 Actions if Independence Violated

- Use mixed-effects models
- Include cluster-robust standard errors
- Use generalized estimating equations (GEE)

## 4. Linearity (for Regression/Correlation)

### 4.1 Visual Check
```python
# Residuals vs Fitted plot
plt.scatter(fitted_values, residuals)
plt.axhline(y=0, color='r', linestyle='--')
```

**Patterns:**
- **Random scatter**: Linearity satisfied
- **Curved pattern**: Non-linearity present
- **Funnel shape**: Heteroscedasticity

### 4.2 Actions if Non-linear

- Polynomial terms
- Transform variables
- Use non-linear regression
- Splines/GAMs

## 5. Sphericity (Repeated Measures)

### 5.1 Mauchly's Test
```r
# In R
library(car)
model <- aov(outcome ~ time + Error(subject/time), data = df)
mauchly.test(model)
```

### 5.2 Corrections
- Greenhouse-Geisser (ε < 0.75)
- Huynh-Feldt (ε > 0.75)

## 6. Outlier Detection

### 6.1 Methods

#### Z-Score Method
```python
z_scores = np.abs(stats.zscore(data))
outliers = np.where(z_scores > 3)[0]  # |z| > 3
```

#### IQR Method
```python
Q1 = np.percentile(data, 25)
Q3 = np.percentile(data, 75)
IQR = Q3 - Q1
outliers = data[(data < Q1 - 1.5*IQR) | (data > Q3 + 1.5*IQR)]
```

#### Modified Z-Score (using MAD)
```python
median = np.median(data)
mad = np.median(np.abs(data - median))
modified_z = 0.6745 * (data - median) / mad
outliers = np.where(np.abs(modified_z) > 3.5)[0]
```

### 6.2 Actions for Outliers

1. **Investigate**: Data entry error?
2. **Report**: Analyze with and without outliers
3. **Transform**: Reduce outlier impact
4. **Robust methods**: Use resistant statistics

## 7. Multicollinearity (Regression)

### 7.1 Variance Inflation Factor (VIF)
```python
from statsmodels.stats.outliers_influence import variance_inflation_factor

vif_data = pd.DataFrame()
vif_data["Variable"] = X.columns
vif_data["VIF"] = [variance_inflation_factor(X.values, i) for i in range(X.shape[1])]
```

**Interpretation:**
- VIF = 1: No correlation
- VIF 1-5: Moderate correlation
- VIF > 5: High correlation (problematic)
- VIF > 10: Severe multicollinearity

### 7.2 Actions
- Remove correlated predictors
- Combine into composite variable
- Use PCA
- Ridge regression

## 8. Comprehensive Assumption Check Function

```python
def comprehensive_assumption_check(data, groups=None, test_type="ttest"):
    """
    Comprehensive assumption checking for common statistical tests.
    
    Parameters:
    -----------
    data : array-like
        Data to check (or list of arrays for multiple groups)
    groups : list of array-like, optional
        Separate groups for group comparisons
    test_type : str
        Type of test planned ("ttest", "anova", "regression")
    
    Returns:
    --------
    dict : Assumption check results
    """
    results = {}
    
    if groups is not None:
        # Multiple groups
        all_data = np.concatenate(groups)
        
        # Normality per group
        results['normality'] = {}
        for i, group in enumerate(groups):
            stat, pval = stats.shapiro(group)
            results['normality'][f'group_{i+1}'] = {
                'statistic': stat,
                'p_value': pval,
                'passed': pval > 0.05
            }
        
        # Homogeneity
        stat, pval = stats.levene(*groups)
        results['homogeneity'] = {
            'test': 'Levene',
            'statistic': stat,
            'p_value': pval,
            'passed': pval > 0.05
        }
        
        # Sample sizes
        results['sample_sizes'] = [len(g) for g in groups]
    
    else:
        # Single sample or paired differences
        stat, pval = stats.shapiro(data)
        results['normality'] = {
            'statistic': stat,
            'p_value': pval,
            'passed': pval > 0.05
        }
    
    return results
```

## 9. Quick Reference: Assumption Violation Actions

| Assumption | Test | If Violated |
|------------|------|-------------|
| Normality | Shapiro-Wilk | Non-parametric test or transformation |
| Homogeneity | Levene's | Welch's test or Brown-Forsythe |
| Independence | Design review | Mixed models or GEE |
| Linearity | Residual plots | Polynomial/spline terms |
| Sphericity | Mauchly's | GG/HF corrections |
| Multicollinearity | VIF | Remove/combine variables |

## References

1. Tabachnick, B. G., & Fidell, L. S. (2019). Using Multivariate Statistics (7th ed.).
2. Field, A. (2018). Discovering Statistics Using IBM SPSS Statistics (5th ed.).
3. Wilcox, R. R. (2017). Introduction to Robust Estimation and Hypothesis Testing (4th ed.).
