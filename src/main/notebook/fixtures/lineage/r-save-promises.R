# Regression for save's non-standard evaluation through the runtime write guard.
value <- rep(1, 4000)
save(value, file = "large.RData")
restored <- new.env(parent = emptyenv())
stopifnot(identical(load("large.RData", envir = restored), "value"))
stopifnot(identical(restored$value, value))

# Symbols are names in the selected environment, not values from the caller.
selected <- new.env(parent = emptyenv())
selected$value <- 42
save(value, file = "selected.RData", envir = selected)
load("selected.RData", envir = restored)
stopifnot(identical(restored$value, 42))

local({
  local_value <- 7
  save(local_value, file = "local.RData")
})
load("local.RData", envir = restored)
stopifnot(identical(restored$local_value, 7))

# The dotted argument must not be forced before save applies eval.promises.
lazy <- new.env(parent = baseenv())
delayedAssign("not_forced", stop("promise forced before serialization"), assign.env = lazy)
save(not_forced, file = "lazy.RData", envir = lazy, eval.promises = FALSE)
stopifnot(identical(load("lazy.RData", envir = restored), "not_forced"))

save(list = c("value"), file = "named.RData", envir = selected)
load("named.RData", envir = restored)
stopifnot(identical(restored$value, 42))

# A file expression is evaluated once, and protected destinations stay blocked.
evaluations <- 0L
save(value, file = { evaluations <- evaluations + 1L; "once.RData" })
stopifnot(evaluations == 1L)
protected <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "forbidden.RData")
blocked <- tryCatch({ save(value, file = protected); NULL }, error = identity)
stopifnot(inherits(blocked, "error"), grepl("read-only", conditionMessage(blocked)))
stopifnot(!file.exists(protected))
cat("SAVE_GUARD_OK\n")
