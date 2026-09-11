# Run in a fresh R kernel; reload the uploaded workbook and write both outputs.
set.seed(42)
suppressPackageStartupMessages({
  library(readxl)
  library(ggVennDiagram)
  library(ggplot2)
})
path <- "inputs/set-membership-111111111111.xlsx"
df <- read_excel(path, sheet = "5 groups", col_names = TRUE)
sets <- lapply(colnames(df), function(c) unique(na.omit(df[[c]])))
names(sets) <- colnames(df)
set_sizes <- sapply(sets, length)
cat("Set sizes:\n"); print(set_sizes)
# Five-set Venn layout; labels report intersection counts (areas are not proportional).
p <- ggVennDiagram(
  sets,
  label_alpha         = 0,
  label_color         = "black",
  label_size          = 3.0,
  label_percent_digit = 1,
  edge_size           = 0.6,
  set_size            = 4.5,
  set_color           = "grey20"
) +
  scale_fill_gradient(low = "#FDE2E4", high = "#9D0208", name = "Intersection\nsize") +
  labs(
    title    = "Venn diagram - five sets",
    subtitle = sprintf(
      "Set sizes  A=%d  B=%d  C=%d  D=%d  E=%d  |  Region labels: count (percent)",
      set_sizes[1], set_sizes[2], set_sizes[3], set_sizes[4], set_sizes[5]
    )
  ) +
  theme_void(base_size = 12) +
  theme(
    plot.title    = element_text(face = "bold", hjust = 0.5),
    plot.subtitle = element_text(hjust = 0.5, color = "grey30", size = 9),
    legend.position = "right"
  )
out_png <- "proportional_venn_5sets.png"
ggsave(
  filename = out_png,
  plot     = p,
  width    = 11,
  height   = 8,
  dpi      = 200,
  bg       = "white"
)
cat("\nSaved:", out_png, "size =", file.info(out_png)$size, "bytes\n")
# Export region-count table for transparency
v  <- Venn(sets)
pd <- process_region_data(v)
region_export <- pd[c("id", "name", "count")]
region_export$item <- vapply(pd$item, function(ids) paste(ids, collapse = ";"), character(1))
write.csv(region_export, "venn_region_counts.csv", row.names = FALSE)
cat("Saved: venn_region_counts.csv\n")
cat("\nTop 12 non-zero regions (sorted by intersection size):\n")
top <- pd[pd$count > 0, ][order(-pd$count[pd$count > 0]), c("name", "count")]
print(head(top, 12))
