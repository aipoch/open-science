# AIPOCH Open-Science Benchmark Results

Prepared October 15, 2026. Results are historical snapshots from AIPOCH's September 29 and October 12 reports, plus the existing August 31 BiomniBench-DA report. This document summarizes reported evaluations; it is not a new benchmark run or an independent reproduction.

The README uses three contributor-supplied figures. See the [figure provenance and snapshot notes](figure-notes.md) for unreconciled public-reference differences and image provenance; the figures do not supersede the dated source reports.

AIPOCH Open-Science's reported results cover finding research papers, implementing scientific procedures, and conducting research with progressively less methodological guidance. They evaluate configured agent systems: the model, specialists, Skills, tools, and execution environment together.

For sharing research evidence, AIPOCH Open-Science supports portable [`.science` packages](https://aipoch.com/docs/guides/research-packages/) containing selected conversation branches, file versions, Notebook records, and verification evidence. This capability does not establish that any of the benchmark runs below has a published `.science` package.

## Results at a glance

| Evaluation               | AIPOCH Open-Science          | Scope                                                | Reporting snapshot |
| ------------------------ | ---------------------------- | ---------------------------------------------------- | ------------------ |
| BiomniBench-DA Public 50 | 79.05 dual-judge mean        | Internal 50-task evaluation                          | August 31, 2026    |
| LitQA2-FullText-Search   | 1.0000 recall@30; 10/10      | Local validation; 3 repeats reported                 | September 29, 2026 |
| PaperFinding             | 0.4554 reported aggregate F1 | Local validation; 66 queries                         | October 12, 2026   |
| ASI-Bench B1             | 79.35 / 100                  | Local seed31415; 59 scored tasks; 3 repeats reported | September 29, 2026 |
| ASI-Bench B2             | 56.11 / 100                  | Local seed31415; 3 repeats reported                  | September 29, 2026 |
| ASI-Bench B3             | 59.67 / 100                  | Local seed31415; 60 tasks per run; 3-run mean        | October 12, 2026   |
| ASI-Bench B4             | 59.46 / 100                  | Local seed31415; 60 tasks per run; 3-run mean        | October 12, 2026   |

All results are self-reported local/internal evaluations. References to the highest score below describe the entries retained in the dated reports, not an official leaderboard position or a current exhaustive ranking.

## Literature retrieval: LitQA2-FullText-Search

This [AstaBench task](https://allenai.org/asta/bench) evaluates retrieval of papers likely to contain the answer to a scientific question. A hit means that the target paper appears among the first 30 returned results. It does not mean that the agent answered the underlying question correctly.

AIPOCH Open-Science reported **10 target-paper hits out of 10 validation queries**, giving **100% recall@30**, using `deepseek-v4-flash` at `max` reasoning effort. The configuration included six AI specialist roles and 15 Skills. Roles covered semantic retrieval, entity/evidence location, evidence review, citation auditing, data analysis, and conclusion review. Three local repeats were reported; individual repeat scores were not included in the supplied summary.

| Entry                      | Validation recall@30 |
| -------------------------- | -------------------- |
| AIPOCH Open-Science, local | **1.00**             |
| Asta Paper Finder          | 0.80                 |
| You.com Search API         | 0.50                 |
| ReAct                      | 0.10                 |

These are the four same-split entries retained in the September report. AIPOCH's reported score is **20 percentage points** above the highest of the three public validation references. Models and tools differ across entries.

The report also lists 26 public test results on a separate 75-query split. Their highest value, 90.67%, must not be used to claim a same-question victory over the test leaderboard. The local result concerns ten validation queries, a small development split.

## Literature retrieval: PaperFinding

PaperFinding evaluates retrieval from semantic requests, clues identifying a specific paper, and metadata constraints. It is a different task and metric from LitQA2.

AIPOCH Open-Science used `deepseek-v4-flash` / `max`, six configured specialists, 16 imported Skills, and Asta Scientific Corpus retrieval. The report records **66 validation queries** and a **0.4554 aggregate score**, labeled `adjusted_f1` locally.

| Query category | Queries | Reported score | Reported per-query metric |
| -------------- | ------- | -------------- | ------------------------- |
| Semantic       | 48      | 0.3308         | `adjusted_f1`             |
| Specific paper | 10      | 0.8286         | `standard_f1`             |
| Metadata       | 8       | 0.7359         | `standard_f1`             |

Specific-paper and metadata retrieval scored higher than semantic retrieval in this run. The report notes three zero-score semantic queries and one zero-score specific query. No three-run average is claimed for this evaluation.

| Entry                      | Validation score reported in the October comparison |
| -------------------------- | --------------------------------------------------- |
| AIPOCH Open-Science, local | **0.4554**                                          |
| Rasyn IRIS                 | 0.3862                                              |
| Asta Paper Finder          | 0.3796                                              |
| You.com Search API         | 0.0656                                              |
| ReAct                      | 0.0294                                              |

The source report identifies four public `1.0.0/validation` records with 66 samples each, using `score_paper_finder/adjusted_f1_micro_avg`. The local value is numerically **0.0692** above the largest public value retained in that report.

**Metric reconciliation remains open.** The supplied local summary names its aggregate `adjusted_f1` and describes different per-query metrics by category; it does not provide enough aggregation detail to independently establish equivalence with `adjusted_f1_micro_avg`. Same-split coverage alone does not establish identical scoring. This table reproduces the report's comparison rather than certifying a fully matched ranking.

The separate 33-entry test comparison uses different questions and is contextual only. The report's additional 12/20 objective-recall figure is omitted from the main results because its sample-selection definition is not supplied.

## Scientific execution and autonomy: ASI-Bench B1–B4

[ASI-Bench](https://github.com/apexin-ai/ASI-Bench) contains 60 project-level tasks across 11 scientific and engineering fields. Four prompt conditions change how much guidance is supplied:

| Level | Guidance supplied                                               | Capability tested                                |
| ----- | --------------------------------------------------------------- | ------------------------------------------------ |
| B1    | Methods, formulas, and full procedure                           | Implement and execute the supplied plan          |
| B2    | Method and constraints without a full procedure                 | Organize the method into a working workflow      |
| B3    | Goal, data, constraints, and outputs without a specified method | Choose methods and execute the workflow          |
| B4    | B3 plus factually correct but unnecessary background            | Complete autonomous research despite distraction |

Scores measure graded output quality on a 100-point scale; they are not percentages of tasks solved perfectly.

### Local comparisons with Codex

The reports record `gpt-6-astra` / `xhigh` for both systems in the following local comparisons.

| Level | AIPOCH Open-Science | Codex | Difference in displayed scores | Coverage and repeats                                                                    |
| ----- | ------------------- | ----- | ------------------------------ | --------------------------------------------------------------------------------------- |
| B1    | **79.35**           | 74.78 | +4.57 points                   | AIPOCH: 59 scored tasks; 3 local repeats reported for both                              |
| B2    | **56.11**           | 56.09 | +0.02 points                   | 3 local repeats reported for both; exact scored-task count not specified in the summary |
| B3    | **59.67**           | 58.12 | +1.55 points                   | Each system: 60 tasks per run; mean of 3 local runs                                     |
| B4    | **59.46**           | 55.45 | +4.01 points                   | Each system: 60 tasks per run; mean of 3 local runs                                     |

B1 excluded one of the standard 60 tasks because the source report attributes it to an official scorer error. The affected task ID and exact scorer version are not included in that summary. B1 and B2 report three repeats and aggregate scores, but do not disclose individual run values or fully specify the repeat aggregation. B3 and B4 explicitly report three-run means.

The B2 numerical gap is only 0.02 points. None of these differences is established as statistically significant by the supplied summaries, which do not include per-run variance or confidence intervals.

### System configuration

B1 used 11 categories of domain specialists with Skills; B2 retained that specialist/Skills configuration. The roles covered areas including astronomy, bioinformatics, statistics, chemistry, robotics, and physical simulation.

B3 and B4 used AIPOCH Open-Science **v0.32.0**, its built-in Codex subscription integration, **12 frozen specialists**, and delegation. Main-session and specialist reasoning effort were `xhigh`. Tasks were scheduled serially, with a 3,600-second model-answer budget and a 7,200-second outer scoring budget. The Codex comparison used **v0.156.1**. Both local systems used the reported substitute judge `deepseek-flash` / `high` with thinking enabled. That judge identifier is retained as written in the source; its mapping to a pinned provider model revision is not supplied.

Shared model and reasoning-effort labels do not imply that all other settings were identical. These results do not isolate the causal contribution of specialists, Skills, or delegation.

### Published reference results

| Level | Highest published reference retained in the source report | Reference score | AIPOCH's numerical difference |
| ----- | --------------------------------------------------------- | --------------- | ----------------------------- |
| B1    | Claude Code × Claude Opus 5 / Max                         | 72.29           | +7.06                         |
| B2    | Codex × GPT-5.6 Sol / ultra                               | 49.57           | +6.54                         |
| B3    | Codex × GPT-5.6 Sol / ultra                               | 51.60           | +8.07                         |
| B4    | Codex × GPT-5.6 Sol / ultra                               | 50.41           | +9.05                         |

These are differences between displayed scores under different evaluation conditions. B1's comparison contains 24 entries, B2's 23, and B3/B4's 23 each. The latter two contain 21 published references and two local results. Their source snapshot was read October 10, 2026 at 11:18 Beijing time, with its Space publication note dated September 6. These are historical comparison snapshots, not claims about today's leaderboard.

All AIPOCH ASI-Bench results here use public **seed31415**. Official submission uses **seed42** with private reference answers and official scoring. The seeds share task frameworks but can differ in input data and parameters; scorer and judge conditions also vary. See the official [scoring contract](https://github.com/apexin-ai/ASI-Bench/blob/main/docs/guide/how-scoring-works.md).

AIPOCH's B4 mean is 0.21 points below its B3 mean; Codex's corresponding difference is 2.67. This describes two reported means. It does not establish run-to-run stability or a general robustness guarantee.

## Existing result: BiomniBench-DA Public 50

The existing [AIPOCH report](https://aipoch.com/blog/open-science-biomnibench-da), dated August 31, 2026, records an internal 50-task run with `gpt-5.6-sol` / `xhigh`. Its **79.05** score is the equal-weight mean of **81.04** from the Gemini 3.1 Pro judge and **77.06** from the DeepSeek v4-pro judge.

It was the highest displayed value in the report's collected comparison. Judge coverage differed among entries, and the report did not provide a public listing for the AIPOCH run. Retain the score while describing its internal status; an unqualified “#1 on BiomniBench-DA Public 50” heading can imply official recognition beyond the evidence.

## Evidence, review, and reproducibility

The two Feishu summaries are the source of AIPOCH's six additional results and their retained comparison values. Their claims are reported here with their original scope. This preparation did not rerun evaluations, inspect raw run artifacts, independently re-extract every public comparison entry, or verify formal acceptance of an AIPOCH submission.

To support independent review, a public evidence release should include run IDs, task coverage and exclusions, per-run/per-task scores, pinned system/scorer/judge versions, prompts and specialist/Skill manifests, aggregation code, and the relevant outputs and execution records. PaperFinding particularly needs the local aggregation matched against the public metric.

Where available, selected evidence can be shared in a `.science` package. Imported sessions remain read-only; they do not execute code or restore credentials. Side Chat conversations and private reading bookmarks are excluded, files depend on export selection, and received verification records describe the sender's checks rather than proving a rerun on the receiving computer.

## Sources

- [AIPOCH September 29 results summary](https://hwtgofuh6ud.feishu.cn/wiki/Kl5cwupToi901BkEaQacM1V2n7e), revision 147, read October 15, 2026. Covers LitQA2 and ASI-Bench B1/B2. Feishu access may be required.
- [AIPOCH October 12 results summary](https://hwtgofuh6ud.feishu.cn/wiki/XZSbw7L87ibjQUk98qJcuqFUnKh), revision 93, read October 15, 2026. Covers PaperFinding and ASI-Bench B3/B4. Feishu access may be required.
- [Ai2 AstaBench task descriptions](https://allenai.org/asta/bench) and [evaluation/submission guidance](https://github.com/allenai/asta-bench), checked October 15, 2026.
- [ASI-Bench repository](https://github.com/apexin-ai/ASI-Bench) and [scoring contract](https://github.com/apexin-ai/ASI-Bench/blob/main/docs/guide/how-scoring-works.md), checked October 15, 2026.
- [AIPOCH BiomniBench-DA report](https://aipoch.com/blog/open-science-biomnibench-da), published August 31, 2026; checked October 15, 2026.
