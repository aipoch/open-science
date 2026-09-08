import openpyxl
import pandas as pd
# Read the Excel file
file_path = "inputs/edge-weights-222222222222.xlsx"
df = pd.read_excel(file_path)
print("Shape:", df.shape)
print("Columns:", df.columns.tolist())
print("\nFirst 30 rows:")
print(df.head(30))
print("\nLast 10 rows:")
print(df.tail(10))

# %%

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.path import Path
import matplotlib as mpl
# Load data
df = pd.read_excel("inputs/edge-weights-222222222222.xlsx")
# Get unique values
genes = sorted([g for g in df['from'].unique() if g.startswith('Gene')], key=lambda x: int(x.replace('Gene','')))
samples = sorted([s for s in df['to'].unique() if s.startswith('S')], key=lambda x: int(x.replace('S','')))
print("Genes:", genes)
print("Samples:", samples)
# Pivot to wide format
matrix = df.pivot(index='from', columns='to', values='value').fillna(0)
matrix = matrix.loc[genes, samples]
print("\nMatrix shape:", matrix.shape)
print(matrix)

# %%

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.path import Path
import matplotlib as mpl
from matplotlib import cm
# Load data
df = pd.read_excel("inputs/edge-weights-222222222222.xlsx")
# Get unique values in order
genes = ['Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6']
samples = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']
# Pivot to wide format
matrix = df.pivot(index='from', columns='to', values='value').fillna(0)
matrix = matrix.loc[genes, samples]
print("Matrix shape:", matrix.shape)
# Define colors for each segment (matching the example style)
# Genes: shades of blue/teal/red/orange (similar to the example)
gene_colors = {
    'Gene1': '#5BA4CF',  # light blue
    'Gene2': '#E07B5C',  # coral
    'Gene3': '#3FB28F',  # teal green
    'Gene4': '#7A85B8',  # blue-purple
    'Gene5': '#C8A2C8',  # light purple/lilac
    'Gene6': '#E8B07A',  # peach/orange
}
# Samples: different colors
sample_colors = {
    'S1': '#A8D5BA',   # mint
    'S2': '#F5A6A6',   # pink
    'S3': '#D67D7D',   # darker red
    'S4': '#B8A98B',   # tan
    'S5': '#9CB89C',   # sage green
    'S6': '#C19A9A',   # mauve
    'S7': '#9B8FC9',   # purple
    'S8': '#C977B5',   # magenta
    'S9': '#E8C56A',   # yellow
    'S10': '#7FB069',  # green
}
# Combine
all_labels = genes + samples
all_colors = [gene_colors[g] for g in genes] + [sample_colors[s] for s in samples]
# Compute totals
row_totals = matrix.sum(axis=1).values  # for genes
col_totals = matrix.sum(axis=0).values  # for samples
all_totals = np.concatenate([row_totals, col_totals])
print("All totals:", all_totals)
print("Sum:", all_totals.sum())

# %%

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.path import Path
import matplotlib as mpl
def chord_diagram(matrix, labels, colors, gap=0.5, figsize=(12, 12),
                  label_fontsize=14, tick_fontsize=8, scale='linear',
                  radius=1.0, ribbon_alpha=0.7):
    """
    Draw a chord diagram from a matrix.
    matrix: 2D array with values
    labels: list of labels for rows/columns (assumes square matrix where matrix[i,j] = connection between i and j)
    colors: list of colors for each segment
    """
    n = len(labels)

    # The matrix is rectangular (genes x samples), so we need to handle both rows and columns
    # matrix is genes x samples. For chord diagram, total for row i = sum over all columns
    # Total for column j = sum over all rows

    # Compute totals
    row_sums = matrix.sum(axis=1)
    col_sums = matrix.sum(axis=0)
    totals = np.concatenate([row_sums, col_sums])
    total_sum = totals.sum()

    # Set up figure
    fig, ax = plt.subplots(figsize=figsize, subplot_kw={'projection': 'polar'})
    ax.set_xlim(-np.pi/2 - 0.2, 3*np.pi/2 + 0.2)
    ax.set_ylim(0, 1.4)
    ax.set_axis_off()

    # Compute angles - start from top, go clockwise
    # We'll use the convention that angle increases clockwise from top
    gap_rad = np.deg2rad(gap)
    available = 2*np.pi - n * gap_rad
    angles = (totals / total_sum) * available

    # Cumulative angles (starting from top, going clockwise)
    theta = np.cumsum(angles) + np.arange(n) * gap_rad + np.pi/2

    # Store positions for ribbon drawing
    # For each label, store its [start, end] angle (in radians, clockwise from top)
    starts = np.zeros(n)
    ends = np.zeros(n)

    # First segment starts at top
    cumulative = np.pi/2
    for i in range(n):
        starts[i] = cumulative
        ends[i] = cumulative + angles[i]
        cumulative = ends[i] + gap_rad

    # Draw outer arcs (the segment rings)
    arc_width = 0.08
    for i in range(n):
        n_segments = 100
        theta_arc = np.linspace(starts[i], ends[i], n_segments)
        r = np.ones(n_segments) * radius
        ax.fill_between(theta_arc, radius - arc_width, radius,
                       color=colors[i], linewidth=0, zorder=3)

    # Now draw ribbons
    # For each (i, j) where i is row (gene) and j is column (sample), draw a ribbon
    # We need to track where in each segment the ribbon starts and ends

    # For each source (row i), track current angle position
    row_current = starts[:matrix.shape[0]].copy()
    # For each target (column j), track current angle position
    n_rows = matrix.shape[0]
    n_cols = matrix.shape[1]
    col_current = starts[n_rows:].copy()

    def hex_to_rgb(hex_color):
        hex_color = hex_color.lstrip('#')
        return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))

    def rgb_to_hex(rgb):
        return '#{:02x}{:02x}{:02x}'.format(int(rgb[0]), int(rgb[1]), int(rgb[2]))

    def adjust_color(hex_color, factor):
        """Lighten color by mixing with white"""
        rgb = np.array(hex_to_rgb(hex_color)) / 255.0
        rgb = rgb + (1 - rgb) * factor
        return rgb_to_hex(rgb * 255)

    def ribbon_arc(ax, start_angle, end_angle, r, color, alpha, lw=0):
        """Draw an arc at radius r between start_angle and end_angle (clockwise from top)"""
        n_segments = 50
        theta = np.linspace(start_angle, end_angle, n_segments)
        x = r * np.sin(theta)
        y = r * np.cos(theta)
        ax.plot(x, y, color=color, linewidth=lw)

    # For each pair (i, j), draw a ribbon connecting them
    for i in range(n_rows):
        for j in range(n_cols):
            value = matrix.iloc[i, j] if hasattr(matrix, 'iloc') else matrix[i, j]
            if value == 0:
                continue

            # Source: row i, angles in radians (clockwise from top)
            src_total = row_sums[i]
            src_width = (value / src_total) * angles[i]
            src_start = row_current[i]
            src_end = src_start + src_width

            # Target: column j (n_rows + j in our combined array)
            tgt_total = col_sums[j]
            tgt_width = (value / tgt_total) * angles[n_rows + j]
            tgt_start = col_current[j]
            tgt_end = tgt_start + tgt_width

            # Update current positions
            row_current[i] = src_end
            col_current[j] = tgt_end

            # Draw the ribbon as a closed shape using bezier curves
            # Source color (with lightening based on target color)
            src_color = colors[i]
            tgt_color = colors[n_rows + j]

            # Create ribbon path
            # Points on the source arc
            n_src = 30
            src_theta = np.linspace(src_start, src_end, n_src)
            x_src_outer = (radius - arc_width) * np.sin(src_theta)
            y_src_outer = (radius - arc_width) * np.cos(src_theta)
            x_src_outer = x_src_outer[::-1]  # Reverse for going back

            # Points on the target arc
            n_tgt = 30
            tgt_theta = np.linspace(tgt_start, tgt_end, n_tgt)
            x_tgt_outer = (radius - arc_width) * np.sin(tgt_theta)
            y_tgt_outer = (radius - arc_width) * np.cos(tgt_theta)

            # Inner radius for ribbons
            inner_r = radius - arc_width - 0.02

            # Use Bezier curves to connect
            # Compute control points for bezier
            ctrl_r = (radius - arc_width + inner_r) / 2  # mid-radius for control

            # Start of source arc, start of target arc
            src_x_start = (radius - arc_width) * np.sin(src_start)
            src_y_start = (radius - arc_width) * np.cos(src_start)
            src_x_end = (radius - arc_width) * np.sin(src_end)
            src_y_end = (radius - arc_width) * np.cos(src_end)

            tgt_x_start = (radius - arc_width) * np.sin(tgt_start)
            tgt_y_start = (radius - arc_width) * np.cos(tgt_start)
            tgt_x_end = (radius - arc_width) * np.sin(tgt_end)
            tgt_y_end = (radius - arc_width) * np.cos(tgt_end)

            # Control points for curves
            ctrl_src_x_start = ctrl_r * np.sin(src_start)
            ctrl_src_y_start = ctrl_r * np.cos(src_start)
            ctrl_src_x_end = ctrl_r * np.sin(src_end)
            ctrl_src_y_end = ctrl_r * np.cos(src_end)

            ctrl_tgt_x_start = ctrl_r * np.sin(tgt_start)
            ctrl_tgt_y_start = ctrl_r * np.cos(tgt_start)
            ctrl_tgt_x_end = ctrl_r * np.sin(tgt_end)
            ctrl_tgt_y_end = ctrl_r * np.cos(tgt_end)

            # Create path
            verts = []
            codes = []

            # Start at the beginning of source outer arc
            verts.append((src_x_outer := (radius - arc_width) * np.sin(src_start),
                         (radius - arc_width) * np.cos(src_start)))
            codes.append(Path.MOVETO)

            # Source outer arc (clockwise from start to end)
            for k in range(1, n_src):
                theta_k = src_start + (src_end - src_start) * k / (n_src - 1)
                verts.append(((radius - arc_width) * np.sin(theta_k),
                            (radius - arc_width) * np.cos(theta_k)))
                codes.append(Path.LINETO)

            # Bezier curve from end of source to start of target (use quadratic)
            verts.append((ctrl_src_x_end, ctrl_src_y_end))
            codes.append(Path.CURVE3)
            verts.append((tgt_x_start, tgt_y_start))
            codes.append(Path.CURVE3)

            # Target outer arc (clockwise from start to end)
            for k in range(1, n_tgt):
                theta_k = tgt_start + (tgt_end - tgt_start) * k / (n_tgt - 1)
                verts.append(((radius - arc_width) * np.sin(theta_k),
                            (radius - arc_width) * np.cos(theta_k)))
                codes.append(Path.LINETO)

            # Bezier curve back from end of target to start of source
            verts.append((ctrl_tgt_x_end, ctrl_tgt_y_end))
            codes.append(Path.CURVE3)
            verts.append((src_x_start := (radius - arc_width) * np.sin(src_start),
                         (radius - arc_width) * np.cos(src_start)))
            codes.append(Path.CURVE3)

            path = Path(verts, codes)
            patch = mpatches.PathPatch(path, facecolor=adjust_color(src_color, 0.1),
                                       edgecolor='none', alpha=ribbon_alpha, zorder=2)
            ax.add_patch(patch)

    # Add tick marks and labels
    # Tick marks at 0, 30, 60 along each segment
    # Compute the value scale: angles are proportional to totals
    # For each segment, find what 30 and 60 units represent in angle

    # Actually, looking at the example, the ticks seem to be at specific positions
    # Let's compute: for each segment, the value scale is totals[i] / total_sum * available
    # So 0 -> start, 30 -> angle that corresponds to 30 value, etc.

    # But wait, looking at the example more carefully, the 0, 30, 60 are values,
    # not the absolute position. The ticks at 30 and 60 show how far along the segment.

    # Find max total to determine the tick scale
    max_total = max(totals)

    # The labels go around outside
    for i in range(n):
        mid_angle = (starts[i] + ends[i]) / 2
        # Label outside
        label_radius = radius + 0.12
        x = label_radius * np.sin(mid_angle)
        y = label_radius * np.cos(mid_angle)

        # Determine rotation
        angle_deg = np.rad2deg(mid_angle)
        # Adjust for readability - text should be tangent to circle
        # If angle is in upper half, rotate normally; lower half, flip
        if 90 < angle_deg <= 270:
            rotation = angle_deg - 180
        else:
            rotation = angle_deg

        ax.text(x, y, labels[i], rotation=rotation, ha='center', va='center',
                fontsize=label_fontsize, zorder=10)

        # Tick marks
        # Compute angle equivalents of value 0, 30, 60 along this segment
        seg_total = totals[i]
        # 0, 30, 60 are likely fixed values
        tick_values = [0, 30, 60]
        for tv in tick_values:
            if tv <= seg_total:
                tick_frac = tv / seg_total
                tick_angle = starts[i] + tick_frac * angles[i]
                # Draw tick line
                x1 = (radius - arc_width - 0.005) * np.sin(tick_angle)
                y1 = (radius - arc_width - 0.005) * np.cos(tick_angle)
                x2 = (radius - arc_width - 0.025) * np.sin(tick_angle)
                y2 = (radius - arc_width - 0.025) * np.cos(tick_angle)
                ax.plot([x1, x2], [y1, y2], color='black', linewidth=0.8, zorder=5)
                # Tick label
                label_x = (radius - arc_width - 0.05) * np.sin(tick_angle)
                label_y = (radius - arc_width - 0.05) * np.cos(tick_angle)
                ax.text(label_x, label_y, str(tv), fontsize=tick_fontsize,
                        ha='center', va='center', zorder=5)

    plt.tight_layout()
    return fig, ax
# Now let's draw the chord diagram
matrix_values = matrix.values
fig, ax = chord_diagram(matrix_values, all_labels, all_colors,
                         gap=0.3, figsize=(12, 12), label_fontsize=14, tick_fontsize=8)
plt.savefig('chord_diagram.png', dpi=100, bbox_inches='tight', facecolor='white')
plt.show()
print("Saved chord_diagram.png")
