import pandas as pd
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
print("Shape:", df.shape)
print("\nColumns:", df.columns.tolist())
print("\nDtypes:")
print(df.dtypes)
print("\nFirst 30 rows:")
print(df.head(30))

# %%

print("Unique 'from' values:", sorted(df['from'].unique()))
print("\nUnique 'to' values:", sorted(df['to'].unique()))
print("\nFull data:")
print(df.to_string())
print("\nValue range:", df['value'].min(), "-", df['value'].max())

# %%

# Check available libraries for chord diagram
import importlib
for lib in ['mpl_chord_diagram', 'chord', 'holoviews', 'plotly']:
    try:
        importlib.import_module(lib)
        print(f"{lib}: available")
    except ImportError:
        print(f"{lib}: NOT available")

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Wedge, FancyBboxPatch, Circle
from matplotlib.path import Path
from matplotlib.patches import PathPatch
import matplotlib.patches as mpatches
# Build a matrix: rows = from (Genes), cols = to (Samples)
from_order = ['Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
to_order = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
matrix = np.zeros((len(from_order), len(to_order)))
for _, row in df.iterrows():
    fi = from_order.index(row['from'])
    ti = to_order.index(row['to'])
    matrix[fi, ti] = row['value']
print("Matrix shape:", matrix.shape)
print("Gene row sums:", matrix.sum(axis=1))
print("Sample col sums:", matrix.sum(axis=0))
print("Total:", matrix.sum())

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
# Build a matrix
from_order = ['Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
to_order = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
matrix = np.zeros((len(from_order), len(to_order)))
for _, row in df.iterrows():
    fi = from_order.index(row['from'])
    ti = to_order.index(row['to'])
    matrix[fi, ti] = row['value']
# Colors approximating the reference image
# Gene colors (right side) - similar to pastel/red-blue palette
gene_colors = ['#4FC3D9', '#E47A6E', '#3CB28E', '#2F4858', '#D89A82', '#A8B4D4']
# Sample colors (left side) - colorful
sample_colors = ['#9BD4B5', '#B7322C', '#76A15F', '#8B6F4E', '#C49A6C',
                 '#9BD4B5', '#B97AB0', '#C4A85F', '#E0D082', '#7BC97F']
# Layout: genes on right (angles -90 to -90-180 = -90 to -270, i.e. upper-right and lower-right)
# Actually let's use: Genes on right side (angles 0 to 180 → starting from top, going clockwise through right)
# In matplotlib polar, angle 0 is at right (3 o'clock), going counterclockwise.
# To place genes on right half and samples on left half, we'll define:
# Genes: angles from 90° (top) clockwise to -90° (bottom) going through 0° (right)
# Samples: from -90° (bottom) clockwise through 180° (left) to 90° (top)
# Or simpler: use mathematical convention where 0° = right, 90° = top
# Genes on right: angles from -60° to 60° going through 0° (clockwise = negative in standard convention)
# Actually let's just use degrees where angle = 0 is top (12 o'clock), clockwise positive
def deg_to_rad(d):
    return np.deg2rad(d)
# Total sums
row_totals = matrix.sum(axis=1)
col_totals = matrix.sum(axis=0)
total = matrix.sum()
# Right half (Genes): 180 degrees, with small gaps
gap_size = 1.5  # degrees per gap
right_total_deg = 180 - gap_size * (len(from_order) + 1)  # 1 outer + 1 inner between each pair? Actually we need n+1 gaps
right_total_deg = 180 - gap_size * (len(from_order))
left_total_deg = 180 - gap_size * (len(to_order))
# Allocate
gene_angles = right_total_deg * row_totals / row_totals.sum()
sample_angles = left_total_deg * col_totals / col_totals.sum()
# Start positions - on right half: start at angle 0 (right horizontal), going counterclockwise up to 180
# Actually in the image, Genes start at top-right and go clockwise
# Let me set: angle 0 = top, positive = clockwise
# Genes occupy right half: from angle -60 (upper) going clockwise through 0 (right) to 60 (lower)
# Wait let me check the image again - Genes are 12 o'clock area, going clockwise to about 4 o'clock
# Samples are from about 4 o'clock going clockwise (counterclockwise visually) to 12 o'clock
# This is the standard layout.
# Let's use polar where angle=0 is at 12 o'clock and increases clockwise
fig, ax = plt.subplots(figsize=(10, 10), subplot_kw={'projection': 'polar'})
ax.set_theta_zero_location('E')  # 0 at right
ax.set_theta_direction(1)  # counterclockwise
ax.set_axis_off()
# Place genes in upper right: angles from 0 to 180 (counterclockwise)
# But image shows Genes from top-right going down to bottom-right
# Let me use theta_zero at top and clockwise direction
fig.clear()
ax = fig.add_subplot(111, projection='polar')
ax.set_theta_zero_location('N')  # 0 at top
ax.set_theta_direction(-1)  # clockwise
ax.set_axis_off()
# Now: Genes occupy the right half: angles 0 to 180 (clockwise from top to bottom through right)
# Samples occupy the left half: angles 180 to 360 (clockwise from bottom to top through left)
# Calculate starting angles for each segment
gene_starts = []
gene_ends = []
current = gap_size / 2  # start with half-gap
for i in range(len(from_order)):
    gene_starts.append(current)
    gene_ends.append(current + gene_angles[i])
    current += gene_angles[i] + gap_size
sample_starts = []
sample_ends = []
current = 180 + gap_size / 2  # start at bottom
for i in range(len(to_order)):
    sample_starts.append(current)
    sample_ends.append(current + sample_angles[i])
    current += sample_angles[i] + gap_size
# Draw segment arcs (outer band)
outer_radius = 1.0
band_width = 0.08
inner_radius = outer_radius - band_width
for i, (start, end) in enumerate(zip(gene_starts, gene_ends)):
    arc = mpatches.Wedge((0, 0), outer_radius, start, end, width=band_width,
                         facecolor=gene_colors[i], edgecolor='white', linewidth=1)
    ax.add_patch(arc)
for i, (start, end) in enumerate(zip(sample_starts, sample_ends)):
    arc = mpatches.Wedge((0, 0), outer_radius, start, end, width=band_width,
                         facecolor=sample_colors[i], edgecolor='white', linewidth=1)
    ax.add_patch(arc)
# Draw chords (ribbons)
def chord_patch(ax, theta1_start, theta1_end, theta2_start, theta2_end, r_inner=0.0, r_outer=1.0):
    """Draw a curved ribbon between two angular ranges."""
    # Use Path with Bezier curves
    r1_in = r_inner
    r1_out = r_outer
    r2_in = r_inner
    r2_out = r_outer

    t1a = deg_to_rad(theta1_start)
    t1b = deg_to_rad(theta1_end)
    t2a = deg_to_rad(theta2_start)
    t2b = deg_to_rad(theta2_end)

    # Anchor points on outer circle (start of each arc going outward)
    p1_out_a = (r1_out * np.cos(t1a), r1_out * np.sin(t1a))
    p1_out_b = (r1_out * np.cos(t1b), r1_out * np.sin(t1b))
    p2_out_a = (r2_out * np.cos(t2a), r2_out * np.sin(t2a))
    p2_out_b = (r2_out * np.cos(t2b), r2_out * np.sin(t2b))
    p1_in_a = (r1_in * np.cos(t1a), r1_in * np.sin(t1a))
    p1_in_b = (r1_in * np.cos(t1b), r1_in * np.sin(t1b))
    p2_in_a = (r2_in * np.cos(t2a), r2_in * np.sin(t2a))
    p2_in_b = (r2_in * np.cos(t2b), r2_in * np.sin(t2b))

    # Build path: start at outer edge of segment 1 start, arc to outer edge of segment 1 end,
    # curve to outer edge of segment 2 end, arc back to outer edge of segment 2 start,
    # curve back to start
    verts = [
        p1_out_a,                                   # start at outer start of seg 1
        p1_out_b,                                   # arc to outer end of seg 1
        p2_out_b,                                   # curve (bezier) to outer end of seg 2
        p2_out_a,                                   # arc to outer start of seg 2
        p1_out_a                                    # curve back to start
    ]
    codes = [
        Path.MOVETO,
        Path.CURVE4,  # arc approximated as bezier? actually need arc command
        Path.CURVE4,
        Path.CURVE4,
        Path.CURVE4,
    ]
    # Use simpler approach: outer arc + two connecting curves + inner arc

    # Actually use proper SVG arc command for the arcs and Bezier for connecting curves
    n_arc_pts = 20

    # Generate points on outer arc of segment 1
    arc1_pts = []
    for j in range(n_arc_pts + 1):
        t = t1a + (t1b - t1a) * j / n_arc_pts
        arc1_pts.append((r1_out * np.cos(t), r1_out * np.sin(t)))

    # Generate points on outer arc of segment 2 (reversed)
    arc2_pts = []
    for j in range(n_arc_pts + 1):
        t = t2b + (t2a - t2b) * j / n_arc_pts
        arc2_pts.append((r2_out * np.cos(t), r2_out * np.sin(t)))

    # Connecting curves use quadratic bezier with control point near center but slightly offset
    verts = []
    codes = []

    # Start
    verts.append(arc1_pts[0])
    codes.append(Path.MOVETO)

    # Outer arc of seg 1
    for pt in arc1_pts[1:]:
        verts.append(pt)
        codes.append(Path.LINETO)

    # Curve from arc1_pts[-1] to arc2_pts[0] - through center
    # Use control point near origin (0,0)
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append(arc2_pts[0])
    codes.append(Path.CURVE4)

    # Outer arc of seg 2 (reversed)
    for pt in arc2_pts[1:]:
        verts.append(pt)
        codes.append(Path.LINETO)

    # Curve back through center
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append(arc1_pts[0])
    codes.append(Path.CURVE4)

    path = Path(verts, codes)
    return path
# For each chord (i, j), we need to find positions along gene_starts and sample_starts based on accumulated values
# Build the cumulative positions for ribbons within each segment
# Each gene i has ribbons to all samples; the position of the j-th ribbon within gene i depends on cumulative sum of values
# Initialize tracking positions for outgoing (genes) and incoming (samples)
gene_out_pos = gene_starts.copy()  # current position for each gene's outbound ribbon
sample_in_pos = sample_starts.copy()
chord_thickness = inner_radius  # max thickness of chord
# Scale factor: total angular space for each segment vs actual values
gene_scale = gene_angles / row_totals  # degrees per unit value
sample_scale = sample_angles / col_totals
for i in range(len(from_order)):
    for j in range(len(to_order)):
        v = matrix[i, j]
        if v <= 0:
            continue

        # Span for this chord on gene side
        g_span = v * gene_scale[i]
        g_start = gene_out_pos[i]
        g_end = g_start + g_span

        # Span on sample side
        s_span = v * sample_scale[j]
        s_start = sample_in_pos[j]
        s_end = s_start + s_span

        # Update positions
        gene_out_pos[i] = g_end
        sample_in_pos[j] = s_end

        # Choose color: in reference image, chord colors mix source and target.
        # Use the gene's color but with alpha, or interpolate
        color = gene_colors[i]

        path = chord_patch(ax, g_start, g_end, s_start, s_end,
                          r_inner=inner_radius * 0.0,  # start from very inner
                          r_outer=inner_radius)
        patch = mpatches.PathPatch(path, facecolor=color, edgecolor='none', alpha=0.85)
        ax.add_patch(patch)
# Draw tick marks
tick_radius_outer = outer_radius + 0.02
tick_radius_inner = outer_radius + 0.05
for i, (start, end) in enumerate(zip(gene_starts, gene_ends)):
    n_ticks = 4  # ticks at 0, 30, 60, 90 representing cumulative percentage
    for k in range(n_ticks):
        frac = k / (n_ticks - 1)
        angle = start + (end - start) * frac
        t = deg_to_rad(angle)
        x1 = tick_radius_inner * np.cos(t)
        y1 = tick_radius_inner * np.sin(t)
        x2 = (tick_radius_inner + 0.03) * np.cos(t)
        y2 = (tick_radius_inner + 0.03) * np.sin(t)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.8)
        # Tick label
        label = str(int(frac * 90))
        ax.text(x2 + 0.005 * np.cos(t), y2 + 0.005 * np.sin(t), label,
                ha='center', va='center', fontsize=8)
for i, (start, end) in enumerate(zip(sample_starts, sample_ends)):
    n_ticks = 4
    for k in range(n_ticks):
        frac = k / (n_ticks - 1)
        angle = start + (end - start) * frac
        t = deg_to_rad(angle)
        x1 = tick_radius_inner * np.cos(t)
        y1 = tick_radius_inner * np.sin(t)
        x2 = (tick_radius_inner + 0.03) * np.cos(t)
        y2 = (tick_radius_inner + 0.03) * np.sin(t)
        ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.8)
        label = str(int(frac * 90))
        ax.text(x2 + 0.005 * np.cos(t), y2 + 0.005 * np.sin(t), label,
                ha='center', va='center', fontsize=8)
# Add labels outside
label_radius = outer_radius + 0.12
for i, (start, end) in enumerate(zip(gene_starts, gene_ends)):
    mid = (start + end) / 2
    t = deg_to_rad(mid)
    x = label_radius * np.cos(t)
    y = label_radius * np.sin(t)
    ax.text(x, y, from_order[i], ha='center', va='center', fontsize=12, fontweight='bold')
for i, (start, end) in enumerate(zip(sample_starts, sample_ends)):
    mid = (start + end) / 2
    t = deg_to_rad(mid)
    x = label_radius * np.cos(t)
    y = label_radius * np.sin(t)
    ax.text(x, y, to_order[i], ha='center', va='center', fontsize=12, fontweight='bold')
ax.set_xlim(-1.5, 1.5)
ax.set_ylim(-1.5, 1.5)
ax.set_aspect('equal')
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, bbox_inches='tight', facecolor='white')
plt.show()
print("Saved chord_diagram.png")

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
# Reconstruct matrix
from_order = ['Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
to_order = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
matrix = np.zeros((len(from_order), len(to_order)))
for _, row in df.iterrows():
    fi = from_order.index(row['from'])
    ti = to_order.index(row['to'])
    matrix[fi, ti] = row['value']
# Colors approximating reference
gene_colors = ['#5BC0CE', '#E47A6E', '#3CB28E', '#2F4858', '#D89A82', '#A8B4D4']
sample_colors = ['#7BC97F', '#B7322C', '#76A15F', '#8B6F4E', '#C49A6C',
                 '#9BD4B5', '#B97AB0', '#C4A85F', '#E0D082', '#7BC97F']
# We will create a clean chord diagram with cubic Bezier ribbons
# All segments around the circle: Genes first (top half), then Samples (bottom half going clockwise)
# OR following reference: all 16 in clockwise order
# Reference image sequence (clockwise starting at 1 o'clock):
# Gene1, Gene2, Gene3, Gene4, Gene5, Gene6, S1, S2, ..., S10
all_labels = from_order + to_order
all_colors = gene_colors + sample_colors
# Compute totals for each segment
totals = np.concatenate([matrix.sum(axis=1), matrix.sum(axis=0)])
# Layout angles
gap_size = 1.0  # degrees
total_gap = gap_size * len(all_labels)
available = 360 - total_gap
angles = available * totals / totals.sum()
# Start positions - clockwise from 12 o'clock, with first half-gap at top
# Actually let's match the reference - first segment is Gene1 starting at ~1 o'clock
# So let's start at -60° (1 o'clock area, which is 60° clockwise from top = -60° in our convention)
# Going clockwise means angles decrease (since 0° = top, clockwise positive? Let me use math convention with N at top)
fig, ax = plt.subplots(figsize=(10, 10), subplot_kw={'projection': 'polar'})
ax.set_theta_zero_location('N')  # 0 at top
ax.set_theta_direction(-1)  # clockwise
ax.set_axis_off()
# Calculate start angles (clockwise from N)
# Start at -45° in standard convention (since we're going clockwise, angles start at 0 (top) and go negative)
# Actually in matplotlib polar with N at top and -1 direction, angles increase clockwise from 0.
# So angle 0 = N, angle 90 = W (left), angle 180 = S, angle 270 = E (right)
# Wait: with theta_direction=-1, angles go clockwise from N (0).
# So 0=N, 90=E (right), 180=S, 270=W (left)...
# Actually let me check: theta_zero_location='N' means 0 angle is at N (top).
# theta_direction=-1 means direction is clockwise. So angle increases clockwise from N.
# 0=N, increasing clockwise: 90=E, 180=S, 270=W.
# Genes should be on the right (E) side - starting from N going clockwise to S through E
# Samples on the left (W) side - from S going clockwise to N through W
# To match reference where Gene1 is at ~1 o'clock and S10 is at ~11 o'clock,
# we need to start the segments at angle 45° (clockwise from N = ~1 o'clock = 45°)
start_angle = 45  # start position - this is where Gene1 begins
positions = []
current = start_angle
for i, a in enumerate(angles):
    positions.append((current, current + a))
    current += a + gap_size
# Sector radius
R_out = 1.0
R_band = 0.08
R_in = R_out - R_band
R_chord = R_in  # chords go from R_in inward
# Draw segments
for i, (s, e) in enumerate(positions):
    wedge = mpatches.Wedge((0, 0), R_out, s, e, width=R_band,
                           facecolor=all_colors[i], edgecolor='white', linewidth=1.5)
    ax.add_patch(wedge)
# Tick marks at 0, 30, 60, 90 (representing cumulative % of segment)
tick_r1 = R_out + 0.02
tick_r2 = R_out + 0.06
for i, (s, e) in enumerate(positions):
    for frac in [0, 0.333, 0.667, 1.0]:
        a = s + (e - s) * frac
        t = np.deg2rad(a)
        x1 = tick_r1 * np.sin(t)
        y1 = tick_r1 * np.cos(t)
        x2 = tick_r2 * np.sin(t)
        y2 = tick_r2 * np.cos(t)
        ax.plot([x1, x2], [y1, y2], color='black', lw=0.8, transform=ax.transData)
        # Wait, in polar the coordinate system is different. Let me use polar plotting

# Let me redo this more carefully using polar coordinates directly
fig.clear()
ax = fig.add_subplot(111, projection='polar')
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1)
ax.set_axis_off()
ax.set_ylim(0, 1.3)
# Draw segments using ax.bar or fill
for i, (s, e) in enumerate(positions):
    n_pts = 30
    theta = np.linspace(s, e, n_pts)
    r = np.full_like(theta, R_out)
    r_inner = np.full_like(theta, R_in)
    # Build a closed polygon: outer arc, then inner arc
    ax.fill_between(np.deg2rad(theta), R_in, R_out, color=all_colors[i],
                     edgecolor='white', linewidth=1.5)
# Draw tick marks (radial lines)
for i, (s, e) in enumerate(positions):
    for frac in [0, 0.333, 0.667, 1.0]:
        a = s + (e - s) * frac
        ax.plot([np.deg2rad(a), np.deg2rad(a)], [R_out, R_out + 0.05],
                color='black', linewidth=0.8)
        ax.text(np.deg2rad(a), R_out + 0.08, f'{int(frac*90)}',
                ha='center', va='center', fontsize=8)
# Add labels
for i, (s, e) in enumerate(positions):
    mid = (s + e) / 2
    ax.text(np.deg2rad(mid), R_out + 0.13, all_labels[i],
            ha='center', va='center', fontsize=11, fontweight='bold',
            rotation=0)
# Draw chords
def draw_chord(ax, s1, e1, s2, e2, color, alpha=0.85):
    """Draw a ribbon from arc [s1, e1] on outer circle to arc [s2, e2]."""
    n_pts = 30
    # Arc 1 (outer)
    theta1 = np.linspace(s1, e1, n_pts)
    r1_out = np.full_like(theta1, R_in)

    # Arc 2 (outer) - reverse order
    theta2 = np.linspace(s2, e2, n_pts)
    r2_out = np.full_like(theta2, R_in)

    # Build polygon vertices in polar
    # Going from arc1 outer to arc2 outer via center
    # Use cubic Bezier curves through center

    # In Cartesian for Path:
    t1_start = np.deg2rad(s1)
    t1_end = np.deg2rad(e1)
    t2_start = np.deg2rad(s2)
    t2_end = np.deg2rad(e2)

    p1a = (R_in * np.sin(t1_start), R_in * np.cos(t1_start))
    p1b = (R_in * np.sin(t1_end), R_in * np.cos(t1_end))
    p2a = (R_in * np.sin(t2_start), R_in * np.cos(t2_start))
    p2b = (R_in * np.sin(t2_end), R_in * np.cos(t2_end))

    # Generate arc points on outer edge
    arc1_pts = []
    for j in range(n_pts + 1):
        t = np.deg2rad(s1 + (e1 - s1) * j / n_pts)
        arc1_pts.append((R_in * np.sin(t), R_in * np.cos(t)))

    arc2_pts = []
    for j in range(n_pts + 1):
        t = np.deg2rad(s2 + (e2 - s2) * j / n_pts)
        arc2_pts.append((R_in * np.sin(t), R_in * np.cos(t)))

    # Build path
    verts = []
    codes = []

    # Outer arc from s1 to e1
    verts.append(arc1_pts[0])
    codes.append(Path.MOVETO)
    for pt in arc1_pts[1:]:
        verts.append(pt)
        codes.append(Path.LINETO)

    # Cubic Bezier from arc1 end to arc2 start, with control points at center
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append(arc2_pts[0])
    codes.append(Path.CURVE4)

    # Outer arc from s2 to e2
    for pt in arc2_pts[1:]:
        verts.append(pt)
        codes.append(Path.LINETO)

    # Cubic Bezier back from arc2 end to arc1 start
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append(arc1_pts[0])
    codes.append(Path.CURVE4)

    path = Path(verts, codes)
    patch = mpatches.PathPatch(path, facecolor=color, edgecolor='none', alpha=alpha)
    ax.add_patch(patch)
# Track positions for chord edges within each segment
gene_out_pos = [p[0] for p in positions[:len(from_order)]]
sample_in_pos = [p[0] for p in positions[len(from_order):]]
gene_scale = [angles[i] / totals[i] for i in range(len(from_order))]
sample_scale = [angles[len(from_order) + i] / totals[len(from_order) + i] for i in range(len(to_order))]
# Chords go from Genes (i in 0-5) to Samples (j in 0-9) - matrix[i,j]
# For ordering: process in order of source segments then targets
for i in range(len(from_order)):
    for j in range(len(to_order)):
        v = matrix[i, j]
        if v <= 0:
            continue
        g_span = v * gene_scale[i]
        s_span = v * sample_scale[j]
        s1, e1 = gene_out_pos[i], gene_out_pos[i] + g_span
        s2, e2 = sample_in_pos[j], sample_in_pos[j] + s_span
        gene_out_pos[i] = e1
        sample_in_pos[j] = e2
        draw_chord(ax, s1, e1, s2, e2, gene_colors[i], alpha=0.85)
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, bbox_inches='tight', facecolor='white')
plt.show()
print("Saved")

# %%

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches
# Reconstruct matrix
from_order = ['Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
to_order = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
matrix = np.zeros((len(from_order), len(to_order)))
for _, row in df.iterrows():
    fi = from_order.index(row['from'])
    ti = to_order.index(row['to'])
    matrix[fi, ti] = row['value']
# Colors
gene_colors = ['#5BC0CE', '#E47A6E', '#3CB28E', '#2F4858', '#D89A82', '#A8B4D4']
sample_colors = ['#7BC97F', '#B7322C', '#76A15F', '#8B6F4E', '#C49A6C',
                 '#9BD4B5', '#B97AB0', '#C4A85F', '#E0D082', '#7BC97F']
all_labels = from_order + to_order
all_colors = gene_colors + sample_colors
totals = np.concatenate([matrix.sum(axis=1), matrix.sum(axis=0)])
# Use fixed angles per segment (not proportional) to match reference - segments appear similar size
# In reference image, segments are roughly equal-sized within each group
# Actually looking again, they're proportional but with different scaling
# Let me use proportional with same scaling
gap_size = 1.0
total_gap = gap_size * len(all_labels)
available = 360 - total_gap
angles = available * totals / totals.sum()
# Place all 16 segments around the circle starting at angle -60 (so Gene1 starts at ~1 o'clock)
# In our convention: 0=N, clockwise positive (because theta_direction=-1 means... wait)
# theta_zero_location='N' means 0 angle is at N (top).
# theta_direction=-1 means clockwise. So increasing angle goes clockwise.
# 0=N, 90=E (right), 180=S (bottom), 270=W (left)
# Reference: Gene1 at ~1 o'clock = roughly 60° (clockwise from N)
# So start at 60°
start_angle = 60  # Gene1 starts here
positions = []
current = start_angle
for i, a in enumerate(angles):
    positions.append((current, current + a))
    current += a + gap_size
fig, ax = plt.subplots(figsize=(10, 10), subplot_kw={'projection': 'polar'})
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1)
ax.set_axis_off()
ax.set_ylim(0, 1.35)
R_out = 1.0
R_band = 0.08
R_in = R_out - R_band
# Draw segments using fill_between
for i, (s, e) in enumerate(positions):
    n_pts = 60
    theta = np.linspace(s, e, n_pts)
    ax.fill_between(np.deg2rad(theta), R_in, R_out,
                     color=all_colors[i], edgecolor='white', linewidth=1.5)
# Ticks at 0, 30, 60, 90
tick_r1 = R_out + 0.015
tick_r2 = R_out + 0.055
for i, (s, e) in enumerate(positions):
    for frac in [0, 0.333, 0.667, 1.0]:
        a = s + (e - s) * frac
        ax.plot([np.deg2rad(a)] * 2, [tick_r1, tick_r2],
                color='black', linewidth=0.7)
        # Tick label
        label = f'{int(round(frac*90))}'
        ax.text(np.deg2rad(a), tick_r2 + 0.025, label,
                ha='center', va='center', fontsize=8)
# Labels - rotate to be tangent
label_r = R_out + 0.12
for i, (s, e) in enumerate(positions):
    mid = (s + e) / 2
    deg = mid
    # Convert to matplotlib angle for text (with our conventions)
    angle_rad = np.deg2rad(deg)
    x = label_r * np.sin(angle_rad)
    y = label_r * np.cos(angle_rad)
    # Determine rotation - in reference, labels are rotated tangentially
    # Our convention: angle from N clockwise
    # Reference labels: Gene1 at top right goes like "Gene1" tilted slightly, etc.
    # Let's compute tangent angle
    # The tangent direction at angle (s+e)/2 going clockwise is perpendicular to radial
    # Rotation needed: 90° - (deg - 90) for text to align with circle
    rot = -deg  # negative because we want it readable

    # For readability, only rotate if necessary; otherwise keep horizontal
    if 90 < deg < 270:
        # bottom half - flip
        rot = 180 - deg
        ha = 'center'
    else:
        rot = -deg
        ha = 'center'

    ax.text(angle_rad, label_r, all_labels[i],
            ha='center', va='center', fontsize=11, fontweight='bold',
            rotation=rot, rotation_mode='anchor')
# Draw chords
def draw_chord(ax, s1, e1, s2, e2, color, alpha=0.85):
    n_pts = 30
    arc1_pts = []
    for j in range(n_pts + 1):
        t = np.deg2rad(s1 + (e1 - s1) * j / n_pts)
        arc1_pts.append((R_in * np.sin(t), R_in * np.cos(t)))
    arc2_pts = []
    for j in range(n_pts + 1):
        t = np.deg2rad(s2 + (e2 - s2) * j / n_pts)
        arc2_pts.append((R_in * np.sin(t), R_in * np.cos(t)))
    verts = []
    codes = []
    verts.append(arc1_pts[0])
    codes.append(Path.MOVETO)
    for pt in arc1_pts[1:]:
        verts.append(pt)
        codes.append(Path.LINETO)
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append(arc2_pts[0])
    codes.append(Path.CURVE4)
    for pt in arc2_pts[1:]:
        verts.append(pt)
        codes.append(Path.LINETO)
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append((0, 0))
    codes.append(Path.CURVE4)
    verts.append(arc1_pts[0])
    codes.append(Path.CURVE4)
    path = Path(verts, codes)
    patch = mpatches.PathPatch(path, facecolor=color, edgecolor='none', alpha=alpha)
    ax.add_patch(patch)
# Track positions
gene_out_pos = [p[0] for p in positions[:len(from_order)]]
sample_in_pos = [p[0] for p in positions[len(from_order):]]
gene_scale = [angles[i] / totals[i] for i in range(len(from_order))]
sample_scale = [angles[len(from_order) + i] / totals[len(from_order) + i] for i in range(len(to_order))]
for i in range(len(from_order)):
    for j in range(len(to_order)):
        v = matrix[i, j]
        if v <= 0:
            continue
        g_span = v * gene_scale[i]
        s_span = v * sample_scale[j]
        s1, e1 = gene_out_pos[i], gene_out_pos[i] + g_span
        s2, e2 = sample_in_pos[j], sample_in_pos[j] + s_span
        gene_out_pos[i] = e1
        sample_in_pos[j] = e2
        draw_chord(ax, s1, e1, s2, e2, gene_colors[i], alpha=0.85)
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, bbox_inches='tight', facecolor='white')
plt.show()
print("Saved")
