import pandas as pd
import os
print("Files in notebook cwd:")
for f in os.listdir('.'):
    print(f"  {f}")
print("\nFiles in inputs/:")
if os.path.exists('inputs'):
    for f in os.listdir('inputs'):
        print(f"  {f}")

# %%

import pandas as pd
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
print("Shape:", df.shape)
print("\nColumns:", df.columns.tolist())
print("\nDtypes:")
print(df.dtypes)
print("\nFirst 10 rows:")
print(df.head(10).to_string())
print("\nLast 5 rows:")
print(df.tail(5).to_string())

# %%

import pandas as pd
import numpy as np
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
print("Unique 'from' values:", sorted(df['from'].unique().tolist()))
print("Unique 'to' values:", sorted(df['to'].unique().tolist()))
print("\nValue stats:")
print(df['value'].describe())
print("\nValue range by gene:")
print(df.groupby('from')['value'].agg(['min', 'max', 'sum']))
print("\nValue range by sample:")
print(df.groupby('to')['value'].agg(['min', 'max', 'sum']))
wide = df.pivot(index='from', columns='to', values='value')
print("\nWide format shape:", wide.shape)
print(wide)

# %%

import importlib
for pkg in ['pycircos', 'plotly', 'matplotlib', 'bokeh', 'holoviews', 'chord']:
    try:
        m = importlib.import_module(pkg)
        print(f"{pkg}: {getattr(m, '__version__', 'unknown')}")
    except ImportError:
        print(f"{pkg}: NOT INSTALLED")

# %%

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.path import Path
import matplotlib.patches as patches
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
genes = [f"Gene{i}" for i in range(1, 7)]
samples = [f"S{i}" for i in range(1, 11)]
gene_totals = df.groupby('from')['value'].sum().reindex(genes).values
sample_totals = df.groupby('to')['value'].sum().reindex(samples).values
n_seg = len(genes) + len(samples)
gap_deg = 1.5
usable = 360.0 - gap_deg * n_seg
gene_frac = gene_totals / gene_totals.sum()
sample_frac = sample_totals / sample_totals.sum()
gene_span = usable * 0.5 * gene_frac
sample_span = usable * 0.5 * sample_frac
gene_starts = []
acc = 0.0
for s in gene_span:
    gene_starts.append(acc)
    acc += s + gap_deg
sample_starts = []
acc = 180.0
for s in sample_span:
    sample_starts.append(acc)
    acc += s + gap_deg
print("Gene spans (deg):", gene_span.round(2).tolist())
print("Gene starts (deg):", gene_starts)
print()
print("Sample spans (deg):", sample_span.round(2).tolist())
print("Sample starts (deg):", sample_starts)
print()
print("Total arc covered:", sum(gene_span) + sum(sample_span) + gap_deg*n_seg, "deg")

# %%

import os
for root, _, files in os.walk('.'):
    for f in files:
        if 'chord' in f.lower():
            print(os.path.join(root, f))
