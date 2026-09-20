import pandas as pd
df = pd.read_excel("inputs/edge-weights-222222222222.xlsx")
print(df.shape)
print(df.head(20))
print(df.dtypes)

# %%

import pandas as pd, numpy as np
from pycirclize import Circos
import matplotlib.pyplot as plt
df = pd.read_excel("inputs/edge-weights-222222222222.xlsx")
mat = df.pivot_table(index="from", columns="to", values="value", aggfunc="sum").fillna(0)
genes = [f"Gene{i}" for i in range(1,7)]
samples = [f"S{i}" for i in range(1,11)]
mat = mat.loc[genes, samples]
print(mat)
print(mat.sum(axis=1)); print(mat.sum(axis=0))

# %%

from pycirclize import Circos
import matplotlib.pyplot as plt
gene_colors = {"Gene1":"#4FA3C4","Gene2":"#E2553F","Gene3":"#1B9E8A","Gene4":"#41618C",
               "Gene5":"#F2907A","Gene6":"#8496B8"}
sample_colors = {"S1":"#7FCDBB","S2":"#E8112D","S3":"#8B7355","S4":"#C9B49A","S5":"#D98880",
                 "S6":"#A8DADC","S7":"#9BB0C4","S8":"#C77DD8","S9":"#E0CFA0","S10":"#8ED973"}
cmap = {**gene_colors, **sample_colors}
order = genes + samples
circos = Circos.chord_diagram(
    mat, space=3, order=order, cmap=cmap,
    ticks_interval=30, label_kws=dict(size=13, r=118),
    ticks_kws=dict(label_size=9),
    link_kws=dict(ec="white", lw=0.2, direction=0),
)
fig = circos.plotfig(figsize=(8,8))
fig.savefig("chord_diagram.png", dpi=300, bbox_inches="tight", facecolor="white")
fig.savefig("chord_diagram.pdf", bbox_inches="tight", facecolor="white")
print("ok")
