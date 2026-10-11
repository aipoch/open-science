library(readxl)
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
cat("dim:", dim(df), "\n")
cat("colnames:", paste(colnames(df), collapse=" | "), "\n")
cat("head 10:\n")
print(head(df, 10))
cat("\ntail 5:\n")
print(tail(df, 5))
cat("\nstructure:\n")
str(df)

# %%

library(readxl)
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
cat("Unique from:", length(unique(df$from)), "->", paste(unique(df$from), collapse=","), "\n")
cat("Unique to:", length(unique(df$to)), "->", paste(unique(df$to), collapse=","), "\n")
# wide format
mat <- reshape2::acast(df, from ~ to, value.var = "value", fill = 0)
cat("Matrix dim:", dim(mat), "\n")
print(round(mat, 2))
cat("\nRow totals:\n"); print(rowSums(mat))
cat("Col totals:\n"); print(colSums(mat))

# %%

library(readxl)
library(tidyr)
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
# Build a Genes x Samples matrix (long -> wide)
mat <- as.matrix(
  pivot_wider(df, names_from = to, values_from = value, values_fill = 0) |>
    column_to_rownames("from")
)
cat("Matrix dim:", dim(mat), "\n")
print(round(mat, 2))
cat("\nRow totals:\n"); print(rowSums(mat))
cat("Col totals:\n"); print(colSums(mat))
saveRDS(mat, "chord_matrix.rds")

# %%

library(readxl)
library(tidyr)
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
wider <- pivot_wider(df, names_from = to, values_from = value, values_fill = 0)
wider_mat <- as.data.frame(wider)
rownames(wider_mat) <- wider_mat$from
wider_mat$from <- NULL
mat <- as.matrix(wider_mat)
cat("Matrix dim:", dim(mat), "\n")
print(round(mat, 2))
cat("\nRow totals:\n"); print(rowSums(mat))
cat("Col totals:\n"); print(colSums(mat))
saveRDS(mat, "chord_matrix.rds")

# %%

suppressPackageStartupMessages({
  library(readxl); library(tidyr); library(dplyr); library(circlize)
})
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
wider <- pivot_wider(df, names_from = to, values_from = value, values_fill = 0)
mat <- as.data.frame(wider)
rownames(mat) <- mat$from; mat$from <- NULL
mat <- as.matrix(mat)
# Chord diagram of the Gene -> Sample adjacency (rows sum ~70, cols sum ~100)
genes <- rownames(mat); samples <- colnames(mat)
sector_colors <- c(setNames(RColorBrewer::brewer.pal(min(8, length(genes)), "Set2")[seq_along(genes)], genes),
                   setNames(RColorBrewer::brewer.pal(min(9, length(samples)), "Set1")[seq_along(samples)], samples))
circos.clear()
circos.par(start.degree = 90, gap.degree = 4, track.margin = c(0.02, 0.02))
chordDiagram(
  mat,
  grid.col      = sector_colors,
  transparency  = 0.35,
  annotationTrack = c("grid", "axis"),
  preAllocateTracks = list(
    track.height = 0.05,
    track.margin = c(0.01, 0.01)
  )
)
# Sector labels
circos.trackPlotRegion(track.index = 1, panel.fun = function(x, y) {
  sector.name <- get.cell.meta.data("sector.index")
  xlim <- get.cell.meta.data("xlim")
  ylim <- get.cell.meta.data("ylim")
  circos.text(
    mean(xlim), ylim[1] + 0.5,
    sector.name, facing = "clockwise", niceFacing = TRUE,
    adj = c(0, 0.5), cex = 0.85
  )
}, bg.border = NA)
circos.clear()
mtext("Chord diagram: Genes -> Samples", side = 3, outer = TRUE, cex = 1.1, line = -1)
dev.copy(png, "chord_diagram.png", width = 1600, height = 1600, res = 200)
dev.off()
cat("Saved chord_diagram.png\n")
list.files(".", pattern = "chord_diagram.png")

# %%

suppressPackageStartupMessages({
  library(readxl); library(tidyr); library(dplyr); library(circlize); library(RColorBrewer)
})
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
wider <- pivot_wider(df, names_from = to, values_from = value, values_fill = 0)
mat <- as.data.frame(wider); rownames(mat) <- mat$from; mat$from <- NULL
mat <- as.matrix(mat)
genes <- rownames(mat); samples <- colnames(mat)
gene_cols  <- setNames(brewer.pal(min(8, length(genes)),  "Set2")[seq_along(genes)],  genes)
sample_cols <- setNames(brewer.pal(min(9, length(samples)), "Set1")[seq_along(samples)], samples)
sector_colors <- c(gene_cols, sample_cols)
# Highlight the largest 20% of flows
thr <- quantile(mat, 0.80, na.rm = TRUE)
highlight_mat <- ifelse(mat >= thr, mat, 0)
others_val <- sum(mat) - sum(highlight_mat)
cols_use <- sector_colors
cols_use["others"] <- "#999999"
circos.clear()
circos.par(start.degree = 90, gap.degree = c(rep(3, length(genes)-1), 8, rep(3, length(samples)-1), 8),
           track.margin = c(0.02, 0.02), canvas.ylim = c(-1.1, 1.1), canvas.xlim = c(-1.1, 1.1))
chordDiagram(
  mat,
  grid.col          = cols_use,
  col               = cols_use,
  transparency      = 0.25,
  annotationTrack   = "grid",
  preAllocateTracks = list(track.height = 0.06)
)
circos.trackPlotRegion(track.index = 1, panel.fun = function(x, y) {
  sector.name <- get.cell.meta.data("sector.index")
  xlim <- get.cell.meta.data("xlim"); ylim <- get.cell.meta.data("ylim")
  circos.text(mean(xlim), ylim[1] + 0.4, sector.name,
              facing = "clockwise", niceFacing = TRUE,
              adj = c(0, 0.5), cex = 0.85)
}, bg.border = NA)
title("Chord diagram: Genes ↔ Samples (top-20% flows emphasized)")
dev.copy(png, "chord_diagram.png", width = 1600, height = 1600, res = 200)
dev.off()
cat("Re-saved chord_diagram.png\n")

# %%

suppressPackageStartupMessages({
  library(readxl); library(tidyr); library(dplyr); library(circlize); library(RColorBrewer)
})
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
wider <- pivot_wider(df, names_from = to, values_from = value, values_fill = 0)
mat <- as.data.frame(wider); rownames(mat) <- mat$from; mat$from <- NULL
mat <- as.matrix(mat)
genes <- rownames(mat); samples <- colnames(mat)
gene_cols   <- setNames(brewer.pal(min(8, length(genes)),  "Set2")[seq_along(genes)],  genes)
sample_cols <- setNames(brewer.pal(min(9, length(samples)), "Set1")[seq_along(samples)], samples)
sector_colors <- c(gene_cols, sample_cols)
# Only color rows/columns that actually exist as sectors
link_cols <- sector_colors
circos.clear()
circos.par(start.degree = 90,
           gap.degree   = c(rep(3, length(genes)-1), 8, rep(3, length(samples)-1), 8),
           track.margin = c(0.02, 0.02),
           canvas.ylim  = c(-1.1, 1.1),
           canvas.xlim  = c(-1.1, 1.1))
chordDiagram(
  mat,
  order            = c(genes, samples),
  grid.col         = sector_colors,
  col              = link_cols,
  transparency     = 0.25,
  annotationTrack  = "grid",
  preAllocateTracks = list(track.height = 0.06)
)
circos.trackPlotRegion(track.index = 1, panel.fun = function(x, y) {
  sector.name <- get.cell.meta.data("sector.index")
  xlim <- get.cell.meta.data("xlim"); ylim <- get.cell.meta.data("ylim")
  circos.text(mean(xlim), ylim[1] + 0.4, sector.name,
              facing = "clockwise", niceFacing = TRUE,
              adj = c(0, 0.5), cex = 0.85)
}, bg.border = NA)
title("Chord diagram: Genes ↔ Samples (adjacency from long table)")
dev.copy(png, "chord_diagram.png", width = 1600, height = 1600, res = 200)
dev.off()
cat("Re-saved chord_diagram.png with adjacent sectors.\n")

# %%

suppressPackageStartupMessages({
  library(readxl); library(tidyr); library(dplyr); library(circlize); library(RColorBrewer)
})
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
wider <- pivot_wider(df, names_from = to, values_from = value, values_fill = 0)
mat <- as.data.frame(wider); rownames(mat) <- mat$from; mat$from <- NULL
mat <- as.matrix(mat)
genes <- rownames(mat); samples <- colnames(mat)
gene_cols   <- setNames(brewer.pal(min(8, length(genes)),  "Set2")[seq_along(genes)],  genes)
sample_cols <- setNames(brewer.pal(min(9, length(samples)), "Set1")[seq_along(samples)], samples)
sector_colors <- c(gene_cols, sample_cols)
# A matrix of link colors indexed by (from, to); color each link by its source gene
link_col_mat <- matrix(gene_cols[rep(genes, times = length(samples))],
                       nrow = length(genes), ncol = length(samples),
                       dimnames = list(genes, samples))
circos.clear()
circos.par(start.degree = 90,
           gap.degree   = c(rep(3, length(genes)-1), 8, rep(3, length(samples)-1), 8),
           track.margin = c(0.02, 0.02),
           canvas.ylim  = c(-1.1, 1.1),
           canvas.xlim  = c(-1.1, 1.1))
chordDiagram(
  mat,
  order            = c(genes, samples),
  grid.col         = sector_colors,
  col              = link_col_mat,
  transparency     = 0.25,
  annotationTrack  = "grid",
  preAllocateTracks = list(track.height = 0.06)
)
circos.trackPlotRegion(track.index = 1, panel.fun = function(x, y) {
  sector.name <- get.cell.meta.data("sector.index")
  xlim <- get.cell.meta.data("xlim"); ylim <- get.cell.meta.data("ylim")
  circos.text(mean(xlim), ylim[1] + 0.4, sector.name,
              facing = "clockwise", niceFacing = TRUE,
              adj = c(0, 0.5), cex = 0.85)
}, bg.border = NA)
title("Chord diagram: Genes ↔ Samples (link color = source gene)")
dev.copy(png, "chord_diagram.png", width = 1600, height = 1600, res = 200)
dev.off()
