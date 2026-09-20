export const reportedSubplotsInput = `import pandas as pd
import matplotlib.pyplot as plt
df = pd.read_csv("inputs/sample-groups-666666666666.csv")
print("Shape:", df.shape)
print("Columns:", df.columns.tolist())
print(df.head())
print("\\nGroup counts:")
print(df["group"].value_counts())`

export const reportedSubplots = `import pandas as pd
import matplotlib.pyplot as plt
df = pd.read_csv("inputs/sample-groups-666666666666.csv")
counts = df["group"].value_counts().sort_index()
labels = counts.index.tolist()
values = counts.values
colors = ["#4C72B0", "#DD8452"]
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5.5))
ax1.pie(values, labels=labels, colors=colors, autopct="%1.1f%%",
        startangle=90, explode=[0.02] * len(labels), textprops={"fontsize": 11})
ax1.set_title("Sample Composition by Group (Pie)", fontsize=13)
bars = ax2.bar(labels, values, color=colors, edgecolor="black", linewidth=0.6)
ax2.set_title("Sample Counts by Group (Bar)", fontsize=13)
ax2.set_xlabel("Group")
ax2.set_ylabel("Number of samples")
ax2.set_ylim(0, max(values) * 1.15)
for bar, v in zip(bars, values):
    ax2.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
             str(v), ha="center", va="bottom", fontsize=11)
ax2.grid(axis="y", linestyle="--", alpha=0.5)
ax2.set_axisbelow(True)
plt.tight_layout()
plt.savefig("synthetic_groups_group_plots.png", dpi=150)
print("Saved: synthetic_groups_group_plots.png")`
