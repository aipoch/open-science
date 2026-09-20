
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.path import Path
import matplotlib.patches as patches
# -----------------------------------------------------------------------------
# Load & prepare data
# -----------------------------------------------------------------------------
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
genes   = [f"Gene{i}" for i in range(1, 7)]
samples = [f"S{i}"     for i in range(1, 11)]
gene_totals   = df.groupby('from')['value'].sum().reindex(genes).values
sample_totals = df.groupby('to')['value'].sum().reindex(samples).values
gene_max      = gene_totals.max()
sample_max    = sample_totals.max()
# -----------------------------------------------------------------------------
# Angle layout (0° = 12 o'clock, increases clockwise)
# -----------------------------------------------------------------------------
gap_deg   = 1.5
n_seg     = len(genes) + len(samples)
usable    = 360.0 - gap_deg * n_seg
gene_frac   = gene_totals   / gene_totals.sum()
sample_frac = sample_totals / sample_totals.sum()
gene_span   = usable * 0.5 * gene_frac
sample_span = usable * 0.5 * sample_frac
def cum_starts(spans, start0):
    out, acc = [], start0
    for s in spans:
        out.append(acc)
        acc += s + gap_deg
    return np.array(out), acc
gene_starts, _   = cum_starts(gene_span, 0.0)
sample_starts, _ = cum_starts(sample_span, 180.0)
gene_ends   = gene_starts   + gene_span
sample_ends = sample_starts + sample_span
# Helper: angle (deg from 12 o'clock CW) -> (x, y) at radius r
def pol2cart(theta_deg, r):
    t = np.deg2rad(theta_deg)
    return r * np.sin(t), r * np.cos(t)
# -----------------------------------------------------------------------------
# Colors
# -----------------------------------------------------------------------------
# Genes: a warm/cool gradient (the reference image shows a varied palette)
gene_palette = ['#F4A582', '#D6604D', '#4393C3', '#1F4E79',
                '#B2182B', '#053061'][:len(genes)]
sample_palette = ['#762A83', '#9970AB', '#C2A5CF', '#E7D4E8',
                  '#D9F0D3', '#A6DBA0', '#5AAE61', '#1B7837',
                  '#B8E186', '#66BD63'][:len(samples)]
gene_colors   = dict(zip(genes,   gene_palette))
sample_colors = dict(zip(samples, sample_palette))
# -----------------------------------------------------------------------------
# Per-pair sub-segments inside each arc (used to draw the ribbons)
# For every (gene, sample) pair we know what arc-length is consumed.
# We accumulate these in the same order the gene arcs and sample arcs are drawn.
# -----------------------------------------------------------------------------
# Build lookup
df_idx = df.set_index(['from', 'to'])['value'].to_dict()
# Within each gene, samples contribute in the same order as the sample arcs.
gene_sub = []   # list of (sample_name, value)
for g in genes:
    row = [(s, df_idx[(g, s)]) for s in samples]
    gene_sub.append(row)
# Within each sample, genes contribute in the same order as the gene arcs.
sample_sub = []
for s in samples:
    row = [(g, df_idx[(g, s)]) for g in genes]
    sample_sub.append(row)
# -----------------------------------------------------------------------------
# Drawing
# -----------------------------------------------------------------------------
fig, ax = plt.subplots(figsize=(10, 10), dpi=120)
ax.set_xlim(-1.45, 1.45)
ax.set_ylim(-1.45, 1.45)
ax.set_aspect('equal')
ax.axis('off')
fig.patch.set_facecolor('white')
R_OUTER = 1.00    # outer edge of colored bar
R_INNER = 0.92    # inner edge of colored bar
R_TICK_OUT = 0.92 # where ticks start (inside the bar)
R_TICK_IN  = 0.86 # where ticks end (pointing inward)
R_LABEL    = 1.10 # label radius
R_RIBBON_OUT = 0.92  # where ribbons attach at outer side
R_RIBBON_IN  = 0.20  # where ribbons converge toward center
# 1) Colored arc bars for genes ------------------------------------------------
for i, g in enumerate(genes):
    a0, a1 = gene_starts[i], gene_ends[i]
    color = gene_colors[g]
    wedge = mpatches.Wedge((0, 0), R_OUTER, 90 - a1, 90 - a0,
                           width=R_OUTER - R_INNER,
                           facecolor=color, edgecolor='white',
                           linewidth=1.2, zorder=3)
    ax.add_patch(wedge)
# 2) Colored arc bars for samples ---------------------------------------------
for i, s in enumerate(samples):
    a0, a1 = sample_starts[i], sample_ends[i]
    color = sample_colors[s]
    wedge = mpatches.Wedge((0, 0), R_OUTER, 90 - a1, 90 - a0,
                           width=R_OUTER - R_INNER,
                           facecolor=color, edgecolor='white',
                           linewidth=1.2, zorder=3)
    ax.add_patch(wedge)
# 3) Tick marks at 0, 30, 60 (relative to that segment's max) ---------------
def draw_ticks(start_deg, span_deg, vmax, color='black'):
    """Draw three small tick lines + tiny labels at 0, 30, 60 (% of vmax)."""
    tick_vals = [0, 30, 60]
    for tv in tick_vals:
        a = start_deg + (tv / 60.0) * span_deg
        x0, y0 = pol2cart(a, R_TICK_IN)
        x1, y1 = pol2cart(a, R_TICK_OUT)
        ax.plot([x0, x1], [y0, y1], color=color, lw=1.0, zorder=4)
        # tiny label inside, slightly past the inner end
        lx, ly = pol2cart(a, R_TICK_IN - 0.04)
        ax.text(lx, ly, str(tv), ha='center', va='center',
                fontsize=7, color='black', zorder=5)
for i, g in enumerate(genes):
    draw_ticks(gene_starts[i], gene_span[i], gene_max)
for i, s in enumerate(samples):
    draw_ticks(sample_starts[i], sample_span[i], sample_max)
# 4) Outer labels -------------------------------------------------------------
def label_arc(start_deg, span_deg, text):
    """Place text at the midpoint of the arc, outside the colored bar."""
    a_mid = start_deg + span_deg / 2
    x, y = pol2cart(a_mid, R_LABEL)
    # Rotation: tangent to circle, reading outward
    rot = -a_mid                       # 0° at top, clockwise
    # Flip if upside-down so the text reads the right way up
    if a_mid > 90 and a_mid < 270:
        rot = rot + 180
    ax.text(x, y, text,
            ha='center', va='center',
            rotation=rot, rotation_mode='anchor',
            fontsize=14, color='black', zorder=6)
for i, g in enumerate(genes):
    label_arc(gene_starts[i], gene_span[i], g)
for i, s in enumerate(samples):
    label_arc(sample_starts[i], sample_span[i], s)
# 5) Ribbons ------------------------------------------------------------------
def ribbon(a0_src, a1_src, a0_dst, a1_dst, color, alpha=0.55):
    """Draw a ribbon between two arc slices using a cubic-ish chord."""
    # Convert angles (deg from 12 o'clock CW) to matplotlib polar (deg CCW from +x)
    def to_mpl(deg):
        return 90 - deg
    src0, src1 = to_mpl(a0_src), to_mpl(a1_src)
    dst0, dst1 = to_mpl(a0_dst), to_mpl(a1_dst)
    r = R_RIBBON_OUT
    # Path: from src start → arc along r to src end → chord to dst end → arc back to dst start → close
    verts = [
        (r * np.cos(np.deg2rad(src0)), r * np.sin(np.deg2rad(src0))),
        (r * np.cos(np.deg2rad(src1)), r * np.sin(np.deg2rad(src1))),
        (r * np.cos(np.deg2rad(dst1)), r * np.sin(np.deg2rad(dst1))),
        (r * np.cos(np.deg2rad(dst0)), r * np.sin(np.deg2rad(dst0))),
        (r * np.cos(np.deg2rad(src0)), r * np.sin(np.deg2rad(src0))),
    ]
    codes = [Path.MOVETO, Path.LINETO, Path.LINETO, Path.LINETO, Path.CLOSEPOLY]
    path = Path(verts, codes)
    poly = mpatches.PathPatch(path, facecolor=color, edgecolor='none',
                              alpha=alpha, zorder=2)
    ax.add_patch(poly)
# Walk each gene and each sample, drawing ribbons in the same order
# so sub-arcs stay adjacent (no overlaps inside one segment).
for gi, g in enumerate(genes):
    g_pos = gene_starts[gi]
    for si, s in enumerate(samples):
        v = df_idx[(g, s)]
        sub_frac = v / gene_totals[gi]
        a0_src = g_pos
        a1_src = g_pos + gene_span[gi] * sub_frac
        g_pos += gene_span[gi] * sub_frac
        # Find this sample's position
        si_idx = samples.index(s)
        s_pos = sample_starts[si_idx]
        # Find sub-position within sample
        # We need to walk the sample arc and find where gene g lives
        g_idx = genes.index(g)
        offset = sum(sample_sub[si_idx][k][1] for k in range(g_idx)) / sample_totals[si_idx]
        a0_dst = sample_starts[si_idx] + sample_span[si_idx] * offset
        a1_dst = a0_dst + sample_span[si_idx] * (v / sample_totals[si_idx])
        ribbon(a0_src, a1_src, a0_dst, a1_dst,
               color=gene_colors[g], alpha=0.55)
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, bbox_inches='tight',
            facecolor='white')
plt.show()
print("Saved chord_diagram.png")