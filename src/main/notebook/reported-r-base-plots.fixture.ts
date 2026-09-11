export const rBasePlots = String.raw`df <- read.csv("inputs/sample-groups-666666666666.csv")
counts <- table(df$group)
cat("counts:\n"); print(counts)
labels_vec <- names(counts)
values_vec <- as.integer(counts)
colors_vec <- c("#4C72B0", "#DD8452")
png("synthetic_groups_group1_pie_r.png", width = 720, height = 720, res = 130)
pie(values_vec,
  labels = paste0(labels_vec, "\n", values_vec, " (",
    round(100 * values_vec / sum(values_vec), 1), "%)"),
  col = colors_vec, border = "white",
  main = "SYNTHETIC_GROUPS group-1: sample composition (pie)", cex.main = 1.4)
dev.off()
png("synthetic_groups_group1_bar_r.png", width = 960, height = 600, res = 130)
bar_positions <- barplot(values_vec, names.arg = labels_vec, col = colors_vec,
  border = NA, ylim = c(0, max(values_vec) * 1.2), ylab = "Number of samples",
  main = "SYNTHETIC_GROUPS group-1: sample counts (bar)", cex.main = 1.4, cex.names = 1.1, las = 1)
text(bar_positions, values_vec + 0.8, labels = values_vec, cex = 1.1)
abline(h = 0, col = "#888888")
grid(nx = NA, ny = NULL, lty = 3, col = "lightgray")
dev.off()
cat("saved\n")`
