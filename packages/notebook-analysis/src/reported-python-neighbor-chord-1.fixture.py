# Redraw using a regular (non-polar) matplotlib axes so the Bezier ribbons render cleanly.
import numpy as np
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.path import Path
from matplotlib.patches import PathPatch, Wedge, Circle
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
# Color palette inspired by the reference (muted, distinguishable)
node_color_map = {
    'Gene1': '#5BB5A2',  # teal/green
    'Gene2': '#E76F51',  # coral
    'Gene3': '#2A9D8F',  # dark teal
    'Gene4': '#457B9D',  # blue
    'Gene5': '#E5989B',  # pink/salmon
    'Gene6': '#A8A29E',  # warm gray
    'S1':    '#E63946',  # red
    'S2':    '#9D8189',  # mauve
    'S3':    '#6A994E',  # green
    'S4':    '#8B5E3C',  # brown
    'S5':    '#A47551',  # tan
    'S6':    '#7E6C8A',  # purple-gray
    'S7':    '#C9ADA7',  # dusty rose
    'S8':    '#9B5DE5',  # purple
    'S9':    '#F15BB5',  # pink
    'S10':   '#FEE440',  # yellow
}
node_color = [node_color_map[name] for name in order]
n_genes = len(genes)
gap_between_groups = np.deg2rad(3.0)
small_intra_gap = np.deg2rad(0.6)
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
# Use a regular Cartesian axes for clean ribbon rendering
fig, ax = plt.subplots(figsize=(12, 12))
ax.set_aspect('equal')
ax.set_axis_off()
ax.set_xlim(-1.4, 1.4)
ax.set_ylim(-1.4, 1.4)
r_outer = 1.0
r_inner_arc = 0.93
def pol2cart(theta, r):
    # theta is measured clockwise from the top (12 o'clock)
    x = r * np.sin(theta)
    y = r * np.cos(theta)
    return x, y
# Outer arcs (each segment)
for i, name in enumerate(order):
    theta1 = starts[i]
    theta2 = starts[i] + extents[i]
    # Build arc points
    n_arc = max(int(np.degrees(theta2 - theta1) / 0.5), 6)
    ts = np.linspace(theta1, theta2, n_arc)
    xs_outer = [pol2cart(t, r_outer)[0] for t in ts]
    ys_outer = [pol2cart(t, r_outer)[1] for t in ts]
    xs_inner = [pol2cart(t, r_inner_arc)[0] for t in ts]
    ys_inner = [pol2cart(t, r_inner_arc)[1] for t in ts]
    # Build path: outer arc forward, inner arc backward
    verts = list(zip(xs_outer, ys_outer)) + list(zip(reversed(xs_inner), reversed(ys_inner)))
    codes = [Path.MOVETO] + [Path.LINETO] * (len(verts) - 2) + [Path.CLOSEPOLY]
    patch = PathPatch(Path(verts, codes), facecolor=node_color[i],
                      edgecolor='white', linewidth=1.4, alpha=0.95)
    ax.add_patch(patch)
    # External label
    mid = starts[i] + extents[i] / 2
    lx, ly = pol2cart(mid, r_outer + 0.07)
    deg = np.degrees(mid)
    rot_deg = -deg
    if 90 < deg < 270:
        rot_deg = 180 - deg
    ax.text(lx, ly, name, rotation=rot_deg, ha='center', va='center',
            fontsize=13, color='black')
# Ticks at 0 and half cumulative value
for i in range(n):
    for frac in (0.0, 0.5):
        ang = starts[i] + extents[i] * frac
        x1, y1 = pol2cart(ang, r_inner_arc - 0.005)
        x2, y2 = pol2cart(ang, r_inner_arc - 0.05)
        ax.plot([x1, x2], [y1, y2], color='gray', linewidth=0.8, zorder=4)
        val = frac * row_sum[i]
        tx, ty = pol2cart(ang, r_inner_arc - 0.10)
        ax.text(tx, ty, f'{val:.0f}', fontsize=7,
                ha='center', va='center', color='gray')
# Ribbons
for i in range(n):
    neighbors = sorted([(j, M[i, j]) for j in range(n) if M[i, j] > 0 and j != i],
                       key=lambda x: x[0])
    cur_i = starts[i]
    for j, val in neighbors:
        frac_i = val / row_sum[i]
        span_i = extents[i] * frac_i
        a1 = cur_i
        a2 = cur_i + span_i
        j_neighbors = sorted([(k, M[j, k]) for k in range(n) if M[j, k] > 0 and k != j],
                             key=lambda x: x[0])
        cum = 0.0
        for k, val_k in j_neighbors:
            if k == i:
                break
            cum += val_k / row_sum[j]
        span_j_start = starts[j] + extents[j] * cum
        b1 = span_j_start
        b2 = b1 + extents[j] * (val / row_sum[j])
        # Sample points along inner arc on each side
        n_sample_i = max(int(np.degrees(span_i) / 0.4), 4)
        n_sample_j = max(int(np.degrees(b2 - b1) / 0.4), 4)
        arc_i = [pol2cart(t, r_inner_arc) for t in np.linspace(a1, a2, n_sample_i)]
        arc_j = [pol2cart(t, r_inner_arc) for t in np.linspace(b1, b2, n_sample_j)]
        # Bezier curve from end of arc_i (last point) to start of arc_j (first point) using control at origin
        def cubic_to(p0, p1, c1=(0, 0), c2=(0, 0), steps=40):
            ts = np.linspace(0, 1, steps)
            pts = []
            for t in ts:
                x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * c1[0] + 3 * (1 - t) * t ** 2 * c2[0] + t ** 3 * p1[0]
                y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * c1[1] + 3 * (1 - t) * t ** 2 * c2[1] + t ** 3 * p1[1]
                pts.append((x, y))
            return pts
        # Build the ribbon perimeter: arc_i forward, curve to arc_j, arc_j forward (in reverse), curve back to arc_i start
        c_out = cubic_to(arc_i[-1], arc_j[0])
        c_back = cubic_to(arc_j[-1], arc_i[0])
        perimeter = arc_i + c_out + list(arc_j) + c_back
        verts = perimeter
        codes = [Path.MOVETO] + [Path.LINETO] * (len(verts) - 2) + [Path.CLOSEPOLY]
        patch = PathPatch(Path(verts, codes), facecolor=node_color[i],
                          edgecolor='none', alpha=0.55, linewidth=0, zorder=2)
        ax.add_patch(patch)
        cur_i += span_i
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=200, bbox_inches='tight', facecolor='white')
plt.close()
print('Saved chord_diagram.png')
