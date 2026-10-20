# Inspect the structure of the input file
file_path <- "inputs/edge-weights-222222222222.xlsx"
if (!file.exists(file_path)) {
  cat("File not found at:", file_path, "\n")
  cat("Current dir:", getwd(), "\n")
  cat("Files in inputs:\n")
  print(list.files("inputs", recursive = TRUE))
}

# %%

file_path <- "inputs/edge-weights-222222222222.xlsx"
cat("Exists:", file.exists(file_path), "\n")
cat("CWD:", getwd(), "\n")
cat("Files in inputs:\n")
print(list.files("inputs", recursive = TRUE))

# %%

suppressPackageStartupMessages({
  library(readxl)
})
file_path <- "inputs/edge-weights-222222222222.xlsx"
sheets <- excel_sheets(file_path)
cat("Sheets:", paste(sheets, collapse = ", "), "\n\n")
for (sh in sheets) {
  df <- read_excel(file_path, sheet = sh)
  cat("=== Sheet:", sh, "===\n")
  cat("Dimensions:", nrow(df), "x", ncol(df), "\n")
  cat("Columns:", paste(names(df), collapse = ", "), "\n")
  cat("Head:\n")
  print(head(df, 10))
  cat("\n")
}

# %%

df <- read_excel(file_path, sheet = "Sheet 1")
cat("Total rows:", nrow(df), "\n")
cat("Unique from:", paste(unique(df$from), collapse = ", "), "\n")
cat("Unique to:", paste(unique(df$to), collapse = ", "), "\n")
cat("Range of value:", range(df$value), "\n\n")
cat("Full data:\n")
print(df, n = 60)

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(dplyr)
  library(tidyr)
})
# Read long-format data
file_path <- "inputs/edge-weights-222222222222.xlsx"
df <- read_excel(file_path, sheet = "Sheet 1")
# Pivot to a Gene x Sample matrix for chordDiagram
mat <- df %>%
  pivot_wider(names_from = to, values_from = value) %>%
  as.data.frame()
# Keep 'from' as row names
rownames(mat) <- mat$from
mat$from <- NULL
# Ensure column order is S1..S10 (sorted)
mat <- mat[, order(colnames(mat))]
cat("Matrix dimensions:", dim(mat), "\n")
cat("Row names (Genes):", paste(rownames(mat), collapse = ", "), "\n")
cat("Column names (Samples):", paste(colnames(mat), collapse = ", "), "\n")
cat("First few cells:\n")
print(round(mat[1:3, 1:5], 2))
cat("\nRow totals (Gene totals):\n")
print(rowSums(mat))
cat("\nColumn totals (Sample totals):\n")
print(colSums(mat))

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(dplyr)
  library(tidyr)
})
# Read and prepare data
file_path <- "inputs/edge-weights-222222222222.xlsx"
df <- read_excel(file_path, sheet = "Sheet 1")
# Pivot to Gene x Sample matrix
mat <- df %>%
  pivot_wider(names_from = to, values_from = value) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
# Reorder columns to S1, S2, ..., S10
mat <- mat[, paste0("S", 1:10)]
# Define color palettes for the two groups (Genes and Samples)
n_genes <- nrow(mat)        # 6
n_samples <- ncol(mat)      # 10
# Gene palette (blue family)
gene_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, n_genes), "Set2")[seq_len(n_genes)],
  rownames(mat)
)
# Sample palette (orange/red family)
sample_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, n_samples), "Set1")[seq_len(n_samples)],
  colnames(mat)
)
grid_colors <- c(gene_colors, sample_colors)
# Draw chord diagram
out_file <- "chord_diagram.png"
png(filename = out_file, width = 2400, height = 2400, res = 300)
circos.clear()
circos.par(start.degree = 90, gap.degree = 2)
chordDiagram(
  mat,
  grid.col = grid_colors,
  transparency = 0.25,
  annotationTrack = c("grid", "axis"),
  preAllocateTracks = list(
    track.height = 0.05,
    track.margin = c(0.01, 0.01)
  )
)
# Add labels
circos.trackPlotRegion(
  track.index = 1,
  panel.fun = function(x, y) {
    sector.name <- get.cell.meta.data("sector.index")
    xlim <- get.cell.meta.data("xlim")
    ylim <- get.cell.meta.data("ylim")
    circos.text(
      mean(xlim), ylim[1] + 0.5, sector.name,
      facing = "clockwise", niceFacing = TRUE,
      adj = c(0, 0.5), cex = 0.85
    )
  },
  bg.border = NA
)
# Title
title(main = "Gene × Sample Chord Diagram", cex.main = 1.3)
dev.off()
cat("Saved:", out_file, "\n")
cat("File size (bytes):", file.size(out_file), "\n")

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(dplyr)
  library(tidyr)
  library(RColorBrewer)
})
# Read and prepare data
file_path <- "inputs/edge-weights-222222222222.xlsx"
df <- read_excel(file_path, sheet = "Sheet 1")
# Pivot to Gene x Sample matrix
mat <- df %>%
  pivot_wider(names_from = to, values_from = value) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- mat[, paste0("S", 1:10)]
# Two distinct color palettes for the two groups
n_genes <- nrow(mat)
n_samples <- ncol(mat)
gene_palette   <- colorRampPalette(brewer.pal(8, "Set2"))(n_genes)
sample_palette <- colorRampPalette(brewer.pal(9, "Set1"))(n_samples)
gene_colors   <- setNames(gene_palette,   rownames(mat))
sample_colors <- setNames(sample_palette, colnames(mat))
grid_colors   <- c(gene_colors, sample_colors)
# Render with larger gaps and label margins for readability
out_file <- "chord_diagram.png"
png(filename = out_file, width = 2400, height = 2400, res = 300)
circos.clear()
circos.par(
  start.degree = 90,
  gap.degree   = 4,
  canvas.xlim  = c(-1.1, 1.1),
  canvas.ylim  = c(-1.1, 1.1)
)
chordDiagram(
  mat,
  grid.col         = grid_colors,
  transparency     = 0.25,
  annotationTrack  = c("grid", "axis"),
  preAllocateTracks = list(
    track.height = 0.06,
    track.margin = c(0.02, 0.02)
  )
)
# Place sector labels just outside the axis track
circos.trackPlotRegion(
  track.index = 1,
  panel.fun = function(x, y) {
    sector.name <- get.cell.meta.data("sector.index")
    xlim <- get.cell.meta.data("xlim")
    ylim <- get.cell.meta.data("ylim")
    circos.text(
      x = mean(xlim),
      y = ylim[1] + 0.5,
      labels = sector.name,
      facing       = "clockwise",
      niceFacing   = TRUE,
      adj          = c(0, 0.5),
      cex          = 0.85
    )
  },
  bg.border = NA
)
title(main = "Gene × Sample Chord Diagram", cex.main = 1.4)
dev.off()
cat("Saved:", out_file, "\n")
cat("Size (bytes):", file.size(out_file), "\n")
