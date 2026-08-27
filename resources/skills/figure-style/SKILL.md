---
name: figure-style
description: 'Publication-grade figure correctness and legibility rules for final-deliverable figures — not every plot. Quick look or iterating on the analysis (EDA scatters, sanity-check histograms)? Plot plainly without this skill. Producing a figure that ships — report, paper, export, or kept artifact — load this skill first and call `apply_figure_style()` — sets a role-mapped font-size ladder, outward ticks, frameless legends, and 300-dpi output. The skill is a checklist, not a house look: data fidelity (claim-titles tested against every row, excluded data never enters summaries), label economy (floor and ceiling), color threading, chart-choice-by-data-shape, layout, and a render-then-verify QA loop (bbox collision + per-panel perceptual check). Ships helpers: apply_figure_style, set_frame, panel_letter, focal_palette, bar_with_points, strip_with_median, goodness_arrow, two_tier_label, end_of_line_labels, panel_crops. For multi-panel figures load `figure-composer`; for whole-paper figure arc load `paper-narrative`.'
license: Apache-2.0
---

# Publication-Grade Figure Rules

_A checklist for correct, legible, internally-consistent scientific figures. This
skill does not impose a visual house style — frame, font, and palette are
parameters. Once loaded, call `apply_figure_style()` before plotting._

## Open Science helper interface

For a final-deliverable Python figure, declare the registered helper on the
same `notebook_execute` request as the producer code:

```json
{ "helperModules": ["figure-style"], "code": "apply_figure_style()\n..." }
```

In shorthand, the required request field is `helperModules: ["figure-style"]`.
The host injects the public callables before the producer cell runs. Call them
directly; do not read, import, `exec`, copy, or hand-write a substitute for the
helper implementation. Never ask for an implementation path, source, or digest.
Ordinary producer imports such as `matplotlib.pyplot` and `numpy` remain visible
in the cell so its own data preparation is readable. Image inspection, judgment,
and revision reasoning stay in the Agent's existing JS control plane; there is
no Python `host` bridge.

The public interface is below. “Sequence” means an ordered Python sequence.
These helpers preserve the source implementation's ordinary Python `zip`
semantics: zipped parallel inputs stop at the shortest sequence; there is no
additional equal-length validation. Inputs passed together to NumPy or
matplotlib can still raise those libraries' normal shape/type errors. Plotting
functions import their optional dependencies only when called. A missing
`matplotlib`, `numpy`, or `scipy` (only for `ci95`) dependency surfaces its
normal Python import error; inspect or manage the bound Runtime Environment,
then retry.

- `apply_figure_style(*, frame="open", font=None, sizes=(8, 7, 6), grid=False)`
  sets matplotlib `rcParams` and returns `None`. `frame` is `"open"`, `"boxed"`,
  or `"none"`; any other value raises `ValueError`. `font` is a sans-serif family
  name or `None`; `sizes` is a three-item `(base, secondary, tick)` iterable;
  other lengths raise `ValueError`. `grid` is truthy/falsy. It sets 300-dpi saved
  output and Type-42 PDF/PS fonts.
- `set_frame(ax, style="open")` mutates and returns no value. `ax` is a
  matplotlib `Axes`; `style` has the same three frame values. An unknown style
  raises `KeyError`.
- `panel_letter(ax, letter, dx=-0.18, dy=1.02, case="lower", fontsize=None)`
  adds a bold axes-relative label and returns `None`. `letter` is string-like;
  `dx`/`dy` are axes coordinates; `case="lower"` lowercases and other values
  uppercase; `fontsize=None` uses the base rc font size plus one.
- `focal_palette(labels, focal, focal_color, other="muted", base_colors=None)`
  returns one color string per label. `labels` is a sequence of hashable labels;
  `focal` is one string or an iterable of focal labels; `focal_color` is any
  matplotlib color. `other` supports `"muted"`, `"grey"`, or `"ordinal"`;
  `base_colors` is an optional non-empty color sequence. It raises `ValueError`
  when no focal label occurs in `labels` or `other` is unsupported, and
  matplotlib raises for invalid colors.
- `bar_with_points(ax, x, ymat, labels, colors, jitter=0.08,
show_points=True, errorbar=None, point_alpha=0.5, point_size=8)` returns `ax`.
  `x` must be a one-dimensional sequence of **numeric bar positions**, such as
  `np.arange(len(labels))`; passing category strings raises `TypeError`. Put
  category names in `labels`. `labels` and `colors` are one-dimensional sequences; `ymat` is a sequence
  of numeric one-dimensional replicate sequences. Bars show means. Matplotlib
  consumes the bar inputs with its normal broadcasting/color-cycling behavior;
  the raw-point overlay pairs `x` and `ymat` with `zip`, so unmatched trailing
  entries are ignored. Tick-label count errors and other incompatible shapes
  remain normal NumPy/matplotlib errors. Every non-empty replicate sequence,
  including `n=1`, shows its raw point when
  `show_points=True`; otherwise `errorbar="sd"` or `"ci95"` draws the sample SD
  or t-distribution 95% CI. Any other non-empty `errorbar` value raises
  `ValueError` when points are hidden.
- `strip_with_median(ax, groups, values, colors=None, jitter=0.12)` returns `ax`.
  `groups` is a one-dimensional label sequence and `values` a sequence of
  numeric one-dimensional replicate sequences. `values` and `colors` are paired
  with `zip`, so an explicitly shorter sequence silently limits the plotted
  groups; `groups` still supplies all x tick labels. `colors=None` supplies one
  dark-gray color per group. Each plotted group gets jittered raw points and a
  median tick; an empty replicate sequence follows NumPy's empty-slice
  warning/NaN behavior.
- `goodness_arrow(ax, text="higher = better", loc="upper left", axis="y",
fontsize=None)` adds an upright cue and returns `None`. `loc` is `"upper left"`,
  `"upper right"`, `"lower left"`, or `"lower right"` (otherwise `KeyError`);
  `axis="y"` uses an up arrow and other values use a right arrow.
- `two_tier_label(name, meta)` returns the string `"{name}\n{meta}"`.
- `end_of_line_labels(ax, xs, ys, labels, colors=None, dx=0.01,
fontsize=None)` adds direct labels and returns `None`. `xs`, `ys`, `labels`,
  and the effective `colors` sequence are paired with `zip`; unmatched trailing
  entries are silently ignored. Each consumed x/y series must be non-empty or
  indexing its endpoint raises `IndexError`; other bad types surface normal
  matplotlib errors.
- `panel_crops(fig, dpi=None, pad_px=6, bbox_inches=None, pad_inches=None)` returns
  `{panel_letter: (x0, y0, x1, y1)}` integer crop boxes in saved-PNG pixel space,
  origin at top left. `fig` is a rendered matplotlib `Figure`; `dpi=None` and
  `bbox_inches=None` follow savefig settings. Without panel letters, keys are axes
  indices as strings. `pad_px` must be a non-negative integer. `bbox_inches` must
  be `None`, `"tight"`, or a matplotlib `Bbox`; invalid values raise `TypeError`.

## §0 Scope

**Load trigger** (same rule as the system prompt's "Publication-grade plots"
section): this skill is for **final-deliverable figures** — those shipping in a
report, paper, or export, or saved as an artifact the user will keep — not for
exploratory/intermediate plots (quick looks, EDA, sanity checks), which are
drawn plainly without it. Once loaded, "every plot" below means every plot you
render toward the deliverable.

§1–§3, §8, and §9 are **correctness** — they apply to every plot, in every
context, and have no aesthetic content. §4–§7 are **guidance** — defaults that
produce a clean result but that a deliberate alternative can override
(individual rules inside §4–§7 that state a factual/perceptual invariant — e.g.
§4.4 semantic-zero centering, §4.5 CVD, §6.9 leader anchoring — still bind). On
its own, this skill is the inner tier (make one plot good); `figure-composer`
and `paper-narrative` supply multi-panel and whole-paper context.

---

## §1 Data fidelity & self-consistency

**1.1 Excluded rows.** A row marked excluded or flagged in the source data is
either omitted entirely or drawn with a visually distinct open/hatched marker
and named in the key. It **never** enters a summary statistic plotted alongside
the included rows.

**1.2 Comparable conditions only.** Arms measured under non-comparable
conditions (different N, epoch budget, initialization, protocol) are not plotted
as visual peers. Separate them with a facet break or a marker on the label, and
state the difference once in the caption.

**1.3 Self-consistency.** Every key, threshold, and title inside the figure must
be satisfied by every plotted row. Before saving, walk each categorical outcome
label back to the rule that defines it; if a row's value contradicts its label
or the title, the figure is wrong, not the data.

**1.4 Claim-titles must be true.** A sentence-title (§5.1) is tested against
every category on the axis before rendering. If any contradicts it, qualify the
title ("on 3 of 4 pairs") or downgrade it to a description.

**1.5 State n and what was held fixed.** Every panel that draws a summary mark
states `n` and the unit of replication, and every small-multiple that holds a
variable fixed states the fixed value — in the panel or, when §2 budget is
tight, in the caption.

**1.6 Reference structure is reference.** A tree, ordering, or topology drawn as
_context_ (a scale bar, a category strip) uses an established reference, not
one inferred from the plotted data. Infer the structure only when the structure
_is_ the result.

**1.7 One number per claim.** A quantitative claim (runtime, accuracy, count)
has exactly one canonical value across every panel, caption, and the abstract.
Define what it measures and use that value everywhere.

---

## §2 Label economy — floor and ceiling

The figure shows the pattern; the **caption** carries the context. Design for a
general scientific reader, not the author.

**2.1 Floor (non-removable).** Every distinct mark, series, glyph, or comparator
must be identifiable from the figure alone. The caption explains _why it
matters_, not _what it is_. A label is non-removable if deleting it leaves a
reader asking "what is that?"; it is removable only if the question becomes "why
is that there?". Comparator labels name the thing ("prior method", "no joint
training"), never a bare role word ("baseline", "previous"). Any term a general
scientist can't parse gets a one-word gloss.

**2.2 Ceiling.** Per panel: title + axis labels + tick labels + series identity
(labeled once per row of small multiples) + at most 2–3 result annotations.
Count the strings; >6 beyond axes/ticks means you're over. The ceiling counts
_narrative_ annotations (callouts, value labels, brackets) — identity labels are
floor, not budget.

**2.3 Move to the caption:** n=, what's-held-fixed, abbreviation expansions,
non-comparable footnotes, exclusion rationale, methodological caveats.

**2.4 Titles are takeaways.** A reader seeing only the title knows what the
panel shows. "Robust to gene dropout" passes; "Fewer genes" fails. Test: read it
aloud cold — if the listener asks "fewer genes _what_?", rewrite. For a row of
small multiples that vary one thing, drop per-panel titles for one row-header.

**2.5 Value-on-mark only for the headline number** — the one a reader would
quote. Everything else is read off the axis.

**2.6 When in doubt, delete the label and re-read.** If the message survives, it
stays deleted.

---

## §3 Axes, scales, small multiples

**3.1 Axis padding.** Axis limits clear the data by ≥ one marker radius on every
side; markers and text never touch a spine. `ax.margins(0.04)` after plotting,
or extend the limit past any annotation.

**3.2 Axis breaks over wasted range.** When data occupy <40 % of an axis, break
the axis or start it at the data floor with a clear non-zero tick. Never draw a
reference line, threshold, or annotation inside a broken-axis gap — the gap has
no coordinate.

**3.3 Log axes get human-readable ticks** — `10²`, `10³`, or `1k / 10k / 100k`,
not raw exponents. **Never** draw filled bars on a log-scaled value axis (bar
length encodes ratio to an arbitrary floor); use points + median tick instead.

**3.4 Shared axes across small multiples.** A row or column of small multiples
shows tick labels once (leftmost / bottommost panel); interior panels keep ticks
but drop labels. When the panels share a y-axis and differ only by x-variable,
render them as abutting subplots (`wspace≤0.06`) with one row-header title.

**3.5 Fill the box.** A panel's data envelope occupies ≥75 % of its allotted
rectangle. If a panel's natural aspect leaves dead bands, reshape the grid
(rowspan, stacked complementary panels) — don't pad the panel.

**3.6 Direction of goodness.** When higher- or lower-is-better is not obvious
from the axis label, place a small upright cue ("higher = better") in the
margin — once per row of panels, never per panel, and never only in the caption.
A directional glyph embedded in rotated text rotates with it; set the cue
upright.

**3.7 Physical width.** A single-row figure at 300 dpi fits the venue's
double-column width. Adding a schematic or labels does not push data panels narrower than
they were before.

---

## §4 Color

**4.1 Threading.** Once a color is bound to an entity (a method, a feature, a
condition), reuse that exact color for every mark representing that entity
across the figure — line, fill, marker, text, heatmap row. Color _is_ the
cross-reference; a reader should never have to consult a legend twice.

**4.2 Limit hues.** Use as few distinct hues as the data require. When the
figure compares a focal series against others, make the focal series visually
dominant (saturated, heavier weight) and render comparators with lower visual
weight (desaturated, lighter, or thinner). The focal hue must not coincide with
any hue in a categorical palette used in the same figure. The focal series must
remain identifiable even when its mark is zero-width or coincident with others —
via outline, marker, or a light tinted band.

**4.3 Hierarchical categories.** When categories nest (groups within groups),
the outer level picks the hue family and the inner level samples within it.

**4.4 Continuous and diverging.** Use a perceptually uniform sequential map for
generic continuous values; a single-hue ramp for ordinal rank or size; a
diverging map for signed quantities — **always** centered at the semantically
meaningful zero (0, 1.0, or median), never the data midpoint.

**4.5 CVD safety.** Never rely on a red/green contrast for a binary or opposing
distinction. Any binary pair should remain distinguishable in deuteranopia
simulation. Reserve one alarm hue for error/anomaly/perturbation marks and do
not reuse it as a data-series color.

**4.6 Two palettes, two legends.** When a figure uses two categorical color
systems, each legend sits adjacent to the first panel where its palette applies.

---

## §5 Typography

**5.1 Sentence titles.** A panel title states the comparison in plain language,
regular weight, left-aligned. Metric names go on the axis, not in the title.

**5.2 Role-mapped size ladder.** A figure uses **at most three** font sizes,
mapped to _role_ not space: titles/axis-labels/series-identity at the base size;
legend/annotation text one step down; tick labels one step further. Panel
letters are the only exception (bold, larger). If a label doesn't fit at its
role's size, fix the layout or shorten the text — don't reach for an
intermediate size. `apply_figure_style(sizes=(8,7,6))` sets the ladder.

**5.3 Nomenclature.** Species, gene, and variable names that scientific
convention italicizes are italicized. Abbreviated codes inherit the rule; expand
once on first appearance.

**5.4 Magnitude suffixes.** Large counts use `k / M / B` (`4.2B`, `120 kb`),
not comma-grouped full numerals.

**5.5 Numeric annotations.** On-mark numbers use at most 2 significant figures —
unless 2-sf rounding would make two distinct rows print the same value, in which
case show the digit that separates them. Text on a filled mark reaches ≥4.5:1
contrast; if it doesn't, place the text outside the mark.

**5.6 No internal codes.** Axis labels use plain-language names; codebase
abbreviations appear only in parentheses after the readable name or in the
caption. Comparator series are labeled with what they _are_, not a role word.

**5.7 Panel letters.** Bold, top-left, outside the axes box. Case follows the
target venue's convention; `panel_letter(ax, 'a', case=...)` handles either.

---

## §6 Chart-family guidance (by data shape)

**6.1 Categorical × numeric.** Show the distribution, not just the summary.
Chart choice follows n: jittered strip with a median tick for small n; box or
violin for large n; bar + overlaid raw points or bar + interval when the mean is
the message. The `errorbar='ci95'` interval is the t-distribution 95% CI of the
mean (half-width `t_{0.975,n−1}·s/√n`), so it is valid at small n. Error bars
and raw-point overlays are alternatives — showing both is usually redundant. A
category absent from a group is marked (`n.d.`, `—`, or a hatched ghost) at its
slot; an empty slot reads as zero. A zero-valued bar
gets a visible stub or dot at the baseline.

**6.2 Single-observation categories.** A filled dot with a thin neutral stem to
the semantic zero (lollipop). Value labels sit beside the dot.

**6.3 Continuous series.** Mean-per-x as a line with markers; individual runs as
thin translucent lines or points behind it. Label each series with direct text
at the right end of its line in preference to a legend box. Summary glyphs
(per-bin mean/median) use a shape that cannot be mistaken for a raw observation,
identical across series, drawn below the raw points in z-order.

**6.4 Distributions on shared support.** When two distributions overlap heavily,
stack them as small panels with a shared x-axis or use a ridgeline. Overlay only
when the separation is visually clear.

**6.5 Matrices.** When a heatmap is small enough to read (< ~200 cells), print
the value in every cell. State the threshold once in the colorbar label.

**6.6 Embeddings.** Dimensionality-reduction scatters (UMAP, t-SNE, PCA) drop
ticks and tick labels; a small corner arrow pair names the axes. Clusters are
labeled by thin leader lines to text in surrounding whitespace.

**6.7 Paired prediction vs. observation.** Stack the two as adjacent tracks with
identical x and color; let the alignment carry the comparison. Target regions
are translucent spans registered in the legend.

**6.8 Insets.** Connect a detail inset to its source region visibly — a bounding
box with connector lines, or a translucent wedge.

**6.9 Label the extremes.** On a scatter of named observations, direct-label at
least the maximum, minimum, and any flagged point with a thin leader line. After
rendering, verify every leader endpoint terminates within one marker radius of
the row it names.

---

## §7 Layout & narrative

**7.1 Show what is measured before the result.** A reader should grasp what's
being compared before seeing the comparison — via a plain-language title, a
labeled schematic, or panel ordering. Any schematic uses the same words and
glyphs as the data panels' labels.

**7.2 One figure, one message.** A multi-panel figure has a single sentence it
is trying to make true. Every panel either states it, supports it, or bounds it;
panels that do none of these belong in supplement.

**7.3 Legends live in whitespace.** Frameless, placed inside the figure's
natural whitespace, or replaced by direct labeling. Legend entries are
swatch-first, left-aligned, and resolve every visually distinct glyph on the
panel.

**7.4 Row-band headers for nested faceting.** When small multiples are grouped,
each group gets one spanning header, not repeated per-panel titles.

**7.5 The figure arc.** For a paper: Figure 1 renders the paper's one-sentence
pitch as data — scope, not architecture. Subsequent figures cover mechanism,
evidence, robustness, application. A panel is judged against the paper's pitch,
not just its own figure's claim; content moves between figures if that's where
the story needs it. (`paper-narrative` runs this review.)

**7.6 Don't re-decorate a passing panel.** Between revision rounds, a panel that
already passes is not made more visually complex to fix nothing. Adding marks or
labels to a clean panel is a regression.

---

## §8 Anti-patterns

These are correctness failures, not style preferences:

- Red and green as opposing categories.
- Filled bars on a log-scaled value axis.
- Colorbar ticks that are evenly spaced but miss the semantic center.
- A diverging colormap whose center is the data midpoint, not the semantic zero.
- An axis title that restates the tick labels.
- Explaining the direction of goodness only in the caption.
- A "reference" line drawn at a value that is itself one of the plotted points.
- An excluded row that enters a plotted summary statistic.
- A leader line whose nearest mark is not the row it labels.

---

## §9 Render-then-verify

After `fig.savefig(...)`, before `save_artifacts`:

**9.1 Geometric (bbox) check.**

```python
# A previous notebook cell may have closed the pyplot manager after capturing
# its inline image. Reattach the headless canvas when reusing that Figure.
if not hasattr(fig.canvas, "get_renderer"):
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    FigureCanvasAgg(fig)
fig.canvas.draw()
r = fig.canvas.get_renderer()
texts = [(t, t.get_window_extent(r)) for t in fig.findobj(mpl.text.Text)
         if t.get_text().strip() and t.get_visible()]
spines = [(s, s.get_window_extent(r)) for ax in fig.axes
          for s in ax.spines.values() if s.get_visible()]
ticklabels = {ax: set(ax.get_xticklabels(which='both') + ax.get_yticklabels(which='both'))
              for ax in fig.axes}
overlaps  = [(a, b) for i, (a, ba) in enumerate(texts) for b, bb in texts[i+1:] if ba.overlaps(bb)]
overlaps += [(t, s) for t, bt in texts for s, bs in spines
             if bt.overlaps(bs) and t not in ticklabels[s.axes]]
# assert: overlaps == [] and every text box lies within fig.bbox
```

Overlap is defined between _visible_ boxes, and a tick label sitting on its own
spine is not a finding. Fix (move, shorten, stagger) and re-save until clean.
This canvas guard makes the check safe when plotting and QA run in separate
`notebook_execute` cells; do not require them to share one cell.

**9.2 Perceptual check.** The bbox check is geometric, not perceptual — it will
not catch a low-contrast label, a leader that crosses three others, or a series
color mistakable for another. Crop the saved PNG to each panel and look:

```python
fig.savefig("figure.png")
for letter, box in panel_crops(fig).items():
    print(letter, box)  # pass each box to the Agent's image-viewing tool
```

For each crop: Is every glyph and mark legible against its background? Does the
smallest plotted element have a stroke or stub? Do any leaders cross? Could any
series color be mistaken for another? Does the legend sit beside what it keys?
A perceptual defect that passes §9.1 is still a defect.

---

_When in doubt: fewer hues, more direct labels, raw data over summary stats, and
state what is being measured before showing the result._
