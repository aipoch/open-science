import openpyxl
import os
# Get the path from the notebook inputs context
input_path = "inputs/edge-weights-222222222222.xlsx"
print(f"File exists: {os.path.exists(input_path)}")
print(f"File size: {os.path.getsize(input_path)} bytes")
# Open the workbook
wb = openpyxl.load_workbook(input_path, data_only=True)
print(f"Sheets: {wb.sheetnames}")
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    print(f"\n=== Sheet: {sheet_name} ===")
    print(f"Dimensions: {ws.dimensions}")
    print(f"Max row: {ws.max_row}, Max col: {ws.max_column}")

    # Print first 15 rows
    for i, row in enumerate(ws.iter_rows(values_only=True), 1):
        if i <= 15:
            print(f"Row {i}: {row}")

# %%

import pandas as pd
# Use pandas with openpyxl engine to bypass the drawing issue
input_path = "inputs/edge-weights-222222222222.xlsx"
# Try reading with pandas
df = pd.read_excel(input_path, sheet_name=None)
print(f"Sheet names: {list(df.keys())}")
for sheet_name, sheet_df in df.items():
    print(f"\n=== Sheet: {sheet_name} ===")
    print(f"Shape: {sheet_df.shape}")
    print(f"Columns: {sheet_df.columns.tolist()}")
    print(sheet_df.head(20))

# %%

import pandas as pd
import numpy as np
input_path = "inputs/edge-weights-222222222222.xlsx"
df = pd.read_excel(input_path, sheet_name="Sheet 1")
print("Unique 'from' values:", sorted(df['from'].unique()))
print("Unique 'to' values:", sorted(df['to'].unique()))
print(f"Total rows: {len(df)}")
print(f"\nFull data:")
print(df.to_string())

# %%

import pandas as pd
import numpy as np
input_path = "inputs/edge-weights-222222222222.xlsx"
df = pd.read_excel(input_path, sheet_name="Sheet 1")
# Pivot to matrix: rows = Genes, columns = Samples
genes_order = [f"Gene{i}" for i in range(1, 7)]
samples_order = [f"S{i}" for i in range(1, 11)]
matrix = df.pivot(index="from", columns="to", values="value").reindex(index=genes_order, columns=samples_order).fillna(0)
print("Matrix shape:", matrix.shape)
print(matrix)
print(f"\nRow sums (Genes): {matrix.sum(axis=1).tolist()}")
print(f"Col sums (Samples): {matrix.sum(axis=0).tolist()}")

# %%

import pandas as pd
import numpy as np
input_path = "inputs/edge-weights-222222222222.xlsx"
df = pd.read_excel(input_path, sheet_name="Sheet 1")
genes_order = [f"Gene{i}" for i in range(1, 7)]
samples_order = [f"S{i}" for i in range(1, 11)]
labels = genes_order + samples_order
n = len(labels)
N = len(genes_order)
# Build full symmetric matrix
mat = np.zeros((n, n))
for _, row in df.iterrows():
    gi = genes_order.index(row['from'])
    si = N + samples_order.index(row['to'])
    val = float(row['value'])
    mat[gi, si] = val
    mat[si, gi] = val
print("Full matrix shape:", mat.shape)
print("Labels:", labels)
print("Diagonal sum (total):", np.trace(mat))
# Save for next step
np.save("/tmp/chord_mat.npy", mat)
with open("/tmp/chord_labels.txt", "w") as f:
    for l in labels:
        f.write(l + "\n")
print("Saved")

# %%

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from matplotlib import patches as mpatches
from matplotlib.path import Path
import matplotlib.patches as patches
import os, sys
print("CWD:", os.getcwd())
input_path = "inputs/edge-weights-222222222222.xlsx"
df = pd.read_excel(input_path, sheet_name="Sheet 1")
genes_order = [f"Gene{i}" for i in range(1, 7)]
samples_order = [f"S{i}" for i in range(1, 11)]
labels = genes_order + samples_order
n = len(labels)
N = len(genes_order)
# Build full symmetric matrix
mat = np.zeros((n, n))
for _, row in df.iterrows():
    gi = genes_order.index(row['from'])
    si = N + samples_order.index(row['to'])
    val = float(row['value'])
    mat[gi, si] = val
    mat[si, gi] = val
print("mat shape:", mat.shape)
print("Row sums:", mat.sum(axis=1))

# %%

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
input_path = "inputs/edge-weights-222222222222.xlsx"
df = pd.read_excel(input_path, sheet_name="Sheet 1")
genes_order = [f"Gene{i}" for i in range(1, 7)]
samples_order = [f"S{i}" for i in range(1, 11)]
labels = genes_order + samples_order
n = len(labels)
N = len(genes_order)
# Build full symmetric matrix
mat = np.zeros((n, n))
for _, row in df.iterrows():
    gi = genes_order.index(row['from'])
    si = N + samples_order.index(row['to'])
    val = float(row['value'])
    mat[gi, si] = val
    mat[si, gi] = val
# ---------- Compute node sizes (sum of flows per node) ----------
node_sum = mat.sum(axis=1)
total = node_sum.sum()
# ---------- Colors ----------
# Genes (right half) - cool/red palette like reference
gene_colors = ['#5BB6CD', '#E26B5A', '#3FB39A', '#4A6B92', '#E89A87', '#9DA8B8']
# Samples (left half) - distinct colors like reference
sample_colors = ['#D34A3F', '#84C7B5', '#A53A3A', '#7A6B5A', '#5BB6A8', '#9C8CB8',
                 '#8FA8C7', '#7AB89C', '#C9B57A', '#5DBE6E']
node_colors = gene_colors + sample_colors
# ---------- Layout: place labels around circle ----------
# Genes start at top-right and go clockwise; Samples on the left side
# Reference shows: S1..S10 on left (counter-clockwise from bottom-left),
# Gene1..Gene6 on right (top-right going clockwise)
# We'll lay them out so the boundary is at the top (angle=0 at 12 o'clock, going clockwise)
# So that boundary: between last gene (Gene6) at bottom-right and first sample (S1) at bottom-left
# Use angles with gap at top
gap_deg = 4  # small gap at top boundary
usable = 360 - gap_deg
# Genes occupy right half (top to bottom), Samples occupy left half (bottom to top)
# Order clockwise starting from angle = gap_deg/2
start_angle = gap_deg / 2  # starting angle (degrees, measured from top going clockwise)
# Compute node span sizes proportional to node_sum
node_span = node_sum / total * usable
# Position nodes clockwise: first Genes (right side), then Samples (left side)
positions = []
angle_cursor = start_angle
for i in range(n):
    span = node_span[i]
    # Mid-angle of this node (degrees clockwise from top)
    mid = angle_cursor + span / 2
    positions.append({'start': angle_cursor, 'end': angle_cursor + span, 'mid': mid, 'span': span})
    angle_cursor += span
# Convert to radians for plotting (matplotlib: 0 at 3 o'clock, ccw positive)
# We use: angle measured clockwise from top (12 o'clock)
# Convert: theta = 90 - alpha (degrees in math), with ccw = positive y up but matplotlib y is inverted on plots
# Simpler: define a helper
def angle_to_xy(angle_deg, r):
    """angle_deg: 0 at top, increasing clockwise"""
    rad = np.deg2rad(90 - angle_deg)  # standard math angle
    return r * np.cos(rad), r * np.sin(rad)
# ---------- Draw figure ----------
fig, ax = plt.subplots(figsize=(8, 8), dpi=120)
ax.set_xlim(-1.3, 1.3)
ax.set_ylim(-1.3, 1.3)
ax.set_aspect('equal')
ax.axis('off')
fig.patch.set_facecolor('white')
R = 1.0  # outer radius of arcs
GAP_PAD = 0.008  # small gap between arcs
# ---------- Draw node arcs ----------
for i, pos in enumerate(positions):
    a0 = pos['start'] + GAP_PAD
    a1 = pos['end'] - GAP_PAD
    # Arc angles
    t0 = np.deg2rad(90 - a0)
    t1 = np.deg2rad(90 - a1)
    # matplotlib arc: theta1, theta2 go ccw
    arc = mpatches.Wedge((0, 0), R, np.rad2deg(t1), np.rad2deg(t0),
                         width=R * 0.08, facecolor=node_colors[i], edgecolor='white', linewidth=1.2)
    ax.add_patch(arc)
# ---------- Draw ribbons (chords) ----------
def ribbon_patch(angle0_start, angle0_end, angle1_start, angle1_end, color, alpha=0.55, r=R*0.92):
    """Draw a curved ribbon connecting arc on node A (angle0_start..end) to node B (angle1_start..end).
    Both angles in clockwise-from-top convention. r = inner radius where ribbon attaches."""
    # Convert to math angles
    t0s = np.deg2rad(90 - angle0_start)
    t0e = np.deg2rad(90 - angle0_end)
    t1s = np.deg2rad(90 - angle1_start)
    t1e = np.deg2rad(90 - angle1_end)

    p0 = (r * np.cos(t0s), r * np.sin(t0s))
    p1 = (r * np.cos(t0e), r * np.sin(t0e))
    p2 = (r * np.cos(t1e), r * np.sin(t1e))
    p3 = (r * np.cos(t1s), r * np.sin(t1s))

    # Control points pull toward origin
    ctrl_r = r * 0.15
    c0 = (ctrl_r * np.cos(t0s), ctrl_r * np.sin(t0s))
    c1 = (ctrl_r * np.cos(t0e), ctrl_r * np.sin(t0e))
    c2 = (ctrl_r * np.cos(t1e), ctrl_r * np.sin(t1e))
    c3 = (ctrl_r * np.cos(t1s), ctrl_r * np.sin(t1s))

    verts = [p0, c0, c1, p1, p2, c2, c3, p3, p0]
    codes = [Path.MOVETO, Path.CURVE4, Path.CURVE4, Path.CURVE4,
             Path.LINETO, Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.CLOSEPOLY]
    path = Path(verts, codes)
    patch = mpatches.PathPatch(path, facecolor=color, edgecolor='white', linewidth=0.3, alpha=alpha)
    return patch
# For each pair (i, j) with i < j and mat[i,j] > 0, draw ribbon
# Use the color of source node for the ribbon (matching reference where ribbon tints follow source)
for i in range(n):
    for j in range(i + 1, n):
        val = mat[i, j]
        if val <= 0:
            continue
        # Determine segment spans within each node based on cumulative connections
        # Order connections for node i by j, and assign sub-spans
        pass
# To match the reference more closely, we need to subdivide each node's arc by the connections
# Build a list of (node_idx, partner_idx, value) and assign sub-angles per node
node_uses = {i: [] for i in range(n)}
for i in range(n):
    for j in range(i + 1, n):
        if mat[i, j] > 0:
            node_uses[i].append((j, mat[i, j]))
            node_uses[j].append((i, mat[i, j]))
# For each node, sort partners by some order (the order they appear in j list) and subdivide arc proportionally
node_segments = {i: [] for i in range(n)}  # list of (partner, start, end)
for i in range(n):
    uses = node_uses[i]
    if not uses:
        continue
    # Keep original order
    total_i = sum(v for _, v in uses)
    cursor = positions[i]['start'] + GAP_PAD
    inner = positions[i]['end'] - GAP_PAD - positions[i]['start'] - GAP_PAD  # usable arc inside
    # The total inside-gap arc
    arc_total = positions[i]['span'] - 2 * GAP_PAD
    for k, (partner, v) in enumerate(uses):
        seg_span = v / total_i * arc_total
        # Add small gap between segments except after the last one
        seg_gap = GAP_PAD * 0.3 if k < len(uses) - 1 else 0
        seg_start = cursor
        seg_end = cursor + seg_span - seg_gap
        node_segments[i].append((partner, seg_start, seg_end))
        cursor = seg_end + seg_gap
# Draw ribbons
for i in range(n):
    for partner, s, e in node_segments[i]:
        # Find partner's segment for i
        for p2, s2, e2 in node_segments[partner]:
            if p2 == i:
                # Draw ribbon from (s,e) at node i to (s2,e2) at node partner
                # Color: use node i's color (source)
                col = node_colors[i]
                rib = ribbon_patch(s, e, s2, e2, col, alpha=0.65, r=R*0.92)
                ax.add_patch(rib)
                break
# ---------- Draw outer tick marks and scale labels ----------
# Outer radius for ticks
R_outer = R + 0.05
R_label = R + 0.12
for i, pos in enumerate(positions):
    # Place outer text label at mid angle
    mid = pos['mid']
    tx, ty = angle_to_xy(mid, R_label)
    rot = mid  # rotate so text aligns with the angle
    # Adjust rotation so text reads outside-out
    # If mid is between 90 and 270 (right side), flip text
    if 90 < mid < 270:
        rot = mid + 180
        ha = 'center'
    else:
        ha = 'center'

    label_text = labels[i]
    ax.text(tx, ty, label_text, ha='center', va='center',
            rotation=rot, rotation_mode='anchor',
            fontsize=13, color='black', fontweight='normal')
# ---------- Tick marks and numeric scale ----------
# For each node, draw tick marks at intervals proportional to the value scale
# In the reference, ticks are at 0, 30, 60, 90 with the node's max being up to ~90-100
# Here, the maximum sum is 101 (S10). Use ticks at 0, 30, 60, 90.
tick_values = [0, 30, 60, 90]
R_tick_inner = R + 0.005
R_tick_outer = R + 0.025
# Draw per-node: scale the tick values to fit each node's total
# Each node has total = node_sum[i]. We need ticks proportional to that.
for i, pos in enumerate(positions):
    node_total = node_sum[i]
    # Each tick represents "value" along the arc proportionally
    # The arc length (in angle) corresponds to node_total
    # Tick at value v takes angle = v / node_total * arc_span
    arc_span = pos['span']
    for tv in tick_values:
        if tv > node_total:
            continue
        frac = tv / node_total
        # Position at start_angle + frac * arc_span
        a = pos['start'] + frac * arc_span
        # Two ticks per segment? Reference shows ticks at edges of each sub-segment
        # Actually reference shows tick marks at small multiples along arc
        x1, y1 = angle_to_xy(a, R_tick_inner)
        x2, y2 = angle_to_xy(a, R_tick_outer)
        ax.plot([x1, x2], [y1, y2], color='#888', linewidth=0.6, zorder=5)
        # Numeric label
        if tv > 0:
            lx, ly = angle_to_xy(a, R_tick_outer + 0.025)
            # Rotate to be tangent
            rot = a
            if 90 < a < 270:
                rot = a + 180
            ax.text(lx, ly, f"{int(tv)}", ha='center', va='center',
                    rotation=rot, rotation_mode='anchor',
                    fontsize=7, color='#555')
# Save
out_path = "chord_diagram.png"
plt.tight_layout()
plt.savefig(out_path, dpi=140, bbox_inches='tight', facecolor='white')
plt.close()
print(f"Saved: {out_path}, exists: {os.path.exists(out_path)}")
print(f"Size: {os.path.getsize(out_path)} bytes")
