import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import Wedge, FancyBboxPatch
import numpy as np
import pandas as pd

df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
genes = ['Gene1','Gene2','Gene3','Gene4','Gene5','Gene6']
samples = [f'S{i}' for i in range(1,11)]

# Aggregate values per gene and per sample (sum of values)
gene_totals = df.groupby('from')['value'].sum().reindex(genes).fillna(0).values
sample_totals = df.groupby('to')['value'].sum().reindex(samples).fillna(0).values
total = gene_totals.sum()

# Normalize to fractions of circle
gene_fracs = gene_totals / total
sample_fracs = sample_totals / total

# Layout: Genes on right half, Samples on left half (like the reference image)
# Actually in reference image: Genes on right, S on left. Let's place genes on right (0 to pi/2... no)
# Looking again: image has Genes (Gene1-Gene6) on the right side from top going clockwise,
# S1-S10 on the left side going from bottom-left to top-left.
# Standard chord diagram: put categories around full circle.

# Use angles starting at top (pi/2) and going clockwise
# Genes occupy the right half (0 to pi going clockwise -> angles -pi/2 to pi/2 i.e. -90° to 90°)
# Samples occupy the left half

# Simpler: assign each gene a consecutive angular slot in right half
n_genes = len(genes)
n_samples = len(samples)

# Gap fraction to leave between groups
gap = 0.01  # fraction of full circle for gap

# Allocate half circle to genes (top-right quadrant and bottom-right quadrant)
# Actually full right half = 0.5 of circle. Distribute genes across the right half
# and samples across the left half.
# In reference, both groups span full 180° each.

half = 0.5
gene_total_frac = sum(gene_fracs)  # should be ~0.5 since values sum equal
sample_total_frac = sum(sample_fracs)
# normalize so they fill their half
gene_norm = gene_fracs / gene_total_frac * (half - gap)
sample_norm = sample_fracs / sample_total_frac * (half - gap)

# Now build cumulative angles. Start at angle=0 (3 o'clock) and go counter-clockwise
# Genes occupy from angle=0 to angle=pi (top), Samples from pi to 2pi (bottom going CCW)

# Better: use matplotlib polar with theta going counter-clockwise from east.
# Genes at top half (angles 0 to pi), samples at bottom half (angles pi to 2pi)
# Add small gap between

# Compute angles
def compute_angles(norm_fracs, start_angle, gap_frac):
    # norm_fracs sums to (half - gap_frac)
    angles = []
    a = start_angle
    for f in norm_fracs:
        angles.append((a, a + f))
        a += f
    # add gap at end
    a += gap_frac
    return angles, a

gene_angles, after_genes = compute_angles(gene_norm, 0, gap)
sample_angles, after_samples = compute_angles(sample_norm, after_genes, gap)

print('Gene angles:', gene_angles)
print('Sample angles:', sample_angles)

# Colors - use a palette similar to reference
import matplotlib.cm as cm
gene_colors = ['#2E86AB','#E07A5F','#3D9970','#2C3E70','#F2A07B','#7B9EBE']
sample_colors = ['#7FBF7F','#E8C56C','#B89CC4','#A8C5E0','#88D4B8','#C58A8A',
                 '#8A7E5C','#C04040','#A8D8C5','#9DBE8A']

# Create figure
fig, ax = plt.subplots(figsize=(8, 8), subplot_kw=dict(projection='polar'))
fig.patch.set_facecolor('#F5F5F0')
ax.set_facecolor('#F5F5F0')
ax.set_theta_zero_location('E')  # 0 at east
ax.set_theta_direction(1)  # counter-clockwise

# Draw arcs for genes and samples
def draw_arc(ax, start, end, color, label, label_offset=0):
    n = 200
    theta = np.linspace(start, end, n)
    r_outer = 1.15
    r_inner = 1.05
    # Outer thick band
    ax.fill_between(theta, r_inner, r_outer, color=color, edgecolor='white', linewidth=1.5, zorder=3)
    # Tick marks
    for t in np.linspace(start, end, 4):
        ax.plot([t, t], [1.05, 1.18], color='#666', linewidth=0.8, zorder=2)
    # Label
    mid = (start + end) / 2
    ax.text(mid, 1.28, label, ha='center', va='center', fontsize=11, fontweight='normal', zorder=5)

for (s, e), c, l in zip(gene_angles, gene_colors, genes):
    draw_arc(ax, s, e, c, l)
for (s, e), c, l in zip(sample_angles, sample_colors, samples):
    draw_arc(ax, s, e, c, l)

# Draw chord ribbons
# For each row in df: from=gene, to=sample, value
# Use Bézier-like ribbons. Each ribbon has two endpoint arcs on each side.
# Approach: for each (gene, sample) connection, draw a filled ribbon
# A chord connects point A on gene arc to point B on sample arc, with width proportional to value at both ends.

# Need to compute sub-positions within each gene and sample arcs for each connection
# Build mappings
gene_subpos = {g: [] for g in genes}
sample_subpos = {s: [] for s in samples}
gene_subpos_val = {g: [] for g in genes}
sample_subpos_val = {s: [] for s in samples}

# Sort by gene, then sample order
df_sorted = df.copy()
for i, g in enumerate(genes):
    g_arc = gene_angles[i]
    g_width = g_arc[1] - g_arc[0]
    g_total = gene_totals[i]
    if g_total == 0:
        continue
    sub_df = df_sorted[df_sorted['from'] == g].sort_values('to', key=lambda x: [samples.index(v) for v in x])
    pos = g_arc[0]
    for _, row in sub_df.iterrows():
        frac = row['value'] / g_total
        sub_width = frac * g_width
        gene_subpos[g].append((pos, pos + sub_width))
        gene_subpos_val[g].append(row['value'])
        pos += sub_width

for j, s in enumerate(samples):
    s_arc = sample_angles[j]
    s_width = s_arc[1] - s_arc[0]
    s_total = sample_totals[j]
    if s_total == 0:
        continue
    sub_df = df_sorted[df_sorted['to'] == s].sort_values('from', key=lambda x: [genes.index(v) for v in x])
    pos = s_arc[0]
    for _, row in sub_df.iterrows():
        frac = row['value'] / s_total
        sub_width = frac * s_width
        sample_subpos[s].append((pos, pos + sub_width))
        sample_subpos_val[s].append(row['value'])
        pos += sub_width

def draw_ribbon(ax, theta1_start, theta1_end, theta2_start, theta2_end, color):
    # Draw a filled ribbon between two angular segments using a polar polygon
    # Use cubic-like path on the outer circle r=1.0
    r = 1.0
    n = 60
    # arc 1 from start to end going CCW
    t1 = np.linspace(theta1_start, theta1_end, n)
    t2 = np.linspace(theta2_end, theta2_start, n)  # reversed
    theta = np.concatenate([t1, t2])
    r_arr = np.concatenate([np.full(n, r), np.full(n, r)])
    ax.fill(theta, r_arr, color=color, alpha=0.5, linewidth=0.5, edgecolor='white', zorder=1)

# Re-iterate df to draw ribbons in consistent color (use gene color)
# Build a quick map
gene_color_map = dict(zip(genes, gene_colors))

# Track sub-positions per connection
gene_sub_idx = {g: 0 for g in genes}
sample_sub_idx = {s: 0 for s in samples}

# Process in canonical order (gene order, then sample order)
for i, g in enumerate(genes):
    sub_df = df_sorted[df_sorted['from'] == g].sort_values('to', key=lambda x: [samples.index(v) for v in x])
    for _, row in sub_df.iterrows():
        s = row['to']
        ts, te = gene_subpos[g][gene_sub_idx[g]]
        ss, se = sample_subpos[s][sample_sub_idx[s]]
        draw_ribbon(ax, ts, te, ss, se, gene_color_map[g])
        gene_sub_idx[g] += 1
        sample_sub_idx[s] += 1

# Ticks and labels around the outer edge (0, 30, 60, 90)
# In reference image, ticks at 0,30,60,90 are shown inside the ring
# Set radial ticks at 1.05
ax.set_ylim(0, 1.4)
ax.set_yticks([])
ax.set_xticks([])
ax.grid(False)
ax.spines['polar'].set_visible(False)

plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=150, facecolor='#F5F5F0', bbox_inches='tight')
plt.show()
print('saved')
