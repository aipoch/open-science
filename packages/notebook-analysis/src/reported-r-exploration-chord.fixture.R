suppressPackageStartupMessages({
  library(readxl)
})
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
cat("Dim:", dim(df), "\n")
cat("Columns:", paste(names(df), collapse=", "), "\n")
cat("Head:\n")
print(head(df, 20))
cat("Tail:\n")
print(tail(df, 10))
str(df)

# %%

# Check unique categories
cat("Unique from:", sort(unique(df$from)), "\n")
cat("Unique to:", sort(unique(df$to)), "\n")
cat("From count:", length(unique(df$from)), "\n")
cat("To count:", length(unique(df$to)), "\n")
# Check circlize package
cat("circlize installed:", "circlize" %in% rownames(installed.packages()), "\n")
cat("circlize version:", as.character(packageVersion("circlize")), "\n")

# %%

suppressPackageStartupMessages({
  library(circlize)
  library(dplyr)
  library(tidyr)
})
# Pivot long → wide matrix (Genes × Samples)
mat <- df %>%
  pivot_wider(names_from = to, values_from = value, values_fill = 0) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- as.matrix(mat)
cat("Matrix dim:", dim(mat), "\n")
cat("Genes (rows):", rownames(mat), "\n")
cat("Samples (cols):", colnames(mat), "\n")
print(round(mat, 1))

# %%

suppressPackageStartupMessages({
  library(circlize)
})
# Color palette: Genes (blue family) vs Samples (orange/red family)
gene_cols <- setNames(
  colorRampPalette(c("#2c7fb8", "#7fcdbb"))(6),
  paste0("Gene", 1:6)
)
sample_cols <- setNames(
  colorRampPalette(c("#fdae61", "#d7191c"))(10),
  paste0("S", 1:10)
)
grid_cols <- c(gene_cols, sample_cols)
# Open PNG device
png("chord_diagram.png", width = 1600, height = 1600, res = 150)
circos.clear()
circos.par(start.degree = 90, gap.degree = 3)
chordDiagram(
  mat,
  grid.col      = grid_cols,
  transparency  = 0.25,
  annotationTrack = c("grid", "axis"),
  preAllocateTracks = list(
    track.height = 0.05,
    track.margin = c(0.01, 0.01)
  )
)
# Sector labels
circos.trackPlotRegion(
  track.index = 1,
  panel.fun = function(x, y) {
    sector.name <- get.cell.meta.data("sector.index")
    xlim <- get.cell.meta.data("xlim")
    ylim <- get.cell.meta.data("ylim")
    circos.text(
      mean(xlim), ylim[1] + 0.6, sector.name,
      facing = "clockwise", niceFacing = TRUE,
      adj = c(0, 0.5), cex = 0.85
    )
  },
  bg.border = NA
)
# Legend
legend_labels <- c(
  "Genes",  names(gene_cols),
  "Samples", names(sample_cols)
)
legend_fill <- c(
  NA, unname(gene_cols),
  NA, unname(sample_cols)
)
legend(
  "bottomleft",
  legend = legend_labels,
  fill   = legend_fill,
  border = NA,
  bty    = "n",
  cex    = 0.85,
  ncol   = 4,
  title  = "Category"
)
title("Gene × Sample Chord Diagram", cex.main = 1.3)
dev.off()
cat("Saved: chord_diagram.png\n")
file.info("chord_diagram.png")[c("size", "isdir")]

# %%

suppressPackageStartupMessages({
  library(circlize)
})
# Color palette: Genes (blue/teal) vs Samples (orange/red)
n_genes  <- nrow(mat)
n_samples <- ncol(mat)
gene_cols <- setNames(
  colorRampPalette(c("#2c7fb8", "#7fcdbb"))(n_genes),
  rownames(mat)
)
sample_cols <- setNames(
  colorRampPalette(c("#fdae61", "#d7191c"))(n_samples),
  colnames(mat)
)
grid_cols <- c(gene_cols, sample_cols)
# Open PNG device
png("chord_diagram.png", width = 1600, height = 1600, res = 150)
circos.clear()
circos.par(start.degree = 90, gap.degree = 3)
chordDiagram(
  mat,
  grid.col       = grid_cols,
  transparency   = 0.25,
  annotationTrack = c("grid", "axis"),
  preAllocateTracks = list(
    track.height = 0.05,
    track.margin = c(0.01, 0.01)
  )
)
# Sector labels along outer ring
circos.trackPlotRegion(
  track.index = 1,
  panel.fun = function(x, y) {
    sector.name <- get.cell.meta.data("sector.index")
    xlim <- get.cell.meta.data("xlim")
    ylim <- get.cell.meta.data("ylim")
    circos.text(
      mean(xlim), ylim[1] + 0.6, sector.name,
      facing = "clockwise", niceFacing = TRUE,
      adj = c(0, 0.5), cex = 0.85
    )
  },
  bg.border = NA
)
# Legend — Genes
legend_x <- 0.02
legend_y <- 0.18
legend(legend_x, legend_y,
       legend = names(gene_cols),
       fill   = unname(gene_cols),
       border = NA, bty = "o", cex = 0.8,
       title  = "Genes", xpd = TRUE)
# Legend — Samples (offset to the right)
legend(legend_x + 0.32, legend_y,
       legend = names(sample_cols),
       fill   = unname(sample_cols),
       border = NA, bty = "o", cex = 0.8,
       title  = "Samples", xpd = TRUE, ncol = 2)
title("Gene × Sample Chord Diagram", cex.main = 1.3)
dev.off()
cat("Saved chord_diagram.png:", file.exists("chord_diagram.png"), "\n")
cat("Size:", file.info("chord_diagram.png")$size, "bytes\n")

# %%

suppressPackageStartupMessages({
  library(circlize)
})
# Reset to default graphics device settings
dev.list()
# Minimal chord diagram test
png("chord_diagram.png", width = 1400, height = 1400, res = 140)
suppressMessages({
  circos.clear()
  circos.par(start.degree = 90, gap.degree = 3)

  chordDiagram(
    mat,
    transparency   = 0.25,
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
        facing = "clockwise", niceFacing = TRUE,
        adj = c(0, 0.5), cex = 0.85
      )
    },
    bg.border = NA
  )
})
dev.off()
cat("Saved:", file.exists("chord_diagram.png"), "\n")
cat("Size:", file.info("chord_diagram.png")$size, "bytes\n")

# %%

suppressPackageStartupMessages({
  library(circlize)
})
# Color palette: Genes (blue/teal) vs Samples (orange/red)
gene_cols <- setNames(
  colorRampPalette(c("#2c7fb8", "#7fcdbb"))(nrow(mat)),
  rownames(mat)
)
sample_cols <- setNames(
  colorRampPalette(c("#fdae61", "#d7191c"))(ncol(mat)),
  colnames(mat)
)
grid_cols <- c(gene_cols, sample_cols)
# Open PNG device
png("chord_diagram.png", width = 1500, height = 1500, res = 150)
suppressMessages({
  circos.clear()
  circos.par(start.degree = 90, gap.degree = 3)

  chordDiagram(
    mat,
    grid.col       = grid_cols,
    transparency   = 0.25,
    annotationTrack = c("grid", "axis"),
    preAllocateTracks = list(
      track.height = 0.05,
      track.margin = c(0.01, 0.01)
    )
  )

  # Sector labels along outer ring
  circos.trackPlotRegion(
    track.index = 1,
    panel.fun = function(x, y) {
      sector.name <- get.cell.meta.data("sector.index")
      xlim <- get.cell.meta.data("xlim")
      ylim <- get.cell.meta.data("ylim")
      circos.text(
        mean(xlim), ylim[1] + 0.6, sector.name,
        facing = "clockwise", niceFacing = TRUE,
        adj = c(0, 0.5), cex = 0.85
      )
    },
    bg.border = NA
  )
})
# Add a title using mtext (works under circlize device)
mtext("Gene × Sample Chord Diagram", side = 3, line = 1, cex = 1.4, font = 2)
mtext("Ribbon width encodes the value of each Gene–Sample pair", side = 1, line = 1, cex = 1.0)
dev.off()
cat("Saved:", file.exists("chord_diagram.png"), "\n")
cat("Size:", file.info("chord_diagram.png")$size, "bytes\n")

# %%

suppressPackageStartupMessages({
  library(circlize)
})
# Sanity check the color vectors
cat("length(gene_cols):", length(gene_cols), "\n")
cat("length(sample_cols):", length(sample_cols), "\n")
cat("any NA in gene_cols:", any(is.na(gene_cols)), "\n")
cat("any NA in sample_cols:", any(is.na(sample_cols)), "\n")
print(gene_cols)
print(sample_cols)
cat("All grid_cols names match rownames+colnames:",
    identical(names(c(gene_cols, sample_cols)),
              c(rownames(mat), colnames(mat))), "\n")

# %%

suppressPackageStartupMessages({
  library(readxl); library(circlize); library(dplyr); library(tidyr)
})
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
mat <- df %>%
  pivot_wider(names_from = to, values_from = value, values_fill = 0) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- as.matrix(mat)
storage.mode(mat) <- "numeric"
# Colors
gene_cols <- setNames(
  colorRampPalette(c("#2c7fb8", "#7fcdbb"))(nrow(mat)),
  rownames(mat)
)
sample_cols <- setNames(
  colorRampPalette(c("#fdae61", "#d7191c"))(ncol(mat)),
  colnames(mat)
)
grid_cols <- c(gene_cols, sample_cols)
cat("OK so far. n_gene=", nrow(mat), " n_sample=", ncol(mat), "\n")
cat("All grid_cols names match sectors:",
    identical(sort(names(grid_cols)), sort(c(rownames(mat), colnames(mat)))), "\n")
# Test minimal chordDiagram with grid.col only (no mtext, no legend)
png("chord_test.png", width = 1200, height = 1200, res = 120)
circos.clear()
circos.par(start.degree = 90, gap.degree = 3)
chordDiagram(
  mat,
  grid.col       = grid_cols,
  transparency   = 0.25,
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
      facing = "clockwise", niceFacing = TRUE,
      adj = c(0, 0.5), cex = 0.85
    )
  },
  bg.border = NA
)
dev.off()
cat("Saved chord_test.png:", file.exists("chord_test.png"),
    "size:", file.info("chord_test.png")$size, "\n")

# %%

suppressPackageStartupMessages({
  library(readxl); library(circlize); library(dplyr); library(tidyr)
})
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
mat <- df %>% pivot_wider(names_from = to, values_from = value, values_fill = 0) %>%
  as.data.frame()
rownames(mat) <- mat$from
mat$from <- NULL
mat <- as.matrix(mat)
storage.mode(mat) <- "numeric"
cat("=== TEST A: no grid.col, no preAllocateTracks ===\n")
tryCatch({
  png("test_a.png", width = 800, height = 800, res = 100)
  circos.clear()
  circos.par(start.degree = 90, gap.degree = 3)
  chordDiagram(mat, transparency = 0.25)
  dev.off()
  cat("OK test_a\n")
}, error = function(e) cat("FAIL test_a:", conditionMessage(e), "\n"))
cat("=== TEST B: with grid.col ===\n")
gene_cols <- setNames(colorRampPalette(c("#2c7fb8","#7fcdbb"))(nrow(mat)), rownames(mat))
sample_cols <- setNames(colorRampPalette(c("#fdae61","#d7191c"))(ncol(mat)), colnames(mat))
grid_cols <- c(gene_cols, sample_cols)
tryCatch({
  png("test_b.png", width = 800, height = 800, res = 100)
  circos.clear()
  circos.par(start.degree = 90, gap.degree = 3)
  chordDiagram(mat, grid.col = grid_cols, transparency = 0.25)
  dev.off()
  cat("OK test_b\n")
}, error = function(e) cat("FAIL test_b:", conditionMessage(e), "\n"))
cat("=== TEST C: with preAllocateTracks (no grid.col) ===\n")
tryCatch({
  png("test_c.png", width = 800, height = 800, res = 100)
  circos.clear()
  circos.par(start.degree = 90, gap.degree = 3)
  chordDiagram(mat, transparency = 0.25,
               annotationTrack = c("grid","axis"),
               preAllocateTracks = list(track.height = 0.05, track.margin = c(0.01, 0.01)))
  circos.trackPlotRegion(track.index = 1, panel.fun = function(x, y) {
    sector.name <- get.cell.meta.data("sector.index")
    xlim <- get.cell.meta.data("xlim"); ylim <- get.cell.meta.data("ylim")
    circos.text(mean(xlim), ylim[1]+0.6, sector.name,
                facing="clockwise", niceFacing=TRUE, adj=c(0,0.5), cex=0.85)
  }, bg.border = NA)
  dev.off()
  cat("OK test_c\n")
}, error = function(e) cat("FAIL test_c:", conditionMessage(e), "\n"))

# %%

cat("step 1: load readxl\n")
suppressPackageStartupMessages(library(readxl))
cat("step 2: read excel\n")
df <- read_excel("inputs/edge-weights-222222222222.xlsx")
cat("step 3: dim\n")
cat("dim:", dim(df), "\n")
