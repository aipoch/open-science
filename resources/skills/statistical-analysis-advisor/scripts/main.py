#!/usr/bin/env python3
"""
Statistical Analysis Advisor
Recommends appropriate statistical methods based on dataset characteristics.
"""

from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple, Any
from enum import Enum
import math


class DataType(Enum):
    CONTINUOUS = "continuous"
    CATEGORICAL = "categorical"
    ORDINAL = "ordinal"


class Distribution(Enum):
    NORMAL = "normal"
    NON_NORMAL = "non-normal"
    UNKNOWN = "unknown"


@dataclass
class TestRecommendation:
    """Result container for statistical test recommendations."""
    recommended_test: str
    alternative_tests: List[str]
    assumptions: List[str]
    warnings: List[str]
    rationale: str


@dataclass
class AssumptionCheck:
    """Result container for assumption checking."""
    assumption: str
    test_name: str
    satisfied: bool
    details: str
    recommendation: str


@dataclass
class PowerAnalysis:
    """Result container for power analysis."""
    effect_size: float
    sample_size: int
    alpha: float
    power: float
    interpretation: str


class StatisticalAdvisor:
    """
    Intelligent advisor for statistical test selection and experimental design.
    """
    
    def __init__(self):
        self.test_decision_tree = self._build_decision_tree()
        self.assumption_tests = self._load_assumption_tests()
    
    def _build_decision_tree(self) -> Dict:
        """Build the statistical test decision tree."""
        return {
            DataType.CONTINUOUS: {
                2: {  # Two groups
                    True: {  # Independent
                        Distribution.NORMAL: "Independent Samples T-Test",
                        Distribution.NON_NORMAL: "Mann-Whitney U Test",
                        Distribution.UNKNOWN: "Mann-Whitney U Test (robust)"
                    },
                    False: {  # Paired
                        Distribution.NORMAL: "Paired Samples T-Test",
                        Distribution.NON_NORMAL: "Wilcoxon Signed-Rank Test",
                        Distribution.UNKNOWN: "Wilcoxon Signed-Rank Test (robust)"
                    }
                },
                "3+": {  # Three or more groups
                    True: {  # Independent
                        Distribution.NORMAL: "One-Way ANOVA",
                        Distribution.NON_NORMAL: "Kruskal-Wallis H Test",
                        Distribution.UNKNOWN: "Kruskal-Wallis H Test (robust)"
                    },
                    False: {  # Repeated measures
                        Distribution.NORMAL: "Repeated Measures ANOVA",
                        Distribution.NON_NORMAL: "Friedman Test",
                        Distribution.UNKNOWN: "Friedman Test (robust)"
                    }
                }
            },
            DataType.CATEGORICAL: {
                2: {
                    True: {
                        "default": "Chi-Square Test of Independence",
                        "expected_low": "Fisher's Exact Test"
                    }
                },
                "3+": {
                    True: {
                        "default": "Chi-Square Test of Independence"
                    }
                }
            },
            DataType.ORDINAL: {
                2: {
                    True: {
                        "default": "Mann-Whitney U Test"
                    },
                    False: {
                        "default": "Wilcoxon Signed-Rank Test"
                    }
                },
                "3+": {
                    True: {
                        "default": "Kruskal-Wallis H Test"
                    },
                    False: {
                        "default": "Friedman Test"
                    }
                }
            }
        }
    
    def _load_assumption_tests(self) -> Dict:
        """Load assumption checking procedures."""
        return {
            "independent_ttest": {
                "normality": {
                    "test": "Shapiro-Wilk",
                    "alternative": "Kolmogorov-Smirnov",
                    "action_if_violated": "Use Mann-Whitney U Test"
                },
                "homogeneity": {
                    "test": "Levene's Test",
                    "alternative": "Bartlett's Test",
                    "action_if_violated": "Use Welch's T-Test"
                },
                "independence": {
                    "check": "Study design review",
                    "action_if_violated": "Non-independent data requires mixed models"
                }
            },
            "paired_ttest": {
                "normality": {
                    "test": "Shapiro-Wilk on differences",
                    "action_if_violated": "Use Wilcoxon Signed-Rank Test"
                },
                "independence_of_pairs": {
                    "check": "Study design review",
                    "action_if_violated": "Requires specialized paired analysis"
                }
            },
            "anova": {
                "normality": {
                    "test": "Shapiro-Wilk (per group)",
                    "action_if_violated": "Consider transformation or Kruskal-Wallis"
                },
                "homogeneity": {
                    "test": "Levene's Test",
                    "action_if_violated": "Use Welch's ANOVA or Brown-Forsythe"
                },
                "independence": {
                    "check": "Study design review",
                    "action_if_violated": "Requires mixed-effects models"
                }
            },
            "chi_square": {
                "expected_frequencies": {
                    "rule": "All expected counts ≥ 5",
                    "alternative_rule": "No more than 20% below 5",
                    "action_if_violated": "Use Fisher's Exact Test"
                },
                "independence": {
                    "check": "Study design review",
                    "action_if_violated": "Use McNemar's Test for paired data"
                }
            }
        }
    
    def recommend_test(
        self,
        data_type: str,
        groups: int,
        independent: bool,
        distribution: str = "unknown",
        paired: Optional[bool] = None,
        expected_cell_counts: Optional[int] = None
    ) -> TestRecommendation:
        """
        Recommend appropriate statistical test based on data characteristics.
        
        Args:
            data_type: "continuous", "categorical", or "ordinal"
            groups: Number of groups (2 or more)
            independent: Whether samples are independent
            distribution: "normal", "non-normal", or "unknown"
            paired: Whether samples are paired (overrides independent if set)
            expected_cell_counts: For chi-square, minimum expected count
        
        Returns:
            TestRecommendation with recommended test and alternatives
        """
        # Normalize inputs
        data_type_enum = DataType(data_type.lower())
        dist_enum = Distribution(distribution.lower())
        
        # Handle paired override
        if paired is not None:
            independent = not paired
        
        # Determine group key
        group_key = 2 if groups == 2 else "3+"
        
        warnings = []
        alternative_tests = []
        
        # Special handling for categorical data
        if data_type_enum == DataType.CATEGORICAL:
            if expected_cell_counts is not None and expected_cell_counts < 5:
                recommended = "Fisher's Exact Test"
                alternative_tests = ["Chi-Square with Yates' correction", "Bootstrap methods"]
                warnings.append("Low expected cell counts - Fisher's Exact Test preferred")
            else:
                recommended = "Chi-Square Test of Independence"
                alternative_tests = ["Fisher's Exact Test (if sparse)", "G-test"]
            
            assumptions = [
                "Independence of observations",
                "Expected frequency ≥ 5 in at least 80% of cells",
                "Mutual exclusivity of categories"
            ]
            
            rationale = f"Chi-square tests are appropriate for categorical data with {groups} groups."
            
        else:
            # Lookup in decision tree
            try:
                tree = self.test_decision_tree[data_type_enum][group_key][independent]
                if isinstance(tree, dict) and Distribution.NORMAL in tree:
                    recommended = tree.get(dist_enum, tree[Distribution.UNKNOWN])
                else:
                    recommended = tree.get("default", "Consultation recommended")
                
                # Determine alternatives
                if data_type_enum == DataType.CONTINUOUS:
                    if groups == 2:
                        if independent:
                            alternative_tests = ["Welch's T-Test", "Yuen's Trimmed Mean T-Test"]
                        else:
                            alternative_tests = ["Permutation Test", "Bootstrap CI"]
                    else:  # 3+ groups
                        if independent:
                            alternative_tests = ["Welch's ANOVA", "Brown-Forsythe Test"]
                        else:
                            alternative_tests = ["Mixed-effects Model", "GEE"]
                
                assumptions = self._get_assumptions_for_test(recommended)
                rationale = self._get_rationale(recommended, data_type_enum, groups, independent, dist_enum)
                
            except KeyError:
                recommended = "Consultation recommended"
                alternative_tests = []
                assumptions = []
                warnings.append("Complex design - specialized consultation advised")
                rationale = "The specified design requires specialized statistical consultation."
        
        # Add sample size warnings
        if groups >= 2 and data_type_enum == DataType.CONTINUOUS:
            warnings.extend(self._check_sample_size_recommendations(groups))
        
        return TestRecommendation(
            recommended_test=recommended,
            alternative_tests=alternative_tests,
            assumptions=assumptions,
            warnings=warnings,
            rationale=rationale
        )
    
    def _get_assumptions_for_test(self, test_name: str) -> List[str]:
        """Get assumptions list for a specific test."""
        test_key = test_name.lower().replace(" ", "_").replace("-", "_")
        
        assumption_map = {
            "independent": "independent_ttest",
            "paired": "paired_ttest",
            "anova": "anova",
            "chi_square": "chi_square",
            "mann_whitney": "independent_ttest",  # Uses same assumptions check
            "wilcoxon": "paired_ttest",
            "kruskal_wallis": "anova"
        }
        
        for key, value in assumption_map.items():
            if key in test_key:
                test_info = self.assumption_tests.get(value, {})
                return [f"{k}: {v.get('test', v.get('check', 'Required'))}" 
                        for k, v in test_info.items()]
        
        return ["Consult references/assumption_tests.md for detailed requirements"]
    
    def _get_rationale(
        self,
        test_name: str,
        data_type: DataType,
        groups: int,
        independent: bool,
        distribution: Distribution
    ) -> str:
        """Generate rationale for test recommendation."""
        parts = []
        
        parts.append(f"Selected {test_name} based on:")
        parts.append(f"- Data type: {data_type.value}")
        parts.append(f"- Groups: {groups}")
        parts.append(f"- Sample relationship: {'Independent' if independent else 'Paired/Related'}")
        parts.append(f"- Distribution: {distribution.value}")
        
        if "mann-whitney" in test_name.lower() or "wilcoxon" in test_name.lower() or "kruskal" in test_name.lower():
            parts.append("\nNon-parametric test chosen due to non-normal distribution or ordinal data.")
            parts.append("These tests are robust to outliers and don't assume normality.")
        
        if "welch" in test_name.lower():
            parts.append("\nWelch's test used for unequal variances.")
        
        return "\n".join(parts)
    
    def _check_sample_size_recommendations(self, groups: int) -> List[str]:
        """Check and return sample size recommendations."""
        warnings = []
        
        if groups == 2:
            warnings.append("Minimum n=20 per group recommended for robust normality tests")
        else:
            warnings.append(f"Minimum n=30 per group recommended for ANOVA with {groups} groups")
        
        return warnings
    
    def check_assumptions(
        self,
        test_type: str,
        sample_sizes: Optional[List[int]] = None,
        normality_pvalues: Optional[List[float]] = None,
        levene_pvalue: Optional[float] = None
    ) -> List[AssumptionCheck]:
        """
        Check statistical assumptions for a given test.
        
        Args:
            test_type: Type of test being considered
            sample_sizes: List of sample sizes per group
            normality_pvalues: P-values from normality tests
            levene_pvalue: P-value from Levene's homogeneity test
        
        Returns:
            List of AssumptionCheck results
        """
        results = []
        
        test_key = test_type.lower().replace(" ", "_")
        
        # Check normality
        if normality_pvalues is not None:
            for i, pval in enumerate(normality_pvalues):
                satisfied = pval > 0.05
                results.append(AssumptionCheck(
                    assumption=f"Normality (Group {i+1})",
                    test_name="Shapiro-Wilk",
                    satisfied=satisfied,
                    details=f"p-value = {pval:.4f}",
                    recommendation="Use non-parametric alternative" if not satisfied else "Assumption satisfied"
                ))
        
        # Check homogeneity
        if levene_pvalue is not None:
            satisfied = levene_pvalue > 0.05
            results.append(AssumptionCheck(
                assumption="Homogeneity of Variance",
                test_name="Levene's Test",
                satisfied=satisfied,
                details=f"p-value = {levene_pvalue:.4f}",
                recommendation="Use Welch's test" if not satisfied else "Assumption satisfied"
            ))
        
        # Sample size check
        if sample_sizes is not None:
            for i, n in enumerate(sample_sizes):
                satisfied = n >= 30
                results.append(AssumptionCheck(
                    assumption=f"Adequate Sample Size (Group {i+1})",
                    test_name="Rule of Thumb",
                    satisfied=satisfied,
                    details=f"n = {n}",
                    recommendation="Consider power analysis" if not satisfied else "Sample size adequate"
                ))
        
        return results
    
    def calculate_power(
        self,
        effect_size: float,
        alpha: float = 0.05,
        sample_size: Optional[int] = None,
        power: Optional[float] = None,
        groups: int = 2
    ) -> PowerAnalysis:
        """
        Calculate statistical power or required sample size.
        
        Args:
            effect_size: Cohen's d (for t-tests) or f (for ANOVA)
            alpha: Significance level (default 0.05)
            sample_size: Sample size per group (if known)
            power: Desired power (if calculating sample size)
            groups: Number of groups
        
        Returns:
            PowerAnalysis with results
        
        Note:
            Either sample_size OR power must be provided (not both)
        """
        if sample_size is None and power is None:
            raise ValueError("Either sample_size or power must be provided")
        
        if sample_size is not None and power is not None:
            raise ValueError("Provide only sample_size OR power, not both")
        
        # Approximate power calculation using normal approximation
        # For more precise calculations, use specialized libraries like statsmodels
        
        if power is not None:
            # Calculate required sample size
            # Using simplified formula: n = 2*((Z_(1-alpha/2) + Z_power)/effect_size)^2 for two groups
            z_alpha = 1.96  # for alpha=0.05
            z_power = {0.8: 0.84, 0.9: 1.28, 0.95: 1.645}.get(power, 0.84)
            
            n_per_group = int(2 * ((z_alpha + z_power) / effect_size) ** 2)
            
            if groups > 2:
                # Rough adjustment for ANOVA
                n_per_group = int(n_per_group * (1 + 0.1 * (groups - 2)))
            
            calculated_power = power
            calculated_n = n_per_group
            interpretation = f"To achieve {power*100:.0f}% power with effect size {effect_size}, need n={n_per_group} per group."
            
        else:
            # Calculate achieved power
            z_alpha = 1.96
            ncp = effect_size * math.sqrt(sample_size / 2)  # non-centrality parameter
            
            # Approximate power using normal distribution
            import statistics
            calculated_power = 1 - statistics.NormalDist().cdf(z_alpha - ncp)
            calculated_power = min(calculated_power, 0.999)  # Cap at 99.9%
            
            calculated_n = sample_size
            
            if calculated_power >= 0.8:
                interpretation = f"Power ({calculated_power:.1%}) is adequate (≥80%)."
            elif calculated_power >= 0.6:
                interpretation = f"Power ({calculated_power:.1%}) is marginal. Consider increasing sample size."
            else:
                interpretation = f"Power ({calculated_power:.1%}) is insufficient. Increase sample size or effect size."
        
        return PowerAnalysis(
            effect_size=effect_size,
            sample_size=calculated_n,
            alpha=alpha,
            power=calculated_power,
            interpretation=interpretation
        )
    
    def get_effect_size_interpretation(self, effect_size: float, metric: str = "cohens_d") -> str:
        """
        Interpret effect size magnitude.
        
        Args:
            effect_size: Calculated effect size value
            metric: Type of effect size metric
        
        Returns:
            Interpretation string
        """
        interpretations = {
            "cohens_d": {
                (0, 0.2): "Negligible",
                (0.2, 0.5): "Small",
                (0.5, 0.8): "Medium",
                (0.8, float('inf')): "Large"
            },
            "eta_squared": {
                (0, 0.01): "Small",
                (0.01, 0.06): "Medium",
                (0.06, 0.14): "Large",
                (0.14, float('inf')): "Very Large"
            },
            "cramers_v": {
                (0, 0.1): "Small",
                (0.1, 0.3): "Medium",
                (0.3, 0.5): "Large",
                (0.5, float('inf')): "Very Large"
            }
        }
        
        metric_interp = interpretations.get(metric, interpretations["cohens_d"])
        
        for (lower, upper), label in metric_interp.items():
            if lower <= abs(effect_size) < upper:
                return f"{label} effect size ({metric} = {effect_size:.3f})"
        
        return f"Effect size = {effect_size:.3f} (interpretation not available)"
    
    def compare_tests(self, scenario: Dict[str, Any]) -> Dict[str, TestRecommendation]:
        """
        Compare multiple test options for a given scenario.
        
        Args:
            scenario: Dictionary with data characteristics
        
        Returns:
            Dictionary mapping test names to recommendations
        """
        recommendations = {}
        
        # Parametric option
        if scenario.get("distribution") == "normal":
            rec = self.recommend_test(**scenario)
            recommendations["parametric"] = rec
        
        # Non-parametric option
        non_normal_scenario = scenario.copy()
        non_normal_scenario["distribution"] = "non-normal"
        rec = self.recommend_test(**non_normal_scenario)
        recommendations["non_parametric"] = rec
        
        # Robust option
        robust_scenario = scenario.copy()
        robust_scenario["distribution"] = "unknown"
        rec = self.recommend_test(**robust_scenario)
        recommendations["robust"] = rec
        
        return recommendations


def main():
    """Example usage and testing."""
    advisor = StatisticalAdvisor()
    
    # Example 1: Two-group comparison with normal distribution
    print("=" * 60)
    print("Example 1: Two-group independent comparison")
    print("=" * 60)
    
    rec = advisor.recommend_test(
        data_type="continuous",
        groups=2,
        independent=True,
        distribution="normal"
    )
    
    print(f"Recommended: {rec.recommended_test}")
    print(f"Alternatives: {', '.join(rec.alternative_tests)}")
    print(f"Rationale:\n{rec.rationale}")
    print(f"Assumptions:")
    for assumption in rec.assumptions:
        print(f"  - {assumption}")
    
    # Example 2: Power analysis
    print("\n" + "=" * 60)
    print("Example 2: Power Analysis")
    print("=" * 60)
    
    power_result = advisor.calculate_power(
        effect_size=0.5,
        alpha=0.05,
        sample_size=30
    )
    
    print(f"Effect size: {power_result.effect_size}")
    print(f"Sample size: {power_result.sample_size}")
    print(f"Achieved power: {power_result.power:.1%}")
    print(f"Interpretation: {power_result.interpretation}")
    
    # Example 3: Sample size calculation
    print("\n" + "=" * 60)
    print("Example 3: Sample Size Calculation")
    print("=" * 60)
    
    size_result = advisor.calculate_power(
        effect_size=0.5,
        alpha=0.05,
        power=0.8
    )
    
    print(f"For 80% power with effect size 0.5:")
    print(f"Required sample size: {size_result.sample_size} per group")
    print(f"Total N: {size_result.sample_size * 2}")
    
    # Example 4: Effect size interpretation
    print("\n" + "=" * 60)
    print("Example 4: Effect Size Interpretation")
    print("=" * 60)
    
    for es in [0.1, 0.4, 0.7, 1.2]:
        interp = advisor.get_effect_size_interpretation(es, "cohens_d")
        print(f"Cohen's d = {es}: {interp}")


if __name__ == "__main__":
    main()
