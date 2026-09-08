import numpy as np
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.path import Path
from matplotlib.patches import PathPatch, Wedge
xlsx_path = 'inputs/edge-weights-222222222222.xlsx'
df = pd.read_excel(xlsx_path, sheet_name='Sheet 1', engine='openpyxl')
genes = sorted(df['from'].unique())
samples = sorted(df['to'].unique(), key=lambda x: int(x[1:]))
order = genes + samples
n = len(order)
idx = {name: i for i, name in enumerate(order)}
M = np.zeros((n, n))
for _, row in df.iterrows():
    i, j = idx[row['from']], idx[row['to']]
    M[i, j] = row['value']
    M[j, i] = row['value']
row_sum = M.sum(axis=1)
total = row_sum.sum()
node_color_map = {
    'Gene1': '#1F77B4', 'Gene2': '#FF7F0E', 'Gene3': '#2CA02C',
    'Gene4': '#D62728', 'Gene5': '#9467BD', 'Gene6': '#8C564B',
    'S1': '#E377C2', 'S2': '#7F7F7F', 'S3': '#BCBD22', 'S4': '#17BECF',
    'S5': '#AEC7E8', 'S6': '#FFBB78', 'S7': '#98DF8A', 'S8': '#FF9896',
    'S9': '#C5B0D5', 'S10': '#C49C94',
}
node_color = [node_color_map[name] for name in order]
n_genes = len(genes)
gap_between_groups = np.deg2rad(2.0)
small_intra_gap = np.deg2rad(0.4)
gaps_total = gap_between_groups * 2 + small_intra_gap * (n - 2)
available = 2 * np.pi - gaps_total
weights = row_sum / total
extents = weights * available
starts = np.zeros(n)
cur = 0.0
for i in range(n):
    starts[i] = cur
    cur += extents[i]
    if i < n - 1:
        cur += small_intra_gap
    if i == n_genes - 1:
        cur += gap_between_groups
cur += gap_between_groups
fig, ax = plt.subplots(figsize=(11, 11), subplot_kw={'projection': 'polar'})
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1)
ax.set_axis_off()
ax.set_ylim(0, 1.25)
r_outer = 1.0
r_inner_arc = 0.94
# Outer arcs
for i, name in enumerate(order):
    theta1 = np.degrees(starts[i])
    theta2 = np.degrees(starts[i] + extents[i])
    w = Wedge((0, 0), r_outer, theta1, theta2, width=r_outer - r_inner_arc,
              facecolor=node_color[i], edgecolor='white', linewidth=1.4, alpha=0.92)
    ax.add_patch(w)
    mid = starts[i] + extents[i] / 2
    label_r = r_outer + 0.07
    deg = np.degrees(mid)
    rot_deg = -deg
    if 90 < deg < 270:
        rot_deg = 180 - deg
    ax.text(mid, label_r, name, rotation=rot_deg, ha='center', va='center',
            fontsize=13, color='black')
# Ticks 0 and half cumulative value
for i in range(n):
    for frac in (0.0, 0.5):
        ang = starts[i] + extents[i] * frac
        tick_r1 = r_inner_arc - 0.01
        tick_r2 = r_inner_arc - 0.05
        x_a = tick_r1 * np.sin(ang); y_a = tick_r1 * np.cos(ang)
        x_b = tick_r2 * np.sin(ang); y_b = tick_r2 * np.cos(ang)
        ax.plot([x_a, x_b], [y_a, y_b], color='gray', linewidth=0.8, zorder=4)
        val = frac * row_sum[i]
        ax.text(ang, tick_r2 - 0.04, f'{val:.0f}', fontsize=7,
                ha='center', va='center', color='gray')
# Ribbons: each ribbon connects an arc-segment on i to an arc-segment on j
# using straight chords (line ends) + cubic Bezier with control points at origin.
# To get a smooth chord ribbon we approximate the arc edge as a straight line
# (since ribbon thickness is small).
r0 = r_inner_arc
for i in range(n):
    name_i = order[i]
    neighbors = sorted([(j, M[i, j]) for j in range(n) if M[i, j] > 0 and j != i],
                       key=lambda x: x[0])
    cur_i = starts[i]
    for j, val in neighbors:
        frac_i = val / row_sum[i]
        span_i = extents[i] * frac_i
        a1 = cur_i
        a2 = cur_i + span_i
        # j's neighbors sorted for slot order
        j_neighbors = sorted([(k, M[j, k]) for k in range(n) if M[j, k] > 0 and k != j],
                             key=lambda x: x[0])
        cum = 0.0
        for k, val_k in j_neighbors:
            if k == i:
                break
            cum += val_k / row_sum[j]
        frac_j = val / row_sum[j]
        b1 = starts[j] + extents[j] * cum
        b2 = b1 + extents[j] * frac_j
        x1, y1 = r0 * np.sin(a1), r0 * np.cos(a1)
        x2, y2 = r0 * np.sin(a2), r0 * np.cos(a2)
        x3, y3 = r0 * np.sin(b1), r0 * np.cos(b1)
        x4, y4 = r0 * np.sin(b2), r0 * np.cos(b2)
        # Build ribbon path with proper cubic Bezier curves.
        # MOVETO -> LINETO (arc edge, approximated) -> CURVE4 (cubic, 3 controls: c1, c2, end)
        # We need to lay out: arc-i-edge, bezier-out, arc-j-edge, bezier-back.
        # For curves from (x2,y2) to (x3,y3) and from (x4,y4) to (x1,y1), control points are at origin.
        verts = [
            (x1, y1),  # MOVETO start
            (x2, y2),  # LINETO end of arc-i edge
            (0.0, 0.0),  # CURVE4 c1 (control 1 of cubic from x2,y2 -> x3,y3)
            (0.0, 0.0),  # CURVE4 c2
            (x3, y3),  # CURVE4 end -> arrive at start of arc-j
            (x4, y4),  # LINETO end of arc-j edge
            (0.0, 0.0),  # CURVE4 c1
            (0.0, 0.0),  # CURVE4 c2
            (x1, y1),  # CURVE4 end -> back to start
        ]
        codes = [
            Path.MOVETO,
            Path.LINETO,
            Path.CURVE4, Path.CURVE4, Path.CURVE4,
            Path.LINETO,
            Path.CURVE4, Path.CURVE4, Path.CURVE4,
        ]
        path = Path(verts, codes)
        patch = PathPatch(path, facecolor=node_color[i], edgecolor='none',
                          alpha=0.55, linewidth=0, zorder=2)
        ax.add_patch(patch)
        cur_i += span_i
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=200, bbox_inches='tight', facecolor='white')
plt.close()
print('Saved chord_diagram.png')
