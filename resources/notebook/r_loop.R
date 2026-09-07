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
  if (is.call(head) && length(head) >= 3L &&
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
  if (is.call(expr) && call_name %in% c("get", "match.fun", "do.call")) {
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
      save = list(runtime_argument(args, "file", .Machine$integer.max)),
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

# User code may manage its own output sinks, but it must never pop the kernel-owned capture sink and
# expose arbitrary output to the JSON-lines protocol. Keep the original primitive in a locked policy
# closure for trusted setup/cleanup, and let user sink(NULL) calls remove only sinks above the active
# capture depth.
output_sink_policy_env <- new.env(parent = baseenv())
output_sink_policy_env$state <- new.env(parent = emptyenv())
output_sink_policy_env$state$protected_depth <- 0L
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
lockEnvironment(output_sink_policy_env, bindings = TRUE)
if (bindingIsLocked("sink", baseenv())) unlockBinding("sink", baseenv())
assign("sink", output_sink_policy_env$guarded_output_sink, envir = baseenv())
lockBinding("sink", baseenv())

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
    interrupt_ack <- FALSE
    error_line <- NA_integer_
    stdout_path <- tempfile("open-science-r-stdout-")
    stdout_connection <- file(stdout_path, open = "wb")
    sink_depth <- sink.number(type = "output")
    kernel_sink(stdout_connection, type = "output")
    output_sink_state$protected_depth <- sink_depth + 1L
    on.exit({
      output_sink_state$protected_depth <- sink_depth
      while (sink.number(type = "output") > sink_depth) kernel_sink(type = "output")
      suppressWarnings(try(close(stdout_connection), silent = TRUE))
      unlink(stdout_path, force = TRUE)
    }, add = TRUE)
    {
      # keep.source retains per-expression srcrefs so a runtime error can report the 1-based line of the
      # top-level statement that failed (the R equivalent of a Python traceback's last user frame).
      exprs <- tryCatch(parse(text = req$code, keep.source = TRUE), error = function(cnd) cnd)
      if (inherits(exprs, "condition")) {
        error <<- conditionMessage(exprs)
      } else {
        policy_error <- tryCatch({
          lapply(exprs, assert_no_package_mutation)
          NULL
        }, error = function(cnd) cnd)
        if (inherits(policy_error, "condition")) {
          error <- conditionMessage(policy_error)
        } else {
          refs <- attr(exprs, "srcref")
          idx <- 0L
          tryCatch({
            for (idx in seq_along(exprs)) {
              namespace_tracker$prepare(exprs[[idx]])
              res <- withVisible(eval(exprs[[idx]], envir = globalenv()))
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
    list(stdout = stdout_text, stderr = "", error = if (is.null(error)) NA else error,
         interrupt_ack = isTRUE(interrupt_ack),
         error_line = if (is.na(error_line)) NULL else error_line,
         result = NA, cwd = getwd(), figures = figures,
         output_truncated = isTRUE(capture_state$output_truncated),
         environment = capture_environment())
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
    assert_no_package_mutation = assert_no_package_mutation,
    output_sink_policy_env = output_sink_policy_env,
    namespace_tracker = namespace_tracker
  ),
  parent = base::baseenv()
))
lockEnvironment(environment(run), bindings = TRUE)

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

  interrupted_response <- function(req_id) {
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
                interrupted_response(req$req_id)
              } else {
                result <- if (identical(req$operation, "inspect_namespace")) {
                  list(namespace = inspect_namespace(identical(req$code, "private")))
                } else {
                  run(req)
                }
                result$req_id <- req$req_id
                result
              }
            },
            interrupt = function(cnd) interrupted_response(req$req_id)
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
            emit(interrupted_response(req$req_id))
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
