import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.path import Path
import matplotlib.patches as patches
import numpy as np
import pandas as pd
import zipfile, xml.etree.ElementTree as ET
# ---- Load data ----
input_path = "inputs/edge-weights-222222222222.xlsx"
with zipfile.ZipFile(input_path) as z:
    with z.open("xl/sharedStrings.xml") as f:
        ss_xml = f.read().decode("utf-8")
    with z.open("xl/worksheets/sheet1.xml") as f:
        sh_xml = f.read().decode("utf-8")
ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
shared = []
for si in ET.fromstring(ss_xml).findall("main:si", ns):
    txt = "".join((t.text or "") for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"))
    shared.append(txt)
rows = []
for row in ET.fromstring(sh_xml).find("main:sheetData", ns).findall("main:row", ns):
    r = []
    for c in row.findall("main:c", ns):
        t = c.get("t", "n")
        v = c.find("main:v", ns)
        val = v.text if v is not None else None
        if t == "s":
            val = shared[int(val)]
        elif t == "n" and val is not None:
            fv = float(val)
            val = int(fv) if fv.is_integer() else fv
        r.append(val)
    rows.append(r)
df = pd.DataFrame(rows[1:], columns=rows[0])
# ---- Build matrix ----
genes = sorted(df['from'].unique(), key=lambda x: int(x[4:]))
samples = sorted(df['to'].unique(), key=lambda x: int(x[1:]))
labels = genes + samples
n = len(labels)
M = np.zeros((n, n))
gene_idx = {g: i for i, g in enumerate(genes)}
samp_idx = {s: i for i, s in enumerate(samples)}
for _, row in df.iterrows():
    i = gene_idx[row['from']]
    j = len(genes) + samp_idx[row['to']]
    M[i, j] = row['value']
    M[j, i] = row['value']
# ---- Colors (close to reference palette) ----
gene_colors = [
    "#4DA6C7",  # Gene1 - cyan/teal
    "#E06B5A",  # Gene2 - red/coral
    "#3DAA8C",  # Gene3 - teal-green
    "#566F94",  # Gene4 - steel blue
    "#F4A582",  # Gene5 - peach
    "#C7B8E0",  # Gene6 - lavender
]
sample_colors = [
    "#7FB69E",  # S1
    "#B22222",  # S2
    "#8B6F4E",  # S3
    "#7D6A53",  # S4
    "#9C9C9C",  # S5
    "#9CC2B6",  # S6
    "#A07AB0",  # S7
    "#C9A24E",  # S8
    "#E7C16A",  # S9
    "#7FCB7F",  # S10
]
node_colors = gene_colors + sample_colors
# ---- Angles ----
totals = M.sum(axis=1)
total_sum = totals.sum()
gap = 0.010 * np.pi
available = 2 * np.pi - gap * n
arcs = totals / total_sum * available
start_angle = np.pi / 2
seg_start = []
seg_end = []
cur = start_angle
for i in range(n):
    seg_start.append(cur)
    seg_end.append(cur - arcs[i])
    cur = seg_end[-1] - gap
seg_start = np.array(seg_start)
seg_end = np.array(seg_end)
# ---- Sub-arc allocation ----
sub_a = np.zeros((n, n))
sub_b = np.zeros((n, n))
for i in range(n):
    my_mid = (seg_start[i] + seg_end[i]) / 2
    def cw_dist(j, _mm=my_mid):
        m = (seg_start[j] + seg_end[j]) / 2
        return (_mm - m) % (2 * np.pi)
    partners = [j for j in range(n) if M[i, j] > 0 and j != i]
    partners.sort(key=cw_dist)
    cur_a = seg_start[i]
    for j in partners:
        frac = M[i, j] / totals[i]
        sub_len = arcs[i] * frac
        sub_a[i, j] = cur_a
        cur_a = cur_a - sub_len
        sub_b[i, j] = cur_a
# ---- Drawing ----
fig, ax = plt.subplots(figsize=(10, 10), facecolor="#F7F7F5")
ax.set_facecolor("#F7F7F5")
ax.set_aspect("equal")
ax.set_xlim(-1.5, 1.5)
ax.set_ylim(-1.5, 1.5)
ax.axis("off")
ring_r_outer = 1.05
ring_r_inner = 0.90
def pol2cart(r, theta):
    return r * np.cos(theta), r * np.sin(theta)
# ---- Ribbons ----
def ribbon_path(i, j, r=ring_r_inner):
    a_i0 = sub_a[i, j]
    a_i1 = sub_b[i, j]
    a_j0 = sub_a[j, i]
    a_j1 = sub_b[j, i]
    p1 = pol2cart(r, a_i0)
    p2 = pol2cart(r, a_i1)
    p3 = pol2cart(r, a_j0)
    p4 = pol2cart(r, a_j1)
    verts = [p1, (0, 0), p2, p3, (0, 0), p4, p1]
    codes = [
        Path.MOVETO,
        Path.CURVE3, Path.CURVE3,
        Path.LINETO,
        Path.CURVE3, Path.CURVE3,
        Path.CLOSEPOLY
    ]
    return Path(verts, codes)
for i in range(n):
    for j in range(i + 1, n):
        if M[i, j] > 0:
            color = node_colors[i]
            ribbon = patches.PathPatch(
                ribbon_path(i, j),
                facecolor=color, edgecolor=color,
                alpha=0.40, linewidth=0.15, zorder=2
            )
            ax.add_patch(ribbon)
# ---- Outer ring segments ----
for i in range(n):
    a0 = np.degrees(seg_end[i])
    a1 = np.degrees(seg_start[i])
    w = mpatches.Wedge(
        (0, 0), ring_r_outer, a0, a1,
        width=ring_r_outer - ring_r_inner,
        facecolor=node_colors[i], edgecolor="white", linewidth=1.5, zorder=3
    )
    ax.add_patch(w)
# ---- Tick marks (0, 30, 60) inside each segment, tangent-oriented ----
for i in range(n):
    a_start = seg_start[i]
    a_end = seg_end[i]
    arc_len = a_start - a_end
    for k, frac in enumerate([1/6, 3/6, 5/6]):
        a = a_start - frac * arc_len
        # radial tick line
        x_in, y_in = pol2cart(ring_r_inner + 0.005, a)
        x_out, y_out = pol2cart(ring_r_outer - 0.005, a)
        ax.plot([x_in, x_out], [y_in, y_out], color="white", linewidth=1.0, zorder=4)
        # label at mid-radius, tangent orientation
        x_lab, y_lab = pol2cart((ring_r_inner + ring_r_outer) / 2, a)
        deg = np.degrees(a) - 90
        if deg > 90:
            deg -= 180
        if deg < -90:
            deg += 180
        ax.text(x_lab, y_lab, ["0", "30", "60"][k], ha="center", va="center",
                fontsize=6, color="white", rotation=deg, zorder=4)
# ---- Outer labels ----
label_r = ring_r_outer + 0.10
for i, lab in enumerate(labels):
    a_mid = (seg_start[i] + seg_end[i]) / 2
    x, y = pol2cart(label_r, a_mid)
    ax.text(x, y, lab, ha="center", va="center", fontsize=15, color="#222", zorder=5)
plt.tight_layout()
plt.savefig("chord_diagram.png", dpi=140, facecolor="#F7F7F5", bbox_inches="tight")
print("Saved. Size:", __import__("os").path.getsize("chord_diagram.png"))
