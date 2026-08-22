const R_ANALYZER = String.raw`
decode_base64 <- function(value) {
  if (!nchar(value)) return('')
  alphabet <- strsplit('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', '')[[1]]
  unpadded <- sub('=+$', '', value)
  digits <- match(strsplit(unpadded, '')[[1]], alphabet) - 1L
  bytes <- integer()
  for (index in seq.int(1L, length(digits), by = 4L)) {
    chunk <- digits[index:min(index + 3L, length(digits))]
    if (length(chunk) >= 2L) bytes <- c(bytes, bitwShiftL(chunk[1], 2L) + bitwShiftR(chunk[2], 4L))
    if (length(chunk) >= 3L) bytes <- c(bytes, bitwShiftL(bitwAnd(chunk[2], 15L), 4L) + bitwShiftR(chunk[3], 2L))
    if (length(chunk) >= 4L) bytes <- c(bytes, bitwShiftL(bitwAnd(chunk[3], 3L), 6L) + chunk[4])
  }
  rawToChar(as.raw(bytes))
}

analyze_source <- function(source) {
  defined <- character()
  used <- character()
  prior_used <- character()
  possibly_used <- character()
  mutated <- character()
  possibly_mutated <- character()
  aliases <- list()
  possible_aliases <- list()
  copy_on_modify <- character()
  copy_on_modify_bindings <- list()
  copy_on_modify_invalidated <- character()
  safe_call_names <- character()
  safe_call_argument_names <- character()
  type_summaries <- list()
  type_bindings <- list()
  receiver_calls <- list()
  member_writes <- list()
  unknown <- character()
  control_depth <- 0L
  local_names <- character()

  pure_safe_calls <- c('abs', 'acos', 'all', 'any', 'asin', 'as.character', 'as.integer', 'as.logical', 'as.numeric', 'atan', 'atan2', 'c', 'ceiling', 'character', 'cos', 'cosh', 'cumsum', 'data.frame', 'desc', 'exp', 'factor', 'floor', 'integer', 'is.na', 'is.null', 'length', 'list', 'log', 'log10', 'log2', 'logical', 'matrix', 'max', 'mean', 'median', 'min', 'n', 'names', 'ncol', 'nrow', 'numeric', 'order', 'paste', 'paste0', 'quantile', 'range', 'rank', 'rep', 'rev', 'round', 'sd', 'seq', 'signif', 'sin', 'sinh', 'slot', 'sort', 'sqrt', 'sum', 'tan', 'tanh', 'trunc', 'unique', 'var', 'which', 'which.max', 'which.min')
  environment_safe_calls <- c('baseenv', 'emptyenv', 'environment', 'globalenv', 'new.env')
  graphics_safe_calls <- c('abline', 'axis', 'barplot', 'bmp', 'cm.colors', 'dev.cur', 'dev.list', 'dev.off', 'dev.size', 'gray.colors', 'grid', 'heat.colors', 'jpeg', 'layout', 'legend', 'lines', 'par', 'pdf', 'pie', 'png', 'points', 'rainbow', 'svg', 'terrain.colors', 'tiff', 'title', 'topo.colors')
  ggplot2_safe_calls <- c('aes', 'aes_', 'aes_string', 'after_scale', 'after_stat', 'annotation_custom', 'coord_cartesian', 'coord_fixed', 'coord_flip', 'coord_map', 'coord_polar', 'element_blank', 'element_line', 'element_rect', 'element_text', 'expand_limits', 'facet_grid', 'facet_wrap', 'geom_area', 'geom_bar', 'geom_boxplot', 'geom_col', 'geom_histogram', 'geom_label', 'geom_line', 'geom_path', 'geom_point', 'geom_ribbon', 'geom_smooth', 'geom_text', 'geom_tile', 'geom_violin', 'ggplot', 'ggsave', 'ggtitle', 'guides', 'labs', 'lims', 'qplot', 'stage', 'stat_identity', 'theme', 'theme_bw', 'theme_classic', 'theme_gray', 'theme_light', 'theme_minimal', 'theme_void', 'vars', 'xlab', 'xlim', 'ylab', 'ylim')
  readr_tabular_read_calls <- c('read_csv', 'read_csv2', 'read_delim', 'read_fwf', 'read_table', 'read_tsv')
  readr_reference_read_calls <- c('read_rds')
  readr_output_calls <- c('write_csv', 'write_delim', 'write_tsv')
  readxl_tabular_read_calls <- c('read_excel', 'read_xls', 'read_xlsx')
  haven_tabular_read_calls <- c('read_dta', 'read_por', 'read_sas', 'read_sav', 'read_xpt')
  haven_output_calls <- c('write_dta', 'write_sas', 'write_sav', 'write_xpt')
  base_value_read_calls <- c('read.fwf', 'readBin', 'readChar', 'readLines')
  jsonlite_value_read_calls <- c('fromJSON')
  yaml_value_read_calls <- c('read_yaml', 'yaml.load_file')
  vroom_value_read_calls <- c('vroom', 'vroom_fwf', 'vroom_lines')
  sf_value_read_calls <- c('st_read')
  matrix_value_read_calls <- c('readMM')
  arrow_reference_read_calls <- c('read_csv_arrow', 'read_delim_arrow', 'read_feather', 'read_ipc_file', 'read_ipc_stream', 'read_json_arrow', 'read_parquet')
  terra_reference_read_calls <- c('rast', 'vect')
  rio_reference_read_calls <- c('import')
  tibble_constructor_calls <- c('as_tibble', 'tibble', 'tribble')
  data_table_constructor_calls <- c('as.data.table', 'data.table', 'fread')
  data_table_reference_mutators <- c('set', 'setalloccol', 'setattr', 'setcolorder', 'setDF', 'setDT', 'setindex', 'setindexv', 'setkey', 'setkeyv', 'setnafill', 'setnames', 'setorder', 'setorderv')
  data_table_output_calls <- c('fwrite')
  bioc_constructor_calls <- c('ExpressionSet', 'SingleCellExperiment', 'SummarizedExperiment')
  bioc_value_accessors <- c('altExp', 'altExps', 'assay', 'assays', 'colData', 'colLabels', 'exprs', 'fData', 'featureData', 'logcounts', 'normcounts', 'pData', 'reducedDim', 'reducedDims', 'rowData', 'rowRanges', 'rowSubset', 'sizeFactors')
  bioc_unknown_accessors <- c('experimentData', 'metadata')
  output_safe_calls <- c('cat', 'dir.exists', 'file.exists', 'message', 'print', 'saveRDS', 'set.seed', 'warning', 'write.csv', 'write.table', readr_output_calls, haven_output_calls)
  tidy_data_mask_calls <- c('arrange', 'count', 'distinct', 'filter', 'group_by', 'mutate', 'rename', 'select', 'summarise', 'summarize', 'transmute')
  tidyr_data_mask_calls <- c('complete', 'drop_na', 'extract', 'fill', 'pivot_longer', 'pivot_wider', 'replace_na', 'separate', 'separate_wider_delim', 'unite', 'unnest', 'unnest_longer', 'unnest_wider')
  tabular_transform_calls <- c(tidy_data_mask_calls, tidyr_data_mask_calls)
  model_data_mask_calls <- c('aov', 'glm', 'lm')
  safe_calls <- c(pure_safe_calls, environment_safe_calls, graphics_safe_calls, ggplot2_safe_calls, output_safe_calls, tibble_constructor_calls, data_table_output_calls, bioc_constructor_calls)
  tabular_read_calls <- c('read.csv', 'read.csv2', 'read.delim', 'read.delim2', 'read.table', 'scan')
  value_file_read_calls <- c(tabular_read_calls, readr_tabular_read_calls, readxl_tabular_read_calls, haven_tabular_read_calls, base_value_read_calls, jsonlite_value_read_calls, yaml_value_read_calls, vroom_value_read_calls, sf_value_read_calls, matrix_value_read_calls)
  reference_file_read_calls <- c(readr_reference_read_calls, arrow_reference_read_calls, terra_reference_read_calls, rio_reference_read_calls, 'readRDS')
  external_read_calls <- c(value_file_read_calls, reference_file_read_calls)
  data_mask_calls <- c('aes', 'aes_', 'aes_string', 'vars')
  known_attached_packages <- c('arrow', 'Biobase', 'data.table', 'dplyr', 'ggplot2', 'haven', 'jsonlite', 'Matrix', 'readr', 'readxl', 'rio', 'sf', 'SingleCellExperiment', 'SummarizedExperiment', 'terra', 'tibble', 'tidyr', 'vroom', 'yaml')
  pipe_ops <- c('%>%', '|>')

  call_operator <- function(expr) {
    if (!is.call(expr) || !is.symbol(expr[[1]])) return(NULL)
    as.character(expr[[1]])
  }

  called_name <- function(expr) {
    if (!is.call(expr)) return(NULL)
    if (is.symbol(expr[[1]])) return(as.character(expr[[1]]))
    callee_op <- call_operator(expr[[1]])
    if (!is.null(callee_op) && callee_op %in% c('::', ':::') && length(expr[[1]]) >= 3L) return(as.character(expr[[1]][[3]]))
    NULL
  }

  qualified_call <- function(expr) {
    if (!is.call(expr) || !is.call(expr[[1]]) || length(expr[[1]]) < 3L) return(NULL)
    qualifier <- call_operator(expr[[1]])
    if (is.null(qualifier) || !qualifier %in% c('::', ':::')) return(NULL)
    list(package = as.character(expr[[1]][[2]]), name = as.character(expr[[1]][[3]]))
  }

  qualified_value_file_read <- function(package, name) {
    (package %in% c('base', 'utils') && name %in% c(tabular_read_calls, base_value_read_calls)) ||
      (package == 'haven' && name %in% haven_tabular_read_calls) ||
      (package == 'jsonlite' && name %in% jsonlite_value_read_calls) ||
      (package == 'Matrix' && name %in% matrix_value_read_calls) ||
      (package == 'readr' && name %in% readr_tabular_read_calls) ||
      (package == 'readxl' && name %in% readxl_tabular_read_calls) ||
      (package == 'sf' && name %in% sf_value_read_calls) ||
      (package == 'vroom' && name %in% vroom_value_read_calls) ||
      (package == 'yaml' && name %in% yaml_value_read_calls)
  }

  qualified_reference_file_read <- function(package, name) {
    (package == 'arrow' && name %in% arrow_reference_read_calls) ||
      (package == 'base' && name == 'readRDS') ||
      (package == 'readr' && name %in% readr_reference_read_calls) ||
      (package == 'rio' && name %in% rio_reference_read_calls) ||
      (package == 'terra' && name %in% terra_reference_read_calls)
  }

  known_qualified_call <- function(package, name) {
      (package == 'base' && name %in% c(pure_safe_calls, output_safe_calls)) ||
      qualified_value_file_read(package, name) ||
      qualified_reference_file_read(package, name) ||
      (package %in% c('Biobase', 'SingleCellExperiment', 'SummarizedExperiment') && name %in% c(bioc_constructor_calls, bioc_value_accessors, bioc_unknown_accessors)) ||
      (package == 'data.table' && name %in% c(data_table_constructor_calls, data_table_reference_mutators, data_table_output_calls, 'copy')) ||
      (package == 'dplyr' && name %in% tidy_data_mask_calls) ||
      (package == 'ggplot2' && name %in% ggplot2_safe_calls) ||
      (package == 'haven' && name %in% c(haven_tabular_read_calls, haven_output_calls)) ||
      (package == 'readr' && name %in% c(readr_tabular_read_calls, readr_reference_read_calls, readr_output_calls)) ||
      (package == 'readxl' && name %in% readxl_tabular_read_calls) ||
      (package == 'tibble' && name %in% tibble_constructor_calls) ||
      (package == 'tidyr' && name %in% tidyr_data_mask_calls) ||
      (package == 'stats' && name %in% c(model_data_mask_calls, pure_safe_calls)) ||
      (package == 'utils' && name %in% output_safe_calls)
  }

  tabular_transform_name <- function(expr) {
    name <- called_name(expr)
    if (is.null(name) || !name %in% tabular_transform_calls) return(NULL)
    qualified <- qualified_call(expr)
    if (is.null(qualified)) return(name)
    if (qualified$package == 'dplyr' && name %in% tidy_data_mask_calls) return(name)
    if (qualified$package == 'tidyr' && name %in% tidyr_data_mask_calls) return(name)
    NULL
  }

  member_name <- function(expr) {
    op <- call_operator(expr)
    if (!is.null(op) && op %in% c('$', '@') && length(expr) >= 3L) return(as.character(expr[[3]]))
    if (!is.null(op) && op == 'slot' && length(expr) >= 3L && is.character(expr[[3]])) return(as.character(expr[[3]]))
    name <- called_name(expr)
    if (!is.null(name) && name %in% c(bioc_value_accessors, bioc_unknown_accessors)) return(name)
    NULL
  }

  named_argument <- function(expr, name) {
    args <- as.list(expr)[-1]
    labels <- names(args)
    if (is.null(labels)) return(NULL)
    indexes <- which(labels == name)
    if (!length(indexes)) return(NULL)
    args[[indexes[[1]]]]
  }

  yaml_read_is_dynamic <- function(expr) {
    args <- as.list(expr)[-1]
    labels <- names(args)
    if (is.null(labels)) return(FALSE)
    handler_indexes <- which(labels == 'handlers')
    if (length(handler_indexes)) {
      handlers <- args[[handler_indexes[[1]]]]
      empty_handlers <- is.null(handlers) ||
        (is.call(handlers) && call_operator(handlers) %in% c('c', 'list') && length(handlers) == 1L)
      if (!empty_handlers) return(TRUE)
    }
    indexes <- which(labels == 'eval.expr')
    if (!length(indexes)) return(FALSE)
    !identical(args[[indexes[[1]]]], FALSE)
  }

  external_read_handle_root <- function(expr) {
    for (name in c('con', 'file', 'path', 'input', 'dsn', 'txt', 'x', 'filename', 'file_path')) {
      root <- root_name(named_argument(expr, name))
      if (!is.null(root)) return(root)
    }
    args <- as.list(expr)[-1]
    labels <- names(args)
    if (!length(args)) return(NULL)
    if (is.null(labels)) return(root_name(args[[1]]))
    positional <- which(is.na(labels) | !nzchar(labels))
    if (!length(positional)) return(NULL)
    root_name(args[[positional[[1]]]])
  }

  static_package_name <- function(expr) {
    if (!is.call(expr) || length(expr) < 2L) return(NULL)
    package <- expr[[2]]
    if (is.symbol(package)) return(as.character(package))
    if (is.character(package) && length(package) == 1L) return(package)
    NULL
  }

  root_name <- function(expr) {
    if (is.symbol(expr)) return(as.character(expr))
    op <- call_operator(expr)
    if (!is.null(op) && op %in% c('$', '@', '[[', '[')) return(root_name(expr[[2]]))
    if (!is.null(op) && op == 'slot' && length(expr) >= 2L) return(root_name(expr[[2]]))
    name <- called_name(expr)
    if (!is.null(name) && name %in% c(bioc_value_accessors, bioc_unknown_accessors) && length(expr) >= 2L) return(root_name(expr[[2]]))
    NULL
  }

  bioc_replacement_accessor <- function(expr) {
    name <- called_name(expr)
    if (!is.null(name) && name %in% c(bioc_value_accessors, bioc_unknown_accessors)) return(name)
    op <- call_operator(expr)
    if (!is.null(op) && op %in% c('$', '@', '[[', '[', 'slot') && length(expr) >= 2L) return(bioc_replacement_accessor(expr[[2]]))
    NULL
  }

  static_scalar_expression <- function(expr) {
    if (is.atomic(expr) && length(expr) == 1L) return(TRUE)
    if (is.symbol(expr)) return(as.character(expr) %in% c('pi'))
    if (!is.call(expr)) return(FALSE)
    op <- call_operator(expr)
    if (is.null(op) || !op %in% c('+', '-', '*', '/', '^')) return(FALSE)
    all(vapply(as.list(expr)[-1], static_scalar_expression, logical(1)))
  }

  static_nonempty_iterable <- function(expr) {
    if (!is.call(expr)) return(FALSE)
    op <- call_operator(expr)
    args <- as.list(expr)[-1]
    if (identical(op, ':') && length(args) == 2L && all(vapply(args, static_scalar_expression, logical(1)))) return(TRUE)
    if (identical(op, 'c') && length(args) > 0L && all(vapply(args, static_scalar_expression, logical(1)))) return(TRUE)
    FALSE
  }

  tribble_column_declaration <- function(expr) {
    is.call(expr) && identical(call_operator(expr), '~') && length(expr) == 2L && is.symbol(expr[[2]])
  }

  effect_only_loop_body <- function(expr) {
    if (!is.call(expr)) return(TRUE)
    op <- call_operator(expr)
    if (!is.null(op) && op %in% c('<-', '=', '->', '<<-', '->>', 'if', 'for', 'while', 'repeat', 'switch', 'function', 'break', 'next', 'return', '&&', '||')) return(FALSE)
    all(vapply(as.list(expr)[-1], effect_only_loop_body, logical(1)))
  }

  copy_on_modify_sources <- function(expr) {
    if (is.null(expr) || is.atomic(expr)) return(character())
    if (is.symbol(expr)) {
      name <- as.character(expr)
      if (name %in% copy_on_modify) return(character())
      matching <- Filter(function(binding) identical(binding$target, name), copy_on_modify_bindings)
      if (length(matching)) return(unlist(matching[[length(matching)]]$sourceNames, use.names = FALSE))
      if (name %in% copy_on_modify_invalidated) return(NULL)
      if (name %in% defined) return(NULL)
      return(name)
    }
    if (!is.call(expr)) return(NULL)
    op <- call_operator(expr)
    qualified <- qualified_call(expr)
    constructors <- c('list', 'c', 'numeric', 'integer', 'logical', 'character', 'complex', 'raw', 'matrix', 'array', 'data.frame', 'factor', 'structure', tibble_constructor_calls)
    value_ops <- c('+', '-', '*', '/', '^', ':')
    if (is.null(op) && !is.null(qualified) && qualified$package == 'tibble' && qualified$name %in% tibble_constructor_calls) op <- qualified$name
    if (is.null(op) && !is.null(qualified) && qualified_value_file_read(qualified$package, qualified$name)) {
      if (qualified$package == 'yaml' && qualified$name %in% yaml_value_read_calls && yaml_read_is_dynamic(expr)) return(NULL)
      return(character())
    }
    if (!is.null(op) && op %in% value_file_read_calls) {
      if (op %in% yaml_value_read_calls && yaml_read_is_dynamic(expr)) return(NULL)
      return(character())
    }
    transform_name <- tabular_transform_name(expr)
    if (!is.null(op) && op %in% pipe_ops && length(expr) >= 3L) {
      data_sources <- copy_on_modify_sources(expr[[2]])
      rhs <- expr[[3]]
      transform_name <- tabular_transform_name(rhs)
      if (is.null(data_sources) || is.null(transform_name) || !transform_name %in% tabular_transform_calls) return(NULL)
      if (!transform_name %in% c('mutate', 'transmute', 'summarise', 'summarize')) return(data_sources)
      added_values <- as.list(rhs)[-1]
      added_sources <- lapply(added_values, function(value) {
        if (is.atomic(value)) return(character())
        if (is.symbol(value)) return(copy_on_modify_sources(value))
        value_op <- call_operator(value)
        if (!is.null(value_op) && value_op %in% constructors) return(copy_on_modify_sources(value))
        if (!is.null(value_op) && value_op %in% c(value_ops, pure_safe_calls)) return(character())
        NULL
      })
      if (any(vapply(added_sources, is.null, logical(1)))) return(NULL)
      return(unique(c(data_sources, unlist(added_sources, use.names = FALSE))))
    }
    if (!is.null(transform_name) && transform_name %in% tabular_transform_calls && length(expr) >= 2L) {
      data_sources <- copy_on_modify_sources(expr[[2]])
      if (is.null(data_sources)) return(NULL)
      if (!transform_name %in% c('mutate', 'transmute', 'summarise', 'summarize')) return(data_sources)
      added_values <- as.list(expr)[-c(1, 2)]
      added_sources <- lapply(added_values, function(value) {
        if (is.atomic(value)) return(character())
        if (is.symbol(value)) return(copy_on_modify_sources(value))
        value_op <- call_operator(value)
        if (!is.null(value_op) && value_op %in% constructors) return(copy_on_modify_sources(value))
        if (!is.null(value_op) && value_op %in% c(value_ops, pure_safe_calls)) return(character())
        NULL
      })
      if (any(vapply(added_sources, is.null, logical(1)))) return(NULL)
      return(unique(c(data_sources, unlist(added_sources, use.names = FALSE))))
    }
    if (is.null(op) || !op %in% c(constructors, value_ops)) return(NULL)
    args <- as.list(expr)[-1]
    if (identical(op, 'tribble')) args <- Filter(Negate(tribble_column_declaration), args)
    sources <- lapply(args, copy_on_modify_sources)
    if (any(vapply(sources, is.null, logical(1)))) return(NULL)
    unique(unlist(sources, use.names = FALSE))
  }

  walk_assignment_target <- function(target) {
    op <- call_operator(target)
    if (is.null(op)) return()
    if (op %in% c('$', '@')) {
      walk(target[[2]])
      return()
    }
    if (op %in% c('[[', '[', 'slot')) {
      target_args <- as.list(target)[-1]
      for (index in seq_along(target_args)) walk(target_args[[index]])
    }
  }

  add_possible_alias <- function(target, source, access = NULL, member = NULL) {
    possible_aliases[[length(possible_aliases) + 1L]] <<- c(list(target = target, source = source, kind = 'possible-reference'), if (!is.null(access)) list(access = access) else list(), if (!is.null(member)) list(member = member) else list())
  }

  method_effect <- function(fn, receivers = c('self', 'private'), copy_on_modify = FALSE) {
    effect <- 'read'
    namespace_unknown <- FALSE
    mark_mutate <- function(conditional = FALSE) {
      if (conditional || copy_on_modify) effect <<- 'unknown'
      else if (effect != 'unknown') effect <<- 'mutate'
    }
    mark_unknown <- function(namespace = FALSE) {
      effect <<- 'unknown'
      if (namespace) namespace_unknown <<- TRUE
    }
    inspect <- function(expr, conditional = FALSE) {
      if (!is.call(expr)) return()
      op <- call_operator(expr)
      if (!is.null(op) && op %in% c('<-', '=', '->', '<<-', '->>')) {
        rightward <- op %in% c('->', '->>')
        target <- if (rightward) expr[[3]] else expr[[2]]
        value <- if (rightward) expr[[2]] else expr[[3]]
        target_root <- root_name(target)
        if (target_root %in% receivers) mark_mutate(conditional)
        else if (!is.symbol(target) || op %in% c('<<-', '->>')) mark_unknown(TRUE)
        inspect(value, conditional)
        return()
      }
      if (identical(op, 'function')) {
        mark_unknown()
        return()
      }
      if (is.null(op)) {
        receiver <- root_name(expr[[1]])
        if (receiver %in% receivers) mark_unknown(TRUE) else mark_unknown(TRUE)
        args <- as.list(expr)[-1]
        for (index in seq_along(args)) inspect(args[[index]], conditional)
        return()
      }
      if (op %in% c('if', 'for', 'while', 'repeat', 'switch')) {
        args <- as.list(expr)[-1]
        for (index in seq_along(args)) inspect(args[[index]], TRUE)
        return()
      }
      syntax <- c('{', '(', 'if', 'for', 'while', 'repeat', '+', '-', '*', '/', '^', ':', '::', ':::', '[[', '[', '$', '@', '!', '&', '&&', '|', '||', '<', '>', '<=', '>=', '==', '!=')
      if (!op %in% c(syntax, safe_calls, 'function')) mark_unknown(TRUE)
      args <- as.list(expr)[-1]
      for (index in seq_along(args)) inspect(args[[index]], conditional)
    }
    if (!identical(call_operator(fn), 'function') || length(fn) < 3L) return(list(effect = 'unknown', unknownScope = 'namespace'))
    body <- fn[[3]]
    inspect(body)
    list(effect = effect, unknownScope = if (namespace_unknown) 'namespace' else NULL)
  }

  method_local_names <- function(fn) {
    if (!identical(call_operator(fn), 'function') || length(fn) < 3L) return(character())
    formals <- names(fn[[2]])
    locals <- if (is.null(formals)) character() else formals
    collect_locals <- function(expr) {
      if (!is.call(expr)) return()
      op <- call_operator(expr)
      if (identical(op, 'function')) return()
      if (!is.null(op) && op %in% c('<-', '=', '->')) {
        target <- if (op == '->') expr[[3]] else expr[[2]]
        value <- if (op == '->') expr[[2]] else expr[[3]]
        if (is.symbol(target)) locals <<- c(locals, as.character(target))
        collect_locals(value)
        return()
      }
      args <- as.list(expr)[-1]
      for (index in seq_along(args)) collect_locals(args[[index]])
    }
    collect_locals(fn[[3]])
    unique(locals)
  }

  method_used_names <- function(fn, receivers = c('self', 'private')) {
    if (!identical(call_operator(fn), 'function') || length(fn) < 3L) return(character())
    locals <- method_local_names(fn)
    used_names <- character()
    collect_used <- function(expr) {
      if (is.symbol(expr)) {
        name <- as.character(expr)
        if (nzchar(name) && !name %in% c(locals, receivers)) used_names <<- c(used_names, name)
        return()
      }
      if (!is.call(expr)) return()
      op <- call_operator(expr)
      if (identical(op, 'function')) return()
      if (!is.null(op) && op %in% c('<-', '=', '->', '<<-', '->>')) {
        rightward <- op %in% c('->', '->>')
        target <- if (rightward) expr[[3]] else expr[[2]]
        value <- if (rightward) expr[[2]] else expr[[3]]
        if (!is.symbol(target)) collect_used(target[[2]])
        collect_used(value)
        return()
      }
      if (!is.null(op) && op %in% c('$', '@', 'slot')) {
        collect_used(expr[[2]])
        return()
      }
      if (!is.null(op) && op %in% c('::', ':::')) return()
      syntax_ops <- c('{', '(', 'if', 'for', 'while', 'repeat', 'switch', '+', '-', '*', '/', '^', ':', '[[', '[', '!', '&', '&&', '|', '||', '<', '>', '<=', '>=', '==', '!=')
      if (!is.null(op) && !op %in% syntax_ops && !op %in% receivers) used_names <<- c(used_names, op)
      args <- as.list(expr)[-1]
      for (index in seq_along(args)) collect_used(args[[index]])
    }
    collect_used(fn[[3]])
    sort(unique(used_names))
  }

  method_safe_call_names <- function(fn) {
    if (!identical(call_operator(fn), 'function') || length(fn) < 3L) return(character())
    calls <- character()
    collect <- function(expr) {
      if (!is.call(expr)) return()
      op <- call_operator(expr)
      if (identical(op, 'function')) return()
      if (!is.null(op) && op %in% safe_calls) calls <<- c(calls, op)
      args <- as.list(expr)[-1]
      for (index in seq_along(args)) collect(args[[index]])
    }
    collect(fn[[3]])
    sort(unique(calls))
  }

  value_relationship <- function(expr) {
    if (is.atomic(expr) || is.null(expr)) return('value')
    name <- called_name(expr)
    if (!is.null(name) && name %in% c('new.env', 'environment')) return('reference')
    if (!is.null(name) && name %in% c('c', 'list', 'data.frame', 'matrix', 'array', 'numeric', 'integer', 'logical', 'character', 'factor')) return('value')
    if (is.call(expr) && is.null(call_operator(expr)) && identical(member_name(expr[[1]]), 'new')) return('reference')
    'unknown'
  }

  summarize_r6 <- function(name, value) {
    if (!identical(called_name(value), 'R6Class')) return(NULL)
    if (!is.null(named_argument(value, 'inherit')) || !is.null(named_argument(value, 'active'))) return(NULL)
    public <- named_argument(value, 'public')
    if (is.null(public) || call_operator(public) != 'list') return(NULL)
    entries <- as.list(public)[-1]
    labels <- names(entries)
    if (is.null(labels) || any(!nzchar(labels))) return(NULL)
    fields <- list()
    methods <- list()
    for (index in seq_along(entries)) {
      entry_name <- labels[[index]]
      entry <- entries[[index]]
      if (identical(call_operator(entry), 'function')) {
        analysis <- method_effect(entry)
        safe_call_names <- method_safe_call_names(entry)
        shadowed_safe_calls <- intersect(safe_call_names, method_local_names(entry))
        if (length(shadowed_safe_calls)) analysis <- list(effect = 'unknown', unknownScope = 'namespace')
        methods[[length(methods) + 1L]] <- list(name = entry_name, effect = analysis$effect, usedNames = as.list(method_used_names(entry)), safeCallNames = as.list(setdiff(safe_call_names, shadowed_safe_calls)), unknownScope = if (is.null(analysis$unknownScope)) 'receiver' else analysis$unknownScope)
      }
      else fields[[length(fields) + 1L]] <- list(name = entry_name, relationship = value_relationship(entry))
    }
    list(name = name, kind = 'r-r6', fields = fields, methods = methods)
  }

  summarize_s4 <- function(expr) {
    if (!identical(called_name(expr), 'setClass') || length(expr) < 2L || !is.character(expr[[2]])) return(NULL)
    name <- as.character(expr[[2]])
    slots <- named_argument(expr, 'slots')
    fields <- list()
    if (!is.null(slots) && call_operator(slots) == 'c') {
      entries <- as.list(slots)[-1]
      labels <- names(entries)
      if (!is.null(labels)) for (index in seq_along(entries)) {
        slot_type <- if (is.character(entries[[index]])) as.character(entries[[index]]) else 'ANY'
        relationship <- if (slot_type == 'environment') 'reference' else if (slot_type %in% c('ANY', 'externalptr', 'weakref', 'list')) 'unknown' else 'value'
        fields[[length(fields) + 1L]] <- list(name = labels[[index]], relationship = relationship)
      }
    }
    list(name = name, kind = 'r-s4', fields = fields, methods = list())
  }

  summarize_s4_method <- function(expr) {
    if (!identical(called_name(expr), 'setMethod')) return(NULL)
    args <- as.list(expr)[-1]
    method_name <- named_argument(expr, 'f')
    if (is.null(method_name) && length(args) >= 1L) method_name <- args[[1]]
    signature <- named_argument(expr, 'signature')
    if (is.null(signature) && length(args) >= 2L) signature <- args[[2]]
    definition <- named_argument(expr, 'definition')
    if (is.null(definition)) {
      functions <- Filter(function(arg) identical(call_operator(arg), 'function'), args)
      if (length(functions)) definition <- functions[[length(functions)]]
    }
    if (!is.character(method_name) || length(method_name) != 1L || !is.character(signature) || length(signature) != 1L || !identical(call_operator(definition), 'function')) return(NULL)
    formals <- definition[[2]]
    receiver <- if (length(formals) && !is.null(names(formals))) names(formals)[[1]] else NULL
    if (is.null(receiver) || !nzchar(receiver)) return(NULL)
    analysis <- method_effect(definition, receiver, TRUE)
    safe_call_names <- method_safe_call_names(definition)
    shadowed_safe_calls <- intersect(safe_call_names, method_local_names(definition))
    if (length(shadowed_safe_calls)) analysis <- list(effect = 'unknown', unknownScope = 'namespace')
    method <- list(name = as.character(method_name), effect = analysis$effect, usedNames = as.list(method_used_names(definition, receiver)), safeCallNames = as.list(setdiff(safe_call_names, shadowed_safe_calls)), unknownScope = if (is.null(analysis$unknownScope)) 'receiver' else analysis$unknownScope)
    list(name = as.character(signature), kind = 'r-s4', complete = FALSE, fields = list(), methods = list(method))
  }

  constructor_type <- function(expr) {
    if (!is.call(expr)) return(NULL)
    if (!is.null(data_table_query(expr))) return('data.table')
    qualified <- qualified_call(expr)
    name <- called_name(expr)
    if (!is.null(qualified) && qualified$package == 'data.table' && qualified$name %in% c(data_table_constructor_calls, 'copy')) return('data.table')
    if (!is.null(name) && name %in% c(data_table_constructor_calls, 'copy')) return('data.table')
    if (!is.null(name) && name %in% bioc_constructor_calls) return(name)
    if (identical(name, 'new') && length(expr) >= 2L && is.character(expr[[2]])) return(as.character(expr[[2]]))
    if (is.null(call_operator(expr)) && is.call(expr[[1]]) && identical(member_name(expr[[1]]), 'new')) return(root_name(expr[[1]]))
    NULL
  }

  add_data_table_summary <- function() {
    if (!any(vapply(type_summaries, function(summary) identical(summary$name, 'data.table'), logical(1)))) {
      type_summaries[[length(type_summaries) + 1L]] <<- list(name = 'data.table', kind = 'r-r6', fields = list(), methods = list())
    }
  }

  add_bioc_summary <- function(name) {
    common_fields <- c('assay', 'assays', 'colData', 'rowData', 'rowRanges')
    fields <- if (identical(name, 'SingleCellExperiment')) c(common_fields, 'altExp', 'altExps', 'colLabels', 'logcounts', 'normcounts', 'reducedDim', 'reducedDims', 'rowSubset', 'sizeFactors') else if (identical(name, 'ExpressionSet')) c('exprs', 'fData', 'featureData', 'pData') else common_fields
    field_summaries <- lapply(fields, function(field) list(name = field, relationship = 'unknown'))
    field_summaries[[length(field_summaries) + 1L]] <- list(name = if (identical(name, 'ExpressionSet')) 'experimentData' else 'metadata', relationship = 'unknown')
    accessors <- unique(c(fields, if (identical(name, 'ExpressionSet')) 'experimentData' else 'metadata'))
    methods <- lapply(accessors, function(accessor) list(name = accessor, effect = 'read', usedNames = list(), safeCallNames = list(), unknownScope = 'receiver'))
    type_summaries[[length(type_summaries) + 1L]] <<- list(name = name, kind = 'r-s4', fields = field_summaries, methods = methods)
  }

  add_data_frame_summary <- function() {
    type_summaries[[length(type_summaries) + 1L]] <<- list(name = 'data.frame', kind = 'r-s4', fields = list(), methods = list())
  }

  data_table_update <- function(expr) {
    if (!identical(call_operator(expr), '[') || length(expr) < 4L) return(NULL)
    update_box <- as.list(expr)[4L]
    if (identical(update_box, list(quote(expr=)))) return(NULL)
    update <- update_box[[1]]
    if (!is.call(update) || !identical(call_operator(update), ':=')) return(NULL)
    list(update = update)
  }

  data_table_query <- function(expr) {
    if (!identical(call_operator(expr), '[') || length(expr) < 4L) return(NULL)
    if (!is.null(data_table_update(expr))) return(NULL)
    args <- as.list(expr)[-1]
    labels <- names(args)
    j_box <- as.list(expr)[4L]
    if (identical(j_box, list(quote(expr=)))) return(NULL)
    j <- j_box[[1]]
    has_data_table_clause <-
      (!is.null(labels) && any(labels %in% c('by', 'keyby', '.SDcols'))) ||
      (is.call(j) && identical(call_operator(j), '.'))
    if (!has_data_table_clause) return(NULL)
    list()
  }

  walk_data_table_mask <- function(expr) {
    if (is.call(expr) && identical(call_operator(expr), '.')) {
      values <- as.list(expr)[-1]
      for (index in seq_along(values)) walk_data_mask(values[[index]], TRUE)
      return()
    }
    walk_data_mask(expr, TRUE)
  }

  walk_data_table_query <- function(expr) {
    receiver <- root_name(expr[[2]])
    if (is.null(receiver)) {
      unknown <<- c(unknown, 'opaque-call')
      return()
    }
    used <<- c(used, receiver)
    if (!receiver %in% defined) prior_used <<- c(prior_used, receiver)
    add_data_table_summary()
    args <- as.list(expr)[-1]
    for (index in seq_along(args)) {
      if (index == 1L) next
      if (is.symbol(args[[index]]) && !nzchar(as.character(args[[index]]))) next
      walk_data_table_mask(args[[index]])
    }
  }

  walk_data_table_update <- function(expr, update) {
    receiver <- root_name(expr[[2]])
    if (is.null(receiver)) {
      unknown <<- c(unknown, 'dynamic-assignment')
      return()
    }
    used <<- c(used, receiver)
    if (!receiver %in% defined) prior_used <<- c(prior_used, receiver)
    mutated <<- c(mutated, receiver)
    add_data_table_summary()
    type_bindings[[length(type_bindings) + 1L]] <<- list(target = receiver, typeName = 'data.table', argumentNames = list())
    receiver_calls[[length(receiver_calls) + 1L]] <<- list(receiver = receiver, member = ':=', kind = 'mutating', argumentNames = list())
    update_args <- as.list(update)[-1]
    update_labels <- names(update_args)
    if (!is.null(update_labels) && any(nzchar(update_labels))) {
      for (index in seq_along(update_args)) walk_data_mask(update_args[[index]], TRUE)
    } else if (length(update_args) > 1L) {
      for (index in seq.int(2L, length(update_args))) walk_data_mask(update_args[[index]], TRUE)
    }
    outer_args <- as.list(expr)[-1]
    for (index in seq_along(outer_args)) {
      if (index %in% c(1L, 3L)) next
      if (is.symbol(outer_args[[index]]) && !nzchar(as.character(outer_args[[index]]))) next
      walk_data_mask(outer_args[[index]], TRUE)
    }
  }

  prepare_assignment <- function(name) {
    conditional <- control_depth > 0L
    type_bindings <<- Filter(function(binding) !identical(binding$target, name), type_bindings)
    copy_on_modify <<- setdiff(copy_on_modify, name)
    copy_on_modify_bindings <<- Filter(function(binding) !identical(binding$target, name), copy_on_modify_bindings)
    copy_on_modify_invalidated <<- setdiff(copy_on_modify_invalidated, name)
    if (conditional) unknown <<- c(unknown, 'control-flow')
    for (target in names(aliases)) {
      alias <- aliases[[target]]
      if (!is.null(alias) && identical(alias$source, name)) {
        add_possible_alias(target, name)
        aliases[[target]] <<- NULL
        unknown <<- c(unknown, 'alias-rebind')
      }
    }
    existing <- aliases[[name]]
    if (!is.null(existing)) {
      if (conditional) {
        add_possible_alias(name, existing$source)
      } else {
        index <- match(existing$source, used)
        if (!is.na(index)) used <<- used[-index]
        prior_index <- match(existing$source, prior_used)
        if (!is.na(prior_index)) prior_used <<- prior_used[-prior_index]
      }
    }
    aliases[[name]] <<- NULL
  }

  update_copy_on_modify_member <- function(name, value) {
    root_sources <- copy_on_modify_sources(as.name(name))
    member_sources <- copy_on_modify_sources(value)
    copy_on_modify <<- setdiff(copy_on_modify, name)
    copy_on_modify_bindings <<- Filter(function(binding) !identical(binding$target, name), copy_on_modify_bindings)
    copy_on_modify_invalidated <<- setdiff(copy_on_modify_invalidated, name)
    if (is.null(root_sources) || is.null(member_sources)) {
      copy_on_modify_invalidated <<- c(copy_on_modify_invalidated, name)
      return()
    }
    sources <- unique(c(root_sources, member_sources))
    if (!length(sources)) copy_on_modify <<- c(copy_on_modify, name)
    else copy_on_modify_bindings[[length(copy_on_modify_bindings) + 1L]] <<- list(target = name, sourceNames = as.list(sources))
  }

  walk_data_mask <- function(expr, track_environment = FALSE) {
    if (is.symbol(expr)) {
      name <- as.character(expr)
      if (track_environment && nzchar(name) && !name %in% c('.data', '.env')) possibly_used <<- c(possibly_used, name)
      return()
    }
    if (!is.call(expr)) return()
    op <- call_operator(expr)
    if (!is.null(op) && op %in% c('$', '[[') && length(expr) >= 3L && is.symbol(expr[[2]]) && as.character(expr[[2]]) %in% c('.env', '.data')) {
      pronoun <- as.character(expr[[2]])
      key <- expr[[3]]
      name <- if (op == '$' && is.symbol(key)) as.character(key) else if (is.character(key) && length(key) == 1L) key else NULL
      if (is.null(name)) {
        unknown <<- c(unknown, 'dynamic-data-mask-lookup')
        return()
      }
      if (pronoun == '.env') {
        used <<- c(used, name)
        if (!name %in% defined) prior_used <<- c(prior_used, name)
      }
      return()
    }
    qualified <- qualified_call(expr)
    if (is.null(op) && !is.null(qualified)) {
      if (known_qualified_call(qualified$package, qualified$name)) op <- qualified$name
      else unknown <<- c(unknown, 'opaque-call')
    }
    if (is.null(op) && is.call(expr[[1]])) {
      callee_op <- call_operator(expr[[1]])
      if (!is.null(callee_op) && callee_op %in% c('$', '[[') && length(expr[[1]]) >= 3L && is.symbol(expr[[1]][[2]])) {
        pronoun <- as.character(expr[[1]][[2]])
        key <- expr[[1]][[3]]
        name <- if (callee_op == '$' && is.symbol(key)) as.character(key) else if (is.character(key) && length(key) == 1L) key else NULL
        if (pronoun == '.env' && !is.null(name)) {
          used <<- c(used, name)
          if (!name %in% defined) prior_used <<- c(prior_used, name)
        }
        unknown <<- c(unknown, if (is.null(name)) 'dynamic-data-mask-lookup' else 'opaque-call')
      }
    }
    dependency_name <- if (is.null(qualified)) op else paste0(qualified$package, '::', qualified$name)
    syntax <- c('{', '(', '+', '-', '*', '/', '^', ':', '[[', '[', '$', '@', '!', '&', '&&', '|', '||', '<', '>', '<=', '>=', '==', '!=', '~')
    if (!is.null(op) && !op %in% syntax) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      if (op %in% safe_calls) safe_call_names <<- c(safe_call_names, dependency_name)
      else unknown <<- c(unknown, 'opaque-call')
    }
    args <- as.list(expr)[-1]
    for (index in seq_along(args)) walk_data_mask(args[[index]], track_environment)
  }

  walk <- function(expr, assignment_target = FALSE) {
    if (is.symbol(expr)) {
      name <- as.character(expr)
      if (!nzchar(name)) return()
      if (!assignment_target && name %in% local_names) return()
      if (assignment_target) defined <<- c(defined, name) else {
        used <<- c(used, name)
        if (!name %in% defined) prior_used <<- c(prior_used, name)
      }
      return()
    }
    if (!is.call(expr)) return()
    op <- call_operator(expr)
    qualified <- qualified_call(expr)
    if (is.null(op) && !is.null(qualified) && known_qualified_call(qualified$package, qualified$name)) op <- qualified$name
    dependency_name <- if (is.null(qualified)) op else paste0(qualified$package, '::', qualified$name)

    s4_summary <- summarize_s4(expr)
    if (!is.null(s4_summary)) {
      type_summaries[[length(type_summaries) + 1L]] <<- s4_summary
      return()
    }
    s4_method_summary <- summarize_s4_method(expr)
    if (!is.null(s4_method_summary)) {
      type_summaries[[length(type_summaries) + 1L]] <<- s4_method_summary
      return()
    }

    table_update <- data_table_update(expr)
    if (!is.null(table_update)) {
      walk_data_table_update(expr, table_update$update)
      return()
    }
    if (!is.null(data_table_query(expr))) {
      walk_data_table_query(expr)
      return()
    }

    if (!is.null(op) && op %in% c(bioc_value_accessors, bioc_unknown_accessors)) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      safe_call_names <<- c(safe_call_names, dependency_name)
      receiver <- if (length(expr) >= 2L) root_name(expr[[2]]) else NULL
      if (is.null(receiver)) unknown <<- c(unknown, 'opaque-call')
      else {
        used <<- c(used, receiver)
        if (!receiver %in% defined) prior_used <<- c(prior_used, receiver)
        argument_roots <- unique(Filter(Negate(is.null), lapply(as.list(expr)[-1], root_name)))
        receiver_calls[[length(receiver_calls) + 1L]] <<- list(receiver = receiver, member = op, kind = 'generic', argumentNames = unname(unlist(argument_roots)))
      }
      args <- as.list(expr)[-1]
      for (index in seq_along(args)) walk(args[[index]])
      return()
    }

    # Calls through an object member are R6/Reference Class (or another opaque callable member)
    # from syntax alone. Scope uncertainty to the receiver instead of tainting every R run.
    if (is.null(op)) {
      receiver <- root_name(expr[[1]])
      if (!is.null(receiver)) {
        used <<- c(used, receiver)
        if (!receiver %in% defined) prior_used <<- c(prior_used, receiver)
        member <- member_name(expr[[1]])
        if (!is.null(member)) {
          argument_roots <- unique(Filter(Negate(is.null), lapply(as.list(expr)[-1], root_name)))
          receiver_calls[[length(receiver_calls) + 1L]] <<- list(receiver = receiver, member = member, argumentNames = unname(unlist(argument_roots)))
        }
        else {
          possibly_mutated <<- c(possibly_mutated, receiver)
          unknown <<- c(unknown, 'opaque-mutation')
        }
      } else {
        unknown <<- c(unknown, 'opaque-call')
      }
      args <- as.list(expr)[-1]
      for (index in seq_along(args)) walk(args[[index]])
      return()
    }

    if (op %in% c('<-', '=', '->', '<<-', '->>')) {
      rightward <- op %in% c('->', '->>')
      nonlocal <- op %in% c('<<-', '->>')
      target <- if (rightward) expr[[3]] else expr[[2]]
      value <- if (rightward) expr[[2]] else expr[[3]]
      name <- root_name(target)
      defined_before <- unique(defined)
      used_before <- length(used)
      r6_summary <- NULL
      constructed_type <- NULL
      simple_alias_assignment <- FALSE
      if (!is.null(name)) {
        if (nonlocal) {
          used <<- c(used, name)
          possibly_mutated <<- c(possibly_mutated, name)
          unknown <<- c(unknown, 'nonlocal-assignment')
        } else if (is.symbol(target)) {
          copy_sources <- copy_on_modify_sources(value)
          defined <<- c(defined, name)
          prepare_assignment(name)
          if (!is.null(copy_sources)) {
            if (!length(copy_sources)) copy_on_modify <<- c(copy_on_modify, name)
            else copy_on_modify_bindings[[length(copy_on_modify_bindings) + 1L]] <<- list(target = name, sourceNames = as.list(copy_sources))
          }
          r6_summary <- summarize_r6(name, value)
          constructed_type <- constructor_type(value)
          if (!is.null(r6_summary)) {
            type_summaries[[length(type_summaries) + 1L]] <<- r6_summary
          } else if (!is.null(constructed_type)) {
            if (identical(constructed_type, 'data.table')) add_data_table_summary()
            else if (constructed_type %in% bioc_constructor_calls) add_bioc_summary(constructed_type)
            constructor_roots <- unique(Filter(Negate(is.null), lapply(as.list(value)[-1], root_name)))
            type_bindings[[length(type_bindings) + 1L]] <<- list(target = name, typeName = constructed_type, argumentNames = unname(unlist(constructor_roots)))
          } else if (is.symbol(value)) {
            simple_alias_assignment <- TRUE
            source <- as.character(value)
            canonical <- aliases[[source]]
            resolved <- if (is.null(canonical)) source else canonical$source
            if (control_depth > 0L) add_possible_alias(name, resolved)
            else aliases[[name]] <<- list(target = name, source = resolved, kind = 'possible-reference')
          } else {
            source <- root_name(value)
            if (!is.null(source)) {
              value_op <- call_operator(value)
              access <- if (!is.null(value_op) && value_op %in% c('[[', '[')) 'subscript' else 'attribute'
              add_possible_alias(name, source, access, member_name(value))
            }
          }
        } else {
          used <<- c(used, name)
          mutated <<- c(mutated, name)
          update_copy_on_modify_member(name, value)
          replacement_accessor <- bioc_replacement_accessor(target)
          if (is.null(replacement_accessor)) {
            member <- member_name(target)
            member_writes[[length(member_writes) + 1L]] <<- c(list(receiver = name), if (is.null(member)) list() else list(member = member))
          } else {
            value_root <- root_name(value)
            receiver_calls[[length(receiver_calls) + 1L]] <<- list(receiver = name, member = replacement_accessor, kind = 'generic', argumentNames = if (is.null(value_root)) list() else list(value_root))
          }
          if (name %in% c('.GlobalEnv', '.BaseNamespaceEnv')) unknown <<- c(unknown, 'dynamic-namespace')
          walk_assignment_target(target)
        }
      } else unknown <<- c(unknown, 'dynamic-assignment')
      if (is.null(r6_summary) && is.null(constructed_type) && !simple_alias_assignment) walk(value)
      else if (!is.null(constructed_type)) {
        value_name <- called_name(value)
        value_qualified <- qualified_call(value)
        value_dependency <- if (is.null(value_qualified)) value_name else paste0(value_qualified$package, '::', value_qualified$name)
        if (!is.null(value_name) && value_name %in% c(data_table_constructor_calls, 'copy', bioc_constructor_calls)) {
          used <<- c(used, value_dependency)
          if (!value_dependency %in% defined) prior_used <<- c(prior_used, value_dependency)
          safe_call_names <<- c(safe_call_names, value_dependency)
          if (identical(value_name, 'fread')) unknown <<- c(unknown, 'external-state')
        }
        if (!is.null(data_table_query(value))) {
          walk_data_table_query(value)
        } else {
          if (is.call(value) && is.null(call_operator(value))) {
            constructor_root <- root_name(value[[1]])
            if (!is.null(constructor_root)) used <<- c(used, constructor_root)
          }
          value_args <- as.list(value)[-1]
          for (index in seq_along(value_args)) if (!is.character(value_args[[index]])) walk(value_args[[index]])
        }
      }
      if (length(used) > used_before) {
        assignment_reads <- used[seq.int(used_before + 1L, length(used))]
        new_prior_reads <- setdiff(assignment_reads, defined_before)
        prior_used <<- c(prior_used, setdiff(new_prior_reads, prior_used))
      }
      return()
    }
    if (op == 'assign') unknown <<- c(unknown, 'dynamic-assignment')
    if (op %in% c('get', 'eval', 'parse', 'substitute', 'do.call')) unknown <<- c(unknown, 'dynamic-namespace')
    if (op %in% c('library', 'require')) {
      package <- static_package_name(expr)
      if (!is.null(package) && package %in% known_attached_packages) {
        used <<- c(used, op)
        if (!op %in% defined) prior_used <<- c(prior_used, op)
        safe_call_names <<- c(safe_call_names, op)
        return()
      }
      unknown <<- c(unknown, 'dynamic-namespace')
    }
    if (op %in% c('attach', 'detach', 'load', 'source', 'sys.source')) unknown <<- c(unknown, 'dynamic-namespace')
    if (op %in% data_table_reference_mutators) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      safe_call_names <<- c(safe_call_names, dependency_name)
      if (length(expr) >= 2L) {
        receiver <- root_name(expr[[2]])
        if (is.null(receiver)) unknown <<- c(unknown, 'dynamic-assignment')
        else {
          used <<- c(used, receiver)
          if (!receiver %in% defined) prior_used <<- c(prior_used, receiver)
          mutated <<- c(mutated, receiver)
          if (identical(op, 'setDT')) {
            add_data_table_summary()
            type_bindings[[length(type_bindings) + 1L]] <<- list(target = receiver, typeName = 'data.table', argumentNames = list())
          } else if (identical(op, 'setDF')) {
            add_data_frame_summary()
            type_bindings[[length(type_bindings) + 1L]] <<- list(target = receiver, typeName = 'data.frame', argumentNames = list())
          }
          receiver_calls[[length(receiver_calls) + 1L]] <<- list(receiver = receiver, member = dependency_name, kind = 'mutating', argumentNames = list())
        }
      }
      args <- as.list(expr)[-1]
      if (length(args) > 1L) for (index in seq.int(2L, length(args))) walk(args[[index]])
      return()
    }
    if (op %in% external_read_calls) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      safe_call_names <<- c(safe_call_names, dependency_name)
      unknown <<- c(unknown, 'external-state')
      args <- as.list(expr)[-1]
      if (op %in% yaml_value_read_calls && yaml_read_is_dynamic(expr)) {
        unknown <<- c(unknown, 'opaque-call', 'dynamic-namespace')
      }
      handle_root <- external_read_handle_root(expr)
      if (!is.null(handle_root)) {
        possibly_mutated <<- c(possibly_mutated, handle_root)
        unknown <<- c(unknown, 'opaque-mutation')
      }
      for (index in seq_along(args)) walk(args[[index]])
      return()
    }
    if (op == 'function') {
      unknown <<- c(unknown, 'function-scope')
      return()
    }

    # '$' and '@' member names are syntax, not free variables. Only the receiver contributes a
    # dependency; assignment to either form is handled above as a definite root-object mutation.
    if (op %in% c('$', '@')) {
      walk(expr[[2]])
      return()
    }

    args <- as.list(expr)[-1]
    if (!is.null(op) && op %in% pipe_ops && length(expr) >= 3L) {
      walk(expr[[2]])
      rhs <- expr[[3]]
      transform_name <- tabular_transform_name(rhs)
      if (!is.null(transform_name) && transform_name %in% tabular_transform_calls) {
        qualified_rhs <- qualified_call(rhs)
        dependency <- if (is.null(qualified_rhs)) transform_name else paste0(qualified_rhs$package, '::', qualified_rhs$name)
        used <<- c(used, dependency)
        if (!dependency %in% defined) prior_used <<- c(prior_used, dependency)
        safe_call_names <<- c(safe_call_names, dependency)
        rhs_args <- as.list(rhs)[-1]
        for (index in seq_along(rhs_args)) walk_data_mask(rhs_args[[index]], TRUE)
        return()
      }
      walk(rhs)
      return()
    }
    if (op %in% model_data_mask_calls) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      safe_call_names <<- c(safe_call_names, dependency_name)
      labels <- names(args)
      for (index in seq_along(args)) {
        if (!is.null(labels) && identical(labels[[index]], 'data')) walk(args[[index]])
        else walk_data_mask(args[[index]], TRUE)
      }
      return()
    }
    if (op %in% tabular_transform_calls) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      safe_call_names <<- c(safe_call_names, dependency_name)
      if (length(args)) walk(args[[1]])
      if (length(args) > 1L) {
        for (index in seq.int(2L, length(args))) walk_data_mask(args[[index]], TRUE)
      }
      return()
    }
    if (op %in% data_mask_calls) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      safe_call_names <<- c(safe_call_names, dependency_name)
      for (index in seq_along(args)) walk_data_mask(args[[index]], TRUE)
      return()
    }
    if (identical(op, 'tribble')) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
      safe_call_names <<- c(safe_call_names, dependency_name)
      values <- Filter(Negate(tribble_column_declaration), args)
      for (index in seq_along(values)) walk(values[[index]])
      return()
    }
    if (identical(op, 'for') && length(expr) >= 4L && is.symbol(expr[[2]]) && static_nonempty_iterable(expr[[3]]) && effect_only_loop_body(expr[[4]])) {
      target <- as.character(expr[[2]])
      walk(expr[[3]])
      prepare_assignment(target)
      defined <<- c(defined, target)
      previous_local_names <- local_names
      local_names <<- c(local_names, target)
      walk(expr[[4]])
      local_names <<- previous_local_names
      return()
    }
    if (op %in% c('if', 'for', 'while', 'repeat', 'switch')) {
      unknown <<- c(unknown, 'control-flow')
      control_depth <<- control_depth + 1L
      for (index in seq_along(args)) walk(args[[index]])
      control_depth <<- control_depth - 1L
      return()
    }
    syntax_ops <- c('{', '(', 'if', 'for', 'while', 'repeat', '+', '-', '*', '/', '^', ':', '::', ':::', '[[', '[', '!', '&', '&&', '|', '||', '<', '>', '<=', '>=', '==', '!=')
    if (!op %in% syntax_ops) {
      used <<- c(used, dependency_name)
      if (!dependency_name %in% defined) prior_used <<- c(prior_used, dependency_name)
    }
    roots <- unique(Filter(Negate(is.null), lapply(args, root_name)))
    if (op %in% safe_calls) {
      safe_call_names <<- c(safe_call_names, dependency_name)
      safe_call_argument_names <<- c(safe_call_argument_names, unlist(roots))
    } else if (!op %in% c(syntax_ops, 'assign', 'get', 'eval', 'parse', 'substitute', 'do.call')) {
      if (length(roots)) {
        receiver_calls[[length(receiver_calls) + 1L]] <<- list(receiver = roots[[1]], member = op, kind = 'generic', argumentNames = unname(unlist(roots)))
      } else unknown <<- c(unknown, 'opaque-call')
    }
    for (index in seq_along(args)) walk(args[[index]])
  }

  parsed <- tryCatch(parse(text = source, keep.source = FALSE), error = function(e) NULL)
  if (is.null(parsed)) return(list(state = 'unknown', reasons = list('parse-error')))
  for (expr in parsed) walk(expr)
  combined_aliases <- c(unname(aliases), possible_aliases)
    if (length(unknown)) return(list(state = 'unknown', reasons = as.list(sort(unique(unknown))), definedNames = as.list(sort(unique(defined))), usedNames = as.list(sort(unique(used))), priorUsedNames = as.list(sort(unique(prior_used))), possiblyUsedNames = as.list(sort(unique(possibly_used))), mutatedNames = as.list(sort(unique(mutated))), possiblyMutatedNames = as.list(sort(unique(possibly_mutated))), aliases = combined_aliases, copyOnModifyNames = as.list(sort(unique(copy_on_modify))), copyOnModifyBindings = copy_on_modify_bindings, copyOnModifyInvalidatedNames = as.list(sort(unique(copy_on_modify_invalidated))), safeCallNames = as.list(sort(unique(safe_call_names))), safeCallArgumentNames = as.list(sort(unique(safe_call_argument_names))), typeSummaries = type_summaries, typeBindings = type_bindings, receiverCalls = receiver_calls, memberWrites = member_writes))
  list(
    state = 'available',
    definedNames = as.list(sort(unique(defined))),
    usedNames = as.list(sort(unique(used))),
    priorUsedNames = as.list(sort(unique(prior_used))),
    possiblyUsedNames = as.list(sort(unique(possibly_used))),
    mutatedNames = as.list(sort(unique(mutated))),
    possiblyMutatedNames = as.list(sort(unique(possibly_mutated))),
    aliases = combined_aliases,
    copyOnModifyNames = as.list(sort(unique(copy_on_modify))),
    copyOnModifyBindings = copy_on_modify_bindings,
    copyOnModifyInvalidatedNames = as.list(sort(unique(copy_on_modify_invalidated))),
    safeCallNames = as.list(sort(unique(safe_call_names))),
    safeCallArgumentNames = as.list(sort(unique(safe_call_argument_names))),
    typeSummaries = type_summaries,
    typeBindings = type_bindings,
    receiverCalls = receiver_calls,
    memberWrites = member_writes
  )
}

emit <- function(result) {
  cat('S\t', result$state, '\n', sep = '')
  fields <- list(D = result$definedNames, U = result$usedNames, J = result$priorUsedNames, Z = result$possiblyUsedNames, M = result$mutatedNames, P = result$possiblyMutatedNames, X = result$reasons, O = result$copyOnModifyNames, I = result$copyOnModifyInvalidatedNames, C = result$safeCallNames, Q = result$safeCallArgumentNames)
  for (prefix in names(fields)) {
    for (value in unlist(fields[[prefix]])) cat(prefix, '\t', URLencode(value, reserved = TRUE), '\n', sep = '')
  }
  for (alias in result$aliases) cat('A\t', URLencode(alias$target, reserved = TRUE), '\t', URLencode(alias$source, reserved = TRUE), '\t', alias$kind, '\t', if (is.null(alias$access)) '' else alias$access, '\t', if (is.null(alias$member)) '' else URLencode(alias$member, reserved = TRUE), '\n', sep = '')
  for (binding in result$copyOnModifyBindings) {
    cat('K\t', URLencode(binding$target, reserved = TRUE), sep = '')
    for (source in binding$sourceNames) cat('\t', URLencode(source, reserved = TRUE), sep = '')
    cat('\n')
  }
  for (summary in result$typeSummaries) {
    cat('Y\t', URLencode(summary$name, reserved = TRUE), '\t', summary$kind, '\t', if (identical(summary$complete, FALSE)) '0' else '1', '\n', sep = '')
    for (field in summary$fields) cat('F\t', URLencode(summary$name, reserved = TRUE), '\t', URLencode(field$name, reserved = TRUE), '\t', field$relationship, '\n', sep = '')
    for (method in summary$methods) {
      cat('H\t', URLencode(summary$name, reserved = TRUE), '\t', URLencode(method$name, reserved = TRUE), '\t', method$effect, '\t', method$unknownScope, '\t', length(method$usedNames), sep = '')
      for (used_name in method$usedNames) cat('\t', URLencode(used_name, reserved = TRUE), sep = '')
      for (safe_call in method$safeCallNames) cat('\t', URLencode(safe_call, reserved = TRUE), sep = '')
      cat('\n')
    }
  }
  for (binding in result$typeBindings) {
    cat('B\t', URLencode(binding$target, reserved = TRUE), '\t', URLencode(binding$typeName, reserved = TRUE), sep = '')
    for (argument in binding$argumentNames) cat('\t', URLencode(argument, reserved = TRUE), sep = '')
    cat('\n')
  }
  for (call in result$receiverCalls) {
    cat('V\t', URLencode(call$receiver, reserved = TRUE), '\t', URLencode(call$member, reserved = TRUE), '\t', if (is.null(call$kind)) 'receiver' else call$kind, sep = '')
    for (argument in call$argumentNames) cat('\t', URLencode(argument, reserved = TRUE), sep = '')
    cat('\n')
  }
  for (write in result$memberWrites) cat('W\t', URLencode(write$receiver, reserved = TRUE), '\t', if (is.null(write$member)) '' else URLencode(write$member, reserved = TRUE), '\t', if (is.null(write$scope)) 'instance' else write$scope, '\n', sep = '')
  cat('.\n')
}

encoded_sources <- if (exists('.notebook_sources', inherits = FALSE)) .notebook_sources else readLines(file('stdin'), warn = FALSE)
sources <- lapply(encoded_sources, decode_base64)
for (source in sources) emit(analyze_source(source))
`
  .replace(/^\s*#.*(?:\r?\n|$)/gmu, '')
  .replace(/^[ \t]+/gmu, '')
  .replace(/\n{2,}/gu, '\n')

export { R_ANALYZER }
