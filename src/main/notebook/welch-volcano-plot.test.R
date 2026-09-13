args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 3L)
stopifnot(requireNamespace("ggplot2", quietly = TRUE), requireNamespace("ggrepel", quietly = TRUE))
root <- getwd()
df_unique <- rbind(
  Strong = c(1, 1.1, 0.9, 4, 4.1, 3.9, 1, 1.1, 0.9, 4, 4.1, 3.9),
  Null = rep(c(1, 2, 3), 4),
  Constant = rep(2, 12),
  UntestableB = c(1, 1.1, 0.9, 4, 4.1, 3.9, rep(2, 6)),
  UntestableA = c(rep(2, 6), 1, 1.1, 0.9, 4, 4.1, 3.9)
)
colnames(df_unique) <- c(
  "CohortActrl1", "CohortActrl2", "CohortActrl4", "CohortAsi1", "CohortAsi2", "CohortAsi5",
  "CohortBctrl1", "CohortBctrl2", "CohortBctrl4", "CohortBsi1", "CohortBsi2", "CohortBsi3"
)
# Raw-input failures must also survive the real plotting/export path.
df_unique <- rbind(df_unique, MissingA = df_unique["Strong", ], InfiniteB = df_unique["Strong", ])
df_unique["MissingA", "CohortActrl1"] <- NA_real_
df_unique["InfiniteB", "CohortBsi1"] <- Inf
source(args[1])
stopifnot(is.na(diff_df$CohortA_log2FoldChange[diff_df$id == "MissingA"]))
stopifnot(is.na(diff_df$CohortB_pvalue[diff_df$id == "InfiniteB"]))
stopifnot(grepl("Missing or non-finite expression", diff_df$CohortA_test_error[diff_df$id == "MissingA"], fixed = TRUE))
computed <- diff_df
check_csv <- function(expected) {
  # CSV does not encode column types; read using the declared result-table schema.
  column_types <- vapply(expected, function(value) {
    if (is.numeric(value)) "numeric" else if (is.logical(value)) "logical" else "character"
  }, character(1))
  saved <- read.csv("diagonal_volcano_diff.csv", check.names = FALSE, stringsAsFactors = FALSE, colClasses = column_types)
  stopifnot(identical(names(saved), names(expected)), nrow(saved) == nrow(expected))
  for (name in names(expected)) {
    value <- expected[[name]]
    if (is.factor(value)) value <- as.character(value)
    stopifnot(isTRUE(all.equal(saved[[name]], value, check.attributes = FALSE, tolerance = 1e-12)))
  }
}
for (case in c("ordinary", "no_hits", "all_missing", "nonfinite", "all_zero")) {
  dir.create(file.path(root, case))
  setwd(file.path(root, case))
  diff_df <- computed
  if (case == "no_hits") {
    diff_df$CohortA_padj <- 0.8
    diff_df$CohortB_padj <- 0.8
  }
  if (case == "all_missing") {
    diff_df$CohortA_log2FoldChange <- NA_real_
    diff_df$CohortB_log2FoldChange <- NA_real_
  }
  if (case == "nonfinite") {
    diff_df$CohortA_log2FoldChange[1:3] <- c(Inf, -Inf, NA_real_)
    diff_df$CohortB_log2FoldChange[4] <- Inf
  }
  if (case == "all_zero") {
    diff_df$CohortA_log2FoldChange <- 0
    diff_df$CohortB_log2FoldChange <- 0
  }
  source(args[2])
  expected <- diff_df
  source(args[3])
  check_csv(expected)
  stopifnot(identical(diff_df, expected), is.finite(lim), lim >= max(fc_cut, 1))
  finite <- is.finite(expected$CohortA_log2FoldChange) & is.finite(expected$CohortB_log2FoldChange)
  stopifnot(identical(plot_df$id, expected$id[finite]))
  stopifnot(all(is.finite(plot_df$CohortA_log2FoldChange)), all(is.finite(plot_df$CohortB_log2FoldChange)))
  stopifnot(identical(as.character(p$scales$get_scales("colour")$get_breaks()), as.character(unique(plot_df$status))))
  built <- ggplot2::ggplot_build(p)
  point_layers <- vapply(p$layers, function(layer) inherits(layer$geom, "GeomPoint"), logical(1))
  label_layers <- which(vapply(p$layers, function(layer) inherits(layer$geom, "GeomTextRepel"), logical(1)))
  stopifnot(any(point_layers), length(label_layers) == 1L)
  stopifnot(sum(vapply(built$data[point_layers], nrow, integer(1))) == sum(finite))
  stopifnot(identical(as.character(built$data[[label_layers]]$label), as.character(top_labels$id)))
  stopifnot(grepl("BH-adjusted p", p$labels$subtitle, fixed = TRUE))
  stopifnot(grepl("Threshold membership does not establish", p$labels$caption, fixed = TRUE))
  if (case == "all_missing") {
    stopifnot(nrow(plot_df) == 0L, grepl("No genes with finite effect estimates", p$labels$subtitle, fixed = TRUE))
  }
  if (case %in% c("no_hits", "all_missing", "all_zero")) stopifnot(nrow(top_labels) == 0L)
  stopifnot(file.exists("diagonal_volcano.png"))
  cat("Rendered and round-tripped:", case, "\n")
  setwd(root)
}
# Simulate both an unavailable plotting dependency and a graphics-device failure.
# Rerun in the same directory: new CSV evidence must not accompany an old PNG.
for (failure in c("dependency", "device")) {
  dir.create(file.path(root, failure))
  setwd(file.path(root, failure))
  scope <- new.env(parent = globalenv())
  scope$diff_df <- computed
  sys.source(args[2], envir = scope)
  sys.source(args[3], envir = scope)
  stopifnot(file.exists("diagonal_volcano.png"))
  scope$diff_df$CohortA_log2FoldChange[1] <- scope$diff_df$CohortA_log2FoldChange[1] + 2
  sys.source(args[2], envir = scope)
  if (failure == "dependency") scope$library <- function(...) stop("injected dependency failure")
  if (failure == "device") scope$ggsave <- function(...) stop("injected device failure")
  error <- tryCatch({sys.source(args[3], envir = scope); NA_character_}, error = conditionMessage)
  stopifnot(identical(error, paste("injected", failure, "failure")))
  check_csv(scope$diff_df)
  stopifnot(!file.exists("diagonal_volcano.png"))
  cat("Preserved CSV after:", failure, "failure\n")
  setwd(root)
}
cat("All Welch plot and export assertions passed\n")
