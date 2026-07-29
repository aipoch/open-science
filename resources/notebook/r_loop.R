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

capture_environment <- function() {
  loaded <- loadedNamespaces()
  attached <- sub("^package:", "", grep("^package:", search(), value = TRUE))
  libraries <- normalizePath(.libPaths(), winslash = "/", mustWork = FALSE)
  packages <- lapply(sort(unique(loaded)), function(package) {
    version <- suppressWarnings(try(as.character(utils::packageVersion(package)), silent = TRUE))
    if (inherits(version, "try-error")) version <- NULL
    package_path <- suppressWarnings(try(find.package(package, quiet = TRUE), silent = TRUE))
    library_rank <- NULL
    if (!inherits(package_path, "try-error") && nzchar(package_path)) {
      normalized <- normalizePath(package_path, winslash = "/", mustWork = FALSE)
      matches <- which(vapply(libraries, function(path) {
        identical(normalized, path) || startsWith(normalized, paste0(path, "/"))
      }, logical(1)))
      if (length(matches) > 0L) library_rank <- as.integer(matches[[1L]])
    }
    description <- suppressWarnings(try(utils::packageDescription(package), silent = TRUE))
    priority <- NULL
    built <- NULL
    if (!inherits(description, "try-error")) {
      if (!is.null(description$Priority)) {
        priority_value <- tolower(description$Priority)
        priority <- if (priority_value %in% c("base", "recommended")) priority_value else "other"
      }
      if (!is.null(description$Built)) built <- description$Built
    }
    list(
      name = package,
      version = version,
      version_status = if (is.null(version)) "unavailable" else "known",
      ecosystem = "r",
      evidence_sources = list("r-session-info"),
      loaded_state = if (package %in% attached) "attached" else "loaded",
      library_rank = library_rank,
      built_for_runtime = built,
      priority = priority
    )
  })
  list(
    runtime_version = paste(R.version$major, R.version$minor, sep = "."),
    packages = packages
  )
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

run <- base::local({
  kernel_figures_dir <- figures_dir
  capture_width <- 800L
  capture_height <- 600L
  capture_res <- 96L
  kernel_png <- grDevices::png
  kernel_dev_off <- grDevices::dev.off
  kernel_plot_new <- graphics::plot.new
  capture_state <- new.env(parent = emptyenv())

  reset_capture_state <- function(dev_id = NA_integer_, initial_usr = NULL) {
    capture_state$active <- !is.na(dev_id)
    capture_state$dev_id <- dev_id
    capture_state$initial_usr <- initial_usr
    capture_state$page_seen <- FALSE
    capture_state$recorded_plot_seen <- FALSE
    capture_state$graphics_state_seen <- FALSE
    capture_state$closed <- FALSE
  }

  reset_capture_state()

  # Content-addresses each non-empty PNG page produced on the device into figures_dir.
  harvest_figures <- function(pattern_dir, keep_blank_pages = TRUE, blank_hashes = character()) {
    raw_files <- list.files(pattern_dir, pattern = "^page-\\d+\\.png$", full.names = TRUE)
    files <- capture_page_files(raw_files)
    out <- list()
    for (f in files) {
      info <- file.info(f)
      if (!is.na(info$size) && info$size > 0 && is_png_file(f)) {
        digest <- content_hash(f)
        if (is.na(digest)) {
          next
        }
        if (!keep_blank_pages && digest %in% blank_hashes) {
          next
        }
        dest <- file.path(kernel_figures_dir, paste0(digest, ".png"))
        copied <- suppressWarnings(file.copy(f, dest, overwrite = TRUE))
        if (isTRUE(copied)) {
          out[[length(out) + 1L]] <- list(mime = "image/png", path = dest)
        }
      }
    }
    # Remove raw page-NNN.png intermediates so the figures dir keeps only content-addressed outputs
    # instead of accumulating stray un-hashed page files.
    unlink(raw_files)
    out
  }

  # Content hash of a file for figure dedup, using base R's tools::md5sum (no new dependency). The
  # driver treats this value as an opaque content key.
  content_hash <- function(path) {
    digest <- suppressWarnings(try(tools::md5sum(path), silent = TRUE))
    if (inherits(digest, "try-error") || length(digest) == 0L || is.na(digest[[1L]])) {
      return(NA_character_)
    }
    unname(digest[[1L]])
  }

  blank_capture_hashes <- function() {
    blank_dir <- tempfile("open-science-blank-r-", tmpdir = kernel_figures_dir)
    created <- suppressWarnings(dir.create(blank_dir, recursive = TRUE, showWarnings = FALSE))
    if (!isTRUE(created) && !dir.exists(blank_dir)) {
      return(character())
    }
    on.exit(unlink(blank_dir, recursive = TRUE, force = TRUE), add = TRUE)

    create_blank_pages <- function(name, open_page) {
      current_dev <- grDevices::dev.cur()
      opened_dev <- NA_integer_
      device_open <- FALSE
      pages_dir <- file.path(blank_dir, name)
      created <- suppressWarnings(dir.create(pages_dir, recursive = TRUE, showWarnings = FALSE))
      if (!isTRUE(created) && !dir.exists(pages_dir)) {
        return(character())
      }
      pattern <- file.path(pages_dir, "page-%03d.png")
      tryCatch(
        {
          kernel_png(filename = pattern, width = capture_width, height = capture_height, res = capture_res)
          opened_dev <- grDevices::dev.cur()
          device_open <- TRUE
          if (isTRUE(open_page)) {
            suppressWarnings(try(kernel_plot_new(), silent = TRUE))
          }
          suppressWarnings(try(kernel_dev_off(opened_dev), silent = TRUE))
          device_open <- FALSE
        },
        error = function(cnd) NULL,
        finally = {
          open_devices <- grDevices::dev.list()
          if (isTRUE(device_open) && !is.null(open_devices) && opened_dev %in% open_devices) {
            suppressWarnings(try(kernel_dev_off(opened_dev), silent = TRUE))
            open_devices <- grDevices::dev.list()
          }
          if (!is.null(open_devices) && current_dev %in% open_devices) {
            suppressWarnings(try(grDevices::dev.set(current_dev), silent = TRUE))
          }
        }
      )
      capture_page_files(list.files(pages_dir, pattern = "^page-\\d+\\.png$", full.names = TRUE))
    }

    files <- c(
      create_blank_pages("empty-device", FALSE),
      create_blank_pages("opened-page", TRUE)
    )
    hashes <- vapply(files, content_hash, character(1))
    unique(hashes[!is.na(hashes)])
  }

  is_png_file <- function(path) {
    con <- suppressWarnings(try(file(path, "rb"), silent = TRUE))
    if (inherits(con, "try-error")) return(FALSE)
    on.exit(close(con), add = TRUE)
    signature <- suppressWarnings(try(readBin(con, what = "raw", n = 8L), silent = TRUE))
    !inherits(signature, "try-error") &&
      identical(signature, as.raw(c(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
  }

  capture_page_files <- function(files) {
    if (length(files) == 0L) return(character())
    page_numbers <- as.integer(sub("^page-(\\d+)\\.png$", "\\1", basename(files)))
    valid <- !is.na(page_numbers) & page_numbers >= 1L
    files <- files[valid]
    page_numbers <- page_numbers[valid]
    if (length(files) == 0L) return(character())
    ord <- order(page_numbers)
    files[ord]
  }

  create_capture_page_dir <- function() {
    for (parent_dir in c(kernel_figures_dir, tempdir())) {
      page_dir <- tempfile("open-science-r-pages-", tmpdir = parent_dir)
      created <- suppressWarnings(dir.create(page_dir, recursive = TRUE, showWarnings = FALSE))
      if (isTRUE(created) || dir.exists(page_dir)) {
        return(page_dir)
      }
    }
    kernel_figures_dir
  }

  capture_device_is_open <- function(dev_id) {
    open_devices <- grDevices::dev.list()
    !is.na(dev_id) && !is.null(open_devices) && unname(dev_id) %in% unname(open_devices)
  }

  capture_device_has_plot <- function(dev_id) {
    if (!capture_device_is_open(dev_id)) {
      return(FALSE)
    }
    current_dev <- grDevices::dev.cur()
    if (!identical(current_dev, dev_id)) {
      suppressWarnings(try(grDevices::dev.set(dev_id), silent = TRUE))
    }
    recorded <- try(grDevices::recordPlot(), silent = TRUE)
    if (!identical(current_dev, dev_id)) {
      open_devices <- grDevices::dev.list()
      if (!is.null(open_devices) && current_dev %in% open_devices) {
        suppressWarnings(try(grDevices::dev.set(current_dev), silent = TRUE))
      }
    }
    !inherits(recorded, "try-error") && length(recorded) >= 1L && !is.null(recorded[[1L]])
  }

  capture_device_usr <- function(dev_id) {
    if (!capture_device_is_open(dev_id)) {
      return(NULL)
    }
    current_dev <- grDevices::dev.cur()
    if (!identical(current_dev, dev_id)) {
      suppressWarnings(try(grDevices::dev.set(dev_id), silent = TRUE))
    }
    usr <- try(graphics::par("usr"), silent = TRUE)
    if (!identical(current_dev, dev_id)) {
      open_devices <- grDevices::dev.list()
      if (!is.null(open_devices) && current_dev %in% open_devices) {
        suppressWarnings(try(grDevices::dev.set(current_dev), silent = TRUE))
      }
    }
    if (inherits(usr, "try-error")) {
      return(NULL)
    }
    as.numeric(usr)
  }

  capture_device_graphics_state_changed <- function(dev_id, initial_usr = NULL) {
    if (is.null(initial_usr)) {
      return(FALSE)
    }
    usr <- capture_device_usr(dev_id)
    !is.null(usr) && !isTRUE(all.equal(usr, initial_usr))
  }

  capture_state_device_matches <- function(which) {
    # Device ids are reusable; callers only accept this match while capture_state still says the
    # request-owned device is open, and the stable dev.off wrapper flips that state on close.
    isTRUE(capture_state$active) &&
      length(which) == 1L &&
      !is.na(which) &&
      !is.na(capture_state$dev_id) &&
      identical(as.integer(unname(which)), as.integer(unname(capture_state$dev_id)))
  }

  mark_capture_page <- function() {
    if (isTRUE(capture_state$active) &&
        !isTRUE(capture_state$closed) &&
        capture_device_is_open(capture_state$dev_id) &&
        identical(grDevices::dev.cur(), capture_state$dev_id)) {
      capture_state$page_seen <- TRUE
    }
  }

  mark_capture_before_dev_off <- function(which) {
    if (capture_state_device_matches(which) &&
        !isTRUE(capture_state$closed) &&
        capture_device_is_open(capture_state$dev_id) &&
        !isTRUE(capture_state$graphics_state_seen) &&
        capture_device_graphics_state_changed(
          capture_state$dev_id,
          capture_state$initial_usr
        )) {
      capture_state$graphics_state_seen <- TRUE
    }
  }

  mark_capture_after_dev_off <- function(which) {
    if (capture_state_device_matches(which) &&
        !capture_device_is_open(capture_state$dev_id)) {
      capture_state$closed <- TRUE
    }
  }

  install_capture_binding_wrapper <- function(package, name, make_wrapper) {
    envs <- list(asNamespace(package))
    package_env <- suppressWarnings(try(as.environment(paste0("package:", package)), silent = TRUE))
    if (!inherits(package_env, "try-error") && !identical(package_env, envs[[1L]])) {
      envs[[length(envs) + 1L]] <- package_env
    }

    for (env in envs) {
      if (!exists(name, envir = env, inherits = FALSE)) {
        next
      }
      original <- get(name, envir = env)
      if (isTRUE(attr(original, "open_science_capture_wrapper", exact = TRUE))) {
        next
      }
      wrapper <- make_wrapper(original)
      attr(wrapper, "open_science_capture_wrapper") <- TRUE
      was_locked <- bindingIsLocked(name, env)
      if (was_locked) unlockBinding(name, env)
      assign(name, wrapper, envir = env)
      if (was_locked) lockBinding(name, env)
    }
  }

  install_capture_wrappers <- function() {
    make_page_wrapper <- function(original) {
      wrapper_env <- base::list2env(
        base::list(mark_page = mark_capture_page, original = original),
        parent = globalenv()
      )
      lockEnvironment(wrapper_env, bindings = TRUE)
      eval(
        quote(function(...) {
          result <- base::withVisible(original(...))
          mark_page()
          if (result$visible) result$value else base::invisible(result$value)
        }),
        envir = wrapper_env
      )
    }

    make_dev_off_wrapper <- function(original) {
      wrapper_env <- base::list2env(
        base::list(
          after_close = mark_capture_after_dev_off,
          before_close = mark_capture_before_dev_off,
          original = original
        ),
        parent = globalenv()
      )
      lockEnvironment(wrapper_env, bindings = TRUE)
      eval(
        quote(function(which = grDevices::dev.cur()) {
          before_close(which)
          result <- base::withVisible(original(which))
          after_close(which)
          if (result$visible) result$value else base::invisible(result$value)
        }),
        envir = wrapper_env
      )
    }

    install_capture_binding_wrapper("graphics", "plot.new", make_page_wrapper)
    if (requireNamespace("grid", quietly = TRUE)) {
      install_capture_binding_wrapper("grid", "grid.newpage", make_page_wrapper)
    }
    install_capture_binding_wrapper("grDevices", "dev.off", make_dev_off_wrapper)
  }

  install_capture_wrappers()

  function(req) {
    reset_capture_state()
    page_dir <- if (nzchar(kernel_figures_dir)) create_capture_page_dir() else tempdir()
    pattern <- file.path(page_dir, "page-%03d.png")
    dev_id <- NA_integer_
    capture_initial_usr <- NULL
    cleanup_page_dir <- nzchar(kernel_figures_dir) && !identical(page_dir, kernel_figures_dir)
    if (cleanup_page_dir) {
      on.exit(unlink(page_dir, recursive = TRUE, force = TRUE), add = TRUE)
    }
    if (nzchar(kernel_figures_dir)) {
      blank_hashes <- blank_capture_hashes()
      kernel_png(filename = pattern, width = capture_width, height = capture_height, res = capture_res)
      dev_id <- grDevices::dev.cur()
      grDevices::dev.control(displaylist = "enable")
      capture_initial_usr <- capture_device_usr(dev_id)
      reset_capture_state(dev_id, capture_initial_usr)
      on.exit(reset_capture_state(), add = TRUE)
    }
    mark_recorded_plot <- function() {
      if (!isTRUE(capture_state$active)) {
        return(NULL)
      }
      if (!isTRUE(capture_state$closed) &&
          !capture_device_is_open(capture_state$dev_id)) {
        capture_state$closed <- TRUE
      }
      if (!isTRUE(capture_state$closed) &&
          !isTRUE(capture_state$graphics_state_seen) &&
          capture_device_graphics_state_changed(
            capture_state$dev_id,
            capture_state$initial_usr
          )) {
        capture_state$graphics_state_seen <- TRUE
      }
      if (!isTRUE(capture_state$closed) &&
          !isTRUE(capture_state$recorded_plot_seen) &&
          capture_device_has_plot(capture_state$dev_id)) {
        capture_state$recorded_plot_seen <- TRUE
      }
    }
    error <- NULL
    error_line <- NA_integer_
    stdout_text <- ""
    stdout_text <- paste(utils::capture.output({
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
            mark_recorded_plot()
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
    capture_device_open <- isTRUE(capture_state$active) &&
      !isTRUE(capture_state$closed) &&
      capture_device_is_open(capture_state$dev_id)
    # If user code closed the capture device, recordPlot() can no longer inspect it. Preserve pages
    # only when this request actually opened a graphics page on the capture device.
    capture_has_plot <- isTRUE(capture_state$page_seen) ||
      isTRUE(capture_state$recorded_plot_seen) ||
      isTRUE(capture_state$graphics_state_seen) ||
      (capture_device_open && capture_device_has_plot(capture_state$dev_id))
    if (nzchar(kernel_figures_dir)) {
      if (capture_device_open) {
        suppressWarnings(try(kernel_dev_off(dev_id), silent = TRUE))
      }
    }
    figures <- if (nzchar(kernel_figures_dir)) {
      harvest_figures(page_dir, capture_has_plot, blank_hashes)
    } else {
      list()
    }
    list(stdout = stdout_text, stderr = "", error = if (is.null(error)) NA else error,
         error_line = if (is.na(error_line)) NULL else error_line,
         result = NA, cwd = getwd(), figures = figures,
         environment = capture_environment())
  }
}, envir = base::list2env(
  base::list(figures_dir = figures_dir, capture_environment = capture_environment),
  parent = base::baseenv()
))
lockEnvironment(environment(run), bindings = TRUE)

repeat {
  req <- read_request()
  if (is.null(req)) break
  resp <- run(req)
  resp$req_id <- req$req_id
  emit(resp)
}
