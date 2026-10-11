import pandas as pd
from pathlib import Path
path = Path('inputs/edge-weights-222222222222.xlsx')
print('exists:', path.exists(), 'size:', path.stat().st_size)
xl = pd.ExcelFile(path)
print('sheet names:', xl.sheet_names)
for sheet in xl.sheet_names:
    df = pd.read_excel(path, sheet_name=sheet)
    print(f'\n=== Sheet: {sheet} ===')
    print('shape:', df.shape)
    print('columns:', list(df.columns))
    print('dtypes:')
    print(df.dtypes)
    print('head:')
    print(df.head(10).to_string())

# %%

import pandas as pd
from pathlib import Path
path = Path('inputs/edge-weights-222222222222.xlsx')
df = pd.read_excel(path, sheet_name='Sheet 1')
print('Unique from (Gene):', sorted(df['from'].unique()))
print('Unique to (S):', sorted(df['to'].unique(), key=lambda x: int(x[1:])))
print('Value range:', df['value'].min(), '-', df['value'].max())
print('Total value:', df['value'].sum())
# Show all data
print(df.to_string())

# %%

import matplotlib
print(matplotlib.__version__)
import sys
# Check available packages
for pkg in ['holoviews', 'bokeh', 'plotly', 'matplotlib']:
    try:
        __import__(pkg)
        print(f'{pkg}: available')
    except ImportError:
        print(f'{pkg}: NOT available')

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
from matplotlib import cm
import pandas as pd
from pathlib import Path
# Load data
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx', sheet_name='Sheet 1')
# Define groups
genes = [f'Gene{i}' for i in range(1, 7)]      # right side
samples = [f'S{i}' for i in range(1, 11)]      # left side
# Order in the reference: S10 at top-left, S1 at bottom-left; Gene1 at top-right, Gene6 at bottom-right
# In a standard counterclockwise arrangement, top = pi/2 start, then going CCW
# We need to set up: genes on right (clockwise), samples on left (also clockwise in upper-left)
# Looking at reference: top-right Gene1, going clockwise: Gene2, Gene3, Gene4, Gene5, Gene6 at bottom-right
# Top-left S10, going clockwise (down the left side): S9, S8, ..., S1 at bottom-left
# This is a typical chord layout.
# Build totals per entity to size segments
totals = df.groupby('from')['value'].sum().to_dict()
for s in samples:
    totals[s] = df[df['to'] == s]['value'].sum()
# Print totals
print("Totals:")
for k in genes + samples:
    print(f'  {k}: {totals[k]:.1f}')
# Layout: place all entities around the circle in the desired visual order.
# Start angle = pi/2 (top), then go clockwise (which is negative angle direction in matplotlib)
# Order around circle (clockwise): S10 -> S9 -> S8 -> S7 -> S6 -> S5 -> S4 -> S3 -> S2 -> S1 -> Gene1 -> Gene2 -> Gene3 -> Gene4 -> Gene5 -> Gene6 -> back to S10
# That way top is S10 (left) and Gene1 (right), bottom is S1 (left) and Gene6 (right).
entities_order = ['S10', 'S9', 'S8', 'S7', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1',
                  'Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
total_sum = sum(totals[e] for e in entities_order)
print(f'Total: {total_sum:.1f}')
# Compute arc lengths proportional to totals (in degrees out of 360)
angles = {}
gap_deg = 1.5  # small gap between segments
n = len(entities_order)
total_gap = gap_deg * n
available = 360 - total_gap
for e in entities_order:
    angles[e] = available * totals[e] / total_sum
# Compute starting angle for each entity
# Start at top (90°), go clockwise => decreasing theta
start_angle = {}
theta = 90.0  # degrees
for e in entities_order:
    start_angle[e] = theta
    theta -= (angles[e] + gap_deg)
# Save for next cell
import json
config = {
    'entities_order': entities_order,
    'start_angle': start_angle,
    'arcs': angles,
    'genes': genes,
    'samples': samples,
    'totals': totals,
}
print(json.dumps(config, indent=2))

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
from matplotlib import cm
import pandas as pd
from pathlib import Path
import json
# Load data
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx', sheet_name='Sheet 1')
# Define groups
genes = [f'Gene{i}' for i in range(1, 7)]      # right side
samples = [f'S{i}' for i in range(1, 11)]      # left side
# Totals
totals = {}
for e in genes + samples:
    if e.startswith('Gene'):
        totals[e] = df[df['from'] == e]['value'].sum()
    else:
        totals[e] = df[df['to'] == e]['value'].sum()
# Order around circle (clockwise from top)
entities_order = ['S10', 'S9', 'S8', 'S7', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1',
                  'Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
total_sum = sum(totals[e] for e in entities_order)
# Compute arc lengths proportional to totals (in degrees)
gap_deg = 1.2
n = len(entities_order)
total_gap = gap_deg * n
available = 360 - total_gap
arcs_deg = {e: available * totals[e] / total_sum for e in entities_order}
# Starting angle (90° at top, clockwise => decreasing)
start_angle = {}
theta = 90.0
for e in entities_order:
    start_angle[e] = theta
    theta -= (arcs_deg[e] + gap_deg)
# Subdivide each entity arc by its connections
# We will allocate sub-arcs in order of the connections
# For each entity, list the connections in a stable order: connections sorted by partner
# Then compute sub_start[e] = list of sub-arc starts within entity e
# Build connection list for each entity
sub_arcs = {e: [] for e in entities_order}  # list of (partner, value, start_deg, end_deg) within entity
for e in entities_order:
    if e.startswith('Gene'):
        conns = df[df['from'] == e][['to', 'value']].values.tolist()
    else:
        conns = df[df['to'] == e][['from', 'value']].values.tolist()
    # Sort by partner name to keep deterministic
    conns.sort(key=lambda x: x[0])
    s = start_angle[e]
    # Allocate proportional to value within entity
    total_e = totals[e]
    cur = s
    for partner, v in conns:
        a = arcs_deg[e] * v / total_e
        sub_arcs[e].append({'partner': partner, 'value': v, 'start': cur, 'end': cur - a, 'span': a})
        cur -= a
# Now we can build the chord ribbons.
# For each connection (from -> to), the ribbon connects from the corresponding sub-arc on Gene to the corresponding sub-arc on Sample.
# Convert angle to (cos, sin) on the unit circle
def polar(theta_deg, r=1.0):
    t = np.deg2rad(theta_deg)
    return r * np.cos(t), r * np.sin(t)
# Build Bezier ribbon between two arcs.
# Idea: For each side, define 4 points on the inner ring (radius r_inner):
#   P1 = start of source arc at r_inner
#   P2 = end of source arc at r_inner
#   P3 = start of target arc at r_inner
#   P4 = end of target arc at r_inner
# Build a closed Path: P1 -> P2 -> Bezier(P2 -> P4) -> P4 -> P3 -> Bezier(P3 -> P1) -> P1
# Bezier control points are along the radial directions (toward center for concave shape)
def ribbon_path(src_start, src_end, tgt_start, tgt_end, r_inner=0.85):
    # Convert angles (degrees, clockwise) to radians for math
    # In matplotlib's coordinate system, x = r*cos(theta), y = r*sin(theta)
    # Going clockwise from top: angles decrease.
    # When we compute (cos, sin) using np.deg2rad, cos/sin expects radians in standard math convention.
    # That works fine for any angle - just use radians.
    def pt(ang, r):
        t = np.deg2rad(ang)
        return np.array([r * np.cos(t), r * np.sin(t)])
    p1 = pt(src_start, r_inner)  # outer corner of source start (going inward)
    p2 = pt(src_end, r_inner)
    p3 = pt(tgt_start, r_inner)
    p4 = pt(tgt_end, r_inner)
    # Control points: pulled toward center for a nice concave ribbon
    c1 = pt(src_start, 0.0)
    c2 = pt(src_end, 0.0)
    c3 = pt(tgt_start, 0.0)
    c4 = pt(tgt_end, 0.0)
    # Path: M p1 A(r1,r1,0,0,1,p2) C c2,c3,p4 A(r1,r1,0,0,1,p3) C c4,c1,p1 Z
    verts = [
        p1,
        # arc from p1 to p2 along r_inner (clockwise)
        # Matplotlib Arc: vertices need additional points along the arc since Path doesn't directly include ARC
        # Use enough segments
    ]
    # We'll build via NumPy arc points instead of ARC primitive
    def arc_pts(a0, a1, r, n=24):
        # Generate points from angle a0 to a1 going clockwise (decreasing) along circle of radius r
        # a0 > a1 (clockwise) so step is negative
        if a0 >= a1:
            ts = np.linspace(a0, a1, n)
        else:
            ts = np.linspace(a0, a1, n)
        return np.column_stack([r * np.cos(np.deg2rad(ts)), r * np.sin(np.deg2rad(ts))])
    pts_src = arc_pts(src_start, src_end, r_inner, n=24)
    pts_tgt = arc_pts(tgt_start, tgt_end, r_inner, n=24)
    # Bezier curve from end of src arc to start of tgt arc, with control points at center
    def bezier_pts(p_start, c_start, c_end, p_end, n=40):
        t = np.linspace(0, 1, n)[:, None]
        return ((1 - t) ** 3) * p_start + 3 * ((1 - t) ** 2) * t * c_start + 3 * (1 - t) * (t ** 2) * c_end + (t ** 3) * p_end
    bz1 = bezier_pts(pts_src[-1], c2, c3, pts_tgt[0], n=40)
    bz2 = bezier_pts(pts_tgt[-1], c4, c1, pts_src[0], n=40)
    verts = np.vstack([pts_src, bz1, pts_tgt, bz2])
    return verts
# Test with one connection
sample_test = sub_arcs['Gene1'][0]
print('First Gene1 connection:', sample_test)
print('Corresponding S10 sub-arc:', next(s for s in sub_arcs['S10'] if s['partner'] == 'Gene1'))
# Save sub_arcs and config to use in next cell
np.save('sub_arcs.npy', np.array(sub_arcs, dtype=object), allow_pickle=True)
with open('config.json', 'w') as f:
    json.dump({'start_angle': start_angle, 'arcs_deg': arcs_deg, 'entities_order': entities_order,
               'gap_deg': gap_deg, 'totals': totals}, f)
print('saved')

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
from matplotlib import cm
import pandas as pd
from pathlib import Path
import json
# Load data
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx', sheet_name='Sheet 1')
genes = [f'Gene{i}' for i in range(1, 7)]
samples = [f'S{i}' for i in range(1, 11)]
totals = {}
for e in genes + samples:
    if e.startswith('Gene'):
        totals[e] = df[df['from'] == e]['value'].sum()
    else:
        totals[e] = df[df['to'] == e]['value'].sum()
entities_order = ['S10', 'S9', 'S8', 'S7', 'S6', 'S5', 'S4', 'S3', 'S2', 'S1',
                  'Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
total_sum = sum(totals[e] for e in entities_order)
gap_deg = 1.2
n = len(entities_order)
total_gap = gap_deg * n
available = 360 - total_gap
arcs_deg = {e: available * totals[e] / total_sum for e in entities_order}
start_angle = {}
theta = 90.0
for e in entities_order:
    start_angle[e] = theta
    theta -= (arcs_deg[e] + gap_deg)
# Sub-arc allocations
sub_arcs = {e: [] for e in entities_order}
for e in entities_order:
    if e.startswith('Gene'):
        conns = df[df['from'] == e][['to', 'value']].values.tolist()
    else:
        conns = df[df['to'] == e][['from', 'value']].values.tolist()
    conns.sort(key=lambda x: x[0])
    s = start_angle[e]
    total_e = totals[e]
    cur = s
    for partner, v in conns:
        a = arcs_deg[e] * v / total_e
        sub_arcs[e].append({'partner': partner, 'value': v, 'start': cur, 'end': cur - a, 'span': a})
        cur -= a
# Colors: assign from a palette. Reference shows pastel colors.
# We want distinct colors per entity. Use a known palette.
palette_colors = [
    '#7FBF7F',  # S10 - green
    '#E6D089',  # S9 - yellow
    '#C77DC7',  # S8 - magenta
    '#9D85C0',  # S7 - purple
    '#A8D8B9',  # S6 - mint
    '#B57F7F',  # S5 - brownish
    '#9C8F73',  # S4 - olive
    '#D62728',  # S3 - red
    '#83C7B6',  # S2 - teal
    '#6F8FAF',  # S1 - blue
    '#1F77B4',  # Gene1 - blue
    '#D14B4B',  # Gene2 - red
    '#2CA02C',  # Gene3 - green
    '#3F4F8F',  # Gene4 - navy
    '#FF7F0E',  # Gene5 - orange
    '#9467BD',  # Gene6 - violet
]
ent_color = dict(zip(entities_order, palette_colors))
# Chord colors: use source (Gene) color with some transparency, or sample-side color
# Reference: chord ribbons are colored according to the source side (Gene)
# Helper: arc points on a circle
def arc_pts(a0, a1, r, n=24):
    # a0..a1 going clockwise (a0 > a1) - we always have a0 >= a1 here
    ts = np.linspace(a0, a1, n)
    return np.column_stack([r * np.cos(np.deg2rad(ts)), r * np.sin(np.deg2rad(ts))])
def bezier_pts(p_start, c_start, c_end, p_end, n=40):
    t = np.linspace(0, 1, n)[:, None]
    return ((1 - t) ** 3) * p_start + 3 * ((1 - t) ** 2) * t * c_start + 3 * (1 - t) * (t ** 2) * c_end + (t ** 3) * p_end
def pt(ang, r):
    t = np.deg2rad(ang)
    return np.array([r * np.cos(t), r * np.sin(t)])
def ribbon_path(src_start, src_end, tgt_start, tgt_end, r_inner=0.85):
    c2 = pt(src_end, 0.0)
    c3 = pt(tgt_start, 0.0)
    c4 = pt(tgt_end, 0.0)
    c1 = pt(src_start, 0.0)
    pts_src = arc_pts(src_start, src_end, r_inner, n=24)
    pts_tgt = arc_pts(tgt_start, tgt_end, r_inner, n=24)
    bz1 = bezier_pts(pts_src[-1], c2, c3, pts_tgt[0], n=40)
    bz2 = bezier_pts(pts_tgt[-1], c4, c1, pts_src[0], n=40)
    verts = np.vstack([pts_src, bz1, pts_tgt, bz2])
    return verts
# Build figure
fig, ax = plt.subplots(figsize=(10, 10))
ax.set_aspect('equal')
ax.axis('off')
fig.patch.set_facecolor('white')
R_OUTER = 1.0
R_INNER = 0.85  # inner ring starts at this radius
R_LABEL = 1.13
# Draw outer ring segments (colored arcs)
for e in entities_order:
    a0 = start_angle[e]
    a1 = a0 - arcs_deg[e]
    # Generate wedge
    n_seg = max(int(arcs_deg[e] * 2) + 1, 12)
    ts = np.linspace(a0, a1, n_seg)
    xs_out = R_OUTER * np.cos(np.deg2rad(ts))
    ys_out = R_OUTER * np.sin(np.deg2rad(ts))
    xs_in = R_INNER * np.cos(np.deg2rad(ts[::-1]))
    ys_in = R_INNER * np.sin(np.deg2rad(ts[::-1]))
    xs = np.concatenate([xs_out, xs_in])
    ys = np.concatenate([ys_out, ys_in])
    ax.fill(xs, ys, color=ent_color[e], ec='white', lw=1.5, zorder=2)
# Draw tick marks: 0, 30, 60 (in arc-length units of the segment)
# Reference shows ticks at 0, 30, 60 for each segment
# We'll place radial tick marks at the segment's outer edge at positions 0, 30, 60 along the arc
# But the ticks in the reference appear to be radial lines (not radial ticks) — they go outward from the outer arc.
# Looking more carefully: the reference shows numeric labels "0", "30", "60" along the inner edge or just outside.
# Looking again: ticks are small radial lines at distance positions. Each segment shows "0", "30", "60"
# These appear to be positioned on the segment arc, going outward from the inner ring to the outer ring.
# I'll add radial tick marks at 0, 30, 60 within each segment.
for e in entities_order:
    a0 = start_angle[e]
    a1 = a0 - arcs_deg[e]
    arc_len = arcs_deg[e]  # in degrees; the total arc spans arcs_deg
    # We need to place ticks where the cumulative value along the segment equals 0, 30, 60
    # The total of entity e is totals[e], and arcs_deg[e] is proportional to totals[e]
    # So at value v (cumulative from start), the angular position = a0 - (v/totals[e]) * arcs_deg[e]
    total_e = totals[e]
    for v in [0, 30, 60]:
        if v > total_e + 0.01:
            continue
        offset = (v / total_e) * arcs_deg[e]
        a = a0 - offset
        # Draw tick line from r=0.92 to r=1.04 (radial outward)
        x1, y1 = pt(a, R_INNER - 0.02)
        x2, y2 = pt(a, R_OUTER + 0.04)
        ax.plot([x1, x2], [y1, y2], color='black', lw=0.8, zorder=3)
        # Label
        lx, ly = pt(a, R_OUTER + 0.06)
        # Rotate label for legibility (pointing outward)
        ang_lbl = np.deg2rad(a)
        # Position perpendicular to the radial direction
        # Place text slightly offset to avoid overlap with segment
        ax.text(lx, ly, str(v), fontsize=7, ha='center', va='center', zorder=4,
                color='black', rotation=np.rad2deg(ang_lbl))
# Draw chord ribbons
# Process each Gene-Sample pair once
chord_alphas = []
for _, row in df.iterrows():
    src = row['from']  # Gene
    tgt = row['to']    # Sample
    val = row['value']
    # Find the sub-arc on each side
    src_sub = next(s for s in sub_arcs[src] if s['partner'] == tgt)
    tgt_sub = next(s for s in sub_arcs[tgt] if s['partner'] == src)
    verts = ribbon_path(src_sub['start'], src_sub['end'], tgt_sub['start'], tgt_sub['end'], r_inner=R_INNER)
    color = ent_color[src]
    ax.fill(verts[:, 0], verts[:, 1], color=color, alpha=0.35, lw=0, zorder=1)
# Draw outer labels
for e in entities_order:
    mid = start_angle[e] - arcs_deg[e] / 2
    lx, ly = pt(mid, R_LABEL)
    # Determine rotation so text is along the radius, pointing outward
    # In matplotlib, x = r*cos(theta), y = r*sin(theta) (theta in radians, mathematical convention)
    # Our angles are in degrees with the convention: 90° = top, decreasing clockwise
    # Convert to math angle: angle_math = 90 - a (since cos(90-a) = sin(a), sin(90-a) = cos(a)) — wait let me reconsider
    # Actually np.cos(np.deg2rad(a)) gives x, np.sin gives y. So if a=90, x=0, y=1 (top). If a=0, x=1, y=0 (right). If a=-90, x=0, y=-1 (bottom).
    # So our "a" in degrees directly corresponds to mathematical angle measured counterclockwise from positive x-axis when interpreted as standard math angle? Let's see: a=90 means x=cos(90)=0, y=sin(90)=1 -> top. a=0 -> x=cos(0)=1, y=sin(0)=0 -> right. a=-90 -> x=cos(-90)=0, y=sin(-90)=-1 -> bottom.
    # So yes, a is the standard math angle.
    rot = mid  # rotation in degrees, same as the math angle
    if rot > 90:
        rot -= 180
    elif rot < -90:
        rot += 180
    # Place text
    ha = 'center'
    va = 'center'
    ax.text(lx, ly, e, fontsize=14, ha=ha, va=va, rotation=rot,
            rotation_mode='anchor', zorder=5)
ax.set_xlim(-1.3, 1.3)
ax.set_ylim(-1.3, 1.3)
plt.tight_layout()
out_path = 'chord_diagram.png'
plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor='white')
plt.close()
print('saved', out_path)
import os
print('size:', os.path.getsize(out_path))
