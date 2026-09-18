import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
from matplotlib.patches import PathPatch, Wedge, Circle
import matplotlib as mpl
# ---------------- Data ----------------
df = pd.read_excel("inputs/edge-weights-222222222222.xlsx", sheet_name="Sheet 1")
genes = sorted(df['from'].unique())
samples = sorted(df['to'].unique(), key=lambda x: int(x[1:]))
gene_totals = df.groupby('from')['value'].sum().reindex(genes)
sample_totals = df.groupby('to')['value'].sum().reindex(samples)
pivot = df.pivot(index='from', columns='to', values='value').fillna(0).reindex(index=genes, columns=samples)
# ---------------- Colors ----------------
gene_colors = {
    'Gene1': '#4FB0C6',
    'Gene2': '#E36C5E',
    'Gene3': '#3FA48C',
    'Gene4': '#3D5A7A',
    'Gene5': '#F7A99B',
    'Gene6': '#9CA3B0',
}
sample_colors = {
    'S1':  '#C9302C',
    'S2':  '#74B6A4',
    'S3':  '#9B7B5E',
    'S4':  '#B86B5E',
    'S5':  '#6FBDA8',
    'S6':  '#5A6E80',
    'S7':  '#C49DB6',
    'S8':  '#B8A0CD',
    'S9':  '#9CA0A8',
    'S10': '#79C082',
}
# ---------------- Arc Layout ----------------
# Coordinates: 0° = north (top), positive = clockwise (math angle = 90 - theta)
GAP_DEG = 1.5
HALF = 180.0
total_gene = float(gene_totals.sum())
total_sample = float(sample_totals.sum())
gene_budget = HALF - GAP_DEG * (len(genes) - 1)
sample_budget = HALF - GAP_DEG * (len(samples) - 1)
gene_unit = gene_budget / total_gene
sample_unit = sample_budget / total_sample
def build_layout(categories, totals, unit, start):
    out = []
    angle = start
    for cat in categories:
        span = totals[cat] * unit
        out.append({'name': cat, 'start': angle, 'end': angle + span, 'total': totals[cat]})
        angle += span + GAP_DEG
    return out, angle
gene_layout, gene_end = build_layout(genes, gene_totals.to_dict(), gene_unit, 0.0)
sample_layout, sample_end = build_layout(samples, sample_totals.to_dict(), sample_unit, gene_end)
scale = 360.0 / sample_end
for d in gene_layout + sample_layout:
    d['start'] *= scale
    d['end'] *= scale
    d['mid'] = (d['start'] + d['end']) / 2.0
def cw_to_mpl(theta_deg):
    """0=north, CW positive -> matplotlib polar radians (0=east, CCW positive)"""
    return np.deg2rad(90.0 - theta_deg)
# ---------------- Ribbon color helpers ----------------
def ribbon_color(c1, c2, alpha=0.55):
    """Mix two hex colors with given alpha."""
    rgb1 = np.array(mpl.colors.to_rgb(c1))
    rgb2 = np.array(mpl.colors.to_rgb(c2))
    rgb = 0.5 * (rgb1 + rgb2)
    return (*rgb, alpha)
# ---------------- Ribbon endpoints tracking ----------------
# For each gene and sample, track which sub-segments have been used
gene_segments = {g['name']: g['start'] for g in gene_layout}
sample_segments = {s['name']: s['start'] for s in sample_layout}
# ---------------- Build figure ----------------
R_OUTER = 1.00
R_INNER = 0.86   # inner edge of the colored ring
TICK_INNER = 0.86
TICK_OUTER = 0.96
fig, ax = plt.subplots(figsize=(8, 8), subplot_kw={'projection': 'polar'})
fig.patch.set_facecolor('white')
ax.set_facecolor('white')
ax.set_theta_zero_location('E')   # default; we'll convert manually
ax.set_theta_direction(1)
ax.set_ylim(0, 1.05)
ax.set_yticks([])
ax.set_xticks([])
ax.grid(False)
ax.spines['polar'].set_visible(False)
ax.set_aspect('equal')
# ---------------- Draw outer arc sectors ----------------
for g in gene_layout:
    a0 = cw_to_mpl(g['start'])
    a1 = cw_to_mpl(g['end'])
    w = Wedge((0, 0), R_OUTER, np.rad2deg(a0), np.rad2deg(a1),
              width=R_OUTER - R_INNER, facecolor=gene_colors[g['name']],
              edgecolor='white', linewidth=1.5, zorder=2)
    ax.add_patch(w)
for s in sample_layout:
    a0 = cw_to_mpl(s['start'])
    a1 = cw_to_mpl(s['end'])
    w = Wedge((0, 0), R_OUTER, np.rad2deg(a0), np.rad2deg(a1),
              width=R_OUTER - R_INNER, facecolor=sample_colors[s['name']],
              edgecolor='white', linewidth=1.5, zorder=2)
    ax.add_patch(w)
# ---------------- Draw ribbons ----------------
# Determine ordering: draw ribbons for each gene starting from largest value sub-ribbon
# to keep larger ribbons behind smaller ones (visually nicer)
# But to mimic image, let's iterate by row then column
gene_unit_rad = {g['name']: cw_to_mpl(gene_unit) - cw_to_mpl(0)}  # not used; use scale-based
# Compute per-value angular span for each side
gene_deg_per_value = gene_unit * scale  # already applied via scale, so layout angles are final
sample_deg_per_value = sample_unit * scale
for g_name in genes:
    for s_name in samples:
        v = pivot.loc[g_name, s_name]
        if v <= 0:
            continue
        # gene sub-segment
        g_pos = gene_segments[g_name]
        g_span = v * gene_deg_per_value
        gene_segments[g_name] += g_span
        # sample sub-segment
        s_pos = sample_segments[s_name]
        s_span = v * sample_deg_per_value
        sample_segments[s_name] += s_span
        a0 = cw_to_mpl(g_pos)
        a1 = cw_to_mpl(g_pos + g_span)
        b0 = cw_to_mpl(s_pos)
        b1 = cw_to_mpl(s_pos + s_span)
        # ribbon endpoints on inner radius
        r = R_INNER
        x0, y0 = r*np.cos(a0), r*np.sin(a0)
        x1, y1 = r*np.cos(a1), r*np.sin(a1)
        x2, y2 = r*np.cos(b0), r*np.sin(b0)
        x3, y3 = r*np.cos(b1), r*np.sin(b1)
        # control points: pull toward center for a smooth arc
        ctrl_factor = 0.30
        cx0 = (1 - ctrl_factor) * x0
        cy0 = (1 - ctrl_factor) * y0
        cx1 = (1 - ctrl_factor) * x1
        cy1 = (1 - ctrl_factor) * y1
        cx2 = (1 - ctrl_factor) * x2
        cy2 = (1 - ctrl_factor) * y2
        cx3 = (1 - ctrl_factor) * x3
        cy3 = (1 - ctrl_factor) * y3
        verts = [
            (x0, y0),
            (cx0, cy0), (cx1, cy1), (x1, y1),  # along gene side
            (cx3, cy3), (cx2, cy2), (x2, y2),  # back along sample side
            (cx0, cy0),
            (x0, y0),
        ]
        codes = [
            Path.MOVETO,
            Path.CURVE4, Path.CURVE4, Path.CURVE4,
            Path.CURVE4, Path.CURVE4, Path.CURVE4,
            Path.CURVE4,
            Path.CLOSEPOLY,
        ]
        path = Path(verts, codes)
        color = ribbon_color(gene_colors[g_name], sample_colors[s_name], alpha=0.55)
        patch = PathPatch(path, facecolor=color, edgecolor='none', zorder=1)
        ax.add_patch(patch)
# ---------------- Tick marks (0, 30, 60, 90) on outer ring ----------------
for g in gene_layout:
    # place ticks near the mid of the sector, on inner edge of the ring
    a_mid = cw_to_mpl(g['mid'])
    # draw 4 ticks at 0, 30, 60, 90 (in proportion to total? no - just visual reference)
    # Based on image: ticks appear at start+0, +30deg, +60deg, +90deg within the ring (visual)
    # Actually the image shows them at fixed angular intervals along each arc
    # Place ticks at start, start+5°, start+10°, ... up to min(end, start+15°)?
    # Actually image shows ticks at relative angular positions
    # Let's just draw ticks at the actual arc start, start + small angular offset
    pass
# Actually ticks in the image are along the colored arc, showing the value scale 0-90
# Each tick represents 30 value units (0, 30, 60, 90)
# Place ticks at proportional positions: tick = start + (value/90)*arc_span
TICK_VALUES = [0, 30, 60, 90]
TICK_MAX = 90.0
def draw_ticks_for(layout, totals_dict):
    for d in layout:
        total = totals_dict[d['name']]
        for tv in TICK_VALUES:
            if tv > total:
                continue
            frac = tv / total
            ang = d['start'] + frac * (d['end'] - d['start'])
            a = cw_to_mpl(ang)
            # tick on the inner edge of the arc (R_INNER) going outward slightly
            ax.plot([a, a], [R_INNER - 0.005, R_INNER + 0.005],
                    color='black', linewidth=1.2, zorder=5, clip_on=False)
draw_ticks_for(gene_layout, gene_totals.to_dict())
draw_ticks_for(sample_layout, sample_totals.to_dict())
# Also draw small ticks (just inside the arc) at intermediate positions (10, 20, 40, 50, 70, 80)
INTERMEDIATE_TICKS = [10, 20, 40, 50, 70, 80]
def draw_small_ticks(layout, totals_dict):
    for d in layout:
        total = totals_dict[d['name']]
        for tv in INTERMEDIATE_TICKS:
            if tv > total:
                continue
            frac = tv / total
            ang = d['start'] + frac * (d['end'] - d['start'])
            a = cw_to_mpl(ang)
            ax.plot([a, a], [R_INNER - 0.002, R_INNER + 0.002],
                    color='black', linewidth=0.8, zorder=5, clip_on=False)
draw_small_ticks(gene_layout, gene_totals.to_dict())
draw_small_ticks(sample_layout, sample_totals.to_dict())
# ---------------- Labels ----------------
LABEL_R = R_OUTER + 0.06
for g in gene_layout:
    a = cw_to_mpl(g['mid'])
    ax.text(a, LABEL_R, g['name'],
            ha='center', va='center',
            rotation=0, fontsize=11, zorder=6)
for s in sample_layout:
    a = cw_to_mpl(s['mid'])
    ax.text(a, LABEL_R, s['name'],
            ha='center', va='center',
            rotation=0, fontsize=11, zorder=6)
# Adjust rotation of labels for readability
# Make labels rotate so they read outward
# Recompute with rotation
for t in ax.texts:
    pass  # we set rotation=0; could improve later
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=200, bbox_inches='tight', facecolor='white')
plt.close()
print("Saved chord_diagram.png")
print("File size:", __import__('os').path.getsize('chord_diagram.png'))
