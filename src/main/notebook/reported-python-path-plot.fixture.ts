export const reportedPathInput = `import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path
csv_path = Path("inputs/sample-groups-666666666666.csv")
df = pd.read_csv(csv_path)
print("shape:", df.shape)
print(df.head())
print("group counts:")
print(df["group"].value_counts())`

export const reportedPathPlots = String.raw`import numpy as np
counts = df["group"].value_counts()
labels = counts.index.tolist()
sizes = counts.values.tolist()
colors = ["#4C72B0", "#DD8452"]
explode = [0.03] * len(labels)
fig1, ax1 = plt.subplots(figsize=(6, 6))
wedges, texts, autotexts = ax1.pie(
    sizes,
    labels=[f"{lab}\n(n={n})" for lab, n in zip(labels, sizes)],
    colors=colors[:len(labels)],
    explode=explode,
    autopct="%1.1f%%",
    startangle=90,
    pctdistance=0.72,
    textprops={"fontsize": 11},
)
for t in autotexts:
    t.set_color("white")
    t.set_fontweight("bold")
ax1.set_title(f"SYNTHETIC_GROUPS — Sample Composition by Group\n(n = {sum(sizes)} samples)",
             fontsize=13)
ax1.axis("equal")
plt.tight_layout()
plt.savefig("synthetic_groups_pie.png", dpi=130, bbox_inches="tight")
plt.show()
fig2, ax2 = plt.subplots(figsize=(7, 5))
bars = ax2.bar(labels, sizes, color=colors[:len(labels)],
              edgecolor="black", linewidth=0.8)
for bar, n in zip(bars, sizes):
    ax2.text(bar.get_x() + bar.get_width() / 2,
             bar.get_height() + 0.5,
             str(n),
             ha="center", va="bottom", fontsize=12, fontweight="bold")
ax2.set_xlabel("Group", fontsize=12)
ax2.set_ylabel("Number of samples", fontsize=12)
ax2.set_title("SYNTHETIC_GROUPS — Sample Counts by Group", fontsize=13)
ax2.set_ylim(0, max(sizes) * 1.15)
ax2.grid(axis="y", linestyle="--", alpha=0.5)
ax2.set_axisbelow(True)
plt.tight_layout()
plt.savefig("synthetic_groups_bar.png", dpi=130, bbox_inches="tight")
plt.show()
print("pie total:", sum(sizes))
print("bar max:", max(sizes))`
