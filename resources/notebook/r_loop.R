# Persistent R exec-loop kernel: one process per environment. Reads a length-prefixed request
# (header line "<req_id> <codeByteLength>", then exactly that many bytes of code), evaluates it in
# .GlobalEnv with REPL visibility semantics, captures stdout + inline PNG figures, and writes one
# jsonlite line per response. Not IRkernel / Jupyter.
suppressWarnings(suppressMessages(library(jsonlite)))

# Package/environment changes are owned by manage_packages in the trusted main process. The main
# process rejects the common forms before they reach this loop; this syntax-tree check is a second
# layer so namespace-qualified and indirect calls cannot install from inside the persistent kernel.
package_mutation_call_name <- function(expr) {
  if (!is.call(expr) || length(expr) == 0L) return(NULL)
  head <- expr[[1L]]
  if (is.symbol(head) && as.character(head) %in% c("::", ":::") && length(expr) >= 3L) {
    return(paste(as.character(expr[[2L]]), as.character(expr[[3L]]), sep = "::"))
  }
  if (is.symbol(head)) return(as.character(head))
  if (is.call(head) && length(head) >= 3L && is.symbol(head[[1L]]) &&
      as.character(head[[1L]]) %in% c("::", ":::")) {
    return(paste(as.character(head[[2L]]), as.character(head[[3L]]), sep = "::"))
  }
  NULL
}

is_package_mutation_name <- function(name) {
  if (is.null(name)) return(FALSE)
  name %in% c("install.packages", "remove.packages", "update.packages") ||
    grepl(
      paste0(
        "^(utils::(install|remove|update)\\.packages|",
        "BiocManager::install|",
        "renv::(install|restore|update|hydrate)|",
        "pak::(pkg_install|pkg_remove|lockfile_install)|",
        "(remotes|devtools)::install_[A-Za-z0-9_.]+)$"
      ),
      name
    )
}

assert_no_package_mutation <- function(expr) {
  if (is.symbol(expr) && is_package_mutation_name(as.character(expr))) {
    stop(
      "Package/environment mutation is not allowed in an R cell; use manage_packages.",
      call. = FALSE
    )
  }
  call_name <- package_mutation_call_name(expr)
  if (identical(call_name, ".Internal") && length(expr) >= 2L &&
      identical(package_mutation_call_name(expr[[2L]]), "system")) {
    stop(
      "Package/environment mutation is not allowed in an R cell; use manage_packages.",
      call. = FALSE
    )
  }
  if (is_package_mutation_name(call_name)) {
    stop(
      "Package/environment mutation is not allowed in an R cell; use manage_packages.",
      call. = FALSE
    )
  }
  if (is.call(expr) && isTRUE(call_name %in% c("get", "match.fun", "do.call"))) {
    strings <- unlist(lapply(as.list(expr)[-1L], function(value) {
      if (is.character(value)) value else character()
    }), use.names = FALSE)
    if (any(vapply(strings, is_package_mutation_name, logical(1)))) {
      stop(
        "Package/environment mutation is not allowed in an R cell; use manage_packages.",
        call. = FALSE
      )
    }
  }
  if (is.call(expr) || is.expression(expr) || is.pairlist(expr)) {
    lapply(as.list(expr), assert_no_package_mutation)
  }
  invisible(NULL)
}

blocked_package_mutation <- function(...) {
  stop(
    "Package/environment mutation is not allowed in an R cell; use manage_packages.",
    call. = FALSE
  )
}

# Keep the policy closure and all of its dependencies outside .GlobalEnv. User cells may assign names
# such as package_mutation_call_name, but the locked evaluator continues resolving the original helpers.
package_mutation_policy_env <- new.env(parent = baseenv())
environment(package_mutation_call_name) <- package_mutation_policy_env
environment(is_package_mutation_name) <- package_mutation_policy_env
environment(assert_no_package_mutation) <- package_mutation_policy_env
environment(blocked_package_mutation) <- package_mutation_policy_env
assign("package_mutation_call_name", package_mutation_call_name, package_mutation_policy_env)
assign("is_package_mutation_name", is_package_mutation_name, package_mutation_policy_env)
assign("assert_no_package_mutation", assert_no_package_mutation, package_mutation_policy_env)
assign("blocked_package_mutation", blocked_package_mutation, package_mutation_policy_env)
lockEnvironment(package_mutation_policy_env, bindings = TRUE)

# Replace the canonical utils entry points before any user request runs. This is the runtime backstop for
# dynamically assembled lookups that cannot be identified from syntax alone, e.g.
# get(paste0("install", ".packages"), asNamespace("utils")). The trusted manage_packages fallback runs
# in a separate Rscript process, so it does not inherit these kernel-only bindings.
for (binding_name in c("install.packages", "remove.packages", "update.packages")) {
  for (binding_env in list(asNamespace("utils"), as.environment("package:utils"))) {
    if (!exists(binding_name, envir = binding_env, inherits = FALSE)) next
    if (bindingIsLocked(binding_name, binding_env)) unlockBinding(binding_name, binding_env)
    assign(binding_name, package_mutation_policy_env$blocked_package_mutation, envir = binding_env)
    lockBinding(binding_name, binding_env)
  }
}

# Enforce the managed-runtime read-only boundary inside the persistent R process. The main-process
# syntax check provides an early error, while these guarded base bindings catch paths assembled in
# local variables on platforms without a native filesystem sandbox.
runtime_write_policy_env <- new.env(parent = baseenv())
runtime_write_policy_env$managed_runtime_dir <- NULL
runtime_write_policy_env$managed_runtime_source <- NULL

canonical_runtime_path <- function(value) {
  if (inherits(value, "connection")) {
    value <- try(summary(value)$description, silent = TRUE)
    if (inherits(value, "try-error")) return(NULL)
  }
  if (!is.character(value) || length(value) != 1L || !nzchar(value)) return(NULL)
  cursor <- path.expand(value)
  suffix <- character()
  while (!file.exists(cursor)) {
    parent <- dirname(cursor)
    if (identical(parent, cursor)) break
    suffix <- c(basename(cursor), suffix)
    cursor <- parent
  }
  resolved <- normalizePath(cursor, winslash = "/", mustWork = FALSE)
  if (length(suffix) > 0L) resolved <- do.call(file.path, as.list(c(resolved, suffix)))
  if (.Platform$OS.type == "windows") resolved <- tolower(resolved)
  resolved
}

assert_runtime_write_allowed <- function(targets) {
  root <- managed_runtime_dir
  if (is.null(root)) return(invisible(NULL))
  for (target in targets) {
    resolved <- canonical_runtime_path(target)
    if (is.null(resolved)) next
    if (identical(resolved, root) || startsWith(resolved, paste0(root, "/"))) {
      stop(
        "Managed runtime files are read-only in an R cell; use manage_packages for changes.",
        call. = FALSE
      )
    }
  }
  invisible(NULL)
}

runtime_command_name <- function(value) {
  name <- basename(gsub("^[\"']|[\"']$", "", as.character(value)[[1L]]))
  tolower(sub("\\.exe$", "", name, ignore.case = TRUE))
}

runtime_text_references_managed <- function(text) {
  comparable <- if (.Platform$OS.type == "windows") tolower(text) else text
  comparable <- chartr("\\", "/", comparable)
  roots <- c(managed_runtime_dir, managed_runtime_source)
  grepl("OPEN_SCIENCE_RUNTIME_DIR", text, fixed = TRUE) ||
    any(vapply(roots, function(candidate) {
      !is.null(candidate) && nzchar(candidate) && grepl(candidate, comparable, fixed = TRUE)
    }, logical(1)))
}

runtime_target_is_managed <- function(value) {
  if (!is.character(value) || length(value) != 1L || !nzchar(value)) return(FALSE)
  text <- gsub("^[\"']|[\"']$", "", trimws(value))
  if (runtime_text_references_managed(text)) return(TRUE)
  resolved <- canonical_runtime_path(text)
  root <- managed_runtime_dir
  !is.null(root) && !is.null(resolved) &&
    (identical(resolved, root) || startsWith(resolved, paste0(root, "/")))
}

runtime_write_targets <- function(words, redirections = character()) {
  if (length(words) == 0L) return(NULL)
  executable <- runtime_command_name(words[[1L]])
  supported <- c(
    "rm", "mv", "cp", "install", "mkdir", "touch", "truncate", "chmod", "chown",
    "ln", "tee", "sed", "perl", "dd"
  )
  if (!executable %in% supported) return(NULL)
  args <- as.character(words[-1L])
  target_directory <- grep("^--target-directory=", args, value = TRUE)
  if (length(target_directory) > 0L) {
    return(c(redirections, sub("^[^=]*=", "", target_directory[[1L]])))
  }
  short_target <- match("-t", args)
  if (!is.na(short_target) && short_target < length(args)) {
    return(c(redirections, args[[short_target + 1L]]))
  }
  if (identical(executable, "dd")) {
    return(c(redirections, sub("^of=", "", grep("^of=", args, value = TRUE))))
  }
  positional <- args[!startsWith(args, "-")]
  if (identical(executable, "ln")) return(c(redirections, positional))
  if (executable %in% c("cp", "install")) {
    destination <- if (length(positional) > 0L) positional[[length(positional)]] else character()
    return(c(redirections, destination))
  }
  if (identical(executable, "mv")) return(c(redirections, positional))
  if (executable %in% c("chmod", "chown")) {
    return(c(redirections, if (length(positional) > 1L) positional[-1L] else character()))
  }
  if (executable %in% c("sed", "perl")) {
    inplace <- any(grepl("^-.*i", args))
    target <- if (length(positional) > 0L) positional[[length(positional)]] else character()
    return(if (inplace) c(redirections, target) else redirections)
  }
  c(redirections, positional)
}

runtime_text_has_write_primitive <- function(text) {
  grepl(
    paste0(
      "\\b(rm|mv|cp|install|mkdir|touch|truncate|chmod|chown|ln|tee|sed|perl|dd)\\b|",
      "\\b(open|write_text|write_bytes|writeFile|writeFileSync|mkdtemp|mkdtempSync)\\s*\\(|",
      "\\b(os|shutil)\\.(remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|",
      "chmod|chown|copy|copy2|copytree|move|rmtree)\\s*\\(|",
      "\\b(unlink|file\\.(append|copy|remove|rename|link|symlink|create)|",
      "dir\\.create|download\\.file|fifo|pipe|writeLines|writeBin|save|saveRDS)\\s*\\(|",
      "\\b(New-Item|Remove-Item|Set-Content|Add-Content|Clear-Content|Out-File)\\b"
    ),
    text,
    ignore.case = TRUE,
    perl = TRUE
  )
}

runtime_shell_words <- function(command) {
  pattern <- "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^[:space:]]+"
  matches <- gregexpr(pattern, command, perl = TRUE)[[1L]]
  if (identical(matches[[1L]], -1L)) return(character())
  words <- regmatches(command, list(matches))[[1L]]
  gsub("^([\"'])(.*)\\1$", "\\2", words, perl = TRUE)
}

runtime_shell_redirections <- function(command) {
  pattern <- ">{1,2}[[:space:]]*(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^[:space:];&|]+)"
  matches <- gregexpr(pattern, command, perl = TRUE)[[1L]]
  if (identical(matches[[1L]], -1L)) return(character())
  values <- regmatches(command, list(matches))[[1L]]
  values <- sub("^>{1,2}[[:space:]]*", "", values)
  gsub("^([\"'])(.*)\\1$", "\\2", values, perl = TRUE)
}

runtime_shell_writes_managed <- function(source) {
  segments <- strsplit(source, "(?:&&|\\|\\||[;\\r\\n])", perl = TRUE)[[1L]]
  for (segment in segments) {
    words <- runtime_shell_words(segment)
    targets <- runtime_write_targets(words, runtime_shell_redirections(segment))
    if (!is.null(targets)) {
      if (any(vapply(targets, runtime_target_is_managed, logical(1)))) return(TRUE)
      next
    }
    if (runtime_text_references_managed(segment) && runtime_text_has_write_primitive(segment)) {
      return(TRUE)
    }
  }
  FALSE
}

runtime_process_writes_managed <- function(command, args = character()) {
  if (length(args) == 0L) return(runtime_shell_writes_managed(as.character(command)[[1L]]))
  words <- c(as.character(command)[[1L]], as.character(args))
  executable <- runtime_command_name(words[[1L]])
  shell_flag <- match("-c", words)
  if (executable %in% c("sh", "bash", "zsh") && !is.na(shell_flag)) {
    payload <- if (shell_flag < length(words)) words[[shell_flag + 1L]] else ""
    payload <- gsub("^([\"'])(.*)\\1$", "\\2", payload, perl = TRUE)
    return(runtime_shell_writes_managed(payload))
  }
  targets <- runtime_write_targets(words)
  if (!is.null(targets)) return(any(vapply(targets, runtime_target_is_managed, logical(1))))
  text <- paste(words, collapse = " ")
  runtime_text_references_managed(text) && runtime_text_has_write_primitive(text)
}

runtime_text_has_package_mutation <- function(text) {
  grepl(
    paste0(
      "\\b(micromamba|mamba|conda|pip|pip3|pipx|uv|poetry)(\\.exe)?\\b.{0,160}",
      "\\b(install|uninstall|update|upgrade|remove|create|sync|add|venv)\\b|",
      "\\b(python|python3|py)(\\.[0-9]+)?(\\.exe)?\\b.{0,80}\\s-m\\s+",
      "((venv|virtualenv|ensurepip)\\b|pip\\b.{0,100}\\b(install|uninstall|wheel)\\b)|",
      "\\bR(script)?(\\.exe)?\\b.{0,120}(\\bCMD\\s+INSTALL\\b|",
      "(install|remove|update)\\.packages\\b)"
    ),
    text,
    ignore.case = TRUE,
    perl = TRUE
  )
}

runtime_package_words_mutate <- function(words) {
  if (length(words) == 0L) return(FALSE)
  words <- as.character(words)
  command_index <- 1L
  while (command_index <= length(words)) {
    name <- runtime_command_name(words[[command_index]])
    if (!name %in% c("sudo", "env", "command", "exec")) break
    command_index <- command_index + 1L
    while (
      command_index <= length(words) &&
        (startsWith(words[[command_index]], "-") || grepl("^[A-Za-z_][A-Za-z0-9_]*=", words[[command_index]]))
    ) {
      command_index <- command_index + 1L
    }
  }
  if (command_index > length(words)) return(FALSE)
  executable <- runtime_command_name(words[[command_index]])
  argv <- words[command_index:length(words)]
  shell_flag <- match("-c", argv)
  if (executable %in% c("sh", "bash", "zsh") && !is.na(shell_flag)) {
    payload <- if (shell_flag < length(argv)) argv[[shell_flag + 1L]] else ""
    return(runtime_command_mutates_packages(payload))
  }
  powershell_flag <- match(TRUE, tolower(argv) %in% c("-command", "-c"))
  if (executable %in% c("powershell", "pwsh") && !is.na(powershell_flag)) {
    payload <- if (powershell_flag < length(argv)) {
      paste(argv[(powershell_flag + 1L):length(argv)], collapse = " ")
    } else {
      ""
    }
    return(runtime_command_mutates_packages(payload))
  }
  installers <- c(
    "micromamba", "mamba", "conda", "pip", "pip3", "pipx", "uv", "poetry",
    "python", "python3", "py", "r", "rscript", "node", "nodejs"
  )
  is_installer <- executable %in% installers || grepl("^python[0-9]+(\\.[0-9]+)*$", executable)
  is_installer && runtime_text_has_package_mutation(paste(argv, collapse = " "))
}

runtime_command_mutates_packages <- function(command, args = character()) {
  if (length(args) > 0L) {
    return(runtime_package_words_mutate(c(as.character(command)[[1L]], as.character(args))))
  }
  segments <- strsplit(as.character(command)[[1L]], "(?:&&|\\|\\||[;\\r\\n])", perl = TRUE)[[1L]]
  any(vapply(segments, function(segment) {
    runtime_package_words_mutate(runtime_shell_words(segment))
  }, logical(1)))
}

package_usage_state <- new.env(parent = emptyenv())
package_usage_state$external_process <- FALSE
runtime_write_policy_env$package_usage_state <- package_usage_state

assert_runtime_process_allowed <- function(command, args = character()) {
  if (runtime_command_mutates_packages(command, args)) {
    stop(
      "Package/environment mutation is not allowed in an R child process; use manage_packages.",
      call. = FALSE
    )
  }
  if (!is.null(managed_runtime_dir) && runtime_process_writes_managed(command, args)) {
    stop(
      "Managed runtime files are read-only in an R child process; use manage_packages for changes.",
      call. = FALSE
    )
  }
  package_usage_state$external_process <- TRUE
  invisible(NULL)
}

runtime_argument <- function(args, name, position) {
  if (!is.null(names(args)) && name %in% names(args)) return(args[[name]])
  if (length(args) >= position) args[[position]] else NULL
}

runtime_symlink_source <- function(source, destination) {
  if (
    is.character(source) && length(source) == 1L && nzchar(source) &&
      is.character(destination) && length(destination) == 1L && nzchar(destination) &&
      !grepl("^(?:[/\\\\]|[A-Za-z]:[/\\\\])", source, perl = TRUE)
  ) {
    return(file.path(dirname(destination), source))
  }
  source
}

make_runtime_write_guard <- function(binding_name, binding_env = baseenv()) {
  original <- get(binding_name, envir = binding_env, inherits = FALSE)
  force(original)
  force(binding_name)
  if (identical(binding_name, "save")) {
    # save inspects the unevaluated names in ... and resolves them in envir.
    # list(...) / do.call() would force those promises and substitute their values.
    return(function(..., file = stop("'file' must be specified"), envir = parent.frame()) {
      assert_runtime_write_allowed(list(file))
      original(..., file = file, envir = envir)
    })
  }
  function(...) {
    args <- list(...)
    targets <- switch(
      binding_name,
      writeLines = list(runtime_argument(args, "con", 2L)),
      writeBin = list(runtime_argument(args, "con", 2L)),
      unlink = list(runtime_argument(args, "x", 1L)),
      file.remove = args,
      file.rename = list(
        runtime_argument(args, "from", 1L),
        runtime_argument(args, "to", 2L)
      ),
      file.link = list(
        runtime_argument(args, "from", 1L),
        runtime_argument(args, "to", 2L)
      ),
      file.symlink = list(
        runtime_symlink_source(
          runtime_argument(args, "from", 1L),
          runtime_argument(args, "to", 2L)
        ),
        runtime_argument(args, "to", 2L)
      ),
      file.create = args,
      file.append = list(runtime_argument(args, "file1", 1L)),
      file.copy = list(runtime_argument(args, "to", 2L)),
      dir.create = list(runtime_argument(args, "path", 1L)),
      download.file = list(runtime_argument(args, "destfile", 2L)),
      saveRDS = list(runtime_argument(args, "file", 2L)),
      cat = list(runtime_argument(args, "file", .Machine$integer.max)),
      file = {
        open_mode <- runtime_argument(args, "open", 2L)
        if (is.character(open_mode) && grepl("[wax+]", open_mode)) {
          list(runtime_argument(args, "description", 1L))
        } else {
          list()
        }
      },
      gzfile = {
        open_mode <- runtime_argument(args, "open", 2L)
        if (is.character(open_mode) && grepl("[wax+]", open_mode)) {
          list(runtime_argument(args, "description", 1L))
        } else {
          list()
        }
      },
      bzfile = {
        open_mode <- runtime_argument(args, "open", 2L)
        if (is.character(open_mode) && grepl("[wax+]", open_mode)) {
          list(runtime_argument(args, "description", 1L))
        } else {
          list()
        }
      },
      xzfile = {
        open_mode <- runtime_argument(args, "open", 2L)
        if (is.character(open_mode) && grepl("[wax+]", open_mode)) {
          list(runtime_argument(args, "description", 1L))
        } else {
          list()
        }
      },
      fifo = {
        open_mode <- runtime_argument(args, "open", 2L)
        if (is.character(open_mode) && grepl("[wax+]", open_mode)) {
          list(runtime_argument(args, "description", 1L))
        } else {
          list()
        }
      },
      open = {
        open_mode <- runtime_argument(args, "open", 2L)
        if (is.character(open_mode) && grepl("[wax+]", open_mode)) {
          list(runtime_argument(args, "con", 1L))
        } else {
          list()
        }
      },
      sink = list(runtime_argument(args, "file", 1L)),
      Sys.chmod = list(runtime_argument(args, "paths", 1L)),
      system = {
        assert_runtime_process_allowed(runtime_argument(args, "command", 1L))
        list()
      },
      system2 = {
        assert_runtime_process_allowed(
          runtime_argument(args, "command", 1L),
          runtime_argument(args, "args", 2L)
        )
        list()
      },
      pipe = {
        assert_runtime_process_allowed(runtime_argument(args, "description", 1L))
        list()
      },
      list()
    )
    assert_runtime_write_allowed(targets)
    do.call(original, args, envir = parent.frame())
  }
}

for (helper in c(
  "canonical_runtime_path",
  "assert_runtime_write_allowed",
  "runtime_command_name",
  "runtime_text_references_managed",
  "runtime_target_is_managed",
  "runtime_write_targets",
  "runtime_text_has_write_primitive",
  "runtime_shell_words",
  "runtime_shell_redirections",
  "runtime_shell_writes_managed",
  "runtime_process_writes_managed",
  "runtime_text_has_package_mutation",
  "runtime_package_words_mutate",
  "runtime_command_mutates_packages",
  "assert_runtime_process_allowed",
  "runtime_argument",
  "runtime_symlink_source",
  "make_runtime_write_guard"
)) {
  helper_fn <- get(helper, envir = .GlobalEnv, inherits = FALSE)
  environment(helper_fn) <- runtime_write_policy_env
  assign(helper, helper_fn, envir = runtime_write_policy_env)
}
runtime_value <- Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR", "")
source_root <- NULL
if (nzchar(runtime_value)) {
  runtime_write_policy_env$managed_runtime_dir <-
    runtime_write_policy_env$canonical_runtime_path(runtime_value)
  source_root <- path.expand(runtime_value)
  if (.Platform$OS.type == "windows") source_root <- tolower(source_root)
  runtime_write_policy_env$managed_runtime_source <- chartr("\\", "/", source_root)
}
runtime_write_bindings <- c(
  "writeLines", "writeBin", "unlink", "file.append", "file.copy", "file.remove", "file.rename",
  "file.link",
  "file.symlink", "file.create",
  "dir.create", "saveRDS", "save", "cat", "file", "gzfile", "bzfile", "xzfile",
  "fifo", "open", "sink", "Sys.chmod", "system", "system2", "pipe"
)
runtime_write_wrappers <- lapply(
  runtime_write_bindings,
  runtime_write_policy_env$make_runtime_write_guard
)
names(runtime_write_wrappers) <- runtime_write_bindings
lockEnvironment(runtime_write_policy_env, bindings = TRUE)
for (binding_name in runtime_write_bindings) {
  if (bindingIsLocked(binding_name, baseenv())) unlockBinding(binding_name, baseenv())
  assign(binding_name, runtime_write_wrappers[[binding_name]], envir = baseenv())
  lockBinding(binding_name, baseenv())
}
download_file_wrapper <- runtime_write_policy_env$make_runtime_write_guard(
  "download.file",
  asNamespace("utils")
)
for (binding_env in list(asNamespace("utils"), as.environment("package:utils"))) {
  if (!exists("download.file", envir = binding_env, inherits = FALSE)) next
  if (bindingIsLocked("download.file", binding_env)) unlockBinding("download.file", binding_env)
  assign("download.file", download_file_wrapper, envir = binding_env)
  lockBinding("download.file", binding_env)
}
rm(
  canonical_runtime_path,
  assert_runtime_write_allowed,
  runtime_command_name,
  runtime_text_references_managed,
  runtime_target_is_managed,
  runtime_write_targets,
  runtime_text_has_write_primitive,
  runtime_shell_words,
  runtime_shell_redirections,
  runtime_shell_writes_managed,
  runtime_process_writes_managed,
  runtime_text_has_package_mutation,
  runtime_package_words_mutate,
  runtime_command_mutates_packages,
  assert_runtime_process_allowed,
  runtime_argument,
  runtime_symlink_source,
  make_runtime_write_guard,
  runtime_value,
  source_root,
  runtime_write_bindings,
  runtime_write_wrappers,
  download_file_wrapper,
  binding_env
)

figures_dir <- Sys.getenv("OPEN_SCIENCE_KERNEL_FIGURES_DIR", "")
text_limit_bytes <- as.numeric(Sys.getenv("OPEN_SCIENCE_NOTEBOOK_TEXT_LIMIT_BYTES", 2 * 1024 * 1024))
diagnostic_limit_bytes <- min(16 * 1024, max(0, text_limit_bytes))
figure_limit_bytes <- as.numeric(Sys.getenv("OPEN_SCIENCE_NOTEBOOK_FIGURE_LIMIT_BYTES", 3.5 * 1024 * 1024))
figure_count_limit <- as.integer(Sys.getenv("OPEN_SCIENCE_NOTEBOOK_FIGURE_COUNT_LIMIT", 12))
figure_total_limit_bytes <- as.numeric(Sys.getenv("OPEN_SCIENCE_NOTEBOOK_FIGURE_TOTAL_LIMIT_BYTES", 8 * 1024 * 1024))
namespace_variable_limit <- as.integer(Sys.getenv("OPEN_SCIENCE_NOTEBOOK_NAMESPACE_VARIABLE_LIMIT", 500))
namespace_response_limit_bytes <- as.integer(Sys.getenv("OPEN_SCIENCE_NOTEBOOK_NAMESPACE_RESPONSE_LIMIT_BYTES", 256 * 1024))

namespace_state <- new.env(parent = emptyenv())
namespace_state$internal_names <- character()
namespace_state$lazy_names <- character()
namespace_state$written_names <- character()

# Base R intentionally does not expose whether an arbitrary environment binding is a promise.
# Track direct delayedAssign() calls for a precise label and completed direct writes so user
# shadows of bootstrap names remain visible. Inspection never reads a binding value.
namespace_tracker <- base::local({
  delayed_assign_call <- function(expr) {
    if (!is.call(expr)) return(FALSE)
    head <- expr[[1L]]
    if (identical(head, as.name("delayedAssign"))) return(TRUE)
    is.call(head) && length(head) == 3L &&
      identical(head[[1L]], as.name("::")) &&
      identical(head[[2L]], as.name("base")) &&
      identical(head[[3L]], as.name("delayedAssign"))
  }

  delayed_names <- function(expr) {
    found <- character()
    visit <- function(node) {
      if (!is.call(node)) return(invisible(NULL))
      if (delayed_assign_call(node) && length(node) >= 2L &&
          is.character(node[[2L]]) && length(node[[2L]]) == 1L) {
        found <<- union(found, node[[2L]])
      }
      if (length(node) > 1L) {
        for (index in seq.int(2L, length(node))) visit(node[[index]])
      }
      invisible(NULL)
    }
    visit(expr)
    found
  }

  direct_written_names <- function(expr) {
    if (!is.call(expr) || length(expr) < 2L) return(character())
    head <- expr[[1L]]
    head_name <- if (is.symbol(head)) as.character(head) else ""
    if (head_name %in% c("<-", "=", "<<-") &&
        is.symbol(expr[[2L]])) {
      return(as.character(expr[[2L]]))
    }
    if (head_name %in% c("->", "->>") && length(expr) >= 3L &&
        is.symbol(expr[[3L]])) {
      return(as.character(expr[[3L]]))
    }
    is_assign <- identical(head, as.name("assign")) ||
      (is.call(head) && length(head) == 3L &&
       identical(head[[1L]], as.name("::")) &&
       identical(head[[2L]], as.name("base")) &&
       identical(head[[3L]], as.name("assign")))
    if (!is_assign) return(character())
    matched <- match.call(base::assign, expr, expand.dots = FALSE)
    name <- matched$x
    if (!is.character(name) || length(name) != 1L) return(character())
    target <- matched$envir
    position <- matched$pos
    targets_global <- is.null(target) && is.null(position) ||
      identical(target, as.name(".GlobalEnv")) ||
      identical(target, quote(globalenv())) ||
      identical(position, as.name(".GlobalEnv")) ||
      identical(position, quote(globalenv())) ||
      identical(position, 1L) || identical(position, 1)
    if (targets_global) name else character()
  }

  list(
    prepare = function(expr) {
      lazy_names <- delayed_names(expr)
      namespace_state$lazy_names <- union(namespace_state$lazy_names, lazy_names)
      namespace_state$written_names <- setdiff(namespace_state$written_names, lazy_names)
      invisible(NULL)
    },
    commit = function(expr) {
      written_names <- direct_written_names(expr)
      # Only clear names for a completed, direct top-level write. Nested control flow remains
      # conservatively marked lazy because not all paths necessarily executed.
      if (!delayed_assign_call(expr)) {
        namespace_state$lazy_names <- setdiff(namespace_state$lazy_names, written_names)
      }
      namespace_state$written_names <- union(namespace_state$written_names, written_names)
      current_names <- ls(envir = .GlobalEnv, all.names = TRUE)
      namespace_state$lazy_names <- intersect(namespace_state$lazy_names, current_names)
      namespace_state$written_names <- intersect(namespace_state$written_names, current_names)
      invisible(NULL)
    }
  )
}, envir = base::list2env(base::list(namespace_state = namespace_state), parent = base::baseenv()))

inspect_namespace <- base::local({
  limit_text_raw <- function(value, limit) {
    text <- if (is.character(value) && length(value) > 0L) value[[1L]] else ""
    # At least one byte is required per character, so this bounds the temporary allocation before
    # converting a potentially enormous string to raw bytes.
    bytes <- charToRaw(substr(text, 1L, limit + 1L))
    truncated <- length(bytes) > limit
    if (truncated) {
      bytes <- bytes[seq_len(limit)]
      while (length(bytes) > 0L && !validUTF8(rawToChar(bytes))) {
        bytes <- bytes[-length(bytes)]
      }
    }
    list(bytes = bytes, truncated = truncated)
  }

  encoded_text <- function(value, limit = 256L) {
    jsonlite::base64_enc(limit_text_raw(value, limit)$bytes)
  }

  function(include_private = FALSE) {
    names <- ls(envir = .GlobalEnv, all.names = TRUE)
    active_names <- names[vapply(
      names,
      bindingIsActive,
      logical(1),
      env = .GlobalEnv
    )]
    shadowed_internal_names <- union(
      union(namespace_state$written_names, namespace_state$lazy_names),
      active_names
    )
    hidden_internal_names <- setdiff(
      namespace_state$internal_names,
      shadowed_internal_names
    )
    names <- sort(setdiff(names, hidden_internal_names))
    if (!isTRUE(include_private)) names <- names[!startsWith(names, ".")]
    variables <- list()
    remaining <- max(0L, namespace_response_limit_bytes - 256L)
    for (name in utils::head(names, namespace_variable_limit)) {
      binding_type <- if (bindingIsActive(name, .GlobalEnv)) {
        "active binding"
      } else if (name %in% namespace_state$lazy_names) {
        "lazy binding"
      } else {
        "binding"
      }
      entry <- list(
        name_base64 = encoded_text(name, 1024L),
        type_base64 = encoded_text(binding_type),
        preview_base64 = encoded_text("")
      )
      if (startsWith(name, ".")) entry$is_private <- TRUE
      encoded_size <- nchar(
        jsonlite::toJSON(entry, auto_unbox = TRUE, null = "null"),
        type = "bytes"
      ) + 1L
      if (encoded_size > remaining) break
      variables[[length(variables) + 1L]] <- entry
      remaining <- remaining - encoded_size
    }
    list(
      variable_count = length(names),
      variables_truncated = length(variables) < length(names),
      variables = variables
    )
  }
}, envir = base::list2env(
  base::list(
    namespace_state = namespace_state,
    namespace_variable_limit = namespace_variable_limit,
    namespace_response_limit_bytes = namespace_response_limit_bytes
  ),
  parent = base::baseenv()
))
lockEnvironment(environment(inspect_namespace), bindings = TRUE)
con <- file("stdin", "rb")

emit <- function(obj) {
  cat(jsonlite::toJSON(obj, auto_unbox = TRUE, null = "null"), "\n", sep = "")
  flush(stdout())
}

# Observe package bindings without evaluating functions, promises, or user data.
# These are potential calls in each top-level expression, not an execution trace.
new_package_observer <- function(clean_session = FALSE) {
  # Force the request-start observation before the caller increments its sequence.
  clean_session <- isTRUE(clean_session)
  if (clean_session) {
    startup_args <- commandArgs()
    args_end <- match("--args", startup_args, nomatch = length(startup_args) + 1L) - 1L
    clean_session <- "--vanilla" %in% startup_args[seq_len(args_end)] &&
      !any(grepl("^--default-packages(=|$)", startup_args[seq_len(args_end)])) &&
      !any(nzchar(Sys.getenv(c("R_DEFAULT_PACKAGES", "R_SCRIPT_DEFAULT_PACKAGES")))) &&
      all(loadedNamespaces() %in% c("base", "utils", "stats", "graphics", "grDevices",
        "methods", "datasets", "compiler", "tools", "grid", "jsonlite"))
  }
  complete <- TRUE
  reads <- list()
  seen <- new.env(parent = emptyenv())
  attached <- function() {
    names <- sub("^package:", "", grep("^package:", search(), value = TRUE))
    if (length(names) > 128L || any(nchar(names) > 128L)) complete <<- FALSE
    names[seq_len(min(length(names), 128L))]
  }
  before <- attached()
  visited <- 0L
  record <- function(expr) tryCatch({
    positions <- seq_along(search())
    if (length(positions) > 128L) { complete <<- FALSE; return(invisible(NULL)) }
    walk <- function(node, depth = 0L) {
      visited <<- visited + 1L
      if (visited > 4096L || depth > 64L) { complete <<- FALSE; return(invisible(NULL)) }
      if (!is.call(node)) return(invisible(NULL))
      op <- if (is.symbol(node[[1L]])) as.character(node[[1L]]) else ""
      if (op %in% c("quote", "substitute", "expression", "function", "~")) return(invisible(NULL))
      if (nzchar(op) && nchar(op) <= 256L) {
        # mode="any" never forces a promise. A non-package or active binding
        # remains unresolved; the static analyzer retains its conservative rules.
        for (pos in positions) {
          env <- as.environment(pos)
          if (!exists(op, envir = env, inherits = FALSE)) next
          label <- environmentName(env)
          is_base <- identical(env, baseenv())
          if ((is_base || startsWith(label, "package:")) && !bindingIsActive(op, env)) {
            pkg <- if (is_base) "base" else substring(label, 9L)
            key <- paste(pkg, op, sep = ":")
            if (!exists(key, envir = seen, inherits = FALSE)) {
              if (length(reads) >= 256L) { complete <<- FALSE; break }
              assign(key, TRUE, envir = seen)
              reads[[length(reads) + 1L]] <<- list(name = op, package = pkg)
            }
          }
          break
        }
      }
      # Do not force missing arguments (e.g. matrix[, 1]).
      args <- as.list(node)
      # A qualified call has a language object in its head. Observe :: itself without
      # evaluating the namespace/member or treating arbitrary computed callees as calls.
      head <- args[[1L]]
      if (is.call(head) && is.symbol(head[[1L]]) &&
          as.character(head[[1L]]) %in% c("::", ":::")) walk(head, depth + 1L)
      for (i in seq_along(args)) {
        if (i > 1L && !identical(args[[i]], quote(expr = ))) walk(args[[i]], depth + 1L)
        if (visited > 4096L) break
      }
    }
    walk(expr)
  }, error = function(e) { complete <<- FALSE })
  list(record = record, finish = function() {
    after <- attached()
    list(before = as.list(before), after = as.list(after), reads = reads, complete = complete,
         cleanSession = isTRUE(clean_session))
  })
}
environment(new_package_observer) <- baseenv()

capture_r_random_state <- function() {
  tryCatch({
    if (!exists(".Random.seed", envir = globalenv(), inherits = FALSE) ||
        bindingIsActive(".Random.seed", globalenv()) ||
        ".Random.seed" %in% namespace_state$lazy_names)
      return(list(state = "unavailable", reason = "seed-unavailable"))
    kinds <- RNGkind()
    if (kinds[[1L]] == "user-supplied" || kinds[[2L]] %in% c("Box-Muller", "user-supplied"))
      return(list(state = "unavailable", reason = "unsupported-rng"))
    seed <- get(".Random.seed", envir = globalenv(), inherits = FALSE)
    sizes <- c(4L, 3L, 3L, 626L, 102L, 0L, 102L, 7L)
    names(sizes) <- c("Wichmann-Hill", "Marsaglia-Multicarry", "Super-Duper",
      "Mersenne-Twister", "Knuth-TAOCP", "user-supplied", "Knuth-TAOCP-2002", "L'Ecuyer-CMRG")
    if (!is.integer(seed) || is.object(seed) || !is.null(attributes(seed)) ||
        length(seed) != sizes[[kinds[[1L]]]])
      return(list(state = "unavailable", reason = "invalid-seed"))
    normal <- match(kinds[[2L]], c("Buggy Kinderman-Ramage", "Ahrens-Dieter", "Box-Muller",
      "user-supplied", "Inversion", "Kinderman-Ramage")) - 1L
    sample <- match(kinds[[3L]], c("Rounding", "Rejection")) - 1L
    header <- match(kinds[[1L]], names(sizes)) - 1L + 100L * normal + 10000L * sample
    if (!identical(seed[[1L]], header))
      return(list(state = "unavailable", reason = "invalid-seed"))
    list(state = "available", kinds = as.list(kinds), seed = as.list(seed))
  }, error = function(e) list(state = "unavailable", reason = "seed-unavailable"))
}
environment(capture_r_random_state) <- list2env(list(namespace_state = namespace_state), parent = baseenv())

capture_execution_context <- local({
  capture_rng <- capture_r_random_state
  function() {
  base::tryCatch({
    limits <- base::Sys.getenv(c("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                               "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"), unset = "")
    rng <- capture_rng()
    base::list(locale = base::substr(base::Sys.getlocale(), 1L, 1024L),
      timezone = base::substr(base::Sys.getenv("TZ", unset = "system-default"), 1L, 256L),
      threadLimits = base::lapply(base::as.list(limits), function(v) base::substr(v, 1L, 32L)),
      randomLibraries = if (base::identical(rng$state, "available"))
        base::as.list(base::paste0("R:", base::unlist(rng$kinds))) else base::list(),
      rRandomState = rng)
  }, error = function(e) NULL)
  }
})

# A checkpoint is a bounded object closure, never a workspace dump. Its binary envelope is
# serialized once so reference aliases inside the selected object graph survive together.
# The host owns path authority, immutable digests, quotas and run/environment identity.
stage_checkpoint_owner <- base::local({
  startup_packages <- sub("^package:", "", grep("^package:", search(), value = TRUE))
  trusted_options <- new.env(parent = emptyenv())
  trusted_options$functions <- list()
  seal_options <- function() {
    if (environmentIsLocked(trusted_options)) return(invisible(NULL))
    trusted_options$functions <- Filter(is.function, options())
    lockEnvironment(trusted_options, bindings = TRUE)
  }
  context_proof <- "literal-and-reviewed-profiles-v3"
  # 32 MiB of uncompressed objects, with a fourfold serialization/roundtrip reserve
  # (128 MiB). This is a conservative observer budget, not a process memory limit.
  snapshot_budget_bytes <- 32 * 1024^2
  # Matrix 1.7.6 .onLoad installs this exact constant condition handler. Encode
  # its proven semantics as base metadata, never as a closure in expected evidence.
  empty_method_handler <- function(cond) NULL
  environment(empty_method_handler) <- emptyenv()
  is_empty_method_handler <- function(value) is.function(value) && typeof(value) == "closure" &&
    identical(environment(value), emptyenv()) && identical(formals(value), formals(empty_method_handler)) &&
    is.null(body(value)) && is.null(attributes(value))
  option_frontier <- new.env(parent = emptyenv())
  option_frontier$ready <- FALSE
  option_frontier$owned <- character()
  check_option_data <- function(value) {
    if (is.null(value)) return(invisible(NULL))
    attrs <- attributes(value)
    if (isS4(value) ||
        !typeof(value) %in% c("logical", "integer", "double", "complex", "character", "raw", "list"))
      fail("unsupported-option-data")
    # Default contrasts has unordered/ordered names. Plain names carry no executable
    # state; class and all other attributes remain unsupported in the expected envelope.
    if (!is.null(attrs) && (!identical(names(attrs), "names") ||
        !is.character(attrs$names) || !is.null(attributes(attrs$names)) ||
        length(attrs$names) != length(value))) fail("unsupported-option-data")
    if (is.list(value)) for (member in value) check_option_data(member)
    invisible(NULL)
  }
  validate_options <- function(value) {
    if (!is.list(value) || !identical(value$proof, context_proof) || !is.list(value$values) ||
        !is.character(value$functions) || !is.character(value$handlers) ||
        anyDuplicated(value$handlers) || !all(value$handlers %in% "ambiguousMethodSelection") ||
        !all(value$handlers %in% names(value$values)) || anyDuplicated(names(value$values)) ||
        length(value$values) > 0L && is.null(names(value$values)) ||
        !all(value$functions %in% names(trusted_options$functions)) ||
        !all(value$functions %in% names(value$values))) fail("invalid-checkpoint-context")
    # Payloads can carry plain names, but no classes, other attributes or namespace
    # references: reading expected evidence must load no code.
    validate(value$values)
    for (member in value$values) check_option_data(member)
    invisible(NULL)
  }
  apply_options <- function(value, only = names(value$values)) {
    selected <- value$values[only]
    for (name in intersect(only, value$functions)) selected[name] <- list(trusted_options$functions[[name]])
    for (name in intersect(only, value$handlers)) selected[name] <- list(empty_method_handler)
    if (length(selected)) options(selected)
    invisible(NULL)
  }
  snapshot_options <- function(option_names = character()) {
    values <- options()[sort(unique(option_names))]
    names(values) <- sort(unique(option_names))
    functions <- character()
    for (name in names(trusted_options$functions)) {
      if (identical(values[[name]], trusted_options$functions[[name]])) {
        # The kernel wraps the default graphics device with trusted resource owners.
        # Rebind that function in this kernel instead of serializing its live connections.
        functions <- c(functions, name)
        values[name] <- list(NULL)
      }
    }
    handlers <- character()
    if ("ambiguousMethodSelection" %in% names(values) && is_empty_method_handler(values$ambiguousMethodSelection)) {
      handlers <- "ambiguousMethodSelection"
      values[handlers] <- list(NULL)
    }
    result <- list(proof = context_proof, values = values, functions = functions, handlers = handlers)
    validate_options(result)
    result
  }
  # This is a bounded call contract for the standard differential-expression path.
  # File authority and package/version locking remain host responsibilities. Package
  # internals are trusted only for these reviewed entry points, never arbitrary setters.
  allowed_libraries <- c("DESeq2", "SummarizedExperiment", "S4Vectors", "IRanges", "stats",
    "utils", "graphics", "grDevices", "methods")
  safe_base <- c("<-", "=", "->", "{", "(", "[", "[[", "$", "@", "~", "::",
    "+", "-", "*", "/", "^", "%%", "%/%", "%*%", ":", "!", "==", "!=", "<", ">",
    "<=", ">=", "&", "&&", "|", "||", "%in%", "c", "list", "pairlist", "matrix", "array",
    "data.frame", "factor", "ordered", "levels", "nlevels", "droplevels", "as.factor",
    "as.data.frame", "as.matrix", "as.vector", "as.numeric", "as.double", "as.integer",
    "as.character", "as.logical", "as.list", "is.na", "is.nan", "is.finite", "is.infinite",
    "is.numeric", "is.integer", "is.character", "is.logical", "is.matrix", "is.data.frame",
    "is.null", "isTRUE", "isFALSE", "any", "all", "anyNA", "length", "lengths", "dim",
    "dimnames", "nrow", "ncol", "names", "rownames", "colnames", "unname", "seq", "seq_len",
    "seq_along", "rep", "rep_len", "rep.int", "rbind", "cbind", "t", "head", "tail",
    "which", "which.min", "which.max", "match", "unique", "duplicated", "sort", "sort.int",
    "order", "rank", "rev", "sum", "prod", "min", "max", "range", "mean", "pmax", "pmin",
    "rowSums", "colSums", "rowMeans", "colMeans", "sweep", "scale", "abs", "sqrt", "exp",
    "expm1", "log", "log2", "log10", "log1p", "round", "signif", "floor", "ceiling",
    "trunc", "sign", "Re", "Im", "Arg", "Conj", "Mod", "paste", "paste0", "sprintf",
    "format", "formatC", "nchar", "substr", "substring", "sub", "gsub", "grep", "grepl",
    "strsplit", "trimws", "tolower", "toupper", "chartr", "iconv", "make.names",
    "make.unique", "file.path", "basename", "dirname", "normalizePath", "path.expand",
    "file.exists", "dir.exists", "readRDS", "saveRDS", "readLines", "writeLines", "readBin",
    "writeBin", "file", "close", "unlink", "dir.create", "list.files", "print", "cat",
    "message", "warning", "stop", "stopifnot", "invisible", "identity", "identical",
    "all.equal", "set.seed", "RNGkind", "options", "getOption", "getwd", "setwd",
    "suppressWarnings", "suppressMessages", "suppressPackageStartupMessages", "library",
    "require", "requireNamespace", "new.env", "rm", "remove", "exists", "structure", "attr",
    "attributes", "class", "unclass", "typeof", "inherits", "ifelse", "is.unsorted")
  safe_stats <- c("heatmap", "p.adjust", "na.omit", "na.exclude", "complete.cases", "sd", "var",
    "median", "quantile", "IQR", "cor", "cov", "dist", "hclust", "prcomp", "model.matrix",
    "model.frame", "terms", "formula", "as.formula", "relevel", "contrasts", "contr.treatment",
    "contr.sum", "contr.poly", "setNames", "aggregate", "fisher.test", "t.test", "wilcox.test",
    "rnorm", "runif", "rnbinom", "rpois", "rgamma", "rbinom", "pnorm", "pchisq", "qnorm",
    "dnorm", "dnbinom", "dpois", "filter", "predict", "coef", "fitted", "residuals")
  safe_utils <- c("read.csv", "read.csv2", "read.delim", "read.delim2", "read.table", "write.csv",
    "write.csv2", "write.table", "head", "tail", "str", "packageVersion", "sessionInfo")
  safe_graphics <- c("plot", "plot.default", "points", "lines", "abline", "text", "title", "legend", "axis",
    "box", "hist", "boxplot", "image", "matplot", "pairs", "barplot", "layout", "par")
  safe_devices <- c("png", "pdf", "svg", "jpeg", "tiff", "bmp", "cairo_pdf", "dev.off",
    "dev.cur", "dev.list", "palette", "rgb", "hsv", "hcl", "rainbow", "heat.colors",
    "terrain.colors", "topo.colors", "cm.colors", "hcl.colors", "colorRampPalette", "adjustcolor")
  safe_deseq <- c("DESeqDataSetFromMatrix", "DESeqDataSet", "DESeq", "results", "resultsNames",
    "counts", "design", "sizeFactors", "dispersions", "normalizationFactors", "dispersionFunction",
    "vst", "varianceStabilizingTransformation", "rlog", "plotPCA", "plotCounts", "plotDispEsts",
    "plotMA", "lfcShrink", "estimateSizeFactors", "estimateDispersions", "nbinomWaldTest", "nbinomLRT")
  safe_summarized <- c("SummarizedExperiment", "assay", "assays", "colData", "rowData", "rowRanges")
  safe_bioc_generics <- c("rownames", "colnames", "nrow", "ncol", "dim", "dimnames", "names",
    "length", "as.data.frame", "as.matrix", "rowSums", "colSums", "rowMeans", "colMeans", "rbind",
    "cbind", "head", "tail", "t", "sort", "order", "unique", "duplicated", "is.na", "mean",
    "sum", "any", "all", "pmax", "pmin")
  call_allowed <- function(package, name) {
    if (package == "base") return(name %in% safe_base)
    if (package == "stats") return(name %in% c(safe_stats, safe_base))
    if (package == "utils") return(name %in% safe_utils)
    if (package == "graphics") return(name %in% safe_graphics)
    if (package == "grDevices") return(name %in% safe_devices)
    if (package == "DESeq2") return(name %in% safe_deseq)
    if (package == "SummarizedExperiment") return(name %in% c(safe_summarized, safe_bioc_generics))
    if (package == "S4Vectors") return(name %in% c("DataFrame", "metadata", "mcols", "Rle",
      "SimpleList", "head", "tail", safe_base))
    if (package == "IRanges") return(name %in% c("IRanges", safe_bioc_generics))
    if (package == "methods") return(name %in% c("as", "is", "isS4", "slot", "slotNames"))
    # Bioconductor attaches generics that mask these standard, read-only operations.
    if (package %in% c("BiocGenerics", "S4Generics", "MatrixGenerics", "Biobase"))
      return(name %in% c(safe_base, safe_stats, safe_deseq, safe_summarized))
    FALSE
  }
  # mode="function" forces promises and active bindings even for ordinary execution.
  # Presence alone is sufficient here: ambiguous/user bindings fail closed without
  # inspecting their value. R may skip a non-function binding, but admission need not.
  call_locations <- function(name) {
    search()[vapply(search(), function(location)
      exists(name, envir = as.environment(location), inherits = FALSE, mode = "any"), logical(1))]
  }
  resolved_call_allowed <- function(name) {
    locations <- call_locations(name)
    length(locations) > 0L && startsWith(locations[[1L]], "package:") &&
      call_allowed(substring(locations[[1L]], 9L), name)
  }
  history <- new.env(parent = emptyenv())
  history$unsupported <- FALSE
  history$reason <- ""
  taint <- function(reason) {
    history$unsupported <- TRUE
    if (!nzchar(history$reason)) history$reason <- reason
  }
  observe <- function(exprs, allow_pending = TRUE) {
    # Namespace mutation and dynamic evaluation can install hidden S3/S4 methods. Once
    # observed, this process cannot attest a closed state using object snapshots alone.
    risky <- c("setMethod", "setGeneric", "setClass", "setOldClass", "registerS3method",
      "registerS3methods", "assignInNamespace", "unlockBinding", "trace", "untrace",
      "assign", "makeActiveBinding", "delayedAssign", "eval", "evalq", "eval.parent",
      "get", "get0", "mget", "dynGet", "do.call", "source", "sys.source", "load",
      "asNamespace", "getNamespace", "getFromNamespace", "loadNamespace", "environment",
      "parent.env", "body<-", "environment<-", "formals<-", ":::")
    declared_package <- FALSE
    visit <- function(node) {
      if (is.symbol(node) && as.character(node) %in% risky) taint(paste0("dynamic-symbol:", as.character(node)))
      if (!is.call(node) && !is.expression(node) && !is.pairlist(node)) return(invisible(NULL))
      if (is.call(node)) {
        head <- node[[1L]]
        op <- if (is.symbol(head)) as.character(head) else if (is.call(head) &&
          length(head) == 3L && as.character(head[[1L]]) %in% c("::", ":::"))
          as.character(head[[3L]]) else ""
        if (op %in% risky) taint(paste0("dynamic-call:", op))
        qualified <- is.call(head) && length(head) == 3L &&
          is.symbol(head[[1L]]) && as.character(head[[1L]]) %in% c("::", ":::")
        if (op %in% c("library", "require", "requireNamespace")) {
          if (qualified && !call_allowed(as.character(head[[2L]]), op)) taint(paste0("unreviewed-call:", as.character(head[[2L]]), "::", op))
          args <- as.list(node)[-1L]
          literal <- if (length(args) > 0L && (is.symbol(args[[1L]]) || is.character(args[[1L]])))
            as.character(args[[1L]]) else ""
          if (length(literal) != 1L || !literal %in% allowed_libraries ||
              (!is.null(args$character.only) && !identical(args$character.only, FALSE)) ||
              (op == "requireNamespace" && is.symbol(args[[1L]]))) taint(paste0("unreviewed-library:", paste(literal, collapse = ",")))
          if (op != "requireNamespace") declared_package <<- TRUE
        } else if (qualified) {
          if (!call_allowed(as.character(head[[2L]]), op)) taint(paste0("unreviewed-call:", as.character(head[[2L]]), "::", op))
        } else if (nzchar(op) && !resolved_call_allowed(op)) {
          locations <- call_locations(op)
          if (!allow_pending || !declared_package || length(locations) > 0L)
            taint(paste0("unreviewed-call:", op, ":", paste(locations, collapse = ",")))
        } else if (!nzchar(op)) taint("computed-call")
      }
      parts <- as.list(node)
      for (i in seq_along(parts)) if ((!is.call(node) || i > 1L) &&
          !identical(parts[[i]], quote(expr = ))) visit(parts[[i]])
      invisible(NULL)
    }
    tryCatch(visit(exprs), error = function(e) taint(paste0("history-analysis:", conditionMessage(e))))
    if (isTRUE(history$unsupported)) unavailable(paste0("unsupported-method-history:", history$reason)) else NULL
  }
  check_global_methods <- function() {
    if (isTRUE(history$unsupported)) fail(paste0("unsupported-method-history:", history$reason))
    user <- union(setdiff(ls(globalenv(), all.names = TRUE), namespace_state$internal_names),
      namespace_state$written_names)
    for (name in user) {
      if (!exists(name, globalenv(), inherits = FALSE)) next
      if (bindingIsActive(name, globalenv())) fail("active-global-method-binding")
      if (name %in% namespace_state$lazy_names) fail("lazy-global-method-binding")
      if (is.function(get(name, globalenv(), inherits = FALSE))) fail("custom-global-method-binding")
    }
  }
  unavailable <- function(reason) list(state = "unavailable", reason = reason)
  fail <- function(reason) stop(reason, call. = FALSE)
  attached <- function() sub("^package:", "", grep("^package:", search(), value = TRUE))
  check_devices <- function(ignored = integer()) {
    if (length(setdiff(as.integer(grDevices::dev.list()), ignored)) > 0L)
      fail("open-user-graphics-device")
  }
  scalar_path <- function(path) is.character(path) && length(path) == 1L &&
    !is.na(path) && nzchar(path)
  # Profiles are for the reviewed R 4.5 / DESeq2 1.50 serial analysis path.
  # Sources: base format/print/file/library, stats model.frame/model.matrix/heatmap,
  # grDevices png/dev.new; DESeq2 1.50.2 plus S4Vectors 0.48.1/matrixStats 1.5.0.
  # These are option names, never guessed defaults. The environment lock owns versions.
  format_options <- c("digits", "digits.secs", "scipen", "OutDec", "width", "max.print")
  model_options <- c("contrasts", "na.action")
  graphics_options <- c("device", "device.ask.default", "bitmapType", "preferRaster", "OutDec")
  deseq_options <- c(model_options, format_options, "matprod", "warn", "verbose",
    "ambiguousMethodSelection", "stringsAsFactors", "matrixStats.center.onUse",
    "matrixStats.center.onScalar", "matrixStats.vars.formula.onMistake", "matrixStats.vars.formula.freq")
  call_options <- function(op, args) {
    if (op %in% c(safe_deseq, "library", "require", "requireNamespace")) {
      if (!identical(paste(R.version$major, strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][[1L]], sep = "."), "4.5"))
        fail("unreviewed-option-runtime")
      # No namespace is loaded to validate a profile. Refuse other installed versions
      # rather than silently treating this reviewed profile as a universal package contract.
      if (op %in% safe_deseq || length(args) && identical(as.character(args[[1L]]), "DESeq2")) {
        versions <- c(DESeq2 = "1.50.2", S4Vectors = "0.48.1", SummarizedExperiment = "1.40.0", matrixStats = "1.5.0", Matrix = "1.7.6", locfit = "1.5.9.12")
        for (package in names(versions)) if (!identical(as.character(utils::packageVersion(package)), versions[[package]]))
          fail("unreviewed-option-package-version")
      }
    }
    if (op %in% c("library", "require", "requireNamespace"))
      return(c("verbose", "conflicts.policy", "keep.source.pkgs", "keep.parse.data.pkgs",
        "checkPackageLicense", "encoding", "matrixStats.envs.min.version"))
    if (op %in% safe_deseq) {
      if (!op %in% c("DESeqDataSetFromMatrix", "DESeq", "results", "resultsNames", "counts",
          "design", "sizeFactors", "dispersions", "normalizationFactors", "dispersionFunction"))
        fail("unreviewed-option-call")
      if (op %in% c("DESeq", "results")) {
        arg_names <- names(args)
        if (is.null(arg_names)) arg_names <- rep("", length(args))
        # Exact installed 1.50.2 formals. R accepts abbreviations such as p=TRUE;
        # checking only args$parallel would miss that implicit parallel branch.
        exact_args <- if (op == "DESeq") c("object", "test", "fitType", "sfType", "betaPrior", "full",
          "reduced", "quiet", "minReplicatesForReplace", "modelMatrixType", "useT", "minmu", "parallel", "BPPARAM") else
          c("object", "contrast", "name", "lfcThreshold", "altHypothesis", "listValues", "cooksCutoff",
            "independentFiltering", "alpha", "filter", "theta", "pAdjustMethod", "filterFun", "format",
            "saveCols", "test", "addMLE", "tidy", "parallel", "BPPARAM", "minmu")
        if (any(!arg_names[nzchar(arg_names)] %in% exact_args) ||
            length(args) > 1L && any(!nzchar(arg_names[-1L])) ||
            !is.null(args$parallel) && !identical(args$parallel, FALSE))
          fail("unreviewed-deseq-option-branch")
      }
      if (op == "DESeq" && !is.null(args$fitType) &&
          !identical(args$fitType, "mean") && !identical(args$fitType, "parametric") &&
          !identical(args$fitType, "local"))
        fail("unreviewed-deseq-option-branch")
      return(deseq_options)
    }
    if (op %in% c("model.matrix", "model.frame", "terms", "formula", "as.formula", "contrasts"))
      return(model_options)
    if (op %in% c(safe_graphics, "heatmap", "png", "pdf", "svg", "jpeg", "tiff", "bmp", "cairo_pdf"))
      return(c(graphics_options, format_options, "verbose"))
    if (op %in% c("read.csv", "read.csv2", "read.delim", "read.delim2", "read.table", "write.csv",
        "write.csv2", "write.table", "file", "readLines", "writeLines"))
      return(c("encoding", "stringsAsFactors", "scipen", "OutDec"))
    if (op %in% c("format", "formatC", "as.character", "paste", "paste0", "sprintf", "print", "cat", "str"))
      return(format_options)
    if (op == "%*%") return("matprod")
    character()
  }
  # Optional environment evidence is deliberately weaker than checkpoint admission:
  # a missing package identity never changes execution or object comparison. Only
  # names/versions leave this owner; paths are private checks against the live library.
  environment_proof_observe <- function(proof, callback) {
    if (is.null(proof) || !isTRUE(proof$complete)) return(invisible(NULL))
    tryCatch(callback(), error = function(e) { proof$complete <- FALSE })
    invisible(NULL)
  }
  environment_proof_package <- function(proof, package) environment_proof_observe(proof, function() {
    if (!is.character(package) || length(package) != 1L || is.na(package) ||
        nchar(package, type = "bytes") > 128L || !grepl("^[A-Za-z][A-Za-z0-9.]*$", package))
      stop("unproven-package-name")
    package <- unname(package)
    root <- normalizePath(.Library, winslash = "/", mustWork = TRUE)
    expected <- paste0(root, "/", package)
    found <- find.package(package, quiet = FALSE)
    path <- normalizePath(found, winslash = "/", mustWork = TRUE)
    if (!identical(path, expected) ||
        !identical(normalizePath(dirname(found), winslash = "/", mustWork = TRUE), root))
      stop("shadowed-package")
    # The loaded namespace may predate a later .libPaths() change. Check both the
    # actual namespace and the current search resolution; neither may be shadowed.
    if (package %in% loadedNamespaces() && package != "base") {
      namespace_path <- getNamespaceInfo(getNamespace(package), "path")
      if (!identical(normalizePath(namespace_path, winslash = "/", mustWork = TRUE), expected) ||
          !identical(normalizePath(dirname(namespace_path), winslash = "/", mustWork = TRUE), root))
        stop("shadowed-namespace")
    }
    description <- paste0(expected, "/DESCRIPTION")
    info <- file.info(description)
    if (is.na(info$size) || info$size > 128 * 1024 || isTRUE(info$isdir) ||
        !identical(normalizePath(description, winslash = "/", mustWork = TRUE), description))
      stop("unproven-package-metadata")
    metadata <- read.dcf(description, fields = c("Package", "Version"))
    if (nrow(metadata) != 1L || !identical(unname(metadata[1L, "Package"]), package))
      stop("unproven-package-metadata")
    version <- unname(metadata[1L, "Version"])
    if (is.na(version) || !nzchar(version) || nchar(version, type = "bytes") > 128L ||
        !grepl("^[A-Za-z0-9][A-Za-z0-9.+_-]*$", version)) stop("unproven-package-version")
    if (package %in% loadedNamespaces() &&
        !identical(package_version(as.character(getNamespaceVersion(package))), package_version(version)))
      stop("changed-package-version")
    prior <- proof$packages[[package]]
    if (!is.null(prior) && !identical(prior, version)) stop("changed-package-version")
    if (is.null(prior) && length(proof$packages) >= 256L) stop("package-proof-budget")
    proof$packages[[package]] <- version
  })
  new_environment_proof <- function(packages, complete = TRUE) {
    proof <- new.env(parent = emptyenv())
    proof$complete <- isTRUE(complete) && identical(paste(R.version$major, strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][[1L]], sep = "."), "4.5")
    proof$packages <- list()
    proof$bytes <- 0
    for (package in unique(c("base", "jsonlite", packages))) environment_proof_package(proof, package)
    proof
  }
  environment_proof_atomic <- function(proof, value) environment_proof_observe(proof, function() {
    # R 4.5 serialize.c uses tag 238 for special ALTREP serialization. Inspect only
    # the root type of our own XDR stream, never arbitrary RDS bytes or values via
    # inspect(). Attributes are visited by validate(). Unknown representations lose
    # this optional proof; no materialization or namespace loading is performed.
    # https://github.com/wch/r-source/blob/R-4-5-branch/src/main/serialize.c
    serialized <- serialize(value, NULL, version = 3L, xdr = TRUE)
    proof$bytes <- proof$bytes + length(serialized)
    if (proof$bytes > snapshot_budget_bytes || length(serialized) < 22L ||
        !identical(serialized[1:2], charToRaw("X\n")) ||
        !identical(readBin(serialized[3:6], "integer", size = 4L, endian = "big"), 3L))
      stop("unproven-serialization")
    encoding_bytes <- readBin(serialized[15:18], "integer", size = 4L, endian = "big")
    if (is.na(encoding_bytes) || encoding_bytes < 0L || encoding_bytes > 1024L ||
        length(serialized) < 22L + encoding_bytes) stop("unproven-serialization")
    expected <- switch(typeof(value), logical = 10L, integer = 13L, double = 14L,
      complex = 15L, character = 16L, raw = 24L, NULL)
    if (is.null(expected) || !identical(as.integer(serialized[[22L + encoding_bytes]]), expected))
      stop("unproven-altrep")
  })
  environment_proof_class <- function(proof, value) environment_proof_observe(proof, function() {
    classes <- attr(value, "class", exact = TRUE)
    if (is.null(classes)) return(invisible(NULL))
    if (isS4(value)) {
      package <- attr(classes, "package", exact = TRUE)
      if (!is.character(classes) || length(classes) != 1L || !is.character(package) ||
          length(package) != 1L || !package %in% loadedNamespaces()) stop("unproven-s4-class")
      # getClassDef searches only an already loaded namespace. A forged package
      # attribute must not turn an unknown/global class into a package dependency.
      definition <- methods::getClassDef(classes[[1L]], where = getNamespace(package), inherits = FALSE)
      if (is.null(definition) || !identical(attr(definition, "package", exact = TRUE), package))
        stop("unproven-s4-class")
      environment_proof_package(proof, package)
    } else {
      # These standard representations have no hidden package-owned dispatch state.
      standard <- c("data.frame", "factor", "ordered", "AsIs", "matrix", "array",
        "table", "Date", "POSIXct", "POSIXlt", "POSIXt", "difftime", "numeric_version",
        "package_version", "R_system_version", "formula", "terms")
      if (!is.character(classes) || anyNA(classes) || !all(classes %in% standard))
        stop("unproven-s3-class")
      environment_proof_package(proof, if (any(classes %in% c("formula", "terms"))) "stats" else "base")
    }
  })
  finish_environment_proof <- function(proof, packages) {
    if (is.null(proof)) return(NULL)
    for (package in unique(c(names(proof$packages), packages))) environment_proof_package(proof, package)
    if (!isTRUE(proof$complete)) return(NULL)
    list(schema_version = 1L, packages = lapply(sort(names(proof$packages)), function(package)
      list(name = package, version = proof$packages[[package]])))
  }
  runtime_footprint <- function() tryCatch({
    # This is an observed candidate inventory, never proof of dependency completeness.
    packages <- loadedNamespaces()
    if (length(packages) == 0L || length(packages) > 4096L) return(NULL)
    proof <- finish_environment_proof(new_environment_proof(packages), packages)
    if (is.null(proof)) return(NULL)
    paths <- unique(vapply(getLoadedDLLs(), function(dll) dll[["path"]], character(1)))
    # R lists its built-in base routines as the pseudo-DLL path "base".
    paths <- paths[nzchar(paths) & paths != "base"]
    if (length(paths) > 4096L || any(nchar(paths, type = "bytes") > 4096L)) return(NULL)
    paths <- sort(unique(normalizePath(paths, winslash = "/", mustWork = TRUE)))
    list(process_id = Sys.getpid(), packages = proof$packages, library_paths = as.list(paths))
  }, error = function(e) NULL)
  package_context <- function(value, fresh_session) {
    if (is.null(value)) return(NULL)
    valid_names <- function(names) is.list(names) && length(names) > 0L && length(names) <= 4096L &&
      all(vapply(names, function(name) is.character(name) && length(name) == 1L &&
        !is.na(name) && grepl("^[A-Za-z][A-Za-z0-9.]{0,127}$", name), logical(1))) &&
      !anyDuplicated(unlist(names, use.names = FALSE))
    if (!is.list(value) || length(value) != 3L ||
        !setequal(names(value), c("schema_version", "source_packages", "target_packages")) ||
        !identical(value$schema_version, 1L) || !valid_names(value$source_packages) ||
        !valid_names(value$target_packages)) fail("invalid-package-context-projection")
    source <- unlist(value$source_packages, use.names = FALSE)
    target <- unlist(value$target_packages, use.names = FALSE)
    if (!isTRUE(fresh_session) || !identical(attached(), startup_packages))
      fail("package-context-projection-requires-fresh-session")
    if (!identical(target, startup_packages) ||
        !all(target %in% c("jsonlite", "stats", "graphics", "grDevices", "utils", "datasets", "methods", "base")))
      fail("unsupported-package-context-target")
    list(schema_version = 1L, source_packages = as.list(source), target_packages = as.list(target))
  }
  plan <- function(exprs, available_names = ls(globalenv(), all.names = TRUE)) {
    reads <- writes <- defined <- pending_calls <- option_writes <- character()
    packages <- character()
    environment_complete <- TRUE
    # The kernel prints visible values after evaluation even without a source print().
    # Visibility is not generally knowable before execution, so retain this finite
    # formatting contract for every cell, including its input before implicit print.
    option_names <- format_options
    declared_package <- FALSE
    nodes <- 0L
    blocked <- c("get", "get0", "mget", "dynGet", "eval", "evalq", "eval.parent",
      "parse", "source", "sys.source", "load", "attach", "detach", "assign", "delayedAssign",
      "makeActiveBinding", "do.call", "match.fun", "substitute", "bquote", "with", "within",
      "local", "environment", "globalenv", "parent.frame", "sys.frame", "sys.frames",
      "sys.function", "as.environment", "asNamespace", "getNamespace", "getFromNamespace",
      "new.env", "list2env", "rm", "remove", "function", "for", "while", "repeat", "if",
      "switch", "on.exit", "<<-", "->>", "call", "as.call", ".Internal", ".Call", ".External")
    read_name <- function(name) {
      if (name %in% c("", "...", ".GlobalEnv", ".BaseNamespaceEnv")) {
        if (nzchar(name)) fail("dynamic-object-dependency")
        return(invisible(NULL))
      }
      if (!name %in% defined && name %in% available_names)
        reads <<- union(reads, name)
    }
    root_name <- function(node) {
      if (is.symbol(node)) return(as.character(node))
      if (is.call(node) && is.symbol(node[[1L]]) &&
          as.character(node[[1L]]) %in% c("[", "[[", "$", "@")) return(root_name(node[[2L]]))
      # S4 replacement generics such as design(dds) <- ~ condition.
      if (is.call(node) && length(node) == 2L && is.symbol(node[[1L]]))
        return(root_name(node[[2L]]))
      fail("unsupported-assignment-target")
    }
    walk_argument <- function(node, depth) {
      # R arguments may be lazy, skipped, or forced out of source order. Their
      # writes remain possible outputs, but cannot define later reads for the caller.
      before <- defined
      walk(node, depth)
      defined <<- before
      invisible(NULL)
    }
    walk <- function(node, depth = 0L) {
      nodes <<- nodes + 1L
      if (nodes > 8192L || depth > 64L) fail("object-analysis-limit")
      if (is.symbol(node)) { read_name(as.character(node)); return(invisible(NULL)) }
      if (!is.call(node)) return(invisible(NULL))
      head <- node[[1L]]
      qualified <- is.call(head) && length(head) == 3L && is.symbol(head[[1L]]) &&
        as.character(head[[1L]]) %in% c("::", ":::")
      if (!is.symbol(head) && !qualified) fail("computed-function-dependency")
      op <- if (qualified) as.character(head[[3L]]) else as.character(head)
      if (op %in% blocked) fail(paste0("unsupported-object-dependency:", op))
      if (qualified && !call_allowed(as.character(head[[2L]]), op))
        fail("unsupported-package-call")
      if (qualified) packages <<- union(packages, as.character(head[[2L]]))
      if (op %in% c("<-", "=", "->")) {
        lhs <- if (op == "->") node[[3L]] else node[[2L]]
        rhs <- if (op == "->") node[[2L]] else node[[3L]]
        walk(rhs, depth + 1L) # RHS must see the old binding before the write is defined.
        name <- root_name(lhs)
        if (!is.symbol(lhs)) walk(lhs, depth + 1L)
        writes <<- union(writes, name)
        defined <<- union(defined, name)
        return(invisible(NULL))
      }
      if (op %in% c("::", ":::")) return(invisible(NULL))
      args <- as.list(node)[-1L]
      if (op == "packageVersion") {
        # utils::packageVersion(pkg, lib.loc = NULL) reads package metadata even
        # when it never loads a namespace or leaves an object in this checkpoint.
        # Match only exact formal names and ordinary positional arguments. Dynamic
        # targets, library overrides and abbreviations lose optional proof alone.
        arg_names <- names(args)
        if (is.null(arg_names)) arg_names <- rep("", length(args))
        exact_names <- c("pkg", "lib.loc")
        matched <- integer(2L)
        proven <- length(args) >= 1L && length(args) <= 2L &&
          all(arg_names %in% c("", exact_names)) && !anyDuplicated(arg_names[nzchar(arg_names)])
        if (proven) {
          for (index in which(nzchar(arg_names))) matched[match(arg_names[[index]], exact_names)] <- index
          positional <- which(!nzchar(arg_names))
          remaining <- which(matched == 0L)
          if (length(positional) > length(remaining)) proven <- FALSE else
            for (index in seq_along(positional)) matched[remaining[[index]]] <- positional[[index]]
          proven <- proven && matched[[1L]] != 0L
        }
        if (proven) {
          target <- args[[matched[[1L]]]]
          proven <- is.character(target) && length(target) == 1L && !is.na(target) && nzchar(target) &&
            (matched[[2L]] == 0L || is.null(args[[matched[[2L]]]]))
          if (proven) packages <<- union(packages, target)
        }
        environment_complete <<- environment_complete && proven
      }
      if (op == "getOption") {
        key <- if (!is.null(args$x)) args$x else if (length(args)) args[[1L]] else NULL
        if (!is.character(key) || length(key) != 1L || is.na(key) || !nzchar(key))
          fail("dynamic-option-dependency")
        option_names <<- union(option_names, key)
      }
      if (op == "options") {
        if (!length(args)) fail("dynamic-option-dependency")
        arg_names <- names(args)
        if (is.null(arg_names)) arg_names <- rep("", length(args))
        for (i in seq_along(args)) {
          if (nzchar(arg_names[[i]])) {
            option_names <<- union(option_names, arg_names[[i]])
            option_writes <<- union(option_writes, arg_names[[i]])
          }
          else if (is.character(args[[i]]) && length(args[[i]]) == 1L &&
              !is.na(args[[i]]) && nzchar(args[[i]])) option_names <<- union(option_names, args[[i]])
          else fail("dynamic-option-dependency")
        }
      }
      option_names <<- union(option_names, call_options(op, args))
      if (op %in% c("library", "require", "requireNamespace")) {
        if (length(args) == 0L || !(is.symbol(args[[1L]]) || is.character(args[[1L]])) ||
            (op == "requireNamespace" && is.symbol(args[[1L]])) ||
            (!is.null(args$character.only) && !identical(args$character.only, FALSE)))
          fail("dynamic-package-dependency")
        packages <<- union(packages, as.character(args[[1L]]))
        for (index in seq_along(args)) if (index > 1L) walk_argument(args[[index]], depth + 1L)
        if (op %in% c("library", "require")) declared_package <<- TRUE
        return(invisible(NULL))
      }
      if (!qualified) {
        # Even a possible argument write can replace the callee with a local alias
        # whose hidden global reads are unproven; must-definition is not needed here.
        if (op %in% writes || exists(op, globalenv(), inherits = FALSE))
          fail("user-function-dependency")
        locations <- call_locations(op)
        if (length(locations) == 0L) {
          if (!declared_package) fail("unresolved-function-dependency")
          # A preceding literal library may expose this binding. Confirm its package
          # owner after the real cell runs; never attach packages ahead of user code.
          pending_calls <<- union(pending_calls, op)
        } else if (!resolved_call_allowed(op)) fail("unsupported-package-call")
        if (length(locations)) packages <<- union(packages, sub("^package:", "", locations[[1L]]))
      }
      args <- as.list(node)[-1L]
      for (index in seq_along(args)) {
        if (identical(args[[index]], quote(expr = ))) next
        if (op %in% c("$", "@") && index == 2L) next
        # Formula symbols are data-mask variables, not global bindings. Embedded executable
        # formula calls are checked normally (and any global formula bindings are captured).
        if (op == "~" && is.symbol(args[[index]])) {
          read_name(as.character(args[[index]])); next
        }
        # Only grouping expressions guarantee evaluation in this source order.
        if (op %in% c("{", "(")) walk(args[[index]], depth + 1L)
        else walk_argument(args[[index]], depth + 1L)
      }
      invisible(NULL)
    }
    for (expr in exprs) walk(expr)
    list(reads = reads, writes = writes, pending_calls = pending_calls,
      option_names = sort(option_names), option_writes = sort(option_writes), packages = packages,
      environment_complete = environment_complete)
  }
  # Reviewed codecs retain the actual free data of DESeq2's generated dispersion
  # closures, not the unrelated fitting call frames (glm/locfit include promises).
  # Only snapshot copies are changed. Live objects and their statistical fit stay intact.
  parametric_dispersion <- function(q) coefs[1] + coefs[2]/q
  local_dispersion <- function(means) exp(predict(fit, data.frame(logMeans = log(means))))
  mean_dispersion <- function(means) meanDisp
  identity_transform <- function(x) x
  dispersion_kind <- function(value) {
    if (typeof(value) != "closure") return("")
    kind <- attr(value, "fitType", exact = TRUE)
    expected <- if (identical(kind, "parametric")) parametric_dispersion else
      if (identical(kind, "local")) local_dispersion else
      if (identical(kind, "mean")) mean_dispersion else NULL
    if (is.null(expected) || !identical(formals(value), formals(expected)) ||
        !identical(body(value), body(expected))) return("")
    env <- environment(value)
    if (!is.environment(env) || !isNamespace(parent.env(env)) ||
        !identical(as.character(getNamespaceName(parent.env(env))), "DESeq2")) return("")
    if (!identical(as.character(utils::packageVersion("DESeq2")), "1.50.2"))
      fail("unreviewed-dispersion-package-version")
    kind
  }
  plain_bindings <- function(env) {
    nms <- ls(env, all.names = TRUE)
    if (any(vapply(nms, bindingIsActive, logical(1), env = env))) fail("active-object-binding")
    if (!"rlang" %in% loadedNamespaces()) fail("unproven-object-binding")
    if (any(rlang::env_binding_are_lazy(env, nms))) fail("lazy-object-binding")
    nms
  }
  local_fit <- function(fit, env) {
    if (!identical(as.character(utils::packageVersion("locfit")), "1.5.9.12"))
      fail("unreviewed-dispersion-package-version")
    expected_names <- c("eva", "cell", "terms", "nvc", "box", "sty", "deriv", "mi", "dp",
      "trans", "critval", "vnames", "yname", "call", "frame")
    if (!is.list(fit) || !identical(class(fit), "locfit") ||
        !identical(names(fit), expected_names)) fail("unreviewed-local-dispersion-fit")
    # The default prediction path uses newdata$logMeans and no custom basis code.
    expected_call <- quote(locfit(formula = logDisps ~ logMeans,
      data = d[disps >= minDisp * 10, , drop = FALSE], weights = means[disps >= minDisp * 10]))
    terms <- fit$terms
    transform <- fit$trans
    if (!identical(fit$call, expected_call) || !identical(fit$frame, env) ||
        !inherits(terms, "terms") || !identical(unclass(terms)[[1L]], as.name("~")) ||
        !identical(terms[[2L]], as.name("logDisps")) || !identical(terms[[3L]], as.name("logMeans")) ||
        !identical(attr(terms, ".Environment", exact = TRUE), env) ||
        !identical(fit$vnames, "logMeans") || !identical(fit$yname, "logDisps") ||
        typeof(transform) != "closure" || !identical(formals(transform), formals(identity_transform)) ||
        !identical(body(transform), body(identity_transform)) || !is.null(attributes(transform)))
      fail("unreviewed-local-dispersion-fit")
    invisible(NULL)
  }
  dispersion_projection <- new.env(parent = emptyenv())
  dispersion_projection$entries <- list()
  project_dispersion <- function(value) {
    kind <- dispersion_kind(value)
    if (!nzchar(kind)) {
      # body<- drops fitType and other attributes. Admission therefore matches the
      # official slot implementations themselves; missing metadata cannot bypass it.
      unfit <- typeof(value) == "closure" && identical(environment(value), globalenv()) &&
        is.null(formals(value)) && is.null(body(value)) && is.null(attributes(value))
      if (unfit) return(value)
      fail("unreviewed-dispersion-closure")
    }
    source <- environment(value)
    nms <- plain_bindings(source)
    if (kind == "mean") {
      if (!"meanDisp" %in% nms) fail("unreviewed-dispersion-frame")
      data <- get("meanDisp", source, inherits = FALSE)
      if (!is.double(data) || length(data) != 1L || !is.null(attributes(data)) ||
          !is.finite(data) || data <= 0) fail("unreviewed-mean-dispersion-fit")
      return(value) # preserve the previously supported official mean graph
    }
    needed <- if (kind == "parametric") "coefs" else "fit"
    original_names <- if (kind == "parametric")
      c("ans", "coefs", "disps", "fit", "good", "iter", "means", "oldcoefs", "residuals") else
      c("d", "dispFunction", "disps", "fit", "means", "minDisp")
    if (!identical(nms, sort(original_names)) && !identical(nms, needed))
      fail("unreviewed-dispersion-frame")
    data <- get(needed, source, inherits = FALSE)
    if (kind == "parametric" && (!is.double(data) || length(data) != 2L ||
        !identical(names(data), c("asymptDisp", "extraPois")) || any(!is.finite(data) | data <= 0)))
      fail("unreviewed-parametric-dispersion-fit")
    if (kind == "local") local_fit(data, source)
    if (identical(nms, needed)) {
      validate(list(value), allow_namespace_functions = TRUE)
      return(value) # restored/canonical frames already own their reference identity
    }
    # Weak keys preserve live alias identity without retaining obsolete glm/locfit
    # frames. Canonical environments remain owned by the existing reference frontier.
    entries <- Filter(function(entry) !is.null(rlang::wref_key(entry$reference)),
      dispersion_projection$entries)
    dispersion_projection$entries <- entries
    index <- which(vapply(entries, function(entry)
      identical(rlang::wref_key(entry$reference), source), logical(1)))
    fresh <- !length(index)
    target <- new.env(parent = parent.env(source))
    if (kind == "local") {
      environment(data$trans) <- emptyenv() # exact function(x) x has no free bindings
      attr(data$terms, ".Environment") <- target
      data$frame <- target
    }
    assign(needed, data, target)
    result <- value
    environment(result) <- target
    # Validate a candidate before replacing a cached frontier: failure cannot corrupt
    # an existing alias. Every retained free value is checked before serialization.
    validate(list(result), allow_namespace_functions = TRUE)
    bytes <- unclass(utils::object.size(data))
    retained_bytes <- sum(vapply(entries, function(entry) entry$bytes, numeric(1)))
    previous_bytes <- if (fresh) 0 else entries[[index[[1L]]]]$bytes
    if (length(entries) + as.integer(fresh) > 1024L ||
        retained_bytes - previous_bytes + bytes > snapshot_budget_bytes)
      fail("object-reference-budget")
    if (!fresh) {
      target <- rlang::wref_value(entries[[index[[1L]]]]$reference)
      if (kind == "local") {
        attr(data$terms, ".Environment") <- target
        data$frame <- target
      }
      assign(needed, data, target)
      environment(result) <- target
      dispersion_projection$entries[[index[[1L]]]]$bytes <- bytes
    } else {
      dispersion_projection$entries[[length(entries) + 1L]] <-
        list(reference = rlang::new_weakref(source, target), bytes = bytes)
    }
    result
  }
  # Native size estimation does not dispatch methods, force bindings, or follow
  # closure frames. Check before container reconstruction; retained private frames
  # are still charged by validate() after the reviewed DESeq projection.
  object_bytes <- function(value, remaining) {
    if (!is.object(value) && is.atomic(value)) {
      width <- switch(typeof(value), raw = 1, logical = 4, integer = 4, double = 8,
        complex = 16, character = 8, 0)
      if (length(value) * width > remaining) fail("object-byte-budget")
    }
    bytes <- unclass(utils::object.size(value))
    if (!is.finite(bytes) || bytes > remaining) fail("object-byte-budget")
    bytes
  }
  project_values <- function(values) {
    object_bytes(values, snapshot_budget_bytes)
    nodes <- 0L
    walk <- function(value, depth = 0L) {
      nodes <<- nodes + 1L
      if (nodes > 100000L || depth > 128L) fail("object-graph-limit")
      if (isS4(value) && identical(as.character(class(value)), "DESeqDataSet")) {
        attrs <- attributes(value)
        attrs$dispersionFunction <- project_dispersion(attrs$dispersionFunction)
        attributes(value) <- attrs
      } else if (is.list(value) && !isS4(value)) {
        attrs <- attributes(value)
        pair <- is.pairlist(value)
        parts <- if (is.object(value)) unclass(value) else value
        if (pair) parts <- base::as.list.default(parts)
        for (index in seq_along(parts)) {
          # Missing formals are language values, not arguments to force. Single
          # bracket replacement also preserves NULL elements instead of deleting them.
          if (!identical(parts[[index]], quote(expr = )))
            parts[index] <- list(walk(parts[[index]], depth + 1L))
        }
        value <- if (pair) as.pairlist(parts) else parts
        attributes(value) <- attrs
      }
      value
    }
    walk(values)
  }
  validate <- function(values, allow_namespace_functions = FALSE, max_bytes = snapshot_budget_bytes,
      environment_proof = NULL) {
    # Call the utils native size implementation directly: object.size is not an S3
    # generic. It does not walk closure environments, which are charged separately.
    # Check before unclass/as.list and before all serialization/normalization copies.
    bytes <- 0
    charge <- function(value) {
      bytes <<- bytes + object_bytes(value, max_bytes - bytes)
    }
    # Native estimation of the root graph does not follow environments or force their
    # bindings. Per-node lower bounds below also cover expanded atomic payloads.
    charge(values)
    visited <- 0L
    environments <- list()
    s4_values <- list()
    proof_atomics <- list()
    reviewed_environments <- list()
    check_env <- function(env, depth) {
      if (isNamespace(env)) environment_proof_package(environment_proof, getNamespaceName(env))
      if (isNamespace(env) || identical(env, baseenv()) || identical(env, emptyenv())) return()
      if (identical(env, globalenv())) fail("global-closure-environment")
      if (startsWith(environmentName(env), "package:")) fail("attached-closure-environment")
      if (any(vapply(environments, identical, logical(1), y = env))) return()
      environments[[length(environments) + 1L]] <<- env
      env_names <- ls(env, all.names = TRUE)
      if (length(env_names) > 100000L) fail("object-graph-limit")
      if (any(vapply(env_names, bindingIsActive, logical(1), env = env))) fail("active-object-binding")
      if (length(env_names)) {
        # Do not load a namespace as an observer side effect. DESeq2 already loads
        # rlang; without its non-forcing native binding query this graph is unproven.
        if (!"rlang" %in% loadedNamespaces()) fail("unproven-object-binding")
        environment_proof_package(environment_proof, "rlang")
        if (any(rlang::env_binding_are_lazy(env, env_names))) fail("lazy-object-binding")
      }
      for (name in env_names) {
        member <- get(name, env, inherits = FALSE)
        charge(member)
        check(member, depth + 1L, TRUE)
      }
      check_env(parent.env(env), depth + 1L)
    }
    simple_design <- function(formula, columns) {
      term <- function(node) {
        if (is.symbol(node)) return(as.character(node) %in% columns)
        if (is.numeric(node)) return(length(node) == 1L && node %in% c(0, 1))
        is.call(node) && length(node) == 3L && identical(node[[1L]], as.name("+")) &&
          term(node[[2L]]) && term(node[[3L]])
      }
      is.call(formula) && length(formula) == 2L && identical(formula[[1L]], as.name("~")) &&
        term(formula[[2L]])
    }
    check <- function(value, depth = 0L, s4_member = FALSE, design_columns = NULL) {
      visited <<- visited + 1L
      if (depth > 128L || visited > 100000L) fail("object-graph-limit")
      if (isS4(value)) {
        if (any(vapply(s4_values, identical, logical(1), y = value))) return(invisible(NULL))
        s4_values[[length(s4_values) + 1L]] <<- value
      }
      type <- typeof(value)
      environment_proof_class(environment_proof, value)
      if (!is.null(environment_proof) && isTRUE(environment_proof$complete) &&
          is.atomic(value) && !is.null(value))
        proof_atomics[[length(proof_atomics) + 1L]] <<- value
      if (!is.object(value) && is.atomic(value)) {
        width <- switch(type, raw = 1, logical = 4, integer = 4, double = 8, complex = 16, character = 8, 0)
        if (length(value) * width > max_bytes) fail("object-byte-budget")
      }
      if (type == "environment" && any(vapply(reviewed_environments, identical, logical(1), y = value))) {
        check_env(value, depth + 1L)
        return(invisible(NULL))
      }
      if (inherits(value, "connection") || type %in% c("externalptr", "weakref", "environment"))
        fail("unsupported-object-reference")
      if (is.function(value)) {
        # DESeqDataSet stores a dispersion function with a private, namespace-rooted data
        # environment. Top-level/user GlobalEnv closures remain unsupported.
        if (!s4_member && !allow_namespace_functions) fail("unsupported-object-closure")
        # DESeqDataSet's official unfit prototype contains function() NULL with a
        # GlobalEnv special reference. It reads no bindings: no parameters/defaults,
        # executable body, or attributes. Preserve this exact sentinel in the one
        # serialized graph; every other GlobalEnv closure still fails closed.
        constant_s4_sentinel <- s4_member && type == "closure" &&
          identical(environment(value), globalenv()) && is.null(formals(value)) && is.null(body(value)) && is.null(attributes(value))
        kind <- dispersion_kind(value)
        if (kind %in% c("parametric", "local")) {
          env <- environment(value)
          needed <- if (kind == "parametric") "coefs" else "fit"
          if (!identical(plain_bindings(env), needed)) fail("unreviewed-dispersion-frame")
          if (kind == "local") local_fit(get("fit", env, inherits = FALSE), env)
          reviewed_environments[[length(reviewed_environments) + 1L]] <<- env
        }
        if (type == "closure" && !constant_s4_sentinel) check_env(environment(value), depth + 1L)
        if (type == "closure") {
          check(formals(value), depth + 1L, s4_member)
          check(body(value), depth + 1L, s4_member)
        }
        function_attrs <- attributes(value)
        for (name in names(function_attrs)) check(function_attrs[[name]], depth + 1L, s4_member)
        return(invisible(NULL))
      }
      formula <- inherits(value, "formula")
      if (!isS4(value) && (is.list(value) || is.pairlist(value) || is.expression(value) || is.call(value))) {
        # S3 list classes (notably package_version in Bioconductor metadata) can make
        # as.list()/[[ return another object of the same class. Inspect the stored data,
        # never invoke user/package extraction methods while validating its graph.
        parts <- as.list(if (is.object(value)) unclass(value) else value)
        for (i in seq_along(parts)) {
          if (!identical(parts[[i]], quote(expr = ))) check(parts[[i]], depth + 1L, s4_member)
        }
      }
      attrs <- attributes(value)
      if (!is.null(attrs)) for (name in names(attrs)) {
        if (formula && name == ".Environment") {
          env <- attrs[[name]]
          if (isNamespace(env)) environment_proof_package(environment_proof, getNamespaceName(env))
          if (!identical(env, globalenv()) && !identical(env, baseenv()) && !isNamespace(env) &&
              !any(vapply(reviewed_environments, identical, logical(1), y = env)))
            fail("unsupported-formula-environment")
          # GlobalEnv itself is an R serialization special reference, not serialized state.
          # Only simple design formulas are safe without a hidden lexical closure.
          symbols <- all.names(value, functions = FALSE, unique = TRUE)
          proven_design <- !is.null(design_columns) && simple_design(value, design_columns)
          if (!is.null(design_columns) && !proven_design) fail("unsupported-design-formula")
          if (identical(env, globalenv()) && !proven_design && any(vapply(symbols, exists, logical(1),
              envir = globalenv(), inherits = FALSE))) fail("formula-global-dependency")
        } else {
          columns <- NULL
          if (isS4(value) && identical(as.character(class(value)), "DESeqDataSet") && name == "design") {
            col_data <- attrs[["colData"]]
            column_values <- if (isS4(col_data)) attr(col_data, "listData", exact = TRUE) else NULL
            if (is.list(column_values)) columns <- names(column_values)
            if (is.null(columns)) fail("unsupported-design-data-mask")
          }
          check(attrs[[name]], depth + 1L, s4_member || isS4(value), design_columns = columns)
        }
      }
      invisible(NULL)
    }
    check(values)
    # An atomic value can hide an environment/closure in its attributes. Do not
    # serialize any candidate until the entire original graph and private closure
    # budget have passed admission; invalid graphs must incur no new serialization.
    for (value in proof_atomics) environment_proof_atomic(environment_proof, value)
    invisible(NULL)
  }
  # R preserves environment identity inside one serialization, not across snapshots.
  # Keep original identities separate from replay anchors; neither uses value equality.
  reference_proof <- "private-environment-identity-v1"
  capture_refs <- new.env(parent = emptyenv())
  capture_refs$values <- list()
  capture_refs$ids <- character()
  capture_refs$bytes <- 0
  capture_refs$next_id <- 0
  capture_refs$pending <- NULL
  capture_refs$session <- paste0(Sys.getpid(), "-", format(Sys.time(), "%Y%m%d%H%M%OS6", tz = "UTC"))
  rollback_capture_references <- function(mark) {
    if (is.null(mark)) return(invisible(NULL))
    # A failed capture owns only its appended references. Published historical
    # identities remain valid, and allocated IDs must never be reused.
    retained <- seq_len(mark$count)
    capture_refs$values <- capture_refs$values[retained]
    capture_refs$ids <- capture_refs$ids[retained]
    capture_refs$bytes <- mark$bytes
    capture_refs$pending <- NULL
    invisible(NULL)
  }
  replay_refs <- new.env(parent = emptyenv())
  reset_references <- function() {
    replay_refs$values <- list()
    replay_refs$ids <- character()
    replay_refs$bytes <- 0
    replay_refs$ready <- FALSE
  }
  reset_references()
  reference_index <- function(values, value) {
    found <- which(vapply(values, identical, logical(1), y = value))
    if (length(found)) found[[1L]] else 0L
  }
  private_reference <- function(value) is.environment(value) &&
    !identical(value, globalenv()) && !identical(value, baseenv()) &&
    !identical(value, emptyenv()) && !isNamespace(value) &&
    !startsWith(environmentName(value), "package:")
  collect_references <- function(graph, skip = list()) {
    values <- list()
    raw <- serialize(graph, NULL, version = 3L, refhook = function(value) {
      if (private_reference(value)) {
        if (reference_index(skip, value)) return("anchored-reference")
        if (!reference_index(values, value)) {
          if (length(values) >= 1024L) fail("object-reference-budget")
          values[[length(values) + 1L]] <<- value
        }
      }
      NULL
    })
    if (length(raw) > snapshot_budget_bytes) fail("object-byte-budget")
    list(values = values, bytes = length(raw))
  }
  validate_reference_proof <- function(value) {
    validate(value)
    check_option_data(value)
    if (!is.list(value) || !identical(names(value), c("proof", "ids")) ||
        !identical(value$proof, reference_proof) || !is.character(value$ids) ||
        !is.null(attributes(value$ids)) || length(value$ids) > 1024L ||
        anyNA(value$ids) || anyDuplicated(value$ids) ||
        any(!nzchar(value$ids) | nchar(value$ids, type = "bytes") > 128L))
      fail("invalid-object-reference-proof")
  }
  capture_reference_proof <- function(graph) {
    found <- collect_references(graph)
    ids <- character()
    fresh <- list()
    for (value in found$values) {
      index <- reference_index(capture_refs$values, value)
      if (index) ids <- c(ids, capture_refs$ids[[index]]) else {
        capture_refs$next_id <- capture_refs$next_id + 1
        ids <- c(ids, paste0(capture_refs$session, ":", capture_refs$next_id))
        fresh[[length(fresh) + 1L]] <- value
      }
    }
    if (length(fresh)) {
      # Charge the entire bounded graph for every retained batch: conservative even
      # when the new environments share descendants with previously retained ones.
      # This is an admission budget, not a heap limit for later user mutations.
      if (length(capture_refs$values) + length(fresh) > 1024L ||
          capture_refs$bytes + found$bytes > snapshot_budget_bytes) fail("object-reference-budget")
      capture_refs$values <- c(capture_refs$values, fresh)
      capture_refs$ids <- c(capture_refs$ids, setdiff(ids, capture_refs$ids))
      capture_refs$bytes <- capture_refs$bytes + found$bytes
    }
    list(proof = reference_proof, ids = ids)
  }
  anchor_references <- function(ids, values, bytes) {
    if (length(ids) != length(values)) fail("object-reference-topology-mismatch")
    fresh <- integer()
    for (i in seq_along(ids)) {
      index <- match(ids[[i]], replay_refs$ids, nomatch = 0L)
      reverse <- reference_index(replay_refs$values, values[[i]])
      if (index && !identical(replay_refs$values[[index]], values[[i]]) ||
          reverse && !identical(replay_refs$ids[[reverse]], ids[[i]]))
        fail("object-reference-identity-conflict")
      if (!index) fresh <- c(fresh, i)
    }
    if (length(fresh)) {
      if (length(replay_refs$values) + length(fresh) > 1024L ||
          replay_refs$bytes + bytes > snapshot_budget_bytes) fail("object-reference-budget")
      replay_refs$values <- c(replay_refs$values, values[fresh])
      replay_refs$ids <- c(replay_refs$ids, ids[fresh])
      replay_refs$bytes <- replay_refs$bytes + bytes
    }
  }
  supplement_bindings <- function(input, only) {
    if (!isTRUE(replay_refs$ready)) fail("missing-object-reference-frontier")
    existing <- setdiff(names(input$bindings), only)
    expected <- collect_references(input$bindings[existing])$values
    current_values <- bindings(existing)
    validate(current_values)
    current <- collect_references(current_values)$values
    if (length(expected) != length(current)) fail("object-reference-topology-mismatch")
    for (i in seq_along(expected)) {
      index <- reference_index(input$reference_values, expected[[i]])
      id <- input$references$ids[[index]]
      anchor <- match(id, replay_refs$ids, nomatch = 0L)
      if (!anchor) fail("unanchored-object-reference")
      if (!identical(replay_refs$values[[anchor]], current[[i]])) fail("object-reference-identity-conflict")
    }
    fresh_ids <- character()
    raw <- serialize(input$bindings[only], NULL, version = 3L, refhook = function(value) {
      if (!private_reference(value)) return(NULL)
      index <- reference_index(input$reference_values, value)
      if (!index) fail("unproven-object-reference")
      id <- input$references$ids[[index]]
      if (id %in% replay_refs$ids) return(id)
      fresh_ids <<- union(fresh_ids, id)
      NULL
    })
    if (length(raw) > snapshot_budget_bytes) fail("object-byte-budget")
    result <- unserialize(raw, refhook = function(id) {
      if (!is.character(id) || length(id) != 1L || !id %in% replay_refs$ids)
        fail("unproven-object-reference")
      replay_refs$values[[match(id, replay_refs$ids)]]
    })
    fresh <- collect_references(result, skip = replay_refs$values)
    anchor_references(fresh_ids, fresh$values, fresh$bytes)
    result
  }
  bindings <- function(names) {
    values <- vector("list", length(names))
    names(values) <- names
    for (name in names) {
      if (!exists(name, globalenv(), inherits = FALSE)) fail("missing-object-binding")
      if (bindingIsActive(name, globalenv())) fail("active-object-binding")
      if (name %in% namespace_state$lazy_names) fail("lazy-object-binding")
      values[[name]] <- list(get(name, globalenv(), inherits = FALSE))
    }
    # Preserve NULL-valued bindings (list[[name]] <- NULL would delete the binding).
    project_values(lapply(values, `[[`, 1L))
  }
  save <- function(path, values, packages, last_value = NULL, option_names = character(), option_writes = character(),
      environment_proof = NULL) {
    last_value <- project_values(last_value)
    validate(list(values, last_value), environment_proof = environment_proof)
    random <- capture_rng()
    if (!identical(random$state, "available")) fail("unsupported-checkpoint-random-state")
    context_options <- snapshot_options(option_names)
    envelope <- list(schema = 2L, bindings = values, packages = packages, last_value = last_value,
      references = capture_reference_proof(list(values, last_value)),
      random = random, options = context_options, option_names = option_names,
      option_writes = option_writes, palette = grDevices::palette())
    validate(envelope, allow_namespace_functions = TRUE)
    saveRDS(envelope, path, version = 3L)
    context_options
  }
  output_snapshot <- function(values, last_value, option_names = character(),
      input_options = snapshot_options(option_names), option_writes = character(), record_references = TRUE,
      environment_proof = NULL) {
    last_value <- project_values(last_value)
    validate(list(values, last_value), environment_proof = environment_proof)
    random <- capture_rng()
    if (!identical(random$state, "available")) fail("unsupported-checkpoint-random-state")
    # Expected output must never deserialize package objects/functions into the replay
    # process. Freeze the complete comparable graph once, then store it as opaque bytes.
    graph <- list(values, last_value, snapshot_options(option_names), grDevices::palette(), random)
    validate(graph, allow_namespace_functions = TRUE)
    serialized <- serialize(graph, NULL, version = 3L)
    if (length(serialized) > snapshot_budget_bytes) fail("object-byte-budget")
    # R's first serialization of runtime objects can differ from its serialized-restored
    # representation (e.g. utils' default str callback). Apply the same one-graph
    # roundtrip to original and replay snapshots; all namespaces referenced by this
    # actual graph are already loaded, unlike those in expected output from a later state.
    canonical <- serialize(unserialize(serialized), NULL, version = 3L)
    if (length(canonical) > snapshot_budget_bytes) fail("object-byte-budget")
    validate_options(input_options)
    envelope <- list(schema = 3L, context_proof = context_proof, comparison = canonical,
      references = if (record_references) capture_reference_proof(list(values, last_value)) else
        list(proof = reference_proof, ids = character()),
      input_options = input_options, option_names = option_names, option_writes = option_writes,
      packages = attached(), output_names = as.character(names(values)))
    validate(envelope)
    envelope
  }
  expected_path <- function(path) {
    if (!scalar_path(path) || !file.exists(path) || file.access(path, 4L) != 0L)
      fail("invalid-expected-output-path")
    path
  }
  load_expected <- function(path) {
    value <- readRDS(path)
    if (!is.list(value) || !identical(value$schema, 3L) ||
        !identical(value$context_proof, context_proof) || !is.raw(value$comparison) ||
        length(value$comparison) == 0L || !is.character(value$packages) ||
        !is.character(value$output_names) || anyDuplicated(value$output_names))
      fail("unsupported-expected-output-format")
    validate_reference_proof(value$references)
    validate_options(value$input_options)
    if (!is.character(value$option_names) || !is.character(value$option_writes) ||
        !identical(as.character(names(value$input_options$values)), value$option_names) ||
        !all(value$option_writes %in% value$option_names)) fail("invalid-checkpoint-option-plan")
    value
  }
  check_option_plan <- function(value, selection) {
    if (!identical(value$option_names, selection$option_names) ||
        !identical(value$option_writes, selection$option_writes)) fail("checkpoint-option-plan-mismatch")
  }
  supplement_options <- function(expected, selection) {
    if (!isTRUE(option_frontier$ready)) fail("missing-option-frontier")
    check_option_plan(expected, selection)
    missing <- setdiff(selection$option_names, option_frontier$owned)
    apply_options(expected$input_options, missing)
    option_frontier$owned <- union(option_frontier$owned, missing)
  }
  load <- function(path) {
    if (!scalar_path(path)) fail("invalid-checkpoint-path")
    value <- readRDS(path)
    if (!is.list(value) || !identical(value$schema, 2L) || !is.list(value$bindings) ||
        !is.character(value$packages) || is.null(names(value$bindings)) && length(value$bindings) > 0L ||
        anyDuplicated(names(value$bindings))) fail("invalid-checkpoint-envelope")
    validate_reference_proof(value$references)
    validate(list(value$bindings, value$last_value))
    found <- collect_references(list(value$bindings, value$last_value))
    if (length(found$values) != length(value$references$ids)) fail("object-reference-topology-mismatch")
    value$reference_values <- found$values
    value$reference_bytes <- found$bytes
    validate_options(value$options)
    if (!is.character(value$option_names) || !is.character(value$option_writes) ||
        !identical(as.character(names(value$options$values)), value$option_names) ||
        !all(value$option_writes %in% value$option_names) ||
        !is.character(value$palette) || length(value$palette) < 2L) fail("invalid-checkpoint-context")
    random <- value$random
    if (!is.list(random) || !identical(random$state, "available") ||
        length(random$kinds) != 3L || !all(vapply(random$kinds, is.character, logical(1))) ||
        length(random$seed) > 1024L || length(random$seed) == 0L ||
        !all(vapply(random$seed, function(x) is.numeric(x) && length(x) == 1L &&
          is.finite(x) && x == as.integer(x), logical(1)))) fail("invalid-checkpoint-random-state")
    value
  }
  begin <- function(req, exprs, ignored_devices = integer(), fresh_session = FALSE) {
    # Cancellation during output harvesting can skip finish entirely. Recover
    # that unfinished capture before any operation, including ordinary requests.
    rollback_capture_references(capture_refs$pending)
    capture <- req$stage_checkpoint
    restore <- req$stage_restore
    compare_path <- req$stage_expected_output_path
    supplement <- req$stage_supplement
    if (is.null(capture) && is.null(restore) && is.null(compare_path) && is.null(supplement)) {
      option_frontier$ready <- FALSE
      option_frontier$owned <- character()
      reset_references()
      return(NULL)
    }
    if (!is.null(restore) || !is.null(capture)) {
      reset_references()
      option_frontier$ready <- FALSE
      option_frontier$owned <- character()
    }
    reference_mark <- if (!is.null(capture))
      list(count = length(capture_refs$values), bytes = capture_refs$bytes) else NULL
    capture_refs$pending <- reference_mark
    reference_transferred <- FALSE
    on.exit({
      if (!reference_transferred) rollback_capture_references(reference_mark)
    }, add = TRUE)
    tryCatch({
      if (sum(!vapply(list(capture, restore, compare_path, supplement), is.null, logical(1))) != 1L)
        fail("conflicting-checkpoint-operations")
      check_devices(ignored_devices)
      check_global_methods()
      if (!is.null(capture)) {
        if (!scalar_path(capture$input_path) || !scalar_path(capture$output_path) ||
            identical(capture$input_path, capture$output_path)) fail("invalid-checkpoint-path")
        selection <- plan(exprs)
        inputs <- bindings(selection$reads)
        environment_proof <- new_environment_proof(c(attached(), selection$packages), selection$environment_complete)
        input_options <- save(capture$input_path, inputs, attached(), option_names = selection$option_names,
          option_writes = selection$option_writes, environment_proof = environment_proof)
        state <- list(state = "capturing", reference_mark = reference_mark,
          environment_proof = environment_proof,
          selection = selection, input_options = input_options, output_path = capture$output_path,
          input_names = selection$reads, before_names = ls(globalenv(), all.names = TRUE))
        reference_transferred <- TRUE
        state
      } else if (!is.null(supplement)) {
        input <- load(supplement$input_path)
        comparison_path <- expected_path(supplement$expected_output_path)
        if (!is.list(supplement$names) || length(supplement$names) == 0L ||
            !all(vapply(supplement$names, function(name) is.character(name) && length(name) == 1L &&
              !is.na(name) && nzchar(name), logical(1)))) fail("invalid-supplement-names")
        names <- unlist(supplement$names, use.names = FALSE)
        if (anyDuplicated(names)) fail("invalid-supplement-names")
        if (!all(names %in% names(input$bindings))) fail("unknown-supplement-binding")
        if (any(vapply(names, exists, logical(1), envir = globalenv(), inherits = FALSE)))
          fail("existing-supplement-binding")
        selection <- plan(exprs, union(names, ls(globalenv(), all.names = TRUE)))
        if (!identical(sort(selection$reads), sort(names(input$bindings))))
          fail("supplement-input-set-mismatch")
        check_option_plan(input, selection)
        expected <- load_expected(comparison_path)
        supplement_options(expected, selection)
        # Resolve anchored references to current environments before adding missing roots.
        # No binding or content of an existing current object is restored from input.
        additions <- supplement_bindings(input, names)
        list2env(additions, envir = globalenv())
        list(state = "restoring", expected_path = comparison_path, selection = selection,
          input_names = names(input$bindings), before_names = ls(globalenv(), all.names = TRUE))
      } else if (!is.null(compare_path)) {
        comparison_path <- expected_path(compare_path)
        selection <- plan(exprs)
        expected <- load_expected(comparison_path)
        supplement_options(expected, selection)
        list(state = "restoring", expected_path = comparison_path, selection = selection,
          input_names = selection$reads, before_names = ls(globalenv(), all.names = TRUE))
      } else {
        # Load only the input before user code. Expected output bytes are host-verified;
        # deserializing their objects here would preload namespaces and change .onLoad order.
        projection <- package_context(restore$package_context, fresh_session)
        input <- load(restore$input_path)
        if (!is.null(projection) &&
            (!identical(input$packages, unlist(projection$source_packages, use.names = FALSE)) ||
              length(input$bindings) != 0L)) fail("package-context-source-mismatch")
        comparison_path <- expected_path(restore$expected_output_path)
        current <- attached()
        required_packages <- if (is.null(projection)) input$packages else
          unlist(projection$target_packages, use.names = FALSE)
        missing <- setdiff(required_packages, current)
        for (package in rev(missing)) suppressPackageStartupMessages(
          library(package, character.only = TRUE, quietly = TRUE, warn.conflicts = FALSE))
        if (!identical(attached(), required_packages)) fail("package-attach-order-mismatch")
        for (name in names(input$bindings)) {
          if (exists(name, globalenv(), inherits = FALSE) &&
              (bindingIsActive(name, globalenv()) || bindingIsLocked(name, globalenv())))
            fail("nonreplaceable-object-binding")
        }
        selection <- plan(exprs, union(names(input$bindings), ls(globalenv(), all.names = TRUE)))
        if (!identical(sort(selection$reads), sort(names(input$bindings))))
          fail("checkpoint-input-set-mismatch")
        check_option_plan(input, selection)
        expected <- load_expected(comparison_path)
        if (!is.null(projection) &&
            !identical(expected$packages, unlist(projection$source_packages, use.names = FALSE)))
          fail("package-context-expected-source-mismatch")
        check_option_plan(expected, selection)
        anchor_references(input$references$ids, input$reference_values, input$reference_bytes)
        replay_refs$ready <- TRUE
        list2env(input$bindings, envir = globalenv())
        if (bindingIsActive(".Random.seed", globalenv()) || bindingIsLocked(".Random.seed", globalenv()))
          fail("nonreplaceable-random-state")
        do.call(RNGkind, input$random$kinds)
        assign(".Random.seed", as.integer(unlist(input$random$seed)), envir = globalenv())
        apply_options(input$options)
        grDevices::palette(input$palette)
        option_frontier$ready <- TRUE
        option_frontier$owned <- selection$option_names
        list(state = "restoring", expected_path = comparison_path, selection = selection,
          package_context = projection, observe_runtime_footprint = isTRUE(restore$observe_runtime_footprint),
          input_names = names(input$bindings), before_names = ls(globalenv(), all.names = TRUE))
      }
    }, error = function(e) {
      option_frontier$ready <- FALSE
      option_frontier$owned <- character()
      reset_references()
      result <- unavailable(conditionMessage(e))
      if (!is.null(restore) || !is.null(compare_path) || !is.null(supplement)) result$restore <- TRUE
      result
    })
  }
  finish <- function(state, error, ignored_devices = integer(), last_value = NULL) {
    if (is.null(state)) {
      if (!is.null(error)) {
        option_frontier$ready <- FALSE
        option_frontier$owned <- character()
        reset_references()
      }
      return(list())
    }
    if (identical(state$state, "unavailable")) {
      option_frontier$ready <- FALSE
      option_frontier$owned <- character()
      reset_references()
      if (isTRUE(state$restore)) return(list(stage_comparison = list(outcome = "unavailable", reason = state$reason)))
      return(list(stage_checkpoint = state))
    }
    reference_committed <- FALSE
    on.exit({
      if (state$state == "capturing") {
        if (!reference_committed) rollback_capture_references(state$reference_mark)
        capture_refs$pending <- NULL
      }
    }, add = TRUE)
    tryCatch({
      if (!is.null(error)) fail("cell-execution-failed")
      check_devices(ignored_devices)
      check_global_methods()
      for (op in state$selection$pending_calls) {
        locations <- call_locations(op)
        if (!resolved_call_allowed(op)) fail("unresolved-function-dependency")
        environment_proof_package(state$environment_proof, sub("^package:", "", locations[[1L]]))
      }
      names <- sort(unique(c(state$selection$writes, state$input_names,
        setdiff(ls(globalenv(), all.names = TRUE), state$before_names))))
      values <- bindings(names)
      last_value <- project_values(last_value)
      validate(values)
      if (state$state == "restoring") option_frontier$owned <- union(option_frontier$owned, state$selection$option_writes)
      if (state$state == "capturing") {
        saveRDS(output_snapshot(values, last_value, state$selection$option_names,
          input_options = state$input_options, option_writes = state$selection$option_writes,
          environment_proof = state$environment_proof), state$output_path, version = 3L)
        reference_committed <- TRUE
        checkpoint <- list(state = "available", input_names = as.list(state$input_names),
          output_names = as.list(names))
        proof <- finish_environment_proof(state$environment_proof, attached())
        if (!is.null(proof)) checkpoint$environment_proof <- proof
        list(stage_checkpoint = checkpoint)
      } else {
        # The expected envelope contains only raw comparison bytes and proven base-data
        # option inputs. Never deserialize its comparison graph or restore its RNG/palette;
        # current state remains owned by the preceding selected steps.
        actual <- output_snapshot(values, last_value, state$selection$option_names,
          option_writes = state$selection$option_writes, record_references = FALSE)
        expected <- load_expected(state$expected_path)
        scientific_equal <- identical(actual$comparison, expected$comparison) &&
          identical(actual$output_names, expected$output_names)
        expected_packages <- if (is.null(state$package_context)) expected$packages else
          unlist(state$package_context$target_packages, use.names = FALSE)
        if (!is.null(state$package_context) &&
            !identical(expected$packages, unlist(state$package_context$source_packages, use.names = FALSE)))
          fail("package-context-expected-source-mismatch")
        equal <- scientific_equal && identical(actual$packages, expected_packages)
        if (equal) {
          found <- collect_references(list(values, last_value))
          anchor_references(expected$references$ids, found$values, found$bytes)
        }
        comparison <- list(outcome = if (equal) "equal" else "different")
        if (!is.null(state$package_context)) {
          comparison$scientific_outcome <- if (scientific_equal) "equal" else "different"
          comparison$package_context <- state$package_context
        }
        if (isTRUE(state$observe_runtime_footprint)) {
          footprint <- runtime_footprint()
          if (!is.null(footprint)) comparison$runtime_footprint <- footprint
        }
        list(stage_comparison = comparison)
      }
    }, error = function(e) {
      option_frontier$ready <- FALSE
      option_frontier$owned <- character()
      reset_references()
      if (state$state == "restoring")
        list(stage_comparison = list(outcome = "unavailable", reason = conditionMessage(e))) else
        list(stage_checkpoint = unavailable(conditionMessage(e)))
    })
  }
  list(begin = begin, finish = finish, observe = observe, seal_options = seal_options)
}, envir = base::list2env(base::list(namespace_state = namespace_state,
  capture_rng = capture_r_random_state), parent = base::baseenv()))
lockEnvironment(environment(stage_checkpoint_owner$begin), bindings = TRUE)

capture_environment <- function(execution_context = NULL) {
  loaded <- loadedNamespaces()
  attached <- sub("^package:", "", grep("^package:", search(), value = TRUE))
  libraries <- normalizePath(.libPaths(), winslash = "/", mustWork = FALSE)
  runtime_home <- normalizePath(R.home(), winslash = "/", mustWork = FALSE)
  user_libraries <- strsplit(Sys.getenv("R_LIBS_USER", ""), .Platform$path.sep, fixed = TRUE)[[1L]]
  user_libraries <- normalizePath(path.expand(user_libraries[nzchar(user_libraries)]), winslash = "/", mustWork = FALSE)
  library_scope <- function(path) {
    if (is.null(path) || !nzchar(path)) return("unknown")
    path <- normalizePath(path, winslash = "/", mustWork = FALSE)
    within <- function(root) identical(path, root) || startsWith(path, paste0(root, "/"))
    if (within(runtime_home)) "environment" else if (any(vapply(user_libraries, within, logical(1)))) "user" else "system"
  }
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
    # packageDescription returns NA (not an error) when metadata is unavailable.
    if (is.list(description)) {
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
      library_scope = if (inherits(package_path, "try-error") || !nzchar(package_path)) "unknown" else library_scope(dirname(package_path)),
      built_for_runtime = built,
      priority = priority
    )
  })
  # The live Kernel must attest unused packages; a separate interpreter inventory cannot
  # establish whether a namespace was loaded. Keep library rank to distinguish shadowed copies.
  installed <- suppressWarnings(try(utils::installed.packages(), silent = TRUE))
  if (!inherits(installed, "try-error")) {
    unused <- installed[!installed[, "Package"] %in% loaded, , drop = FALSE]
    packages <- c(packages, lapply(seq_len(nrow(unused)), function(index) {
      entry <- unused[index, ]
      library_rank <- match(normalizePath(entry[["LibPath"]], winslash = "/", mustWork = FALSE), libraries)
      list(
        name = entry[["Package"]],
        version = entry[["Version"]],
        version_status = "known",
        ecosystem = "r",
        evidence_sources = list("r-session-info", "r-installed-packages"),
        loaded_state = if (package_usage_state$external_process) "unknown" else "installed-only",
        library_rank = if (is.na(library_rank)) NULL else as.integer(library_rank),
        library_scope = library_scope(entry[["LibPath"]])
      )
    }))
  }
  list(
    runtime_version = paste(R.version$major, R.version$minor, sep = "."),
    packages = packages,
    execution_context = execution_context
  )
}

# User code may manage its own output sinks, but it must never pop the kernel-owned capture sink and
# expose arbitrary output to the JSON-lines protocol. Keep the original primitive in a locked policy
# closure for trusted setup/cleanup, and let user sink(NULL) calls remove only sinks above the active
# capture depth.
output_sink_policy_env <- new.env(parent = baseenv())
output_sink_policy_env$state <- new.env(parent = emptyenv())
output_sink_policy_env$state$protected_depth <- 0L
output_sink_policy_env$state$protected_connections <- as.integer(con)
output_sink_policy_env$kernel_sink <- base::sink
guarded_output_sink <- function(
    file = NULL,
    append = FALSE,
    type = c("output", "message"),
    split = FALSE) {
  type <- match.arg(type)
  if (is.null(file) && identical(type, "output") &&
      sink.number(type = "output") <= state$protected_depth) {
    return(invisible(NULL))
  }
  kernel_sink(file = file, append = append, type = type, split = split)
}
environment(guarded_output_sink) <- output_sink_policy_env
assign("guarded_output_sink", guarded_output_sink, output_sink_policy_env)
# base::closeAllConnections closes descriptors directly after popping sinks. The sink guard alone
# cannot protect the request stream or active capture descriptor. Retain base cleanup semantics for
# user connections, including user-owned sinks, while excluding these kernel-owned descriptors.
guarded_close_all_connections <- function() {
  if (sink.number(type = "message") > 0L) kernel_sink(stderr(), type = "message")
  while (sink.number(type = "output") > state$protected_depth) kernel_sink(type = "output")
  gc()
  connections <- setdiff(getAllConnections(), c(0L, 1L, 2L, state$protected_connections))
  for (id in connections) close(getConnection(id))
  invisible(NULL)
}
environment(guarded_close_all_connections) <- output_sink_policy_env
assign("guarded_close_all_connections", guarded_close_all_connections, output_sink_policy_env)
lockEnvironment(output_sink_policy_env, bindings = TRUE)
if (bindingIsLocked("sink", baseenv())) unlockBinding("sink", baseenv())
assign("sink", output_sink_policy_env$guarded_output_sink, envir = baseenv())
lockBinding("sink", baseenv())
if (bindingIsLocked("closeAllConnections", baseenv())) unlockBinding("closeAllConnections", baseenv())
assign("closeAllConnections", output_sink_policy_env$guarded_close_all_connections, envir = baseenv())
lockBinding("closeAllConnections", baseenv())

run <- base::local({
  kernel_figures_dir <- figures_dir
  output_text_limit <- max(0, text_limit_bytes - diagnostic_limit_bytes)
  output_figure_limit <- figure_limit_bytes
  output_figure_count_limit <- figure_count_limit
  output_figure_total_limit <- figure_total_limit_bytes
  capture_width <- 800L
  capture_height <- 600L
  capture_res <- 96L
  kernel_png <- grDevices::png
  kernel_dev_off <- grDevices::dev.off
  kernel_plot_new <- graphics::plot.new
  kernel_sink <- output_sink_policy_env$kernel_sink
  output_sink_state <- output_sink_policy_env$state
  capture_state <- new.env(parent = emptyenv())
  external_device_owners <- new.env(parent = emptyenv())
  request_state <- new.env(parent = emptyenv())
  request_state$sequence <- 0L

  reset_capture_state <- function(
      dev_id = NA_integer_,
      initial_usr = NULL,
      request_id = NA_integer_) {
    capture_state$active <- !is.na(dev_id)
    capture_state$dev_id <- dev_id
    capture_state$initial_usr <- initial_usr
    capture_state$request_id <- request_id
    capture_state$page_seen <- FALSE
    capture_state$recorded_plot_seen <- FALSE
    capture_state$graphics_state_seen <- FALSE
    capture_state$closed <- FALSE
    capture_state$output_truncated <- FALSE
    capture_state$external_device_capture_keys <- character()
    capture_state$external_capture_keys <- character()
  }

  reset_capture_state()

  # Content-addresses each non-empty PNG page produced on the device into figures_dir.
  harvest_figures <- function(pattern_dir, keep_blank_pages = TRUE, blank_hashes = character()) {
    raw_files <- list.files(pattern_dir, pattern = "^page-\\d+\\.png$", full.names = TRUE)
    files <- capture_page_files(raw_files)
    out <- list()
    total_bytes <- 0
    for (f in files) {
      info <- file.info(f)
      if (!is.na(info$size) && info$size > 0 && is_png_file(f)) {
        if (length(out) >= output_figure_count_limit || info$size > output_figure_limit ||
            total_bytes + info$size > output_figure_total_limit) {
          capture_state$output_truncated <- TRUE
          next
        }
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
          total_bytes <- total_bytes + info$size
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

  external_device_key <- function(which) {
    if (length(which) != 1L || is.na(which)) {
      return(NA_character_)
    }
    as.character(as.integer(unname(which)))
  }

  external_device_owned_by_current_request <- function(which) {
    key <- external_device_key(which)
    !is.na(key) &&
      exists(key, envir = external_device_owners, inherits = FALSE) &&
      identical(
        get(key, envir = external_device_owners, inherits = FALSE),
        capture_state$request_id
      )
  }

  file_device_capture_key <- function(args) {
    path <- args[["filename", exact = TRUE]]
    if (is.null(path)) path <- args[["file", exact = TRUE]]
    if (is.null(path) && length(args) > 0L) path <- args[[1L]]
    if (!is.character(path) || length(path) != 1L || is.na(path) || !nzchar(path)) {
      return(NA_character_)
    }
    normalized_path <- file.path(
      normalizePath(dirname(path), winslash = "/", mustWork = FALSE),
      basename(path)
    )
    tools::file_path_sans_ext(normalized_path)
  }

  registered_external_capture_key <- function(which) {
    key <- external_device_key(which)
    if (is.na(key) || is.null(capture_state$external_device_capture_keys[[key]])) {
      return(NA_character_)
    }
    capture_state$external_device_capture_keys[[key]]
  }

  forget_external_device <- function(which) {
    key <- external_device_key(which)
    if (!is.na(key) && exists(key, envir = external_device_owners, inherits = FALSE)) {
      rm(list = key, envir = external_device_owners)
    }
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
    forget_external_device(which)
  }

  record_external_plot <- function(which) {
    if (!isTRUE(capture_state$active) ||
        isTRUE(capture_state$closed) ||
        capture_state_device_matches(which) ||
        !external_device_owned_by_current_request(which) ||
        !capture_device_is_open(capture_state$dev_id) ||
        !capture_device_is_open(which)) {
      return(NULL)
    }
    capture_key <- registered_external_capture_key(which)
    if (!is.na(capture_key) && capture_key %in% capture_state$external_capture_keys) {
      return(NULL)
    }
    current_dev <- grDevices::dev.cur()
    if (!identical(current_dev, which)) {
      suppressWarnings(try(grDevices::dev.set(which), silent = TRUE))
    }
    recorded <- suppressWarnings(try(grDevices::recordPlot(), silent = TRUE))
    if (!identical(current_dev, which) && capture_device_is_open(current_dev)) {
      suppressWarnings(try(grDevices::dev.set(current_dev), silent = TRUE))
    }
    if (inherits(recorded, "try-error") || length(recorded) < 1L || is.null(recorded[[1L]])) {
      return(NULL)
    }
    if (!is.na(capture_key)) {
      capture_state$external_capture_keys <- c(
        capture_state$external_capture_keys,
        capture_key
      )
    }
    recorded
  }

  replay_external_plot <- function(recorded) {
    if (is.null(recorded) ||
        isTRUE(capture_state$closed) ||
        !capture_device_is_open(capture_state$dev_id)) {
      return(invisible(NULL))
    }
    current_dev <- grDevices::dev.cur()
    if (!identical(current_dev, capture_state$dev_id)) {
      suppressWarnings(try(grDevices::dev.set(capture_state$dev_id), silent = TRUE))
    }
    suppressWarnings(try(grDevices::replayPlot(recorded), silent = TRUE))
    if (!identical(current_dev, capture_state$dev_id) && capture_device_is_open(current_dev)) {
      suppressWarnings(try(grDevices::dev.set(current_dev), silent = TRUE))
    }
    invisible(NULL)
  }

  register_external_device <- function(args) {
    current_dev <- grDevices::dev.cur()
    if (isTRUE(capture_state$active) &&
        !isTRUE(capture_state$closed) &&
        !capture_state_device_matches(current_dev)) {
      key <- external_device_key(current_dev)
      if (!is.na(key)) {
        assign(key, capture_state$request_id, envir = external_device_owners)
        capture_state$external_device_capture_keys[[key]] <- file_device_capture_key(args)
      }
      suppressWarnings(try(grDevices::dev.control(displaylist = "enable"), silent = TRUE))
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
          record_external = record_external_plot,
          replay_external = replay_external_plot,
          original = original
        ),
        parent = globalenv()
      )
      lockEnvironment(wrapper_env, bindings = TRUE)
      eval(
        quote(function(which = grDevices::dev.cur()) {
          recorded <- record_external(which)
          before_close(which)
          result <- base::withVisible(original(which))
          after_close(which)
          replay_external(recorded)
          if (result$visible) result$value else base::invisible(result$value)
        }),
        envir = wrapper_env
      )
    }

    make_file_device_wrapper <- function(original) {
      wrapper_env <- base::list2env(
        base::list(register_device = register_external_device, original = original),
        parent = globalenv()
      )
      lockEnvironment(wrapper_env, bindings = TRUE)
      eval(
        quote(function(...) {
          result <- base::withVisible(original(...))
          register_device(base::list(...))
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
    for (name in c("bmp", "jpeg", "png", "tiff", "pdf", "postscript", "svg", "cairo_pdf", "cairo_ps")) {
      install_capture_binding_wrapper("grDevices", name, make_file_device_wrapper)
    }
    # ggsave prefers ragg devices when available. Hook their load without preloading optional packages.
    install_ragg_wrappers <- function(...) {
      for (name in c("agg_png", "agg_jpeg", "agg_tiff")) {
        install_capture_binding_wrapper("ragg", name, make_file_device_wrapper)
      }
    }
    setHook(packageEvent("ragg", "onLoad"), install_ragg_wrappers)
    if ("ragg" %in% loadedNamespaces()) install_ragg_wrappers()
  }

  install_capture_wrappers()

  function(req) {
    # Initialize once, without consuming a random draw, so an unseeded first
    # cell also has a reproducible starting sequence. Explicit set.seed wins.
    if (!base::exists(".Random.seed", envir = base::globalenv(), inherits = FALSE))
      base::set.seed(NULL)
    context_before <- capture_execution_context()
    package_observer <- new_package_observer(request_state$sequence == 0L)
    fresh_package_session <- request_state$sequence == 0L && isTRUE(package_observer$finish()$cleanSession)
    request_state$sequence <- request_state$sequence + 1L
    request_id <- request_state$sequence
    reset_capture_state(request_id = request_id)
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
      reset_capture_state(dev_id, capture_initial_usr, request_id)
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
    stage_state <- NULL
    last_value <- NULL
    execution_started <- FALSE
    interrupt_ack <- FALSE
    error_line <- NA_integer_
    stdout_path <- tempfile("open-science-r-stdout-")
    stdout_connection <- file(stdout_path, open = "wb")
    stdout_connection_id <- as.integer(stdout_connection)
    output_sink_state$protected_connections <- c(output_sink_state$protected_connections, stdout_connection_id)
    sink_depth <- sink.number(type = "output")
    kernel_sink(stdout_connection, type = "output")
    output_sink_state$protected_depth <- sink_depth + 1L
    on.exit({
      output_sink_state$protected_depth <- sink_depth
      output_sink_state$protected_connections <- setdiff(output_sink_state$protected_connections, stdout_connection_id)
      while (sink.number(type = "output") > sink_depth) kernel_sink(type = "output")
      suppressWarnings(try(close(stdout_connection), silent = TRUE))
      unlink(stdout_path, force = TRUE)
    }, add = TRUE)
    {
      # keep.source retains per-expression srcrefs so a runtime error can report the 1-based line of the
      # top-level statement that failed (the R equivalent of a Python traceback's last user frame).
      exprs <- tryCatch(parse(text = req$code, keep.source = TRUE), error = function(cnd) cnd)
      if (inherits(exprs, "condition")) {
        error <- conditionMessage(exprs)
      } else {
        restoring_request <- !is.null(req$stage_restore) || !is.null(req$stage_supplement)
        if (!restoring_request) stage_checkpoint_owner$observe(exprs)
        policy_error <- tryCatch({
          lapply(exprs, assert_no_package_mutation)
          NULL
        }, error = function(cnd) cnd)
        if (inherits(policy_error, "condition")) {
          error <- conditionMessage(policy_error)
        } else {
          stage_state <- stage_checkpoint_owner$begin(req, exprs,
            if (is.na(dev_id)) integer() else dev_id, fresh_package_session)
          restore_failed <- (!is.null(req$stage_restore) || !is.null(req$stage_supplement) ||
            !is.null(req$stage_expected_output_path)) &&
            (is.null(stage_state) || identical(stage_state$state, "unavailable"))
          if (restoring_request && !restore_failed) {
            source_status <- stage_checkpoint_owner$observe(exprs)
            if (!is.null(source_status)) {
              stage_state <- source_status
              stage_state$restore <- TRUE
              restore_failed <- TRUE
            }
          }
          if (restore_failed) error <- paste0("Stage restoration failed: ", stage_state$reason)
          if (!is.null(stage_state) && !restore_failed &&
              (!is.null(req$stage_restore) || !is.null(req$stage_supplement))) {
            context_before <- capture_execution_context()
            package_observer <- new_package_observer(FALSE)
          }
          refs <- attr(exprs, "srcref")
          idx <- 0L
          tryCatch({
            for (idx in if (restore_failed) integer() else seq_along(exprs)) {
              execution_started <- TRUE
              package_observer$record(exprs[[idx]])
              namespace_tracker$prepare(exprs[[idx]])
              res <- withVisible(eval(exprs[[idx]], envir = globalenv()))
              last_value <- list(value = res$value, visible = res$visible)
              namespace_tracker$commit(exprs[[idx]])
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
          interrupt = function(cnd) {
            error <<- "interrupted"
            interrupt_ack <<- TRUE
          })
        }
      }
    }
    if (is.expression(exprs)) stage_checkpoint_owner$observe(exprs, allow_pending = FALSE)
    output_sink_state$protected_depth <- sink_depth
    while (sink.number(type = "output") > sink_depth) kernel_sink(type = "output")
    close(stdout_connection)
    stdout_size <- file.info(stdout_path)$size
    stdout_file <- file(stdout_path, open = "rb")
    stdout_raw <- readBin(stdout_file, what = "raw", n = output_text_limit)
    close(stdout_file)
    unlink(stdout_path, force = TRUE)
    stdout_text <- iconv(rawToChar(stdout_raw), from = "UTF-8", to = "UTF-8", sub = "")
    stdout_text <- sub("\\r?\\n$", "", stdout_text)
    if (!is.na(stdout_size) && stdout_size > output_text_limit) {
      capture_state$output_truncated <- TRUE
    }
    remaining_text_bytes <- diagnostic_limit_bytes
    if (!is.null(error)) {
      error_raw <- charToRaw(enc2utf8(error))
      if (length(error_raw) > remaining_text_bytes) {
        error <- if (remaining_text_bytes > 0) {
          iconv(
            rawToChar(error_raw[seq_len(remaining_text_bytes)]),
            from = "UTF-8",
            to = "UTF-8",
            sub = ""
          )
        } else {
          ""
        }
        capture_state$output_truncated <- TRUE
      }
    }
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
    stage_result <- stage_checkpoint_owner$finish(stage_state, error, integer(), last_value)
    if (!is.null(req$stage_checkpoint) && is.null(stage_result$stage_checkpoint))
      stage_result$stage_checkpoint <- list(state = "unavailable", reason = "cell-not-executed")
    if ((!is.null(req$stage_restore) || !is.null(req$stage_expected_output_path) ||
        !is.null(req$stage_supplement)) &&
        is.null(stage_result$stage_comparison))
      stage_result$stage_comparison <- list(outcome = "unavailable")
    c(stage_result, list(stdout = stdout_text, stderr = "", error = if (is.null(error)) NA else error,
         execution_started = isTRUE(execution_started),
         interrupt_ack = isTRUE(interrupt_ack),
         error_line = if (is.na(error_line)) NULL else error_line,
         result = NA, cwd = getwd(), figures = figures,
         output_truncated = isTRUE(capture_state$output_truncated),
         environment = capture_environment(list(schemaVersion = 1L, before = context_before,
                                               after = capture_execution_context(),
                                               rPackages = package_observer$finish()))))
  }
}, envir = base::list2env(
  base::list(
    figures_dir = figures_dir,
    text_limit_bytes = text_limit_bytes,
    diagnostic_limit_bytes = diagnostic_limit_bytes,
    figure_limit_bytes = figure_limit_bytes,
    figure_count_limit = figure_count_limit,
    figure_total_limit_bytes = figure_total_limit_bytes,
    capture_environment = capture_environment,
    capture_execution_context = capture_execution_context,
    new_package_observer = new_package_observer,
    assert_no_package_mutation = assert_no_package_mutation,
    output_sink_policy_env = output_sink_policy_env,
    namespace_tracker = namespace_tracker,
    stage_checkpoint_owner = stage_checkpoint_owner
  ),
  parent = base::baseenv()
))
lockEnvironment(environment(run), bindings = TRUE)
stage_checkpoint_owner$seal_options()

# Capture the loop's trusted startup names once. The inspector hides unchanged bootstrap names but
# reveals confirmed user shadows, while the request loop keeps private references to trusted code.
namespace_state$internal_names <- ls(envir = .GlobalEnv, all.names = TRUE)
rm(namespace_state)

# Request I/O and the read-path interrupt flag live outside .GlobalEnv. User cells eval in
# globalenv() and may assign names such as interrupt_during_read or getwd; those assignments
# must not skip the next request or crash cancellation. Parent is baseenv() so cancellation
# helpers resolve trusted bindings. SIGINT during a blocked stdin read looks like an empty
# read and, if left uncaught at top level, prints "Execution halted" and exits.
base::local({
  state <- new.env(parent = emptyenv())
  state$during_read <- FALSE
  # Retain the fully read frame until its response is emitted. A SIGINT can otherwise unwind
  # read_request after consuming the body and discard the request before it is acknowledged.
  state$current_req <- NULL

  # This private control never enters run's user-source observer or checkpoint history.
  # Capture base's implementation at startup so .GlobalEnv shadows cannot replace it.
  interrupt_sleep <- Sys.sleep
  interrupt_probe_response <- function(error = NULL, interrupt_ack = FALSE) {
    list(stdout = "", stderr = "", error = error, interrupt_ack = interrupt_ack,
         error_line = NULL, result = NA, cwd = getwd(), figures = list())
  }
  interrupt_probe <- function(code) {
    if (!identical(code, ""))
      return(interrupt_probe_response("Invalid interrupt probe request"))
    interrupt_sleep(0.05)
    interrupt_probe_response()
  }

  read_request <- function() {
    empty_streak <- 0L
    repeat {
      header <- tryCatch(
        readLines(con, n = 1L, warn = FALSE),
        interrupt = function(cnd) {
          state$during_read <- TRUE
          NA_character_
        }
      )
      if (length(header) == 1L && is.na(header)) next
      if (length(header) == 0L) {
        empty_streak <- empty_streak + 1L
        if (!isOpen(con) || empty_streak >= 2L) return(NULL)
        # SIGINT on a blocked read often returns empty without raising interrupt.
        state$during_read <- TRUE
        next
      }
      empty_streak <- 0L
      parts <- strsplit(header, " ", fixed = TRUE)[[1]]
      req_id <- parts[1]
      n <- as.integer(parts[2])
      operation <- if (length(parts) >= 3L) parts[3L] else "execute"
      if (is.na(n) || n < 0L) n <- 0L
      acc <- raw()
      body_empty <- 0L
      while (length(acc) < n) {
        chunk <- tryCatch(
          readBin(con, what = "raw", n = n - length(acc)),
          interrupt = function(cnd) {
            state$during_read <- TRUE
            structure(raw(), interrupt = TRUE)
          }
        )
        if (isTRUE(attr(chunk, "interrupt"))) next
        if (length(chunk) == 0L) {
          body_empty <- body_empty + 1L
          if (!isOpen(con) || body_empty >= 2L) return(NULL)
          state$during_read <- TRUE
          next
        }
        body_empty <- 0L
        acc <- c(acc, chunk)
      }
      req <- tryCatch(
        {
          code <- if (n > 0L) rawToChar(acc, multiple = FALSE) else ""
          req <- list(req_id = req_id, code = code, operation = operation)
          state$current_req <- req
          req
        },
        interrupt = function(cnd) {
          state$during_read <- TRUE
          req <- list(
            req_id = req_id,
            code = if (n > 0L) rawToChar(acc, multiple = FALSE) else "",
            operation = operation
          )
          state$current_req <- req
          req
        }
      )
      return(req)
    }
  }

  interrupted_response <- function(req_id, operation) {
    if (identical(operation, "interrupt_probe")) {
      response <- interrupt_probe_response("interrupted", TRUE)
      response$req_id <- req_id
      return(response)
    }
    environment <- tryCatch(
      capture_environment(),
      interrupt = function(cnd) {
        list(
          runtime_version = paste(R.version$major, R.version$minor, sep = "."),
          packages = list()
        )
      },
      error = function(cnd) {
        list(
          runtime_version = paste(R.version$major, R.version$minor, sep = "."),
          packages = list()
        )
      }
    )
    list(
      stdout = "",
      stderr = "",
      error = "interrupted",
      interrupt_ack = TRUE,
      error_line = NULL,
      result = NA,
      cwd = getwd(),
      figures = list(),
      output_truncated = FALSE,
      environment = environment,
      req_id = req_id
    )
  }

  # Keep one interrupt handler active across request-boundary transitions as well as response emit.
  # The inner loop normally runs until EOF; a late interrupt unwinds only to this recovery point.
  repeat {
    keep_running <- tryCatch(
      {
        repeat {
          req <- tryCatch(
            read_request(),
            interrupt = function(cnd) {
              req <- state$current_req
              state$during_read <- TRUE
              if (is.null(req)) "retry" else req
            }
          )
          if (is.null(req)) break
          if (identical(req, "retry")) next
          resp <- tryCatch(
            {
              if (isTRUE(state$during_read)) {
                state$during_read <- FALSE
                interrupted_response(req$req_id, req$operation)
              } else {
                result <- if (identical(req$operation, "interrupt_probe")) {
                  interrupt_probe(req$code)
                } else if (identical(req$operation, "inspect_namespace")) {
                  list(namespace = inspect_namespace(identical(req$code, "private")))
                } else {
                  if (identical(req$operation, "execute_stage")) {
                    payload <- tryCatch(jsonlite::fromJSON(req$code, simplifyVector = FALSE),
                      error = function(e) NULL)
                    if (is.list(payload) && is.character(payload$code) && length(payload$code) == 1L) {
                      req$code <- payload$code
                      req$stage_checkpoint <- payload$stage_checkpoint
                      req$stage_restore <- payload$stage_restore
                      req$stage_supplement <- payload$stage_supplement
                      req$stage_expected_output_path <- payload$stage_expected_output_path
                    } else {
                      req$code <- "stop('Invalid stage execution request')"
                    }
                  }
                  run(req)
                }
                result$req_id <- req$req_id
                result
              }
            },
            interrupt = function(cnd) interrupted_response(req$req_id, req$operation)
          )
          suspendInterrupts({
            emit(resp)
            state$current_req <- NULL
          })
        }
        FALSE
      },
      interrupt = function(cnd) {
        req <- state$current_req
        if (is.null(req)) {
          state$during_read <- TRUE
        } else {
          state$during_read <- FALSE
          suspendInterrupts({
            emit(interrupted_response(req$req_id, req$operation))
            state$current_req <- NULL
          })
        }
        TRUE
      }
    )
    if (!isTRUE(keep_running)) break
  }
}, envir = base::list2env(
  base::list(
    con = con,
    emit = emit,
    run = run,
    inspect_namespace = inspect_namespace,
    capture_environment = capture_environment
  ),
  parent = base::baseenv()
))
