export const reportedPythonCallbackPrelude = `import numpy as np
import matplotlib.pyplot as plt
x = np.linspace(0, 2 * np.pi, 500)
y = np.sin(x)
plt.figure(figsize=(8, 5))
plt.plot(x, y, color="#1f77b4", linewidth=2, label="sin(x)")
plt.axhline(0, color="gray", linewidth=0.8)
plt.axvline(np.pi, color="gray", linewidth=0.5, linestyle="--", alpha=0.6)
plt.title("Sine Wave")
plt.xlabel("x (radians)")
plt.ylabel("sin(x)")
plt.xticks([0, np.pi / 2, np.pi, 3 * np.pi / 2, 2 * np.pi], ["0", "π/2", "π", "3π/2", "2π"])
plt.ylim(-1.2, 1.2)
plt.grid(True, alpha=0.3)
plt.legend()
plt.tight_layout()
plt.savefig("sin_plot.png", dpi=120)
plt.close()
print("saved")`

export const reportedPythonCallbackPlot = String.raw`import matplotlib.pyplot as plt
# Synthetic data from  inputs/group_bar_r-777777777777.png:SYNTHETIC_GROUPS
labels = ["Ctrl", "IRI"]
sizes = [33, 33]
colors = ["#4878A6", "#E1812C"]
fig, ax = plt.subplots(figsize=(7, 6), dpi=120)
wedges, texts, autotexts = ax.pie(
    sizes, labels=labels, colors=colors,
    autopct=lambda p: f"{p:.1f}%\n({int(round(p * sum(sizes) / 100))})",
    startangle=90, counterclock=False,
    wedgeprops=dict(edgecolor="white", linewidth=2),
    textprops=dict(fontsize=12),
)
for t in autotexts:
    t.set_color("white")
    t.set_fontsize(11)
    t.set_fontweight("bold")
ax.set_title("SYNTHETIC_GROUPS sample counts per group (n=66)", fontsize=14, fontweight="bold", pad=18)
ax.axis("equal")
plt.tight_layout()
plt.savefig("group_pie_r.png", dpi=120, bbox_inches="tight")
plt.close()
print("saved")`
