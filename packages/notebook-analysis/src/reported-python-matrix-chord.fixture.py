import numpy as np
import matplotlib.pyplot as plt
from matplotlib.path import Path
import matplotlib.patches as mpatches

genes = sorted(df['from'].unique(), key=lambda x: int(x.replace('Gene','')))
def s_key(s): return int(s.replace('S',''))
samples = sorted(df['to'].unique(), key=s_key)

M = np.zeros((len(genes), len(samples)))
for _, row in df.iterrows():
    M[genes.index(row['from']), samples.index(row['to'])] = row['value']

row_totals = M.sum(axis=1)
col_totals = M.sum(axis=0)
totals = np.concatenate([row_totals, col_totals])
labels = genes + samples
n = len(labels)
gap_deg = 1.5
gap = np.deg2rad(gap_deg)
total_gap = gap * n
total_value = totals.sum()
angular_total = 2*np.pi - total_gap
start = np.pi/2
spans = (totals / total_value) * angular_total
begs = np.zeros(n); ends = np.zeros(n)
b = start
for i in range(n):
    begs[i] = b
    ends[i] = b - spans[i]
    b = ends[i] - gap

gene_colors = ['#7BC8E0', '#F17A6B', '#3CB495', '#566B8C', '#F0BFA0', '#B0B7C9']
sample_colors = ['#9E9E9E', '#D32F2F', '#A1887F', '#8D6E63', '#B5D6C2', '#C5C9D6',
                 '#B39DDB', '#CE93D8', '#FBC02D', '#81C784']
colors = gene_colors + sample_colors
fig, ax = plt.subplots(figsize=(8.5, 8.5), dpi=140)
ax.set_aspect('equal'); ax.axis('off')
R_OUTER = 1.00
R_INNER = 0.78
R_TICK_OUT = 0.99
R_TICK_IN = 0.79
R_LABEL = 1.10
R_RIBBON = 0.74

def to_math(theta):
    return -theta

def arc_segment(ax, t1, t2, r_in, r_out, color):
    n_pts = 60
    ts = np.linspace(t1, t2, n_pts)
    outer = np.column_stack([r_out*np.cos(ts), r_out*np.sin(ts)])
    inner = np.column_stack([r_in*np.cos(ts[::-1]), r_in*np.sin(ts[::-1])])
    pts = np.vstack([outer, inner])
    codes = [Path.MOVETO] + [Path.LINETO]*(len(pts)-1)
    path = Path(pts, codes)
    patch = mpatches.PathPatch(path, facecolor=color, edgecolor='white', lw=2.5)
    ax.add_patch(patch)

for i in range(n):
    arc_segment(ax, to_math(begs[i]), to_math(ends[i]), R_INNER, R_OUTER, colors[i])

for i in range(n):
    seg_total = totals[i]
    for tv in [0, 30, 60]:
        if tv > seg_total: continue
        frac = tv / seg_total
        ang_cw = begs[i] - frac * spans[i]
        ang = to_math(ang_cw)
        ax.plot([R_TICK_IN*np.cos(ang), R_TICK_OUT*np.cos(ang)],
                [R_TICK_IN*np.sin(ang), R_TICK_OUT*np.sin(ang)],
                color='white', lw=0.7, alpha=0.85, zorder=5)
        lx = (R_TICK_OUT - 0.025)*np.cos(ang)
        ly = (R_TICK_OUT - 0.025)*np.sin(ang)
        ax.text(lx, ly, str(tv), fontsize=5.5, color='white', ha='center', va='center',
                zorder=6, weight='bold')

for i in range(n):
    ang_cw = (begs[i] + ends[i])/2
    ang = to_math(ang_cw)
    lx = R_LABEL*np.cos(ang); ly = R_LABEL*np.sin(ang)
    rot = np.degrees(ang)
    if rot > 90: rot -= 180
    if rot < -90: rot += 180
    ax.text(lx, ly, labels[i], fontsize=11, ha='center', va='center',
            rotation=rot, rotation_mode='anchor', color='#222')

def ribbon(ax, g_a1, g_a2, s_a1, s_a2, color, alpha=0.55):
    r = R_RIBBON
    pts = [
        (r*np.cos(g_a1), r*np.sin(g_a1)),
        (0.0, 0.0), (0.0, 0.0),
        (r*np.cos(s_a1), r*np.sin(s_a1)),
        (0.0, 0.0), (0.0, 0.0),
        (r*np.cos(s_a2), r*np.sin(s_a2)),
        (0.0, 0.0), (0.0, 0.0),
        (r*np.cos(g_a2), r*np.sin(g_a2)),
        (r*np.cos(g_a1), r*np.sin(g_a1)),
    ]
    codes = [Path.MOVETO, Path.CURVE4, Path.CURVE4, Path.CURVE4,
             Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.CURVE4,
             Path.CURVE4, Path.CURVE4, Path.CLOSEPOLY]
    path = Path(pts, codes)
    patch = mpatches.PathPatch(path, facecolor=color, edgecolor='none', alpha=alpha)
    ax.add_patch(patch)

offsets_g = np.zeros(len(genes))
offsets_s = np.zeros(len(samples))
for i in range(len(genes)):
    for j in range(len(samples)):
        v = M[i, j]
        if v <= 0: continue
        g_total = totals[i]; s_total = totals[len(genes)+j]
        g_span = spans[i]; s_span = spans[len(genes)+j]
        g_a1_cw = begs[i] - (offsets_g[i]/g_total) * g_span
        g_a2_cw = begs[i] - ((offsets_g[i]+v)/g_total) * g_span
        s_a1_cw = begs[len(genes)+j] - (offsets_s[j]/s_total) * s_span
        s_a2_cw = begs[len(genes)+j] - ((offsets_s[j]+v)/s_total) * s_span
        ribbon(ax, to_math(g_a1_cw), to_math(g_a2_cw),
               to_math(s_a1_cw), to_math(s_a2_cw), colors[i], alpha=0.5)
        offsets_g[i] += v
        offsets_s[j] += v

ax.set_xlim(-1.3, 1.3); ax.set_ylim(-1.3, 1.3)
plt.tight_layout()
plt.savefig('chord_diagram.png', dpi=160, bbox_inches='tight', facecolor='white')
print('saved')
