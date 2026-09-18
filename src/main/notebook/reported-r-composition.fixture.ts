export const combinedPlot = String.raw`library(ggplot2)
has_cowplot <- requireNamespace("cowplot", quietly = TRUE)
has_grid <- requireNamespace("gridExtra", quietly = TRUE)
cat("cowplot:", has_cowplot, " gridExtra:", has_grid, "\n")
library(ggplot2)
library(patchwork)
input_path <- "inputs/sample-groups-666666666666.csv"
df <- read.csv(input_path, stringsAsFactors = FALSE)
counts <- as.data.frame(table(df$group), stringsAsFactors = FALSE)
names(counts) <- c("group", "n")
counts$pct <- counts$n / sum(counts$n)
counts$label_pie <- paste0(counts$group, "\n", counts$n, " (", sprintf("%.1f%%", counts$pct * 100), ")")
counts$label_bar <- paste0(counts$n, "\n", sprintf("%.1f%%", counts$pct * 100))
group_colors <- c(Ctrl = "#4C78A8", IRI = "#F58518")
pie_plot <- ggplot(counts, aes(x = "", y = n, fill = group)) +
  geom_bar(stat = "identity", width = 1, colour = "white", linewidth = 1) +
  coord_polar(theta = "y") +
  geom_text(aes(label = label_pie), position = position_stack(vjust = 0.5), colour = "white", size = 5, fontface = "bold") +
  scale_fill_manual(values = group_colors) +
  labs(title = "Sample composition (pie)", fill = "Group") +
  theme_void(base_size = 13) +
  theme(plot.title = element_text(hjust = 0.5, face = "bold"), legend.position = "bottom")
bar_plot <- ggplot(counts, aes(x = group, y = n, fill = group)) +
  geom_bar(stat = "identity", width = 0.6, colour = "white", linewidth = 1) +
  geom_text(aes(label = label_bar), vjust = -0.4, size = 4.5, fontface = "bold") +
  scale_fill_manual(values = group_colors) +
  scale_y_continuous(expand = expansion(mult = c(0, 0.15)), breaks = seq(0, max(counts$n) + 5, 5)) +
  labs(title = "Sample counts by group (bar)", x = "Group", y = "Sample count") +
  theme_minimal(base_size = 13) +
  theme(plot.title = element_text(hjust = 0.5, face = "bold"), legend.position = "none", panel.grid.major.x = element_blank())
combined <- pie_plot + bar_plot +
  plot_annotation(title = "SYNTHETIC_GROUPS sample distribution", subtitle = sprintf("Total samples: %d", sum(counts$n))) +
  plot_layout(guides = "collect") & theme(legend.position = "bottom")
ggsave("synthetic_groups_group_combined.png", plot = combined, width = 11, height = 5.5, dpi = 130)
cat("saved:", "synthetic_groups_group_combined.png\n")`
