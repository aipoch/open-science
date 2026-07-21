# Persistent R exec-loop kernel: one process per environment. Reads a length-prefixed request
# (header line "<req_id> <codeByteLength>", then exactly that many bytes of code), evaluates it in
# .GlobalEnv with REPL visibility semantics, captures stdout + inline PNG figures, and writes one
# jsonlite line per response. Not IRkernel / Jupyter.
suppressWarnings(suppressMessages(library(jsonlite)))

# A non-interactive R session has no default CRAN mirror, so a bare install.packages() in a cell
# fails with "trying to use CRAN without setting a mirror". Set the app's configured mirror (or the
# public default) so inline installs work; manage_packages remains the sanctioned install path.
options(repos = c(CRAN = Sys.getenv("OPEN_SCIENCE_CRAN_MIRROR", "https://cloud.r-project.org")))

figures_dir <- Sys.getenv("OPEN_SCIENCE_KERNEL_FIGURES_DIR", "")
con <- file("stdin", "rb")

emit <- function(obj) {
  cat(jsonlite::toJSON(obj, auto_unbox = TRUE, null = "null"), "\n", sep = "")
  flush(stdout())
}

# Reads one request off the length-prefixed protocol; returns list(req_id, code) or NULL at EOF.
read_request <- function() {
  header <- readLines(con, n = 1L, warn = FALSE)
  if (length(header) == 0L) return(NULL)
  parts <- strsplit(header, " ", fixed = TRUE)[[1]]
  req_id <- parts[1]
  n <- as.integer(parts[2])
  code <- if (n > 0L) readChar(con, n, useBytes = TRUE) else ""
  list(req_id = req_id, code = code)
}

# Content-addresses each non-empty PNG page produced on the device into figures_dir.
harvest_figures <- function(pattern_dir) {
  files <- list.files(pattern_dir, pattern = "^page-\\d+\\.png$", full.names = TRUE)
  out <- list()
  for (f in files) {
    info <- file.info(f)
    if (!is.na(info$size) && info$size > 0) {
      digest <- content_hash(f)
      dest <- file.path(figures_dir, paste0(digest, ".png"))
      file.copy(f, dest, overwrite = TRUE)
      out[[length(out) + 1L]] <- list(mime = "image/png", path = dest)
    }
    # Remove the raw page-NNN.png intermediate (copied or empty) so the figures dir keeps only
    # content-addressed outputs instead of accumulating stray un-hashed page files.
    unlink(f)
  }
  out
}

# Content hash of a file for figure dedup, using base R's tools::md5sum (no new dependency). The
# driver treats this value as an opaque content key.
content_hash <- function(path) {
  unname(tools::md5sum(path))
}

run <- function(req) {
  page_dir <- if (nzchar(figures_dir)) figures_dir else tempdir()
  pattern <- file.path(page_dir, "page-%03d.png")
  grDevices::png(filename = pattern, width = 800, height = 600, res = 96)
  dev_id <- grDevices::dev.cur()
  error <- NULL
  error_line <- NA_integer_
  stdout_text <- ""
  stdout_text <- paste(capture.output({
    # keep.source retains per-expression srcrefs so a runtime error can report the 1-based line of the
    # top-level statement that failed (the R equivalent of a Python traceback's last user frame).
    exprs <- tryCatch(parse(text = req$code, keep.source = TRUE), error = function(cnd) cnd)
    if (inherits(exprs, "condition")) {
      error <<- conditionMessage(exprs)
    } else {
      refs <- attr(exprs, "srcref")
      idx <- 0L
      tryCatch({
        for (idx in seq_along(exprs)) {
          res <- withVisible(eval(exprs[[idx]], envir = globalenv()))
          if (isTRUE(res$visible)) print(res$value)
        }
      },
      error = function(cnd) {
        error <<- conditionMessage(cnd)
        if (!is.null(refs) && idx >= 1L && idx <= length(refs)) {
          error_line <<- as.integer(refs[[idx]][1])
        }
      },
      interrupt = function(cnd) error <<- "interrupted")
    }
  }), collapse = "\n")
  suppressWarnings(try(grDevices::dev.off(dev_id), silent = TRUE))
  figures <- if (nzchar(figures_dir)) harvest_figures(page_dir) else list()
  list(stdout = stdout_text, stderr = "", error = if (is.null(error)) NA else error,
       error_line = if (is.na(error_line)) NULL else error_line,
       result = NA, cwd = getwd(), figures = figures)
}

repeat {
  req <- read_request()
  if (is.null(req)) break
  resp <- run(req)
  resp$req_id <- req$req_id
  emit(resp)
}
