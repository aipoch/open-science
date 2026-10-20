import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
from matplotlib.patches import PathPatch, Wedge, Circle
from matplotlib import colors as mcolors
from matplotlib.colors import to_rgba
import colorsys
import pandas as pd
def lighten(hex_color, amount=0.5):
    c = to_rgba(hex_color)
    r, g, b = c[:3]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l + (1 - l) * amount
    r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
    return mcolors.to_hex((r2, g2, b2))
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx', sheet_name='Sheet 1')
matrix = df.pivot(index='from', columns='to', values='value').fillna(0)
gene_order = sorted(matrix.index.tolist(), key=lambda x: int(x.replace('Gene','')))
sample_order = sorted(matrix.columns.tolist(), key=lambda x: int(x.replace('S','')))
matrix = matrix.loc[gene_order, sample_order]
samples_ccw = list(reversed(sample_order))
genes_ccw = list(reversed(gene_order))
gene_palette = ['#3FB6C8', '#E86A5C', '#2EA98B', '#3D4F8C', '#A6A6A6', '#F0A48C']
sample_palette = ['#1FB48C', '#7BBE3E', '#D7B05B', '#A669A1', '#E89B5C', '#9FCEDB',
                  '#9F8FB8', '#C49A6C', '#B89B6A', '#E59A6A']
gene_color = {g: gene_palette[i] for i, g in enumerate(gene_order)}
sample_color = {s: sample_palette[i] for i, s in enumerate(sample_order)}
gap_deg = 4
all_totals = float(matrix.values.sum())
gene_arc_deg = (360 - 2*gap_deg) * matrix.values.sum(axis=1).sum() / all_totals
sample_arc_deg = (360 - 2*gap_deg) * matrix.values.sum(axis=0).sum() / all_totals
sample_totals = matrix.values.sum(axis=0).tolist()
gene_totals = matrix.values.sum(axis=1).tolist()
sample_ccw_totals = list(reversed(sample_totals))
gene_ccw_totals = list(reversed(gene_totals))
sample_ccw_starts = []
cum = 90 + gap_deg/2
for v in sample_ccw_totals:
    sample_ccw_starts.append(cum)
    cum += sample_arc_deg * v / sum(sample_ccw_totals)
gene_ccw_starts = []
cum = 270 + gap_deg/2
for v in gene_ccw_totals:
    gene_ccw_starts.append(cum)
    cum += gene_arc_deg * v / sum(gene_ccw_totals)
# Build segments
sample_segments = []
for idx, sname in enumerate(samples_ccw):
    start_a = sample_ccw_starts[idx]
    total = sample_ccw_totals[idx]
    j = sample_order.index(sname)
    gene_vals = matrix.values[:, j]
    subdivs = []
    cum2 = start_a
    for gi, gname in enumerate(gene_order):
        ext = sample_arc_deg * gene_vals[gi] / total
        subdivs.append({'gene': gname, 'start': cum2, 'end': cum2 + ext, 'value': gene_vals[gi]})
        cum2 += ext
    sample_segments.append({
        'name': sname, 'start': start_a, 'end': start_a + sample_arc_deg,
        'total': total, 'subdivs': subdivs, 'color': sample_color[sname]
    })
gene_segments = []
for idx, gname in enumerate(genes_ccw):
    start_a = gene_ccw_starts[idx]
    total = gene_ccw_totals[idx]
    i = gene_order.index(gname)
    sample_vals = matrix.values[i, :]
    subdivs = []
    cum2 = start_a
    for sj, sname in enumerate(sample_order):
        ext = gene_arc_deg * sample_vals[sj] / total
        subdivs.append({'sample': sname, 'start': cum2, 'end': cum2 + ext, 'value': sample_vals[sj]})
        cum2 += ext
    gene_segments.append({
        'name': gname, 'start': start_a, 'end': start_a + gene_arc_deg,
        'total': total, 'subdivs': subdivs, 'color': gene_color[gname]
    })
fig, ax = plt.subplots(figsize=(10, 10), facecolor='white')
ax.set_xlim(-1.5, 1.5)
ax.set_ylim(-1.5, 1.5)
ax.set_aspect('equal')
ax.axis('off')
R_OUTER = 1.0
R_INNER = 0.92
R_LABEL = 1.10
def deg2rad(d):
    return np.deg2rad(d)
def polar(r, deg):
    rad = deg2rad(deg)
    return (r * np.cos(rad), r * np.sin(rad))
def draw_arc_band(ax, start_deg, end_deg, color, r_in=R_INNER, r_out=R_OUTER, alpha=1.0):
    wedge = Wedge((0, 0), r_out, start_deg, end_deg, width=max(r_out - r_in, 0.001),
                  facecolor=color, edgecolor='white', linewidth=1.2, alpha=alpha)
    ax.add_patch(wedge)
    return wedge
# Subdivision bands (lightened partner colors)
for seg in sample_segments:
    for sd in seg['subdivs']:
        col = lighten(gene_color[sd['gene']], 0.55)
        draw_arc_band(ax, sd['start'], sd['end'], col)
for seg in gene_segments:
    for sd in seg['subdivs']:
        col = lighten(sample_color[sd['sample']], 0.55)
        draw_arc_band(ax, sd['start'], sd['end'], col)
def ribbon_path(r_in, r_out, a0_deg, a1_deg, b0_deg, b1_deg):
    p_outer_a_start = polar(r_out, a0_deg)
    p_outer_a_end   = polar(r_out, a1_deg)
    p_inner_a_end   = polar(r_in, a1_deg)
    p_inner_a_start = polar(r_in, a0_deg)
    p_outer_b_start = polar(r_out, b0_deg)
    p_outer_b_end   = polar(r_out, b1_deg)
    p_inner_b_end   = polar(r_in, b1_deg)
    p_inner_b_start = polar(r_in, b0_deg)
    cp_r = r_in * 0.4
    cp_outer_a = polar(cp_r, (a0_deg + a1_deg) / 2)
    cp_outer_b = polar(cp_r, (b0_deg + b1_deg) / 2)
    cp_inner_a = polar(cp_r, (a0_deg + a1_deg) / 2)
    cp_inner_b = polar(cp_r, (b0_deg + b1_deg) / 2)
    verts = [
        p_outer_a_start,
        cp_outer_a, cp_outer_b, p_outer_b_start,
        p_outer_b_end,
        cp_inner_b, cp_inner_a, p_inner_a_end,
        p_inner_a_start,
        cp_outer_a, cp_outer_a, p_outer_a_start
    ]
    codes = [
        Path.MOVETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4,
        Path.LINETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4,
        Path.LINETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4
    ]
    return Path(verts, codes)
# Build a quick lookup from (sample, gene) -> subdiv info
sample_lookup = {}
for seg in sample_segments:
    for sd in seg['subdivs']:
        # sample subdiv carries gene info: links from sample to this gene
        sample_lookup[(seg['name'], sd['gene'])] = sd
gene_lookup = {}
for seg in gene_segments:
    for sd in seg['subdivs']:
        gene_lookup[(seg['name'], sd['sample'])] = sd
# Draw ribbons (color from sample's perspective: use sample's color, lightened)
# Actually, looking at the reference image, ribbons look like they're colored to match one of the segments.
# Let's color each ribbon by the sample color (since samples have more variety).
for (sname, gname), s_sub in sample_lookup.items():
    g_sub = gene_lookup.get((gname, sname))
    if g_sub is None:
        continue
    # Use a blend or pick sample color
    col = sample_color[sname]
    col_transparent = to_rgba(col, alpha=0.5)
    path = ribbon_path(R_INNER - 0.04, R_INNER,
                       g_sub['start'], g_sub['end'],
                       s_sub['start'], s_sub['end'])
    patch = PathPatch(path, facecolor=col_transparent, edgecolor='none', alpha=0.5)
    ax.add_patch(patch)
# Ticks and labels
def tick_values(max_total, max_ticks=4):
    rough = max_total / max_ticks
    pow10 = 10 ** np.floor(np.log10(rough))
    candidates = [1, 2, 2.5, 5, 10]
    for c in candidates:
        step = c * pow10
        if max_total / step <= max_ticks + 1:
            return step
    return step
max_sample_total = max(sample_totals)
max_gene_total = max(gene_totals)
sample_step = tick_values(max_sample_total)
gene_step = tick_values(max_gene_total)
for seg in sample_segments:
    start_a = seg['start']
    end_a = seg['end']
    total = seg['total']
    n = int(np.ceil(total / sample_step)) + 1
    tick_vals = np.arange(0, n * sample_step + 0.001, sample_step)
    for tv in tick_vals:
        frac = tv / total
        if frac > 1.001:
            break
        ang = start_a + (end_a - start_a) * frac
        x1, y1 = polar(R_OUTER + 0.005, ang)
        x2, y2 = polar(R_OUTER + 0.035, ang)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.7, zorder=5)
        if tv <= total + 0.001:
            lx, ly = polar(R_OUTER + 0.07, ang)
            ax.text(lx, ly, f'{int(tv)}', ha='center', va='center', fontsize=7, color='#444444')
for seg in gene_segments:
    start_a = seg['start']
    end_a = seg['end']
    total = seg['total']
    n = int(np.ceil(total / gene_step)) + 1
    tick_vals = np.arange(0, n * gene_step + 0.001, gene_step)
    for tv in tick_vals:
        frac = tv / total
        if frac > 1.001:
            break
        ang = start_a + (end_a - start_a) * frac
        x1, y1 = polar(R_OUTER + 0.005, ang)
        x2, y2 = polar(R_OUTER + 0.035, ang)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.7, zorder=5)
        if tv <= total + 0.001:
            lx, ly = polar(R_OUTER + 0.07, ang)
            ax.text(lx, ly, f'{int(tv)}', ha='center', va='center', fontsize=7, color='#444444')
# Segment name labels
for seg in sample_segments + gene_segments:
    mid = (seg['start'] + seg['end']) / 2
    lx, ly = polar(R_LABEL + 0.06, mid)
    rad = deg2rad(mid)
    cos_v, sin_v = np.cos(rad), np.sin(rad)
    ha = 'left' if cos_v > 0.1 else ('right' if cos_v < -0.1 else 'center')
    va = 'bottom' if sin_v > 0.1 else ('top' if sin_v < -0.1 else 'center')
    ax.text(lx, ly, seg['name'], ha=ha, va=va, fontsize=13, fontweight='normal')
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print('Saved chord_diagram.png')

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
from matplotlib.patches import PathPatch, Wedge, Circle
from matplotlib import colors as mcolors
from matplotlib.colors import to_rgba
import colorsys
import pandas as pd
def lighten(hex_color, amount=0.5):
    c = to_rgba(hex_color)
    r, g, b = c[:3]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l + (1 - l) * amount
    r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
    return mcolors.to_hex((r2, g2, b2))
# ----- Build layout -----
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx', sheet_name='Sheet 1')
matrix = df.pivot(index='from', columns='to', values='value').fillna(0)
gene_order = sorted(matrix.index.tolist(), key=lambda x: int(x.replace('Gene','')))
sample_order = sorted(matrix.columns.tolist(), key=lambda x: int(x.replace('S','')))
matrix = matrix.loc[gene_order, sample_order]
samples_ccw = list(reversed(sample_order))  # S10..S1
genes_ccw = list(reversed(gene_order))      # Gene6..Gene1
gene_palette = ['#3FB6C8', '#E86A5C', '#2EA98B', '#3D4F8C', '#A6A6A6', '#F0A48C']
sample_palette = ['#1FB48C', '#7BBE3E', '#D7B05B', '#A669A1', '#E89B5C', '#9FCEDB',
                  '#9F8FB8', '#C49A6C', '#B89B6A', '#E59A6A']
gene_color = {g: gene_palette[i] for i, g in enumerate(gene_order)}
sample_color = {s: sample_palette[i] for i, s in enumerate(sample_order)}
gap_deg = 6
half_arc = (360 - 2*gap_deg) / 2  # 174°
sample_totals = matrix.values.sum(axis=0).tolist()
gene_totals = matrix.values.sum(axis=1).tolist()
sample_ccw_totals = sample_totals[::-1]
gene_ccw_totals = gene_totals[::-1]
sample_ccw_starts = []
cum = 90 + gap_deg/2
for v in sample_ccw_totals:
    sample_ccw_starts.append(cum)
    cum += half_arc * v / sum(sample_ccw_totals)
gene_ccw_starts = []
cum = 270 + gap_deg/2
for v in gene_ccw_totals:
    gene_ccw_starts.append(cum)
    cum += half_arc * v / sum(gene_ccw_totals)
sample_segments = []
for idx, sname in enumerate(samples_ccw):
    start_a = sample_ccw_starts[idx]
    total = sample_ccw_totals[idx]
    arc = half_arc * total / sum(sample_ccw_totals)
    j = sample_order.index(sname)
    gene_vals = matrix.values[:, j]
    subdivs = []
    cum2 = start_a
    for gi, gname in enumerate(gene_order):
        ext = arc * gene_vals[gi] / total
        subdivs.append({'gene': gname, 'start': cum2, 'end': cum2 + ext, 'value': gene_vals[gi]})
        cum2 += ext
    sample_segments.append({
        'name': sname, 'start': start_a, 'end': start_a + arc,
        'total': total, 'arc': arc, 'subdivs': subdivs, 'color': sample_color[sname]
    })
gene_segments = []
for idx, gname in enumerate(genes_ccw):
    total = gene_ccw_totals[idx]
    arc = half_arc * total / sum(gene_ccw_totals)
    start_a = gene_ccw_starts[idx]
    i = gene_order.index(gname)
    sample_vals = matrix.values[i, :]
    subdivs = []
    cum2 = start_a
    for sj, sname in enumerate(sample_order):
        ext = arc * sample_vals[sj] / total
        subdivs.append({'sample': sname, 'start': cum2, 'end': cum2 + ext, 'value': sample_vals[sj]})
        cum2 += ext
    gene_segments.append({
        'name': gname, 'start': start_a, 'end': start_a + arc,
        'total': total, 'arc': arc, 'subdivs': subdivs, 'color': gene_color[gname]
    })
# ----- Draw -----
fig, ax = plt.subplots(figsize=(10, 10), facecolor='white')
ax.set_xlim(-1.4, 1.4)
ax.set_ylim(-1.4, 1.4)
ax.set_aspect('equal')
ax.axis('off')
R_OUTER = 1.0
R_INNER = 0.92
R_LABEL = 1.10
def deg2rad(d):
    return np.deg2rad(d)
def polar(r, deg):
    rad = deg2rad(deg)
    return (r * np.cos(rad), r * np.sin(rad))
def draw_arc_band(ax, start_deg, end_deg, color, r_in=R_INNER, r_out=R_OUTER, alpha=1.0):
    # For matplotlib Wedge, theta1 < theta2 always. So we handle wrap-around.
    if end_deg >= start_deg:
        wedge = Wedge((0, 0), r_out, start_deg, end_deg, width=max(r_out - r_in, 0.001),
                      facecolor=color, edgecolor='white', linewidth=1.2, alpha=alpha)
    else:
        # Wrap around 360
        wedge1 = Wedge((0, 0), r_out, start_deg, 360, width=max(r_out - r_in, 0.001),
                       facecolor=color, edgecolor='white', linewidth=1.2, alpha=alpha)
        wedge2 = Wedge((0, 0), r_out, 0, end_deg, width=max(r_out - r_in, 0.001),
                       facecolor=color, edgecolor='white', linewidth=1.2, alpha=alpha)
        ax.add_patch(wedge1)
    ax.add_patch(wedge)
# Subdivision bands - colored by partner (lightened)
for seg in sample_segments:
    for sd in seg['subdivs']:
        col = lighten(gene_color[sd['gene']], 0.55)
        draw_arc_band(ax, sd['start'], sd['end'], col)
for seg in gene_segments:
    for sd in seg['subdivs']:
        col = lighten(sample_color[sd['sample']], 0.55)
        draw_arc_band(ax, sd['start'], sd['end'], col)
def ribbon_path(r_in, r_out, a0_deg, a1_deg, b0_deg, b1_deg):
    p_outer_a_start = polar(r_out, a0_deg)
    p_outer_a_end   = polar(r_out, a1_deg)
    p_inner_a_end   = polar(r_in, a1_deg)
    p_inner_a_start = polar(r_in, a0_deg)
    p_outer_b_start = polar(r_out, b0_deg)
    p_outer_b_end   = polar(r_out, b1_deg)
    p_inner_b_end   = polar(r_in, b1_deg)
    p_inner_b_start = polar(r_in, b0_deg)
    cp_r = r_in * 0.4
    cp_outer_a = polar(cp_r, (a0_deg + a1_deg) / 2)
    cp_outer_b = polar(cp_r, (b0_deg + b1_deg) / 2)
    cp_inner_a = polar(cp_r, (a0_deg + a1_deg) / 2)
    cp_inner_b = polar(cp_r, (b0_deg + b1_deg) / 2)
    verts = [
        p_outer_a_start,
        cp_outer_a, cp_outer_b, p_outer_b_start,
        p_outer_b_end,
        cp_inner_b, cp_inner_a, p_inner_a_end,
        p_inner_a_start,
        cp_outer_a, cp_outer_a, p_outer_a_start
    ]
    codes = [
        Path.MOVETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4,
        Path.LINETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4,
        Path.LINETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4
    ]
    return Path(verts, codes)
# Build lookups
sample_lookup = {}
for seg in sample_segments:
    for sd in seg['subdivs']:
        sample_lookup[(seg['name'], sd['gene'])] = sd
gene_lookup = {}
for seg in gene_segments:
    for sd in seg['subdivs']:
        gene_lookup[(seg['name'], sd['sample'])] = sd
# Draw ribbons
for (sname, gname), s_sub in sample_lookup.items():
    g_sub = gene_lookup.get((gname, sname))
    if g_sub is None:
        continue
    col = sample_color[sname]
    col_transparent = to_rgba(col, alpha=0.5)
    path = ribbon_path(R_INNER - 0.04, R_INNER,
                       g_sub['start'], g_sub['end'],
                       s_sub['start'], s_sub['end'])
    patch = PathPatch(path, facecolor=col_transparent, edgecolor='none', alpha=0.5)
    ax.add_patch(patch)
# Ticks and labels
def tick_values(max_total, max_ticks=4):
    rough = max_total / max_ticks
    pow10 = 10 ** np.floor(np.log10(rough))
    candidates = [1, 2, 2.5, 5, 10]
    for c in candidates:
        step = c * pow10
        if max_total / step <= max_ticks + 1:
            return step
    return step
max_sample_total = max(sample_totals)
max_gene_total = max(gene_totals)
sample_step = tick_values(max_sample_total)
gene_step = tick_values(max_gene_total)
for seg in sample_segments:
    start_a = seg['start']
    arc = seg['arc']
    total = seg['total']
    n = int(np.ceil(total / sample_step)) + 1
    tick_vals = np.arange(0, n * sample_step + 0.001, sample_step)
    for tv in tick_vals:
        frac = tv / total
        if frac > 1.001:
            break
        ang = start_a + arc * frac
        x1, y1 = polar(R_OUTER + 0.005, ang)
        x2, y2 = polar(R_OUTER + 0.035, ang)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.7, zorder=5)
        if tv <= total + 0.001:
            lx, ly = polar(R_OUTER + 0.07, ang)
            ax.text(lx, ly, f'{int(tv)}', ha='center', va='center', fontsize=7, color='#444444')
for seg in gene_segments:
    start_a = seg['start']
    arc = seg['arc']
    total = seg['total']
    n = int(np.ceil(total / gene_step)) + 1
    tick_vals = np.arange(0, n * gene_step + 0.001, gene_step)
    for tv in tick_vals:
        frac = tv / total
        if frac > 1.001:
            break
        ang = start_a + arc * frac
        x1, y1 = polar(R_OUTER + 0.005, ang)
        x2, y2 = polar(R_OUTER + 0.035, ang)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.7, zorder=5)
        if tv <= total + 0.001:
            lx, ly = polar(R_OUTER + 0.07, ang)
            ax.text(lx, ly, f'{int(tv)}', ha='center', va='center', fontsize=7, color='#444444')
# Segment labels
for seg in sample_segments + gene_segments:
    mid = (seg['start'] + seg['end']) / 2
    if seg['end'] < seg['start']:
        # Wrap-around: use mean angle
        mid_alt = (seg['start'] + (seg['end'] + 360)) / 2
        if mid_alt > 360:
            mid_alt -= 360
        mid = mid_alt
    lx, ly = polar(R_LABEL + 0.05, mid)
    rad = deg2rad(mid)
    cos_v, sin_v = np.cos(rad), np.sin(rad)
    ha = 'left' if cos_v > 0.1 else ('right' if cos_v < -0.1 else 'center')
    va = 'bottom' if sin_v > 0.1 else ('top' if sin_v < -0.1 else 'center')
    ax.text(lx, ly, seg['name'], ha=ha, va=va, fontsize=13, fontweight='normal')
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print('Saved chord_diagram.png')

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
from matplotlib.patches import PathPatch, Wedge, Circle
from matplotlib import colors as mcolors
from matplotlib.colors import to_rgba
import colorsys
import pandas as pd
def lighten(hex_color, amount=0.5):
    c = to_rgba(hex_color)
    r, g, b = c[:3]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l + (1 - l) * amount
    r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
    return mcolors.to_hex((r2, g2, b2))
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx', sheet_name='Sheet 1')
matrix = df.pivot(index='from', columns='to', values='value').fillna(0)
gene_order = sorted(matrix.index.tolist(), key=lambda x: int(x.replace('Gene','')))
sample_order = sorted(matrix.columns.tolist(), key=lambda x: int(x.replace('S','')))
matrix = matrix.loc[gene_order, sample_order]
samples_ccw = list(reversed(sample_order))
genes_ccw = list(reversed(gene_order))
gene_palette = ['#3FB6C8', '#E86A5C', '#2EA98B', '#3D4F8C', '#A6A6A6', '#F0A48C']
sample_palette = ['#1FB48C', '#7BBE3E', '#D7B05B', '#A669A1', '#E89B5C', '#9FCEDB',
                  '#9F8FB8', '#C49A6C', '#B89B6A', '#E59A6A']
gene_color = {g: gene_palette[i] for i, g in enumerate(gene_order)}
sample_color = {s: sample_palette[i] for i, s in enumerate(sample_order)}
gap_deg = 6
half_arc = (360 - 2*gap_deg) / 2
sample_totals = matrix.values.sum(axis=0).tolist()
gene_totals = matrix.values.sum(axis=1).tolist()
sample_ccw_totals = sample_totals[::-1]
gene_ccw_totals = gene_totals[::-1]
sample_ccw_starts = []
cum = 90 + gap_deg/2
for v in sample_ccw_totals:
    sample_ccw_starts.append(cum)
    cum += half_arc * v / sum(sample_ccw_totals)
gene_ccw_starts = []
cum = 270 + gap_deg/2
for v in gene_ccw_totals:
    gene_ccw_starts.append(cum)
    cum += half_arc * v / sum(gene_ccw_totals)
sample_segments = []
for idx, sname in enumerate(samples_ccw):
    start_a = sample_ccw_starts[idx]
    total = sample_ccw_totals[idx]
    arc = half_arc * total / sum(sample_ccw_totals)
    j = sample_order.index(sname)
    gene_vals = matrix.values[:, j]
    subdivs = []
    cum2 = start_a
    for gi, gname in enumerate(gene_order):
        ext = arc * gene_vals[gi] / total
        subdivs.append({'gene': gname, 'start': cum2, 'end': cum2 + ext, 'value': gene_vals[gi]})
        cum2 += ext
    sample_segments.append({
        'name': sname, 'start': start_a, 'end': start_a + arc,
        'total': total, 'arc': arc, 'subdivs': subdivs, 'color': sample_color[sname]
    })
gene_segments = []
for idx, gname in enumerate(genes_ccw):
    total = gene_ccw_totals[idx]
    arc = half_arc * total / sum(gene_ccw_totals)
    start_a = gene_ccw_starts[idx]
    i = gene_order.index(gname)
    sample_vals = matrix.values[i, :]
    subdivs = []
    cum2 = start_a
    for sj, sname in enumerate(sample_order):
        ext = arc * sample_vals[sj] / total
        subdivs.append({'sample': sname, 'start': cum2, 'end': cum2 + ext, 'value': sample_vals[sj]})
        cum2 += ext
    gene_segments.append({
        'name': gname, 'start': start_a, 'end': start_a + arc,
        'total': total, 'arc': arc, 'subdivs': subdivs, 'color': gene_color[gname]
    })
# ----- Draw -----
fig, ax = plt.subplots(figsize=(10, 10), facecolor='white')
ax.set_xlim(-1.4, 1.4)
ax.set_ylim(-1.4, 1.4)
ax.set_aspect('equal')
ax.axis('off')
R_OUTER = 1.0
R_INNER = 0.90
R_LABEL = 1.10
def deg2rad(d):
    return np.deg2rad(d)
def polar(r, deg):
    rad = deg2rad(deg)
    return (r * np.cos(rad), r * np.sin(rad))
def draw_arc_band_full(ax, start_deg, end_deg, color, r_in=R_INNER, r_out=R_OUTER, alpha=1.0):
    """Draw arc band handling wrap-around."""
    if end_deg >= start_deg:
        wedge = Wedge((0, 0), r_out, start_deg, end_deg, width=max(r_out - r_in, 0.001),
                      facecolor=color, edgecolor='white', linewidth=1.5, alpha=alpha)
        ax.add_patch(wedge)
    else:
        wedge1 = Wedge((0, 0), r_out, start_deg, 360, width=max(r_out - r_in, 0.001),
                       facecolor=color, edgecolor='white', linewidth=1.5, alpha=alpha)
        wedge2 = Wedge((0, 0), r_out, 0, end_deg, width=max(r_out - r_in, 0.001),
                       facecolor=color, edgecolor='white', linewidth=1.5, alpha=alpha)
        ax.add_patch(wedge1)
        ax.add_patch(wedge2)
# Draw outer arc band per segment (one solid color per segment)
for seg in sample_segments:
    draw_arc_band_full(ax, seg['start'], seg['end'], seg['color'])
for seg in gene_segments:
    draw_arc_band_full(ax, seg['start'], seg['end'], seg['color'])
# Add white separators between subdivisions (just thin radial lines)
for seg in sample_segments + gene_segments:
    for sd in seg['subdivs']:
        # Draw a thin white line at the start of each subdivision (except the first)
        # Actually let's draw a small white radial mark at each subdivision boundary
        pass
def ribbon_path(r_in, r_out, a0_deg, a1_deg, b0_deg, b1_deg):
    p_outer_a_start = polar(r_out, a0_deg)
    p_outer_a_end   = polar(r_out, a1_deg)
    p_inner_a_end   = polar(r_in, a1_deg)
    p_inner_a_start = polar(r_in, a0_deg)
    p_outer_b_start = polar(r_out, b0_deg)
    p_outer_b_end   = polar(r_out, b1_deg)
    p_inner_b_end   = polar(r_in, b1_deg)
    p_inner_b_start = polar(r_in, b0_deg)
    cp_r = r_in * 0.4
    cp_outer_a = polar(cp_r, (a0_deg + a1_deg) / 2)
    cp_outer_b = polar(cp_r, (b0_deg + b1_deg) / 2)
    cp_inner_a = polar(cp_r, (a0_deg + a1_deg) / 2)
    cp_inner_b = polar(cp_r, (b0_deg + b1_deg) / 2)
    verts = [
        p_outer_a_start,
        cp_outer_a, cp_outer_b, p_outer_b_start,
        p_outer_b_end,
        cp_inner_b, cp_inner_a, p_inner_a_end,
        p_inner_a_start,
        cp_outer_a, cp_outer_a, p_outer_a_start
    ]
    codes = [
        Path.MOVETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4,
        Path.LINETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4,
        Path.LINETO,
        Path.CURVE4, Path.CURVE4, Path.CURVE4
    ]
    return Path(verts, codes)
# Lookups
sample_lookup = {}
for seg in sample_segments:
    for sd in seg['subdivs']:
        sample_lookup[(seg['name'], sd['gene'])] = sd
gene_lookup = {}
for seg in gene_segments:
    for sd in seg['subdivs']:
        gene_lookup[(seg['name'], sd['sample'])] = sd
# Draw ribbons (color = sample color, lighter)
for (sname, gname), s_sub in sample_lookup.items():
    g_sub = gene_lookup.get((gname, sname))
    if g_sub is None:
        continue
    # Use lightened sample color for ribbon
    col = lighten(sample_color[sname], 0.25)
    col_transparent = to_rgba(col, alpha=0.65)
    path = ribbon_path(R_INNER - 0.04, R_INNER,
                       g_sub['start'], g_sub['end'],
                       s_sub['start'], s_sub['end'])
    patch = PathPatch(path, facecolor=col_transparent, edgecolor='none', alpha=0.65)
    ax.add_patch(patch)
# Ticks and labels
def tick_values(max_total, max_ticks=4):
    rough = max_total / max_ticks
    pow10 = 10 ** np.floor(np.log10(rough))
    candidates = [1, 2, 2.5, 5, 10]
    for c in candidates:
        step = c * pow10
        if max_total / step <= max_ticks + 1:
            return step
    return step
max_sample_total = max(sample_totals)
max_gene_total = max(gene_totals)
sample_step = tick_values(max_sample_total)
gene_step = tick_values(max_gene_total)
for seg in sample_segments:
    start_a = seg['start']
    arc = seg['arc']
    total = seg['total']
    n = int(np.ceil(total / sample_step)) + 1
    tick_vals = np.arange(0, n * sample_step + 0.001, sample_step)
    for tv in tick_vals:
        frac = tv / total
        if frac > 1.001:
            break
        ang = start_a + arc * frac
        x1, y1 = polar(R_OUTER + 0.005, ang)
        x2, y2 = polar(R_OUTER + 0.035, ang)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.7, zorder=5)
        if tv <= total + 0.001:
            lx, ly = polar(R_OUTER + 0.07, ang)
            ax.text(lx, ly, f'{int(tv)}', ha='center', va='center', fontsize=7, color='#444444')
for seg in gene_segments:
    start_a = seg['start']
    arc = seg['arc']
    total = seg['total']
    n = int(np.ceil(total / gene_step)) + 1
    tick_vals = np.arange(0, n * gene_step + 0.001, gene_step)
    for tv in tick_vals:
        frac = tv / total
        if frac > 1.001:
            break
        ang = start_a + arc * frac
        x1, y1 = polar(R_OUTER + 0.005, ang)
        x2, y2 = polar(R_OUTER + 0.035, ang)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.7, zorder=5)
        if tv <= total + 0.001:
            lx, ly = polar(R_OUTER + 0.07, ang)
            ax.text(lx, ly, f'{int(tv)}', ha='center', va='center', fontsize=7, color='#444444')
# Segment labels
for seg in sample_segments + gene_segments:
    mid = (seg['start'] + seg['end']) / 2
    if seg['end'] < seg['start']:
        mid_alt = (seg['start'] + (seg['end'] + 360)) / 2
        if mid_alt > 360:
            mid_alt -= 360
        mid = mid_alt
    lx, ly = polar(R_LABEL + 0.06, mid)
    rad = deg2rad(mid)
    cos_v, sin_v = np.cos(rad), np.sin(rad)
    ha = 'left' if cos_v > 0.1 else ('right' if cos_v < -0.1 else 'center')
    va = 'bottom' if sin_v > 0.1 else ('top' if sin_v < -0.1 else 'center')
    ax.text(lx, ly, seg['name'], ha=ha, va=va, fontsize=13, fontweight='normal')
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print('Saved chord_diagram.png')
