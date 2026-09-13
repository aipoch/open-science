# Differential-expression decisions and regression examples

The primary-agent analysis instructions require the model to establish data scale,
sample identities, independent replication, pairing/batches and contrast direction
before choosing a differential-expression method. Frequentist discovery uses a
declared multiple-testing family; untestable results remain unknown. These are
generation instructions, not a statistical validator of arbitrary Notebook code.

## Corrected Welch example

[`bh-r-welch-volcano.fixture.json`](../src/main/notebook/bh-r-welch-volcano.fixture.json)
is a corrected companion to the historical reported Welch replay. Its numerical
cells are exercised by
[`welch-volcano-statistics.test.R`](../src/main/notebook/welch-volcano-statistics.test.R).
The input is assumed to be verified log2 expression from independent biological
replicates. This is not a recommended raw-count RNA-seq pipeline, and choosing a
Welch test still requires checking the study design and model assumptions.

- The `compute` cell retains all genes, raw p-values, test failure messages and BH-adjusted
  p-values. It requires every planned observation within a comparison to be finite:
  if any is missing or infinite, that gene's effect, p-value and adjusted p-value
  for that comparison remain missing with an exclusion reason. No observations
  are silently removed or imputed, and the other comparison is evaluated
  independently. This is a conservative example policy, not a universal missing-data
  recommendation; methods using available observations require an explicit
  missingness assumption and consistent observations for effects and tests.
  Each cohort contrast is a separately declared family. The total number
  of planned gene tests, including failed tests, is passed to `p.adjust`; failed
  p-values stay missing. Adjustment precedes effect-size or label selection.
- The `classify` cell uses strict `padj < 0.05` and `abs(log2FC) > log2(1.5)` thresholds.
  Each contrast retains its own decision, including `NA` when untestable. Joint
  membership requires both contrasts to be testable; an untestable comparator
  cannot produce an A-only or B-only label. Top labels rank by adjusted p-values.
- The `plot` cell labels the figure as an effect comparison, names the BH threshold, and
  distinguishes untestable genes with a cross when coordinates are finite. The
  previous PNG is removed before updating results, preventing a failed rerun in
  a writable output directory from leaving an old image beside a new table.
  The complete result table is exported before loading plotting packages or saving
  the image, retaining genes that cannot be plotted. Only finite paired effects
  enter the plot; axes have a positive minimum range and an empty panel explicitly
  states when no finite paired effects are available. Neither a threshold
  crossing in one cohort only nor opposite effect signs prove an interaction.

The BH guarantee depends on valid p-values and its dependence assumptions. The
declared per-contrast adjustment does not claim joint FDR control across all
contrasts, intersections, or an additional observed-effect-size subset. To claim
an effect exceeds a biological threshold, choose a suitable threshold hypothesis
test rather than interpreting a post-hoc effect-size filter as that test.

The historical `reported-r-welch-volcano.fixture.json` is intentionally unchanged:
it reproduces a previously reported dependency/failure-recovery scenario. Its
nominal p-value classification is **not** a scientifically endorsed analysis
template. Passing `dependency-analysis.welch-volcano.test.ts` or reproducing its
PNG certifies neither statistical assumptions nor biological conclusions.

## Dependency compatibility

`dependency-analysis.bh-welch-volcano.test.ts` runs the corrected cells through the
actual source and file-access analyzers, and reconstructs the complete producer
chain from the historical input preparation to the new plot and CSV. Individual
cell assertions target the three corrected cells; unchanged preparation cells
remain covered by the historical regression suite. The output
projection must be `clear`; both exported paths must be recognized. The historical
replay has its own unchanged regression test.

The corrected compute cell explicitly converts extracted test results to numeric
and character vectors. This retains missing values and error messages while
making the return types provable by the existing analyzer. No generic function
whitelist or uncertainty rule has been relaxed.

## Numerical acceptance checks

Use an existing R installation with base R/stats; contributed packages are not
needed for the numerical checks. From the repository root, set
`OPEN_SCIENCE_TEST_R_ENV` to its installation prefix (containing `bin/Rscript` or
`bin/Rscript.exe`), then run:

```sh
npm test -- src/main/notebook/welch-volcano-statistics.test.ts
```

The portable test run skips this check when the runtime prefix is absent. The
real R lane in `.github/workflows/runtime-certification.yml` explicitly runs it
with its provisioned R environment. When `RUN_KERNEL=1`, a missing R prefix fails
test collection instead of silently skipping. That lane is advisory in Nightly
and blocking on manual dispatch; it is not a universal pull-request gate. It executes
the companion's actual cells, checking real Welch results and failed constant
genes, missing/nonfinite observations in either arm of either comparison,
single-gene matrix/data-frame inputs without dimension loss, hand-calculated
BH values with a missing test, nominal-versus-adjusted
decisions, both directions of missing comparator evidence, threshold boundaries,
and eligible plot labels. Deterministic substituted p-values isolate one BH
check; the earlier check uses the real `stats::t.test`.

## Plot and export acceptance checks

`welch-volcano-plot.test.ts` executes all three corrected cells in real R with
`ggplot2` and `ggrepel`. Set `RUN_KERNEL=1` and `OPEN_SCIENCE_TEST_R_ENV`, then run:

```sh
npm test -- src/main/notebook/welch-volcano-statistics.test.ts src/main/notebook/welch-volcano-plot.test.ts
```

The real runtime CI lane explicitly includes both tests and provisions these
packages. The plot test skips outside `RUN_KERNEL=1`; inside that mode, a missing
R prefix or plotting dependency fails instead of skipping. It renders five PNGs
(normal, no discoveries, all missing effects, nonfinite effects, and all zero
effects), checks the plotted rows and labels, and reads back every exported column
using the declared table schema. Injected dependency-loading and graphics-device
failures during a rerun must still leave the complete new CSV and no previous PNG.
PNG headers and dimensions are checked
in addition to building the actual ggplot. This test certifies R rendering and
export behavior, not the full application kernel/provenance replay.

The runtime prompt delivery is covered by
`src/main/acp/session-presentation-policy.test.ts`. These tests cannot establish
model compliance in a live task. A real-data end-to-end evaluation must separately
check the model/design, count normalization, sample alignment, full gene universe,
reported decisions and figures against independently computed reference results.

## Live generation acceptance

A bounded live evaluation on 2026-09-13 sent the exact baseline and patched
behavior appends to the existing native Codex subscription runtime. Two fresh
responses covered seven bundled scenarios each. The generated base R code was
executed against four independent input variants: baseline passed 55 of 62
assertions, while patched passed all 62. The baseline converted missing test
membership to FALSE when the effect failed its threshold (`NA & FALSE` in R);
the patched response assigned membership only to finite, testable results.
Both responses otherwise handled BH, supplied adjustments and the qualitative
scenarios appropriately. No statistical reliability or causal improvement is
established by one response per condition. The CLI used its default model; the
capture did not expose an exact model ID. This was instruction/generation testing,
not execution/rendering/replay in a built application.

Prompt delivery tests establish instruction placement, not model adherence. Run
these scenarios in a fresh primary Session of a build from this worktree, using
a configured model and an isolated evaluation directory. Record the source
revision and working-tree diff hash, model/provider, prompt, generated code,
execution logs and exported tables/figures. Do not count the hand-authored
companion as model output, or an installed older build as the patched build.

| Scenario given to the model                                                           | Acceptance evidence                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified log2 expression; independent replicates; request genome-wide Welch discovery | BH uses the full declared family before effect-size selection; exported raw and adjusted values match an independent R calculation.         |
| Valid full-family `padj` already supplied; request a plot                             | Supplied values are retained without a second BH adjustment; plotted hits, labels and table decisions agree.                                |
| One contrast is significant; the other has a failed test                              | The failed contrast remains missing with a reason; it cannot support an A-only/B-only or specificity claim.                                 |
| A table contains only prefiltered nominal hits                                        | The model does not claim recovered genome-wide FDR from that subset; it requests the full family or labels the limitation.                  |
| Explicit exploratory request to display nominal p-values                              | Nominal results are labeled exploratory rather than FDR-controlled.                                                                         |
| Raw RNA-seq counts with paired donors                                                 | The model checks count input and pairing and selects a suitable count/design model; it does not apply this example's log2 Welch assumption. |
| No discoveries, or every test fails                                                   | No top-N discoveries are invented; exported missing evidence is retained and the figure does not imply significance.                        |

Review the actual generated code and execute it against independent references;
keyword presence alone is insufficient. Compare the same prompts against the
baseline build and report failures as well as passes. Even a passing live sample
does not enforce correctness for arbitrary future code. This change has no
runtime statistical validator; that would require a separate, defined input and
analysis contract rather than generic rejection based on source keywords.

## Statistical references

- [R p.adjust documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/p.adjust.html)
- [DESeq2 input, design and interaction guidance](https://bioconductor.org/packages/release/bioc/vignettes/DESeq2/inst/doc/DESeq2.html)
