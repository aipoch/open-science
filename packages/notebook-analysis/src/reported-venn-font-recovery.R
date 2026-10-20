# Run in a fresh R kernel after failed font registration attempts.
suppressPackageStartupMessages({
  library(readxl)
  library(ggplot2)
  library(ggVennDiagram)
})
options(scipen = 999)
set.seed(42)
fp <- "inputs/set-membership-111111111111.xlsx"
df <- read_excel(fp, sheet = "5 groups")
# Build a named list of unique, non-NA IDs per column
sets <- lapply(df, function(x) unique(na.omit(as.character(x))))
# Plot the five sets using the default device font.
p <- ggVennDiagram(
  sets,
  label_alpha   = 0,
  label_geom    = "label",
  set_color      = c("#4DAF4A", "#377EB8", "#E41A1C", "#984EA3", "#FF7F00"),
  set_size       = 3,
  show_intersect = FALSE
) +
  scale_fill_gradient(low = "white", high = "#377EB8") +
  scale_x_continuous(expand = expansion(mult = 0.1)) +
  scale_y_continuous(expand = expansion(mult = 0.1)) +
  labs(
    title    = "Venn Diagram (5 sets, A-E)",
    subtitle = sprintf(
      "Set sizes: A=%d, B=%d, C=%d, D=%d, E=%d",
      lengths(sets)[1], lengths(sets)[2], lengths(sets)[3],
      lengths(sets)[4], lengths(sets)[5]
    ),
    fill = "Region size"
  ) +
  theme(
    plot.title    = element_text(face = "bold", hjust = 0.5),
    plot.subtitle = element_text(hjust = 0.5, color = "grey30")
  )
out_png <- "proportional_venn_5sets.png"
ggsave(out_png, p, width = 9, height = 7, dpi = 200, bg = "white")
cat("Saved:", out_png, "size=", file.info(out_png)$size, "bytes\n")
# Also list the pairwise-ish intersection counts (top-level only) for the user
intersect_region <- process_region_data(Venn(sets))
cat("\nVenn region counts (top combinations by count):\n")
print(head(intersect_region[order(-intersect_region$count), c("name", "count")], 15))
