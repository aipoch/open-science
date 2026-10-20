export const reportedCountsSource = `import pandas as pd
df = pd.read_csv("inputs/sample-groups-666666666666.csv")
counts = df["group"].value_counts().sort_index()
print(counts)
print("total:", counts.sum())`

export const reportedPlotSetup = `import matplotlib.pyplot as plt
color_ctrl = "#4c72b0"
color_iri = "#dd8452"
groups = list(counts.index)
values = counts.values
total = int(values.sum())`

export const reportedPieSource = `fig, ax = plt.subplots(figsize=(7, 6), dpi=120)
wedges, texts, autotexts = ax.pie(
    values,
    labels=[f"{g}\\n{n} ({n/total:.1%})" for g, n in zip(groups, values)],
    colors=[color_ctrl if g == "Ctrl" else color_iri for g in groups],
    startangle=90, counterclock=False, autopct="",
    wedgeprops=dict(edgecolor="white", linewidth=2), textprops=dict(fontsize=12),
)
for t in texts:
    t.set_fontsize(13)
ax.set_title("SYNTHETIC_GROUPS sample composition by group", fontsize=14, fontweight="bold")
ax.text(0, -1.25, f"Total samples: {total}", ha="center", fontsize=11, color="#555555")
fig.tight_layout()
fig.savefig("synthetic_groups_pie.png", dpi=120, bbox_inches="tight")
plt.close(fig)
print("pie saved")`

export const reportedBarRetry = `fig, ax = plt.subplots(figsize=(8, 5.5), dpi=120)
bars = ax.bar(groups, values,
    color=[color_ctrl if g == "Ctrl" else color_iri for g in groups],
    width=0.55, edgecolor="white")
for bar, n in zip(bars, values):
    pct = n / total * 100
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.6, f"{n}",
        ha="center", va="bottom", fontsize=12, fontweight="bold")
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() / 2, f"{pct:.1f}%",
        ha="center", va="center", fontsize=11, color="white", fontweight="bold")
ax.set_title("SYNTHETIC_GROUPS sample counts by group\\nTotal samples: 66", fontsize=13, fontweight="bold")
ax.set_xlabel("Group", fontsize=12)
ax.set_ylabel("Sample count", fontsize=12)
ax.set_ylim(0, max(values) * 1.18)
ax.set_yticks(range(0, max(values) + 6, 5))
ax.set_axisbelow(True)
ax.grid(axis="y", linestyle=":", color="#cccccc")
for spine in ("top", "right"):
    ax.spines[spine].set_visible(False)
fig.tight_layout()
fig.savefig("synthetic_groups_bar.png", dpi=120, bbox_inches="tight")
plt.close(fig)
print("bar saved")`

export const reportedFailedPlot = [
  reportedPlotSetup,
  reportedPieSource,
  reportedBarRetry.replace(
    'ax.set_xlabel',
    'ax.suptitle(f"Total samples: {total}", fontsize=11, color="#555555", y=0.96)\nax.set_xlabel'
  )
].join('\n')
