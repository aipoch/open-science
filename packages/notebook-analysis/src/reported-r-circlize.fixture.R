suppressPackageStartupMessages({
  library(circlize)
  library(readxl)
  library(dplyr)
  library(tidyr)
})
src <- "inputs/edge-weights-222222222222.xlsx"
raw <- read_excel(src, sheet = "Sheet 1")
cat("Rows:", nrow(raw), "\n")
cat("Columns:", paste(names(raw), collapse = ", "), "\n")
cat("\nFirst rows:\n")
print(head(raw, 6))
cat("\nUnique 'from' levels:", paste(sort(unique(raw$from)), collapse = ", "), "\n")
cat("Unique 'to' levels:", paste(sort(unique(raw$to)), collapse = ", "), "\n")
cat("\nSummary of value:\n")
print(summary(raw$value))

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(readxl)
  library(dplyr)
  library(tidyr)
})
src <- "inputs/edge-weights-222222222222.xlsx"
raw <- read_excel(src, sheet = "Sheet 1")
# Long -> wide matrix (genes x samples)
mat <- raw %>%
  pivot_wider(names_from = to, values_from = value, values_fill = 0) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- as.matrix(mat)
# Reorder rows/columns to keep a sensible layout
mat <- mat[order(rownames(mat)), order(colnames(mat)), drop = FALSE]
cat("Matrix dim:", paste(dim(mat), collapse = " x "), "\n")
cat("Row names:", paste(rownames(mat), collapse = ", "), "\n")
cat("Col names:", paste(colnames(mat), collapse = ", "), "\n")
cat("Matrix row sums (genes):\n")
print(rowSums(mat))
cat("Matrix col sums (samples):\n")
print(colSums(mat))

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(readxl)
  library(dplyr)
  library(tidyr)
})
src <- "inputs/edge-weights-222222222222.xlsx"
raw <- read_excel(src, sheet = "Sheet 1")
# Long -> wide matrix (genes x samples)
mat <- raw %>%
  pivot_wider(names_from = to, values_from = value, values_fill = 0) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- as.matrix(mat)
# Sort samples naturally (S1, S2, ..., S10)
col_order <- mixedsort::mixedsort(colnames(mat))
mat <- mat[, col_order, drop = FALSE]
# Distinct colour palettes for the two groups
gene_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, nrow(mat)), "Set2")[seq_len(nrow(mat))],
  rownames(mat)
)
sample_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, ncol(mat)), "Set3")[seq_len(ncol(mat))],
  colnames(mat)
)
grid_colors <- c(gene_colors, sample_colors)
# Output file path
out_png <- "chord_diagram.png"
out_pdf <- "chord_diagram.pdf"
png(out_png, width = 1800, height = 1800, res = 220)
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
# Add labels on the outer track
circos.trackPlotRegion(
  track.index = 1,
  panel.fun = function(x, y) {
    sector.name <- get.cell.meta.data("sector.index")
    xlim <- get.cell.meta.data("xlim")
    ylim <- get.cell.meta.data("ylim")
    circos.text(
      mean(xlim), ylim[1] + 0.6, sector.name,
      facing = "clockwise", niceFacing = TRUE, adj = c(0, 0.5),
      cex = 0.85
    )
  },
  bg.border = NA
)
# Add a legend describing the two groups
legend(
  "bottom",
  legend = c(
    paste0("Genes (", length(gene_colors), ")"),
    paste0("Samples (", length(sample_colors), ")")
  ),
  fill = c("#4575B4", "#F1A340"),
  bty = "n",
  cex = 0.9,
  title = "Sectors"
)
title(main = "Gene x Sample chord diagram (circlize)")
dev.off()
# Also save a vector PDF for downstream use
pdf(out_pdf, width = 8, height = 8)
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
circos.trackPlotRegion(
  track.index = 1,
  panel.fun = function(x, y) {
    sector.name <- get.cell.meta.data("sector.index")
    xlim <- get.cell.meta.data("xlim")
    ylim <- get.cell.meta.data("ylim")
    circos.text(
      mean(xlim), ylim[1] + 0.6, sector.name,
      facing = "clockwise", niceFacing = TRUE, adj = c(0, 0.5),
      cex = 0.85
    )
  },
  bg.border = NA
)
legend(
  "bottom",
  legend = c(
    paste0("Genes (", length(gene_colors), ")"),
    paste0("Samples (", length(sample_colors), ")")
  ),
  fill = c("#4575B4", "#F1A340"),
  bty = "n",
  cex = 0.9,
  title = "Sectors"
)
title(main = "Gene x Sample chord diagram (circlize)")
dev.off()
circos.clear()
cat("Wrote:", out_png, "and", out_pdf, "\n")
cat("Files in cwd:\n")
print(list.files(pattern = "chord_diagram"))

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(readxl)
  library(dplyr)
  library(tidyr)
})
# Tiny natural-order sort: extract trailing digits and sort numerically
nat_sort <- function(x) {
  key <- regmatches(x, regexpr("[0-9]+$", x))
  num <- suppressWarnings(as.integer(key))
  num[is.na(num)] <- -1
  x[order(num, x)]
}
src <- "inputs/edge-weights-222222222222.xlsx"
raw <- read_excel(src, sheet = "Sheet 1")
# Long -> wide matrix (genes x samples)
mat <- raw %>%
  pivot_wider(names_from = to, values_from = value, values_fill = 0) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- as.matrix(mat)
mat <- mat[order(rownames(mat)), nat_sort(colnames(mat)), drop = FALSE]
# Distinct colour palettes for the two groups
n_genes <- nrow(mat)
n_samples <- ncol(mat)
gene_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, n_genes), "Set2")[seq_len(n_genes)],
  rownames(mat)
)
sample_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, n_samples), "Set3")[seq_len(n_samples)],
  colnames(mat)
)
grid_colors <- c(gene_colors, sample_colors)
out_png <- "chord_diagram.png"
out_pdf <- "chord_diagram.pdf"
draw_chord <- function(file, width, height, res = NULL) {
  if (!is.null(res)) {
    png(file, width = width, height = height, res = res)
  } else {
    pdf(file, width = width, height = height)
  }
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
  circos.trackPlotRegion(
    track.index = 1,
    panel.fun = function(x, y) {
      sector.name <- get.cell.meta.data("sector.index")
      xlim <- get.cell.meta.data("xlim")
      ylim <- get.cell.meta.data("ylim")
      circos.text(
        mean(xlim), ylim[1] + 0.6, sector.name,
        facing = "clockwise", niceFacing = TRUE, adj = c(0, 0.5),
        cex = 0.85
      )
    },
    bg.border = NA
  )
  legend(
    "bottom",
    legend = c(
      paste0("Genes (", length(gene_colors), ")"),
      paste0("Samples (", length(sample_colors), ")")
    ),
    fill = c("#66C2A5", "#FC8D62"),
    bty = "n",
    cex = 0.9,
    title = "Sectors"
  )
  title(main = "Gene x Sample chord diagram (circlize)")
  dev.off()
  circos.clear()
}
draw_chord(out_png, width = 1800, height = 1800, res = 220)
draw_chord(out_pdf, width = 8, height = 8)
cat("Wrote:", out_png, "and", out_pdf, "\n")
cat("Files in cwd:\n")
print(list.files(pattern = "chord_diagram"))
cat("\nFile sizes:\n")
print(file.info(list.files(pattern = "chord_diagram", full.names = TRUE))[, "size", drop = FALSE])

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(readxl)
  library(dplyr)
  library(tidyr)
})
nat_sort <- function(x) {
  key <- regmatches(x, regexpr("[0-9]+$", x))
  num <- suppressWarnings(as.integer(key))
  num[is.na(num)] <- -1
  x[order(num, x)]
}
src <- "inputs/edge-weights-222222222222.xlsx"
raw <- read_excel(src, sheet = "Sheet 1")
mat <- raw %>%
  pivot_wider(names_from = to, values_from = value, values_fill = 0) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- as.matrix(mat)
mat <- mat[order(rownames(mat)), nat_sort(colnames(mat)), drop = FALSE]
n_genes <- nrow(mat)
n_samples <- ncol(mat)
gene_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, n_genes), "Set2")[seq_len(n_genes)],
  rownames(mat)
)
sample_colors <- setNames(
  RColorBrewer::brewer.pal(max(3, n_samples), "Set3")[seq_len(n_samples)],
  colnames(mat)
)
grid_colors <- c(gene_colors, sample_colors)
draw_chord <- function(file, width, height, res = NULL) {
  if (!is.null(res)) {
    png(file, width = width, height = height, res = res)
  } else {
    pdf(file, width = width, height = height)
  }
  # Reserve space at the bottom for the legend so it doesn't overlap S2/S1
  circos.clear()
  circos.par(start.degree = 90, gap.degree = 2)
  par(mar = c(6, 2, 4, 2))
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
  circos.trackPlotRegion(
    track.index = 1,
    panel.fun = function(x, y) {
      sector.name <- get.cell.meta.data("sector.index")
      xlim <- get.cell.meta.data("xlim")
      ylim <- get.cell.meta.data("ylim")
      circos.text(
        mean(xlim), ylim[1] + 0.6, sector.name,
        facing = "clockwise", niceFacing = TRUE, adj = c(0, 0.5),
        cex = 0.85
      )
    },
    bg.border = NA
  )
  # Layout a legend outside the chord ring using base R `layout`/figure.
  # Place the chord in the upper portion of the device, legend along the bottom.
  title(main = "Gene x Sample chord diagram (circlize)")
  dev.off()
  circos.clear()
}
draw_chord("chord_diagram.png", width = 1800, height = 2000, res = 220)
draw_chord("chord_diagram.pdf", width = 8, height = 8)
# Add a separate legend PNG using a dedicated device
png("chord_diagram_legend.png", width = 1800, height = 240, res = 220)
par(mar = c(2, 2, 1, 2))
plot.new()
plot.window(xlim = c(0, 10), ylim = c(0, 1))
legend(
  "center",
  legend = c(
    paste0("Genes (", length(gene_colors), ")"),
    paste0("Samples (", length(sample_colors), ")")
  ),
  fill = c("#66C2A5", "#FC8D62"),
  bty = "n",
  cex = 1.1,
  horiz = TRUE,
  x.intersp = 1.5,
  text.width = 2.4
)
dev.off()
cat("Wrote:\n")
print(list.files(pattern = "chord_diagram"))
