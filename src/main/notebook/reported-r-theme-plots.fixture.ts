export const rThemePlots = String.raw`suppressPackageStartupMessages({
  library(ggplot2)
})
df <- read.csv("inputs/sample-groups-666666666666.csv", stringsAsFactors = FALSE)
counts <- as.data.frame(table(df$group), stringsAsFactors = FALSE)
names(counts) <- c("group", "n")
counts$group <- as.character(counts$group)
counts$pct <- counts$n / sum(counts$n) * 100
counts$label <- paste0(counts$group, "\nn=", counts$n, "\n", sprintf("%.1f%%", counts$pct))
cols <- c(Ctrl = "#4C9BE8", IRI = "#E07B5A")
p_pie <- ggplot(counts, aes(x = "", y = n, fill = group)) +
  geom_bar(stat = "identity", width = 1, color = "white", linewidth = 1.2) +
  coord_polar(theta = "y", start = 0, direction = -1) +
  scale_fill_manual(values = cols) +
  geom_text(aes(label = label), position = position_stack(vjust = 0.5),
            color = "white", fontface = "bold", size = 4.2) +
  labs(title = "SYNTHETIC_GROUPS — Sample Composition by Group", fill = "Group") +
  theme_void(base_size = 13) +
  theme(plot.title = element_text(hjust = 0.5, face = "bold", size = 15),
        legend.position = "right", plot.margin = margin(10, 10, 10, 10))
ggsave("synthetic_groups_pie_ggplot.png", p_pie, width = 8, height = 6, dpi = 140)
p_bar <- ggplot(counts, aes(x = group, y = n, fill = group)) +
  geom_col(width = 0.6, color = "white", linewidth = 0.8) +
  geom_text(aes(label = paste0("n=", n, "\n", sprintf("%.1f%%", pct), "")),
            vjust = -0.4, size = 4.5, fontface = "bold", color = "#333333") +
  scale_fill_manual(values = cols) +
  scale_y_continuous(expand = expansion(mult = c(0, 0.18)),
                     breaks = pretty(c(0, max(counts$n) * 1.2), 6)) +
  labs(title = "SYNTHETIC_GROUPS — Sample Counts per Group",
       x = "Group", y = "Number of samples", fill = "Group") +
  theme_minimal(base_size = 13) +
  theme(plot.title = element_text(hjust = 0.5, face = "bold", size = 15),
        panel.grid.major.x = element_blank(), panel.grid.minor = element_blank(),
        legend.position = "right", axis.line = element_line(color = "gray40", linewidth = 0.5),
        plot.margin = margin(10, 10, 10, 10))
ggsave("synthetic_groups_bar_ggplot.png", p_bar, width = 8, height = 5.5, dpi = 140)
cat("files:\n"); print(list.files(pattern = "^synthetic_groups_.*ggplot\\.png$"))`
