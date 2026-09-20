import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import Wedge, Arc, FancyArrowPatch, Polygon
from matplotlib.path import Path
import matplotlib.patches as patches
import numpy as np
import pandas as pd
# Load data
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
# Compute segment sizes
gene_names = ['Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
sample_names = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
all_names = gene_names + sample_names
sizes = {}
for n in gene_names:
    sizes[n] = df[df['from'] == n]['value'].sum()
for n in sample_names:
    sizes[n] = df[df['to'] == n]['value'].sum()
# Colors
colors_map = {
    'Gene1': '#4E9DAB', 'Gene2': '#E26A52', 'Gene3': '#41AE7B',
    'Gene4': '#5B6E94', 'Gene5': '#F4A582', 'Gene6': '#9C9C9C',
    'S1': '#8FCFA9', 'S2': '#E16462', 'S3': '#9C5E5E',
    'S4': '#9F8A66', 'S5': '#92C2C2', 'S6': '#9DB1D2',
    'S7': '#A992C9', 'S8': '#C58CB3', 'S9': '#E0A0A0', 'S10': '#7FB069'
}
total = sum(sizes.values())
gap = 1.0  # degrees
# Compute segment angles - clockwise from top
start_angle = 90
angles = {}
current = start_angle
for n in all_names:
    extent = (sizes[n] / total) * 360
    angles[n] = (current, current + extent - gap)
    current += extent
# Compute ribbon positions: for each (source, target, value) record,
# we need to subdivide the source segment by value of each target,
# and similarly for target segment.
# Sort records by source then by target for consistent ribbon stacking
records = df.sort_values(['from', 'to']).to_dict('records')
# Build offset trackers
src_offsets = {n: angles[n][0] for n in all_names}
tgt_offsets = {n: angles[n][0] for n in all_names}
# We will assign ribbon positions based on cumulative value
ribbon_positions = []
for rec in records:
    src, tgt, val = rec['from'], rec['to'], rec['value']
    src_start_angle = src_offsets[src]
    src_extent = (val / sizes[src]) * (angles[src][1] - angles[src][0])
    src_end_angle = src_start_angle + src_extent
    src_offsets[src] = src_end_angle

    tgt_start_angle = tgt_offsets[tgt]
    tgt_extent = (val / sizes[tgt]) * (angles[tgt][1] - angles[tgt][0])
    tgt_end_angle = tgt_start_angle + tgt_extent
    tgt_offsets[tgt] = tgt_end_angle

    ribbon_positions.append({
        'src': src, 'tgt': tgt, 'val': val,
        'src_a': (src_start_angle, src_end_angle),
        'tgt_a': (tgt_start_angle, tgt_end_angle),
        'color': colors_map[src]
    })
print(f"Number of ribbons: {len(ribbon_positions)}")
print("First few:")
for r in ribbon_positions[:5]:
    print(r)

# %%

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import Wedge, Arc, FancyArrowPatch, Polygon
from matplotlib.path import Path
import matplotlib.patches as patches
import numpy as np
import pandas as pd
# Helper: convert angle (degrees, clockwise from top) to coordinates on circle
def angle_to_xy(angle_deg, radius):
    # 0° is at top (y=+), increasing clockwise
    # angle in standard math: angle_rad = pi/2 - angle_deg * pi/180
    a = np.deg2rad(90 - angle_deg)
    return (radius * np.cos(a), radius * np.sin(a))
# Compute sample segment along an arc at radius r for an angle span
def arc_points(angle_start, angle_end, radius, n=40):
    angles = np.linspace(angle_start, angle_end, n)
    pts = [angle_to_xy(a, radius) for a in angles]
    return pts
# Build the chord ribbon between two angle spans
def chord_quadrilateral(src_a, tgt_a, r_inner, r_outer, color, alpha=0.55, lw=0.4):
    # src_a, tgt_a are (start, end) angles in degrees
    # Source side: outer edge
    src_outer = arc_points(src_a[0], src_a[1], r_outer)
    src_inner = arc_points(src_a[1], src_a[0], r_inner)
    tgt_outer = arc_points(tgt_a[0], tgt_a[1], r_outer)
    tgt_inner = arc_points(tgt_a[1], tgt_a[0], r_inner)

    # Build polygon: source arc forward, target arc forward, source arc back
    # Use bezier curves for smoother ribbons
    s_start = angle_to_xy(src_a[0], r_outer)
    s_end = angle_to_xy(src_a[1], r_outer)
    s_inner_start = angle_to_xy(src_a[0], r_inner)
    s_inner_end = angle_to_xy(src_a[1], r_inner)
    t_start = angle_to_xy(tgt_a[0], r_outer)
    t_end = angle_to_xy(tgt_a[1], r_outer)
    t_inner_start = angle_to_xy(tgt_a[0], r_inner)
    t_inner_end = angle_to_xy(tgt_a[1], r_inner)

    # Path with bezier curves for ribbons
    verts = []
    codes = []

    # Start at src outer start
    verts.append(s_start)
    codes.append(Path.MOVETO)
    # Bezier curve along src outer arc
    verts.append(((s_start[0] + s_end[0]) / 2, (s_start[1] + s_end[1]) / 2))
    codes.append(Path.CURVE3)
    verts.append(s_end)
    codes.append(Path.CURVE3)
    # Bezier curve from src outer end to tgt outer end (cross-circle)
    # Use a control point near origin
    verts.append(((s_end[0] + t_end[0]) / 2, (s_end[1] + t_end[1]) / 2))
    codes.append(Path.CURVE3)
    verts.append(t_end)
    codes.append(Path.CURVE3)
    # Bezier curve along tgt outer arc (reversed)
    verts.append(((t_end[0] + t_start[0]) / 2, (t_end[1] + t_start[1]) / 2))
    codes.append(Path.CURVE3)
    verts.append(t_start)
    codes.append(Path.CURVE3)
    # Bezier curve from tgt outer start back to src outer start (cross-circle)
    verts.append(((t_start[0] + s_start[0]) / 2, (t_start[1] + s_start[1]) / 2))
    codes.append(Path.CURVE3)
    verts.append(s_start)
    codes.append(Path.CURVE3)

    path = Path(verts, codes)
    return patches.PathPatch(path, facecolor=color, alpha=alpha, edgecolor='none', lw=lw)
# Build the figure
fig, ax = plt.subplots(figsize=(11, 11), dpi=110)
ax.set_xlim(-1.5, 1.5)
ax.set_ylim(-1.5, 1.5)
ax.set_aspect('equal')
ax.axis('off')
R_OUTER = 1.0
R_INNER = 0.86  # inner radius where ribbons connect
R_LABEL = 1.08
R_TICK = 1.03
# Draw ribbons first (below segments)
for r in ribbon_positions:
    ribbon = chord_quadrilateral(r['src_a'], r['tgt_a'], 0, R_INNER,
                                  r['color'], alpha=0.55, lw=0.2)
    ax.add_patch(ribbon)
# Draw outer ring segments
for n in all_names:
    start, end = angles[n]
    # matplotlib Wedge uses theta in degrees, theta1 to theta2 in counter-clockwise
    # We need to convert from our clockwise-from-top to matplotlib's counter-clockwise-from-east
    # Our angle 90 = top, 0 = right. matplotlib theta=0 = right (east), increases counter-clockwise
    # To convert: theta_mpl = 90 - angle
    theta1 = 90 - end
    theta2 = 90 - start
    wedge = Wedge((0, 0), R_OUTER, theta1, theta2, width=R_OUTER-R_INNER,
                  facecolor=colors_map[n], edgecolor='white', linewidth=1.5)
    ax.add_patch(wedge)
# Draw ticks for value scale (0, 30, 60) on each segment
for n in all_names:
    start, end = angles[n]
    extent = end - start
    s = sizes[n]
    # Tick positions: 0, 30, 60 (only if within range)
    max_tick = min(60, s)
    tick_values = [0, 30, 60]
    tick_values = [v for v in tick_values if v <= s]

    mid_angle = (start + end) / 2  # mid-point of segment

    for v in tick_values:
        # Angle offset within segment
        offset = (v / s) * extent
        tick_angle = start + offset
        # Draw a small radial line outward
        x1, y1 = angle_to_xy(tick_angle, R_OUTER)
        x2, y2 = angle_to_xy(tick_angle, R_TICK)
        ax.plot([x1, x2], [y1, y2], color='black', lw=0.8, zorder=5)
        # Tick label
        lx, ly = angle_to_xy(tick_angle, R_TICK + 0.04)
        ax.text(lx, ly, str(v), ha='center', va='center', fontsize=8, zorder=6)
# Draw segment labels
for n in all_names:
    start, end = angles[n]
    mid_angle = (start + end) / 2
    lx, ly = angle_to_xy(mid_angle, R_LABEL)
    # Rotate text based on angle to keep readable
    text_angle = mid_angle
    if 90 < text_angle < 270:
        rotation = text_angle - 180  # flip for readability on left side
        ha_align = 'right'
    elif text_angle == 90 or text_angle == 270:
        rotation = 0
        ha_align = 'center'
    else:
        rotation = text_angle
        ha_align = 'left'
    # Special case: very close to top/bottom
    if 80 < text_angle < 100:
        rotation = 0
        ha_align = 'center'
    elif 260 < text_angle < 280:
        rotation = 0
        ha_align = 'center'

    # Apply rotation considering text orientation
    # Convert our clockwise-from-top angle to standard rotation
    rot_deg = -rotation if ha_align == 'right' else rotation
    ax.text(lx, ly, n, ha='center', va='center', fontsize=13, fontweight='normal',
            rotation=rot_deg, rotation_mode='anchor', zorder=7)
plt.title('Chord Diagram: Gene–Sample', fontsize=15, pad=20)
plt.savefig('chord_diagram.png', dpi=120, bbox_inches='tight', facecolor='white')
plt.show()
print('saved chord_diagram.png')
