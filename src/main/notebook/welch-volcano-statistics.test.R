# Synthetic log2 expression only. No contributed R packages are needed.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L)
df_unique <- rbind(
  Strong = c(1, 1.1, 0.9, 4, 4.1, 3.9, 1, 1.1, 0.9, 4, 4.1, 3.9),
  Null = rep(c(1, 2, 3), 4),
  Constant = rep(2, 12),
  UntestableB = c(1, 1.1, 0.9, 4, 4.1, 3.9, rep(2, 6)),
  UntestableA = c(rep(2, 6), 1, 1.1, 0.9, 4, 4.1, 3.9)
)
colnames(df_unique) <- c(
  "CohortActrl1", "CohortActrl2", "CohortActrl4",
  "CohortAsi1", "CohortAsi2", "CohortAsi5",
  "CohortBctrl1", "CohortBctrl2", "CohortBctrl4",
  "CohortBsi1", "CohortBsi2", "CohortBsi3"
)
source(args[1])
stopifnot(nrow(diff_df) == 5L)
row <- function(id) diff_df[diff_df$id == id, , drop = FALSE]
stopifnot(abs(row("Strong")$CohortA_log2FoldChange - 3) < 1e-12)
stopifnot(row("Null")$CohortA_pvalue == 1)
stopifnot(is.na(row("Constant")$CohortA_pvalue))
stopifnot(nzchar(row("Constant")$CohortA_test_error))
# The family includes all five planned tests, not just the three finite ones.
stopifnot(isTRUE(all.equal(row("Strong")$CohortA_padj,
                         row("Strong")$CohortA_pvalue * 5 / 2)))
source(args[2])
stopifnot(as.character(row("Constant")$status) == "Not testable in one or both")
stopifnot(as.character(row("UntestableB")$status) == "Not testable in one or both")
stopifnot(isTRUE(row("UntestableB")$CohortA_meets_threshold))
stopifnot(is.na(row("UntestableB")$CohortB_meets_threshold))
stopifnot(isTRUE(row("UntestableA")$CohortB_meets_threshold))
stopifnot(is.na(row("UntestableA")$CohortA_meets_threshold))
stopifnot(as.character(row("Null")$status) == "Neither meets thresholds")

# A one-gene matrix must retain its dimensions; data frames remain supported too.
local({
  single_gene <- df_unique["Strong", , drop = FALSE]
  expected_p <- stats::t.test(c(4, 4.1, 3.9), c(1, 1.1, 0.9), var.equal = FALSE)$p.value
  for (input in list(single_gene, as.data.frame(single_gene))) {
    result <- compute_diff(input, cohort_a_ctrl_samples, cohort_a_si_samples)
    stopifnot(nrow(result) == 1L, result$id == "Strong")
    stopifnot(abs(result$log2FoldChange - 3) < 1e-12)
    stopifnot(isTRUE(all.equal(result$pvalue, expected_p)))
    stopifnot(isTRUE(all.equal(result$padj, expected_p)), is.na(result$test_error))
  }
})

# Missing/nonfinite observations invalidate only their own comparison. Exercise
# control and treatment samples in both cohorts, with matrix and data-frame input.
local({
  for (bad_value in c(NA_real_, NaN, Inf, -Inf)) {
    for (sample_index in c(1L, 4L, 7L, 10L)) {
      input <- df_unique[rep(1L, 2L), , drop = FALSE]
      rownames(input) <- c("Complete", "Incomplete")
      input[2, sample_index] <- bad_value
      for (expression in list(input, as.data.frame(input))) {
        scope <- new.env(parent = globalenv())
        scope$df_unique <- expression
        invisible(capture.output(sys.source(args[1], envir = scope)))
        invisible(capture.output(sys.source(args[2], envir = scope)))
        result <- scope$diff_df
        invalid <- if (sample_index < 7L) "CohortA" else "CohortB"
        valid <- if (sample_index < 7L) "CohortB" else "CohortA"
        bad <- result[result$id == "Incomplete", , drop = FALSE]
        good <- result[result$id == "Complete", , drop = FALSE]
        for (field in c("log2FoldChange", "pvalue", "padj", "meets_threshold")) {
          stopifnot(is.na(bad[[paste0(invalid, "_", field)]]))
        }
        stopifnot(grepl("Missing or non-finite expression", bad[[paste0(invalid, "_test_error")]], fixed = TRUE))
        stopifnot(isTRUE(bad[[paste0(valid, "_meets_threshold")]]))
        stopifnot(is.na(bad[[paste0(valid, "_test_error")]]))
        stopifnot(as.character(bad$status) == "Not testable in one or both")
        stopifnot(!"Incomplete" %in% scope$top_labels$id)
        # The excluded gene still counts toward the planned two-gene BH family.
        stopifnot(isTRUE(all.equal(good[[paste0(invalid, "_padj")]], 2 * good[[paste0(invalid, "_pvalue")]])))
        stopifnot(abs(bad[[paste0(valid, "_log2FoldChange")]] - 3) < 1e-12)
      }
    }
  }
})

# Exercise the actual adjustment inside compute_diff with known p-values.
# Temporary deterministic t.test responses isolate BH from the preceding model;
# the real Welch test was exercised above. Expected BH values are hand-calculated.
local({
  known <- c(0.001, 0.02, 0.04, 0.2, NA_real_)
  cursor <- 0L
  fake_test <- function(...) {
    cursor <<- cursor + 1L
    if (is.na(known[cursor])) stop("synthetic untestable gene")
    list(p.value = known[cursor])
  }
  checked_compute <- compute_diff
  environment(checked_compute) <- list2env(list(t.test = fake_test), parent = environment(compute_diff))
  result <- checked_compute(df_unique, cohort_a_ctrl_samples, cohort_a_si_samples)
  stopifnot(isTRUE(all.equal(result$padj, c(0.005, 0.05, 1 / 15, 0.25, NA_real_))))
  stopifnot(result$test_error[5] == "synthetic untestable gene")
})

# Raw p-values deliberately conflict with adjusted decisions. No FDR recomputation
# after effect-size selection, and no conversion of untestable to A/B-only.
diff_df <- data.frame(
  id = c("nominal_only", "A_only", "B_only", "same", "opposite", "missing_B", "p_boundary", "fc_boundary", "missing_effect"),
  CohortA_pvalue = rep(0.001, 9), CohortB_pvalue = rep(0.001, 9),
  CohortA_padj = c(0.2, 0.01, 0.2, 0.01, 0.01, 0.01, 0.05, 0.01, 0.01),
  CohortB_padj = c(0.2, 0.2, 0.01, 0.01, 0.01, NA, 0.2, 0.2, 0.01),
  CohortA_log2FoldChange = c(1, 1, 1, 1, 1, 1, 1, log2(1.5), NA),
  CohortB_log2FoldChange = c(1, 1, 1, 1, -1, 1, 1, 1, 1)
)
source(args[2])
stopifnot(identical(as.character(diff_df$status), c(
  "Neither meets thresholds", "Meets thresholds in A only", "Meets thresholds in B only",
  "Both (same direction)", "Both (opposite direction)", "Not testable in one or both",
  "Neither meets thresholds", "Neither meets thresholds", "Not testable in one or both"
)))
stopifnot(!any(top_labels$id %in% c("nominal_only", "missing_B", "missing_effect")))
# No discoveries and no testable genes are legitimate outcomes, not top-N hits.
diff_df$CohortA_padj <- 0.9
diff_df$CohortB_padj <- 0.9
source(args[2])
stopifnot(nrow(top_labels) == 0L)
diff_df$CohortA_padj <- NA_real_
diff_df$CohortB_padj <- NA_real_
source(args[2])
stopifnot(nrow(top_labels) == 0L)
stopifnot(all(as.character(diff_df$status) == "Not testable in one or both"))
cat("All Welch scientific assertions passed\n")
