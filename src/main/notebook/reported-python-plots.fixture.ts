export const reportedPythonPlots = (inputPath: string): string[] => [
  `import numpy as np
import matplotlib.pyplot as plt
x = np.linspace(-2 * np.pi, 2 * np.pi, 400)
y = np.sin(x)
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.plot(x, y, color="#1f77b4", linewidth=2, label="sin(x)")
ax.axhline(0, color="#888888", linewidth=0.8)
ax.axvline(0, color="#888888", linewidth=0.8)
ax.set_xticks(np.arange(-2 * np.pi, 2 * np.pi + 1e-9, np.pi / 2))
ax.set_xticklabels([f"{v/np.pi:.1g}π" for v in np.arange(-2 * np.pi, 2 * np.pi + 1e-9, np.pi / 2)])
ax.set_ylim(-1.2, 1.2)
ax.set_xlabel("x (radians)")
ax.set_ylabel("sin(x)")
ax.set_title("Sine function on [-2π, 2π]")
ax.grid(True, linestyle=":", alpha=0.6)
ax.legend(loc="upper right")
fig.tight_layout()
fig.savefig("sine_plot.png", dpi=150)
print("saved sine_plot.png")`,
  `import pandas as pd
import matplotlib.pyplot as plt
df = pd.read_csv("${inputPath}")
counts = df["group"].value_counts().sort_index()
print(counts)
print("Total samples:", len(df))
fig, ax = plt.subplots(figsize=(6, 6))
colors = ["#4C78A8", "#F58518"]
wedges, texts, autotexts = ax.pie(
    counts.values,
    labels=counts.index,
    autopct="%1.1f%%",
    startangle=90,
    colors=colors,
    pctdistance=0.7,
    wedgeprops=dict(edgecolor="white", linewidth=2),
)
for t in texts:
    t.set_fontsize(12)
for t in autotexts:
    t.set_color("white")
    t.set_fontsize(11)
    t.set_fontweight("bold")
ax.set_title(f"SYNTHETIC_GROUPS sample composition (n={len(df)})")
ax.axis("equal")
fig.tight_layout()
fig.savefig("group_pie.png", dpi=150)
print("saved group_pie.png")`,
  `import pandas as pd
import matplotlib.pyplot as plt
df = pd.read_csv("${inputPath}")
counts = df["group"].value_counts().sort_index()
fig, ax = plt.subplots(figsize=(6, 4.5))
colors = ["#4C78A8", "#F58518"]
bars = ax.bar(counts.index, counts.values, color=colors, edgecolor="white", linewidth=1.2)
for b, v in zip(bars, counts.values):
    ax.text(b.get_x() + b.get_width() / 2, v + 0.5, str(v),
            ha="center", va="bottom", fontsize=11, fontweight="bold")
ax.set_ylabel("Number of samples")
ax.set_xlabel("Group")
ax.set_title(f"SYNTHETIC_GROUPS sample counts per group (n={len(df)})")
ax.set_ylim(0, max(counts.values) * 1.15)
ax.grid(True, axis="y", linestyle=":", alpha=0.6)
ax.set_axisbelow(True)
fig.tight_layout()
fig.savefig("group_bar.png", dpi=150)
print(counts.to_dict())
print("saved group_bar.png")`
]
