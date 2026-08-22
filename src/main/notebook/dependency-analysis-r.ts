import {
  fieldChild,
  fieldChildren,
  parseNotebookSource,
  type Node
} from './dependency-analysis-parser'
import type {
  NotebookDependencyAlias,
  NotebookDependencyCopyBinding,
  NotebookDependencyMemberWrite,
  NotebookDependencyReceiverCall,
  NotebookDependencyTypeBinding,
  NotebookDependencyTypeSummary,
  NotebookRunDependencyFacts
} from './dependency-analysis-types'

type RExpr =
  | { kind: 'symbol'; name: string }
  | { kind: 'character'; value: string }
  | { kind: 'atomic'; logical?: boolean }
  | { kind: 'null' }
  | { kind: 'formals'; names: string[]; values: Array<RExpr | null> }
  | {
      kind: 'call'
      operator: string | null
      callee: RExpr
      args: RExpr[]
      names: Array<string | null>
    }

const isSymbol = (expr: RExpr | null | undefined): expr is Extract<RExpr, { kind: 'symbol' }> =>
  expr?.kind === 'symbol'
const isCall = (expr: RExpr | null | undefined): expr is Extract<RExpr, { kind: 'call' }> =>
  expr?.kind === 'call'
const isCharacter = (
  expr: RExpr | null | undefined
): expr is Extract<RExpr, { kind: 'character' }> => expr?.kind === 'character'
const isNull = (expr: RExpr | null | undefined): boolean => !expr || expr.kind === 'null'
const emptySymbol = (): RExpr => ({ kind: 'symbol', name: '' })
const symbol = (name: string): RExpr => ({ kind: 'symbol', name })
const rCall = (
  operator: string,
  args: RExpr[],
  names?: Array<string | null>
): Extract<RExpr, { kind: 'call' }> => ({
  kind: 'call',
  operator,
  callee: symbol(operator),
  args,
  names: names ?? args.map(() => null)
})

const stringValue = (node: Node): string =>
  fieldChild(node, 'content')?.text ?? node.text.replace(/^['"]|['"]$/gu, '')

const convertArguments = (node: Node | null): { args: RExpr[]; names: Array<string | null> } => {
  const args: RExpr[] = []
  const names: Array<string | null> = []
  if (!node) return { args, names }
  let afterValue = false
  let pendingEmpty = false
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    if (!child) continue
    if (
      child.type === '(' ||
      child.type === '[' ||
      child.type === ')' ||
      child.type === ']' ||
      child.type === ']]' ||
      child.type === '{' ||
      child.type === '}'
    ) {
      continue
    }
    if (child.type === ',' || child.type === 'comma') {
      if (!afterValue) {
        args.push(emptySymbol())
        names.push(null)
      }
      afterValue = false
      pendingEmpty = true
      continue
    }
    if (child.type === 'argument') {
      const nameNode = fieldChild(child, 'name')
      const valueNode = fieldChild(child, 'value')
      names.push(
        nameNode ? (nameNode.type === 'string' ? stringValue(nameNode) : nameNode.text) : null
      )
      args.push(valueNode ? (convertR(valueNode) ?? emptySymbol()) : emptySymbol())
      afterValue = true
      pendingEmpty = false
    }
  }
  if (pendingEmpty) {
    args.push(emptySymbol())
    names.push(null)
  }
  return { args, names }
}

const convertR = (node: Node | null | undefined): RExpr | null => {
  if (!node) return null
  switch (node.type) {
    case 'identifier':
    case 'dots':
    case 'dot_dot_i':
      return symbol(node.text)
    case 'string':
      return { kind: 'character', value: stringValue(node) }
    case 'integer':
    case 'float':
    case 'complex':
    case 'inf':
    case 'nan':
    case 'na':
      return { kind: 'atomic' }
    case 'true':
      return { kind: 'atomic', logical: true }
    case 'false':
      return { kind: 'atomic', logical: false }
    case 'null':
      return { kind: 'null' }
    case 'comment':
      return null
    case 'binary_operator': {
      const op = fieldChild(node, 'operator')?.text ?? ''
      const lhs = convertR(fieldChild(node, 'lhs')) ?? emptySymbol()
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [lhs, rhs])
    }
    case 'unary_operator': {
      const op = fieldChild(node, 'operator')?.text ?? ''
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [rhs])
    }
    case 'extract_operator': {
      const op = fieldChild(node, 'operator')?.text ?? '$'
      const lhs = convertR(fieldChild(node, 'lhs')) ?? emptySymbol()
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [lhs, rhs])
    }
    case 'namespace_operator': {
      const op = fieldChild(node, 'operator')?.text ?? '::'
      const lhs = convertR(fieldChild(node, 'lhs')) ?? emptySymbol()
      const rhs = convertR(fieldChild(node, 'rhs')) ?? emptySymbol()
      return rCall(op, [lhs, rhs])
    }
    case 'call': {
      const fn = convertR(fieldChild(node, 'function')) ?? emptySymbol()
      const { args, names } = convertArguments(fieldChild(node, 'arguments'))
      return {
        kind: 'call',
        operator: isSymbol(fn) ? fn.name : null,
        callee: fn,
        args,
        names
      }
    }
    case 'subset':
    case 'subset2': {
      const op = node.type === 'subset2' ? '[[' : '['
      const fn = convertR(fieldChild(node, 'function')) ?? emptySymbol()
      const { args, names } = convertArguments(fieldChild(node, 'arguments'))
      return rCall(op, [fn, ...args], [null, ...names])
    }
    case 'braced_expression':
    case 'parenthesized_expression': {
      const op = node.type === 'braced_expression' ? '{' : '('
      const body = fieldChildren(node, 'body').map((child) => convertR(child) ?? emptySymbol())
      return rCall(op, body)
    }
    case 'function_definition': {
      const parameters = fieldChild(node, 'parameters')
      const names: string[] = []
      const values: Array<RExpr | null> = []
      for (const parameter of parameters?.namedChildren.filter(
        (child) => child.type === 'parameter'
      ) ?? []) {
        const name = fieldChild(parameter, 'name')?.text ?? ''
        names.push(name)
        const defaultValue = fieldChild(parameter, 'default')
        values.push(defaultValue ? convertR(defaultValue) : null)
      }
      const body = convertR(fieldChild(node, 'body')) ?? emptySymbol()
      return rCall('function', [{ kind: 'formals', names, values }, body])
    }
    case 'if_statement': {
      const args = [
        convertR(fieldChild(node, 'condition')) ?? emptySymbol(),
        convertR(fieldChild(node, 'consequence')) ?? emptySymbol()
      ]
      const alternative = fieldChild(node, 'alternative')
      if (alternative) args.push(convertR(alternative) ?? emptySymbol())
      return rCall('if', args)
    }
    case 'for_statement':
      return rCall('for', [
        convertR(fieldChild(node, 'variable')) ?? emptySymbol(),
        convertR(fieldChild(node, 'sequence')) ?? emptySymbol(),
        convertR(fieldChild(node, 'body')) ?? emptySymbol()
      ])
    case 'while_statement':
      return rCall('while', [
        convertR(fieldChild(node, 'condition')) ?? emptySymbol(),
        convertR(fieldChild(node, 'body')) ?? emptySymbol()
      ])
    case 'repeat_statement':
      return rCall('repeat', [convertR(fieldChild(node, 'body')) ?? emptySymbol()])
    default:
      if (node.namedChildCount === 1 && node.namedChildren[0])
        return convertR(node.namedChildren[0])
      if (node.namedChildCount > 1) {
        return rCall(
          '{',
          node.namedChildren.map((child) => convertR(child) ?? emptySymbol())
        )
      }
      return isSymbol({ kind: 'symbol', name: node.text }) ? symbol(node.text) : { kind: 'atomic' }
  }
}

const unique = <T>(values: T[]): T[] => [...new Set(values)]
const removeFirst = (values: string[], item: string): string[] => {
  const index = values.indexOf(item)
  return index === -1 ? values : [...values.slice(0, index), ...values.slice(index + 1)]
}

const analyzeRSource = (root: Node): NotebookRunDependencyFacts => {
  const pureSafeCalls = [
    'abs',
    'acos',
    'all',
    'any',
    'asin',
    'as.character',
    'as.integer',
    'as.logical',
    'as.numeric',
    'atan',
    'atan2',
    'c',
    'ceiling',
    'character',
    'cos',
    'cosh',
    'cumsum',
    'data.frame',
    'desc',
    'exp',
    'factor',
    'floor',
    'integer',
    'is.na',
    'is.null',
    'length',
    'list',
    'log',
    'log10',
    'log2',
    'logical',
    'matrix',
    'max',
    'mean',
    'median',
    'min',
    'n',
    'names',
    'ncol',
    'nrow',
    'numeric',
    'order',
    'paste',
    'paste0',
    'quantile',
    'range',
    'rank',
    'rep',
    'rev',
    'round',
    'sd',
    'seq',
    'signif',
    'sin',
    'sinh',
    'slot',
    'sort',
    'sqrt',
    'sum',
    'tan',
    'tanh',
    'trunc',
    'unique',
    'var',
    'which',
    'which.max',
    'which.min'
  ]
  const environmentSafeCalls = ['baseenv', 'emptyenv', 'environment', 'globalenv', 'new.env']
  const graphicsSafeCalls = [
    'abline',
    'axis',
    'barplot',
    'bmp',
    'cm.colors',
    'dev.cur',
    'dev.list',
    'dev.off',
    'dev.size',
    'gray.colors',
    'grid',
    'heat.colors',
    'jpeg',
    'layout',
    'legend',
    'lines',
    'par',
    'pdf',
    'pie',
    'png',
    'points',
    'rainbow',
    'svg',
    'terrain.colors',
    'tiff',
    'title',
    'topo.colors'
  ]
  const ggplot2SafeCalls = [
    'aes',
    'aes_',
    'aes_string',
    'after_scale',
    'after_stat',
    'annotation_custom',
    'coord_cartesian',
    'coord_fixed',
    'coord_flip',
    'coord_map',
    'coord_polar',
    'element_blank',
    'element_line',
    'element_rect',
    'element_text',
    'expand_limits',
    'facet_grid',
    'facet_wrap',
    'geom_area',
    'geom_bar',
    'geom_boxplot',
    'geom_col',
    'geom_histogram',
    'geom_label',
    'geom_line',
    'geom_path',
    'geom_point',
    'geom_ribbon',
    'geom_smooth',
    'geom_text',
    'geom_tile',
    'geom_violin',
    'ggplot',
    'ggsave',
    'ggtitle',
    'guides',
    'labs',
    'lims',
    'qplot',
    'stage',
    'stat_identity',
    'theme',
    'theme_bw',
    'theme_classic',
    'theme_gray',
    'theme_light',
    'theme_minimal',
    'theme_void',
    'vars',
    'xlab',
    'xlim',
    'ylab',
    'ylim'
  ]
  const readrTabularReadCalls = [
    'read_csv',
    'read_csv2',
    'read_delim',
    'read_fwf',
    'read_table',
    'read_tsv'
  ]
  const readrReferenceReadCalls = ['read_rds']
  const readrOutputCalls = ['write_csv', 'write_delim', 'write_tsv']
  const readxlTabularReadCalls = ['read_excel', 'read_xls', 'read_xlsx']
  const havenTabularReadCalls = ['read_dta', 'read_por', 'read_sas', 'read_sav', 'read_xpt']
  const havenOutputCalls = ['write_dta', 'write_sas', 'write_sav', 'write_xpt']
  const baseValueReadCalls = ['read.fwf', 'readBin', 'readChar', 'readLines']
  const jsonliteValueReadCalls = ['fromJSON']
  const yamlValueReadCalls = ['read_yaml', 'yaml.load_file']
  const vroomValueReadCalls = ['vroom', 'vroom_fwf', 'vroom_lines']
  const sfValueReadCalls = ['st_read']
  const matrixValueReadCalls = ['readMM']
  const arrowReferenceReadCalls = [
    'read_csv_arrow',
    'read_delim_arrow',
    'read_feather',
    'read_ipc_file',
    'read_ipc_stream',
    'read_json_arrow',
    'read_parquet'
  ]
  const terraReferenceReadCalls = ['rast', 'vect']
  const rioReferenceReadCalls = ['import']
  const tibbleConstructorCalls = ['as_tibble', 'tibble', 'tribble']
  const dataTableConstructorCalls = ['as.data.table', 'data.table', 'fread']
  const dataTableReferenceMutators = [
    'set',
    'setalloccol',
    'setattr',
    'setcolorder',
    'setDF',
    'setDT',
    'setindex',
    'setindexv',
    'setkey',
    'setkeyv',
    'setnafill',
    'setnames',
    'setorder',
    'setorderv'
  ]
  const dataTableOutputCalls = ['fwrite']
  const biocConstructorCalls = ['ExpressionSet', 'SingleCellExperiment', 'SummarizedExperiment']
  const biocValueAccessors = [
    'altExp',
    'altExps',
    'assay',
    'assays',
    'colData',
    'colLabels',
    'exprs',
    'fData',
    'featureData',
    'logcounts',
    'normcounts',
    'pData',
    'reducedDim',
    'reducedDims',
    'rowData',
    'rowRanges',
    'rowSubset',
    'sizeFactors'
  ]
  const biocUnknownAccessors = ['experimentData', 'metadata']
  const outputSafeCalls = [
    'cat',
    'dir.exists',
    'file.exists',
    'message',
    'print',
    'saveRDS',
    'set.seed',
    'warning',
    'write.csv',
    'write.table',
    ...readrOutputCalls,
    ...havenOutputCalls
  ]
  const tidyDataMaskCalls = [
    'arrange',
    'count',
    'distinct',
    'filter',
    'group_by',
    'mutate',
    'rename',
    'select',
    'summarise',
    'summarize',
    'transmute'
  ]
  const tidyrDataMaskCalls = [
    'complete',
    'drop_na',
    'extract',
    'fill',
    'pivot_longer',
    'pivot_wider',
    'replace_na',
    'separate',
    'separate_wider_delim',
    'unite',
    'unnest',
    'unnest_longer',
    'unnest_wider'
  ]
  const tabularTransformCalls = [...tidyDataMaskCalls, ...tidyrDataMaskCalls]
  const modelDataMaskCalls = ['aov', 'glm', 'lm']
  const safeCalls = new Set([
    ...pureSafeCalls,
    ...environmentSafeCalls,
    ...graphicsSafeCalls,
    ...ggplot2SafeCalls,
    ...outputSafeCalls,
    ...tibbleConstructorCalls,
    ...dataTableOutputCalls,
    ...biocConstructorCalls
  ])
  const tabularReadCalls = [
    'read.csv',
    'read.csv2',
    'read.delim',
    'read.delim2',
    'read.table',
    'scan'
  ]
  const valueFileReadCalls = new Set([
    ...tabularReadCalls,
    ...readrTabularReadCalls,
    ...readxlTabularReadCalls,
    ...havenTabularReadCalls,
    ...baseValueReadCalls,
    ...jsonliteValueReadCalls,
    ...yamlValueReadCalls,
    ...vroomValueReadCalls,
    ...sfValueReadCalls,
    ...matrixValueReadCalls
  ])
  const referenceFileReadCalls = new Set([
    ...readrReferenceReadCalls,
    ...arrowReferenceReadCalls,
    ...terraReferenceReadCalls,
    ...rioReferenceReadCalls,
    'readRDS'
  ])
  const externalReadCalls = new Set([...valueFileReadCalls, ...referenceFileReadCalls])
  const dataMaskCalls = new Set(['aes', 'aes_', 'aes_string', 'vars'])
  const knownAttachedPackages = new Set([
    'arrow',
    'Biobase',
    'data.table',
    'dplyr',
    'ggplot2',
    'haven',
    'jsonlite',
    'Matrix',
    'readr',
    'readxl',
    'rio',
    'sf',
    'SingleCellExperiment',
    'SummarizedExperiment',
    'terra',
    'tibble',
    'tidyr',
    'vroom',
    'yaml'
  ])
  const pipeOps = new Set(['%>%', '|>'])
  const dataTableMutators = new Set(dataTableReferenceMutators)
  const tidyMask = new Set(tidyDataMaskCalls)
  const tidyrMask = new Set(tidyrDataMaskCalls)
  const tabularTransform = new Set(tabularTransformCalls)
  const biocValue = new Set(biocValueAccessors)
  const biocUnknown = new Set(biocUnknownAccessors)
  const yamlReads = new Set(yamlValueReadCalls)
  const tibbleConstructors = new Set(tibbleConstructorCalls)
  const dataTableConstructors = new Set(dataTableConstructorCalls)
  const biocConstructors = new Set(biocConstructorCalls)
  const modelMask = new Set(modelDataMaskCalls)
  const pureSafe = new Set(pureSafeCalls)
  const outputSafe = new Set(outputSafeCalls)

  const defined: string[] = []
  let used: string[] = []
  let priorUsed: string[] = []
  const possiblyUsed: string[] = []
  const mutated: string[] = []
  const possiblyMutated: string[] = []
  const aliases = new Map<string, { target: string; source: string; kind: 'possible-reference' }>()
  const possibleAliases: NotebookDependencyAlias[] = []
  let copyOnModify: string[] = []
  let copyOnModifyBindings: NotebookDependencyCopyBinding[] = []
  let copyOnModifyInvalidated: string[] = []
  const safeCallNames: string[] = []
  const safeCallArgumentNames: string[] = []
  const typeSummaries: NotebookDependencyTypeSummary[] = []
  let typeBindings: NotebookDependencyTypeBinding[] = []
  const receiverCalls: NotebookDependencyReceiverCall[] = []
  const memberWrites: NotebookDependencyMemberWrite[] = []
  const unknown: string[] = []
  let controlDepth = 0
  let localNames: string[] = []

  const callOperator = (expr: RExpr | null | undefined): string | null =>
    isCall(expr) && isSymbol(expr.callee) ? expr.callee.name : null
  const calledName = (expr: RExpr | null | undefined): string | null => {
    if (!isCall(expr)) return null
    if (isSymbol(expr.callee)) return expr.callee.name
    const calleeOp = callOperator(expr.callee)
    if (
      calleeOp &&
      (calleeOp === '::' || calleeOp === ':::') &&
      expr.callee.kind === 'call' &&
      expr.callee.args[1]
    ) {
      return isSymbol(expr.callee.args[1])
        ? expr.callee.args[1].name
        : isCharacter(expr.callee.args[1])
          ? expr.callee.args[1].value
          : null
    }
    return null
  }
  const qualifiedCall = (
    expr: RExpr | null | undefined
  ): { package: string; name: string } | null => {
    if (!isCall(expr) || !isCall(expr.callee) || expr.callee.args.length < 2) return null
    const qualifier = callOperator(expr.callee)
    if (qualifier !== '::' && qualifier !== ':::') return null
    const pkg = expr.callee.args[0]
    const name = expr.callee.args[1]
    const packageName = isSymbol(pkg) ? pkg.name : isCharacter(pkg) ? pkg.value : null
    const member = isSymbol(name) ? name.name : isCharacter(name) ? name.value : null
    if (!packageName || !member) return null
    return { package: packageName, name: member }
  }
  const qualifiedValueFileRead = (pkg: string, name: string): boolean =>
    ((pkg === 'base' || pkg === 'utils') &&
      (tabularReadCalls.includes(name) || baseValueReadCalls.includes(name))) ||
    (pkg === 'haven' && havenTabularReadCalls.includes(name)) ||
    (pkg === 'jsonlite' && jsonliteValueReadCalls.includes(name)) ||
    (pkg === 'Matrix' && matrixValueReadCalls.includes(name)) ||
    (pkg === 'readr' && readrTabularReadCalls.includes(name)) ||
    (pkg === 'readxl' && readxlTabularReadCalls.includes(name)) ||
    (pkg === 'sf' && sfValueReadCalls.includes(name)) ||
    (pkg === 'vroom' && vroomValueReadCalls.includes(name)) ||
    (pkg === 'yaml' && yamlValueReadCalls.includes(name))
  const qualifiedReferenceFileRead = (pkg: string, name: string): boolean =>
    (pkg === 'arrow' && arrowReferenceReadCalls.includes(name)) ||
    (pkg === 'base' && name === 'readRDS') ||
    (pkg === 'readr' && readrReferenceReadCalls.includes(name)) ||
    (pkg === 'rio' && rioReferenceReadCalls.includes(name)) ||
    (pkg === 'terra' && terraReferenceReadCalls.includes(name))
  const knownQualifiedCall = (pkg: string, name: string): boolean =>
    (pkg === 'base' && (pureSafe.has(name) || outputSafe.has(name))) ||
    qualifiedValueFileRead(pkg, name) ||
    qualifiedReferenceFileRead(pkg, name) ||
    (['Biobase', 'SingleCellExperiment', 'SummarizedExperiment'].includes(pkg) &&
      (biocConstructors.has(name) || biocValue.has(name) || biocUnknown.has(name))) ||
    (pkg === 'data.table' &&
      (dataTableConstructors.has(name) ||
        dataTableMutators.has(name) ||
        dataTableOutputCalls.includes(name) ||
        name === 'copy')) ||
    (pkg === 'dplyr' && tidyMask.has(name)) ||
    (pkg === 'ggplot2' && ggplot2SafeCalls.includes(name)) ||
    (pkg === 'haven' &&
      (havenTabularReadCalls.includes(name) || havenOutputCalls.includes(name))) ||
    (pkg === 'readr' &&
      (readrTabularReadCalls.includes(name) ||
        readrReferenceReadCalls.includes(name) ||
        readrOutputCalls.includes(name))) ||
    (pkg === 'readxl' && readxlTabularReadCalls.includes(name)) ||
    (pkg === 'tibble' && tibbleConstructors.has(name)) ||
    (pkg === 'tidyr' && tidyrMask.has(name)) ||
    (pkg === 'stats' && (modelMask.has(name) || pureSafe.has(name))) ||
    (pkg === 'utils' && outputSafe.has(name))
  const tabularTransformName = (expr: RExpr | null | undefined): string | null => {
    const name = calledName(expr)
    if (!name || !tabularTransform.has(name)) return null
    const qualified = qualifiedCall(expr)
    if (!qualified) return name
    if (qualified.package === 'dplyr' && tidyMask.has(name)) return name
    if (qualified.package === 'tidyr' && tidyrMask.has(name)) return name
    return null
  }
  const memberName = (expr: RExpr | null | undefined): string | null => {
    const op = callOperator(expr)
    if (op && (op === '$' || op === '@') && isCall(expr) && expr.args[1]) {
      return isSymbol(expr.args[1])
        ? expr.args[1].name
        : isCharacter(expr.args[1])
          ? expr.args[1].value
          : null
    }
    if (op === 'slot' && isCall(expr) && isCharacter(expr.args[1])) return expr.args[1].value
    const name = calledName(expr)
    if (name && (biocValue.has(name) || biocUnknown.has(name))) return name
    return null
  }
  const namedArgument = (expr: RExpr | null | undefined, name: string): RExpr | null => {
    if (!isCall(expr)) return null
    const index = expr.names.findIndex((label) => label === name)
    return index >= 0 ? (expr.args[index] ?? null) : null
  }
  const yamlReadIsDynamic = (expr: RExpr): boolean => {
    if (!isCall(expr)) return false
    const handlersIndex = expr.names.findIndex((label) => label === 'handlers')
    if (handlersIndex >= 0) {
      const handlers = expr.args[handlersIndex]
      const emptyHandlers =
        isNull(handlers) ||
        (isCall(handlers) &&
          (callOperator(handlers) === 'c' || callOperator(handlers) === 'list') &&
          handlers.args.length === 0)
      if (!emptyHandlers) return true
    }
    const evalIndex = expr.names.findIndex((label) => label === 'eval.expr')
    if (evalIndex < 0) return false
    const value = expr.args[evalIndex]
    return !(value?.kind === 'atomic' && value.logical === false)
  }
  const externalReadHandleRoot = (expr: RExpr): string | null => {
    for (const name of [
      'con',
      'file',
      'path',
      'input',
      'dsn',
      'txt',
      'x',
      'filename',
      'file_path'
    ]) {
      const root = rootName(namedArgument(expr, name))
      if (root) return root
    }
    if (!isCall(expr) || !expr.args.length) return null
    const positional = expr.names
      .map((label, index) => ({ label, index }))
      .filter((item) => !item.label)
    if (!expr.names.some(Boolean)) return rootName(expr.args[0])
    if (!positional.length) return null
    return rootName(expr.args[positional[0]!.index])
  }
  const staticPackageName = (expr: RExpr): string | null => {
    if (!isCall(expr) || !expr.args[0]) return null
    const pkg = expr.args[0]
    if (isSymbol(pkg)) return pkg.name
    if (isCharacter(pkg)) return pkg.value
    return null
  }
  const rootName = (expr: RExpr | null | undefined): string | null => {
    if (isSymbol(expr)) return expr.name
    const op = callOperator(expr)
    if (op && ['$', '@', '[[', '['].includes(op) && isCall(expr)) return rootName(expr.args[0])
    if (op === 'slot' && isCall(expr)) return rootName(expr.args[0])
    const name = calledName(expr)
    if (name && (biocValue.has(name) || biocUnknown.has(name)) && isCall(expr))
      return rootName(expr.args[0])
    return null
  }
  const biocReplacementAccessor = (expr: RExpr | null | undefined): string | null => {
    const name = calledName(expr)
    if (name && (biocValue.has(name) || biocUnknown.has(name))) return name
    const op = callOperator(expr)
    if (op && ['$', '@', '[[', '[', 'slot'].includes(op) && isCall(expr))
      return biocReplacementAccessor(expr.args[0])
    return null
  }
  const staticScalarExpression = (expr: RExpr | null | undefined): boolean => {
    if (expr?.kind === 'atomic' || expr?.kind === 'character') return true
    if (isSymbol(expr)) return expr.name === 'pi'
    if (!isCall(expr)) return false
    const op = callOperator(expr)
    if (!op || !['+', '-', '*', '/', '^'].includes(op)) return false
    return expr.args.every(staticScalarExpression)
  }
  const staticNonemptyIterable = (expr: RExpr | null | undefined): boolean => {
    if (!isCall(expr)) return false
    const op = callOperator(expr)
    if (op === ':' && expr.args.length === 2 && expr.args.every(staticScalarExpression)) return true
    if (op === 'c' && expr.args.length > 0 && expr.args.every(staticScalarExpression)) return true
    return false
  }
  const tribbleColumnDeclaration = (expr: RExpr | null | undefined): boolean =>
    isCall(expr) && callOperator(expr) === '~' && expr.args.length === 1 && isSymbol(expr.args[0])
  const effectOnlyLoopBody = (expr: RExpr | null | undefined): boolean => {
    if (!isCall(expr)) return true
    const op = callOperator(expr)
    if (
      op &&
      [
        '<-',
        '=',
        '->',
        '<<-',
        '->>',
        'if',
        'for',
        'while',
        'repeat',
        'switch',
        'function',
        'break',
        'next',
        'return',
        '&&',
        '||'
      ].includes(op)
    ) {
      return false
    }
    return expr.args.every(effectOnlyLoopBody)
  }
  const copyOnModifySources = (expr: RExpr | null | undefined): string[] | null => {
    if (!expr || expr.kind === 'atomic' || expr.kind === 'character' || expr.kind === 'null')
      return []
    if (isSymbol(expr)) {
      if (!expr.name) return []
      if (copyOnModify.includes(expr.name)) return []
      const matching = copyOnModifyBindings.filter((binding) => binding.target === expr.name)
      if (matching.length) return matching[matching.length - 1]?.sourceNames ?? []
      if (copyOnModifyInvalidated.includes(expr.name)) return null
      if (defined.includes(expr.name)) return null
      return [expr.name]
    }
    if (!isCall(expr)) return null
    let op = callOperator(expr)
    const qualified = qualifiedCall(expr)
    const constructors = [
      'list',
      'c',
      'numeric',
      'integer',
      'logical',
      'character',
      'complex',
      'raw',
      'matrix',
      'array',
      'data.frame',
      'factor',
      'structure',
      ...tibbleConstructorCalls
    ]
    const valueOps = ['+', '-', '*', '/', '^', ':']
    if (!op && qualified?.package === 'tibble' && tibbleConstructors.has(qualified.name))
      op = qualified.name
    if (!op && qualified && qualifiedValueFileRead(qualified.package, qualified.name)) {
      if (qualified.package === 'yaml' && yamlReads.has(qualified.name) && yamlReadIsDynamic(expr))
        return null
      return []
    }
    if (op && valueFileReadCalls.has(op)) {
      if (yamlReads.has(op) && yamlReadIsDynamic(expr)) return null
      return []
    }
    if (op && pipeOps.has(op) && expr.args.length >= 2) {
      const dataSources = copyOnModifySources(expr.args[0])
      const rhs = expr.args[1]
      const transformName = tabularTransformName(rhs)
      if (!dataSources || !transformName || !tabularTransform.has(transformName)) return null
      if (!['mutate', 'transmute', 'summarise', 'summarize'].includes(transformName))
        return dataSources
      const addedValues = isCall(rhs) ? rhs.args : []
      const addedSources = addedValues.map((value) => {
        if (value.kind === 'atomic' || value.kind === 'character') return [] as string[]
        if (isSymbol(value)) return copyOnModifySources(value)
        const valueOp = callOperator(value)
        if (valueOp && constructors.includes(valueOp)) return copyOnModifySources(value)
        if (valueOp && (valueOps.includes(valueOp) || pureSafe.has(valueOp))) return [] as string[]
        return null
      })
      if (addedSources.some((item) => item === null)) return null
      return unique([...dataSources, ...addedSources.flatMap((item) => item ?? [])])
    }
    const transformName = tabularTransformName(expr)
    if (transformName && tabularTransform.has(transformName) && expr.args.length >= 1) {
      const dataSources = copyOnModifySources(expr.args[0])
      if (!dataSources) return null
      if (!['mutate', 'transmute', 'summarise', 'summarize'].includes(transformName))
        return dataSources
      const addedValues = expr.args.slice(1)
      const addedSources = addedValues.map((value) => {
        if (value.kind === 'atomic' || value.kind === 'character') return [] as string[]
        if (isSymbol(value)) return copyOnModifySources(value)
        const valueOp = callOperator(value)
        if (valueOp && constructors.includes(valueOp)) return copyOnModifySources(value)
        if (valueOp && (valueOps.includes(valueOp) || pureSafe.has(valueOp))) return [] as string[]
        return null
      })
      if (addedSources.some((item) => item === null)) return null
      return unique([...dataSources, ...addedSources.flatMap((item) => item ?? [])])
    }
    if (!op || ![...constructors, ...valueOps].includes(op)) return null
    const callArgs =
      op === 'tribble' ? expr.args.filter((value) => !tribbleColumnDeclaration(value)) : expr.args
    const sources = callArgs.map(copyOnModifySources)
    if (sources.some((item) => item === null)) return null
    return unique(sources.flatMap((item) => item ?? []))
  }
  const walkAssignmentTarget = (target: RExpr): void => {
    const op = callOperator(target)
    if (!op || !isCall(target)) return
    if (op === '$' || op === '@') {
      walk(target.args[0], false)
      return
    }
    if (op === '[[' || op === '[' || op === 'slot') {
      for (const arg of target.args) walk(arg, false)
    }
  }
  const addPossibleAlias = (
    target: string,
    source: string,
    access?: string,
    member?: string
  ): void => {
    possibleAliases.push({
      target,
      source,
      kind: 'possible-reference',
      ...(access === 'attribute' || access === 'subscript' ? { access } : {}),
      ...(member ? { member } : {})
    })
  }
  const methodEffect = (
    fn: RExpr,
    receivers = ['self', 'private'],
    copyOnModifyMethod = false
  ): { effect: 'read' | 'mutate' | 'unknown'; unknownScope?: 'namespace' } => {
    let effect: 'read' | 'mutate' | 'unknown' = 'read'
    let namespaceUnknown = false
    const markMutate = (conditional = false): void => {
      if (conditional || copyOnModifyMethod) effect = 'unknown'
      else if (effect !== 'unknown') effect = 'mutate'
    }
    const markUnknown = (namespace = false): void => {
      effect = 'unknown'
      if (namespace) namespaceUnknown = true
    }
    const inspect = (expr: RExpr | null | undefined, conditional = false): void => {
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op && ['<-', '=', '->', '<<-', '->>'].includes(op)) {
        const rightward = op === '->' || op === '->>'
        const target = rightward ? expr.args[1] : expr.args[0]
        const value = rightward ? expr.args[0] : expr.args[1]
        const targetRoot = rootName(target)
        if (targetRoot && receivers.includes(targetRoot)) markMutate(conditional)
        else if (!isSymbol(target) || op === '<<-' || op === '->>') markUnknown(true)
        inspect(value, conditional)
        return
      }
      if (op === 'function') {
        markUnknown()
        return
      }
      if (!op) {
        markUnknown(true)
        for (const arg of expr.args) inspect(arg, conditional)
        return
      }
      if (['if', 'for', 'while', 'repeat', 'switch'].includes(op)) {
        for (const arg of expr.args) inspect(arg, true)
        return
      }
      const syntax = [
        '{',
        '(',
        'if',
        'for',
        'while',
        'repeat',
        '+',
        '-',
        '*',
        '/',
        '^',
        ':',
        '::',
        ':::',
        '[[',
        '[',
        '$',
        '@',
        '!',
        '&',
        '&&',
        '|',
        '||',
        '<',
        '>',
        '<=',
        '>=',
        '==',
        '!='
      ]
      if (!syntax.includes(op) && !safeCalls.has(op) && op !== 'function') markUnknown(true)
      for (const arg of expr.args) inspect(arg, conditional)
    }
    if (callOperator(fn) !== 'function' || !isCall(fn) || fn.args.length < 2) {
      return { effect: 'unknown', unknownScope: 'namespace' }
    }
    inspect(fn.args[1])
    return { effect, unknownScope: namespaceUnknown ? 'namespace' : undefined }
  }
  const methodLocalNames = (fn: RExpr): string[] => {
    if (callOperator(fn) !== 'function' || !isCall(fn) || fn.args[0]?.kind !== 'formals') return []
    const locals = [...fn.args[0].names]
    const collectLocals = (expr: RExpr | null | undefined): void => {
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op === 'function') return
      if (op && ['<-', '=', '->'].includes(op)) {
        const target = op === '->' ? expr.args[1] : expr.args[0]
        const value = op === '->' ? expr.args[0] : expr.args[1]
        if (isSymbol(target)) locals.push(target.name)
        collectLocals(value)
        return
      }
      for (const arg of expr.args) collectLocals(arg)
    }
    collectLocals(fn.args[1])
    return unique(locals)
  }
  const methodUsedNames = (fn: RExpr, receivers = ['self', 'private']): string[] => {
    if (callOperator(fn) !== 'function' || !isCall(fn)) return []
    const locals = methodLocalNames(fn)
    const usedNames: string[] = []
    const collectUsed = (expr: RExpr | null | undefined): void => {
      if (isSymbol(expr)) {
        if (expr.name && !locals.includes(expr.name) && !receivers.includes(expr.name))
          usedNames.push(expr.name)
        return
      }
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op === 'function') return
      if (op && ['<-', '=', '->', '<<-', '->>'].includes(op)) {
        const rightward = op === '->' || op === '->>'
        const target = rightward ? expr.args[1] : expr.args[0]
        const value = rightward ? expr.args[0] : expr.args[1]
        if (!isSymbol(target) && isCall(target)) collectUsed(target.args[0])
        collectUsed(value)
        return
      }
      if (op && ['$', '@', 'slot'].includes(op)) {
        collectUsed(expr.args[0])
        return
      }
      if (op === '::' || op === ':::') return
      const syntaxOps = [
        '{',
        '(',
        'if',
        'for',
        'while',
        'repeat',
        'switch',
        '+',
        '-',
        '*',
        '/',
        '^',
        ':',
        '[[',
        '[',
        '!',
        '&',
        '&&',
        '|',
        '||',
        '<',
        '>',
        '<=',
        '>=',
        '==',
        '!='
      ]
      if (op && !syntaxOps.includes(op) && !receivers.includes(op)) usedNames.push(op)
      for (const arg of expr.args) collectUsed(arg)
    }
    collectUsed(fn.args[1])
    return unique(usedNames).sort()
  }
  const methodSafeCallNames = (fn: RExpr): string[] => {
    if (callOperator(fn) !== 'function' || !isCall(fn)) return []
    const calls: string[] = []
    const collect = (expr: RExpr | null | undefined): void => {
      if (!isCall(expr)) return
      const op = callOperator(expr)
      if (op === 'function') return
      if (op && safeCalls.has(op)) calls.push(op)
      for (const arg of expr.args) collect(arg)
    }
    collect(fn.args[1])
    return unique(calls).sort()
  }
  const valueRelationship = (expr: RExpr | null | undefined): 'value' | 'reference' | 'unknown' => {
    if (!expr || expr.kind === 'atomic' || expr.kind === 'character' || expr.kind === 'null')
      return 'value'
    const name = calledName(expr)
    if (name && (name === 'new.env' || name === 'environment')) return 'reference'
    if (
      name &&
      [
        'c',
        'list',
        'data.frame',
        'matrix',
        'array',
        'numeric',
        'integer',
        'logical',
        'character',
        'factor'
      ].includes(name)
    ) {
      return 'value'
    }
    if (isCall(expr) && !callOperator(expr) && memberName(expr.callee) === 'new') return 'reference'
    return 'unknown'
  }
  const summarizeR6 = (name: string, value: RExpr): NotebookDependencyTypeSummary | null => {
    if (calledName(value) !== 'R6Class' || !isCall(value)) return null
    if (namedArgument(value, 'inherit') || namedArgument(value, 'active')) return null
    const publicExpr = namedArgument(value, 'public')
    if (!publicExpr || callOperator(publicExpr) !== 'list' || !isCall(publicExpr)) return null
    if (publicExpr.names.some((label) => !label)) return null
    const fields: NotebookDependencyTypeSummary['fields'] = []
    const methods: NotebookDependencyTypeSummary['methods'] = []
    for (let index = 0; index < publicExpr.args.length; index += 1) {
      const entryName = publicExpr.names[index]
      const entry = publicExpr.args[index]
      if (!entryName) return null
      if (callOperator(entry) === 'function' && entry) {
        let analysis = methodEffect(entry)
        const safeNames = methodSafeCallNames(entry)
        const shadowed = safeNames.filter((item) => methodLocalNames(entry).includes(item))
        if (shadowed.length) analysis = { effect: 'unknown', unknownScope: 'namespace' }
        methods.push({
          name: entryName,
          effect: analysis.effect,
          usedNames: methodUsedNames(entry),
          safeCallNames: safeNames.filter((item) => !shadowed.includes(item)),
          unknownScope: analysis.unknownScope ?? 'receiver'
        })
      } else if (entry) fields.push({ name: entryName, relationship: valueRelationship(entry) })
    }
    return { name, kind: 'r-r6', fields, methods }
  }
  const summarizeS4 = (expr: RExpr): NotebookDependencyTypeSummary | null => {
    if (calledName(expr) !== 'setClass' || !isCall(expr) || !isCharacter(expr.args[0])) return null
    const name = expr.args[0].value
    const slots = namedArgument(expr, 'slots')
    const fields: NotebookDependencyTypeSummary['fields'] = []
    if (slots && callOperator(slots) === 'c' && isCall(slots)) {
      for (let index = 0; index < slots.args.length; index += 1) {
        const label = slots.names[index]
        if (!label) continue
        const slotType = isCharacter(slots.args[index]) ? slots.args[index].value : 'ANY'
        const relationship =
          slotType === 'environment'
            ? 'reference'
            : ['ANY', 'externalptr', 'weakref', 'list'].includes(slotType)
              ? 'unknown'
              : 'value'
        fields.push({ name: label, relationship })
      }
    }
    return { name, kind: 'r-s4', fields, methods: [] }
  }
  const summarizeS4Method = (expr: RExpr): NotebookDependencyTypeSummary | null => {
    if (calledName(expr) !== 'setMethod' || !isCall(expr)) return null
    const methodName = namedArgument(expr, 'f') ?? expr.args[0]
    const signature = namedArgument(expr, 'signature') ?? expr.args[1]
    let definition = namedArgument(expr, 'definition')
    if (!definition) {
      const functions = expr.args.filter((arg) => callOperator(arg) === 'function')
      definition = functions[functions.length - 1]
    }
    if (
      !isCharacter(methodName) ||
      !isCharacter(signature) ||
      callOperator(definition) !== 'function' ||
      !definition
    ) {
      return null
    }
    const formals =
      isCall(definition) && definition.args[0]?.kind === 'formals' ? definition.args[0] : null
    const receiver = formals?.names[0]
    if (!receiver) return null
    let analysis = methodEffect(definition, [receiver], true)
    const safeNames = methodSafeCallNames(definition)
    const shadowed = safeNames.filter((item) => methodLocalNames(definition).includes(item))
    if (shadowed.length) analysis = { effect: 'unknown', unknownScope: 'namespace' }
    return {
      name: signature.value,
      kind: 'r-s4',
      complete: false,
      fields: [],
      methods: [
        {
          name: methodName.value,
          effect: analysis.effect,
          usedNames: methodUsedNames(definition, [receiver]),
          safeCallNames: safeNames.filter((item) => !shadowed.includes(item)),
          unknownScope: analysis.unknownScope ?? 'receiver'
        }
      ]
    }
  }
  const constructorType = (expr: RExpr | null | undefined): string | null => {
    if (!isCall(expr)) return null
    if (dataTableQuery(expr)) return 'data.table'
    const qualified = qualifiedCall(expr)
    const name = calledName(expr)
    if (
      qualified?.package === 'data.table' &&
      (dataTableConstructors.has(qualified.name) || qualified.name === 'copy')
    ) {
      return 'data.table'
    }
    if (name && (dataTableConstructors.has(name) || name === 'copy')) return 'data.table'
    if (name && biocConstructors.has(name)) return name
    if (name === 'new' && isCharacter(expr.args[0])) return expr.args[0].value
    if (!callOperator(expr) && isCall(expr.callee) && memberName(expr.callee) === 'new')
      return rootName(expr.callee)
    return null
  }
  const addDataTableSummary = (): void => {
    if (!typeSummaries.some((summary) => summary.name === 'data.table')) {
      typeSummaries.push({ name: 'data.table', kind: 'r-r6', fields: [], methods: [] })
    }
  }
  const addBiocSummary = (name: string): void => {
    const common = ['assay', 'assays', 'colData', 'rowData', 'rowRanges']
    const fields =
      name === 'SingleCellExperiment'
        ? [
            ...common,
            'altExp',
            'altExps',
            'colLabels',
            'logcounts',
            'normcounts',
            'reducedDim',
            'reducedDims',
            'rowSubset',
            'sizeFactors'
          ]
        : name === 'ExpressionSet'
          ? ['exprs', 'fData', 'featureData', 'pData']
          : common
    const extra = name === 'ExpressionSet' ? 'experimentData' : 'metadata'
    const fieldSummaries = [...fields, extra].map((field) => ({
      name: field,
      relationship: 'unknown' as const
    }))
    const accessors = unique([...fields, extra])
    typeSummaries.push({
      name,
      kind: 'r-s4',
      fields: fieldSummaries,
      methods: accessors.map((accessor) => ({
        name: accessor,
        effect: 'read',
        usedNames: [],
        safeCallNames: [],
        unknownScope: 'receiver'
      }))
    })
  }
  const addDataFrameSummary = (): void => {
    typeSummaries.push({ name: 'data.frame', kind: 'r-s4', fields: [], methods: [] })
  }
  const dataTableUpdate = (expr: RExpr): { update: RExpr } | null => {
    if (callOperator(expr) !== '[' || !isCall(expr) || expr.args.length < 3) return null
    const update = expr.args[2]
    if (!update || (isSymbol(update) && !update.name)) return null
    if (!isCall(update) || callOperator(update) !== ':=') return null
    return { update }
  }
  const dataTableQuery = (expr: RExpr): Record<string, never> | null => {
    if (callOperator(expr) !== '[' || !isCall(expr) || expr.args.length < 3) return null
    if (dataTableUpdate(expr)) return null
    const j = expr.args[2]
    if (!j || (isSymbol(j) && !j.name)) return null
    const hasClause =
      expr.names.some((label) => label === 'by' || label === 'keyby' || label === '.SDcols') ||
      (isCall(j) && callOperator(j) === '.')
    return hasClause ? {} : null
  }
  const walkDataMask = (expr: RExpr | null | undefined, trackEnvironment = false): void => {
    if (isSymbol(expr)) {
      if (trackEnvironment && expr.name && expr.name !== '.data' && expr.name !== '.env')
        possiblyUsed.push(expr.name)
      return
    }
    if (!isCall(expr)) return
    const op = callOperator(expr)
    if (
      op &&
      (op === '$' || op === '[[') &&
      expr.args.length >= 2 &&
      isSymbol(expr.args[0]) &&
      (expr.args[0].name === '.env' || expr.args[0].name === '.data')
    ) {
      const pronoun = expr.args[0].name
      const key = expr.args[1]
      const name = op === '$' && isSymbol(key) ? key.name : isCharacter(key) ? key.value : null
      if (!name) {
        unknown.push('dynamic-data-mask-lookup')
        return
      }
      if (pronoun === '.env') {
        used.push(name)
        if (!defined.includes(name)) priorUsed.push(name)
      }
      return
    }
    const qualified = qualifiedCall(expr)
    let resolvedOp = op
    if (!resolvedOp && qualified) {
      if (knownQualifiedCall(qualified.package, qualified.name)) resolvedOp = qualified.name
      else unknown.push('opaque-call')
    }
    if (!resolvedOp && isCall(expr.callee)) {
      const calleeOp = callOperator(expr.callee)
      if (
        calleeOp &&
        (calleeOp === '$' || calleeOp === '[[') &&
        isCall(expr.callee) &&
        isSymbol(expr.callee.args[0])
      ) {
        const pronoun = expr.callee.args[0].name
        const key = expr.callee.args[1]
        const name =
          calleeOp === '$' && isSymbol(key) ? key.name : isCharacter(key) ? key.value : null
        if (pronoun === '.env' && name) {
          used.push(name)
          if (!defined.includes(name)) priorUsed.push(name)
        }
        unknown.push(name ? 'opaque-call' : 'dynamic-data-mask-lookup')
      }
    }
    const dependencyName = qualified ? `${qualified.package}::${qualified.name}` : resolvedOp
    const syntax = [
      '{',
      '(',
      '+',
      '-',
      '*',
      '/',
      '^',
      ':',
      '[[',
      '[',
      '$',
      '@',
      '!',
      '&',
      '&&',
      '|',
      '||',
      '<',
      '>',
      '<=',
      '>=',
      '==',
      '!=',
      '~'
    ]
    if (resolvedOp && !syntax.includes(resolvedOp) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (safeCalls.has(resolvedOp)) safeCallNames.push(dependencyName)
      else unknown.push('opaque-call')
    }
    for (const arg of expr.args) walkDataMask(arg, trackEnvironment)
  }
  const walkDataTableMask = (expr: RExpr): void => {
    if (isCall(expr) && callOperator(expr) === '.') {
      for (const value of expr.args) walkDataMask(value, true)
      return
    }
    walkDataMask(expr, true)
  }
  const walkDataTableQuery = (expr: RExpr): void => {
    if (!isCall(expr)) return
    const receiver = rootName(expr.args[0])
    if (!receiver) {
      unknown.push('opaque-call')
      return
    }
    used.push(receiver)
    if (!defined.includes(receiver)) priorUsed.push(receiver)
    addDataTableSummary()
    for (let index = 1; index < expr.args.length; index += 1) {
      const arg = expr.args[index]
      if (isSymbol(arg) && !arg.name) continue
      walkDataTableMask(arg)
    }
  }
  const walkDataTableUpdate = (expr: RExpr, update: RExpr): void => {
    if (!isCall(expr) || !isCall(update)) return
    const receiver = rootName(expr.args[0])
    if (!receiver) {
      unknown.push('dynamic-assignment')
      return
    }
    used.push(receiver)
    if (!defined.includes(receiver)) priorUsed.push(receiver)
    mutated.push(receiver)
    addDataTableSummary()
    typeBindings.push({ target: receiver, typeName: 'data.table', argumentNames: [] })
    receiverCalls.push({ receiver, member: ':=', kind: 'mutating', argumentNames: [] })
    const updateLabels = update.names
    if (updateLabels.some((label) => label)) {
      for (const arg of update.args) walkDataMask(arg, true)
    } else if (update.args.length > 1) {
      for (const arg of update.args.slice(1)) walkDataMask(arg, true)
    }
    for (let index = 0; index < expr.args.length; index += 1) {
      if (index === 0 || index === 2) continue
      const arg = expr.args[index]
      if (isSymbol(arg) && !arg.name) continue
      walkDataMask(arg, true)
    }
  }
  const prepareAssignment = (name: string): void => {
    const conditional = controlDepth > 0
    typeBindings = typeBindings.filter((binding) => binding.target !== name)
    copyOnModify = copyOnModify.filter((item) => item !== name)
    copyOnModifyBindings = copyOnModifyBindings.filter((binding) => binding.target !== name)
    copyOnModifyInvalidated = copyOnModifyInvalidated.filter((item) => item !== name)
    if (conditional) unknown.push('control-flow')
    for (const [target, alias] of [...aliases.entries()]) {
      if (alias.source === name) {
        addPossibleAlias(target, name)
        aliases.delete(target)
        unknown.push('alias-rebind')
      }
    }
    const existing = aliases.get(name)
    if (existing) {
      if (conditional) addPossibleAlias(name, existing.source)
      else {
        used = removeFirst(used, existing.source)
        priorUsed = removeFirst(priorUsed, existing.source)
      }
    }
    aliases.delete(name)
  }
  const updateCopyOnModifyMember = (name: string, value: RExpr | undefined): void => {
    const rootSources = copyOnModifySources(symbol(name))
    const memberSources = copyOnModifySources(value)
    copyOnModify = copyOnModify.filter((item) => item !== name)
    copyOnModifyBindings = copyOnModifyBindings.filter((binding) => binding.target !== name)
    copyOnModifyInvalidated = copyOnModifyInvalidated.filter((item) => item !== name)
    if (!rootSources || !memberSources) {
      copyOnModifyInvalidated.push(name)
      return
    }
    const sources = unique([...rootSources, ...memberSources])
    if (!sources.length) copyOnModify.push(name)
    else copyOnModifyBindings.push({ target: name, sourceNames: sources })
  }
  const walk = (expr: RExpr | null | undefined, assignmentTarget = false): void => {
    if (!expr) return
    if (isSymbol(expr)) {
      if (!expr.name) return
      if (!assignmentTarget && localNames.includes(expr.name)) return
      if (assignmentTarget) defined.push(expr.name)
      else {
        used.push(expr.name)
        if (!defined.includes(expr.name)) priorUsed.push(expr.name)
      }
      return
    }
    if (!isCall(expr)) return
    let op = callOperator(expr)
    const qualified = qualifiedCall(expr)
    if (!op && qualified && knownQualifiedCall(qualified.package, qualified.name))
      op = qualified.name
    const dependencyName = qualified ? `${qualified.package}::${qualified.name}` : op

    const s4Summary = summarizeS4(expr)
    if (s4Summary) {
      typeSummaries.push(s4Summary)
      return
    }
    const s4MethodSummary = summarizeS4Method(expr)
    if (s4MethodSummary) {
      typeSummaries.push(s4MethodSummary)
      return
    }
    const tableUpdate = dataTableUpdate(expr)
    if (tableUpdate) {
      walkDataTableUpdate(expr, tableUpdate.update)
      return
    }
    if (dataTableQuery(expr)) {
      walkDataTableQuery(expr)
      return
    }
    if (op && (biocValue.has(op) || biocUnknown.has(op)) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      const receiver = expr.args[0] ? rootName(expr.args[0]) : null
      if (!receiver) unknown.push('opaque-call')
      else {
        used.push(receiver)
        if (!defined.includes(receiver)) priorUsed.push(receiver)
        const argumentRoots = unique(
          expr.args.map(rootName).filter((name): name is string => Boolean(name))
        )
        receiverCalls.push({ receiver, member: op, kind: 'generic', argumentNames: argumentRoots })
      }
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (!op) {
      const receiver = rootName(expr.callee)
      if (receiver) {
        used.push(receiver)
        if (!defined.includes(receiver)) priorUsed.push(receiver)
        const member = memberName(expr.callee)
        if (member) {
          const argumentRoots = unique(
            expr.args.map(rootName).filter((name): name is string => Boolean(name))
          )
          receiverCalls.push({ receiver, member, argumentNames: argumentRoots })
        } else {
          possiblyMutated.push(receiver)
          unknown.push('opaque-mutation')
        }
      } else unknown.push('opaque-call')
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (['<-', '=', '->', '<<-', '->>'].includes(op)) {
      const rightward = op === '->' || op === '->>'
      const nonlocal = op === '<<-' || op === '->>'
      const target = rightward ? expr.args[1] : expr.args[0]
      const value = rightward ? expr.args[0] : expr.args[1]
      const name = rootName(target)
      const definedBefore = unique(defined)
      const usedBefore = used.length
      let r6Summary: NotebookDependencyTypeSummary | null = null
      let constructed: string | null = null
      let simpleAliasAssignment = false
      if (name) {
        if (nonlocal) {
          used.push(name)
          possiblyMutated.push(name)
          unknown.push('nonlocal-assignment')
        } else if (isSymbol(target)) {
          const copySources = copyOnModifySources(value)
          defined.push(name)
          prepareAssignment(name)
          if (copySources) {
            if (!copySources.length) copyOnModify.push(name)
            else copyOnModifyBindings.push({ target: name, sourceNames: copySources })
          }
          r6Summary = value ? summarizeR6(name, value) : null
          constructed = value ? constructorType(value) : null
          if (r6Summary) typeSummaries.push(r6Summary)
          else if (constructed) {
            if (constructed === 'data.table') addDataTableSummary()
            else if (biocConstructors.has(constructed)) addBiocSummary(constructed)
            const constructorRoots = unique(
              (isCall(value) ? value.args : [])
                .map(rootName)
                .filter((item): item is string => Boolean(item))
            )
            typeBindings.push({
              target: name,
              typeName: constructed,
              argumentNames: constructorRoots
            })
          } else if (isSymbol(value)) {
            simpleAliasAssignment = true
            const source = value.name
            const canonical = aliases.get(source)
            const resolved = canonical ? canonical.source : source
            if (controlDepth > 0) addPossibleAlias(name, resolved)
            else aliases.set(name, { target: name, source: resolved, kind: 'possible-reference' })
          } else if (value) {
            const source = rootName(value)
            if (source) {
              const valueOp = callOperator(value)
              const access =
                valueOp && (valueOp === '[[' || valueOp === '[') ? 'subscript' : 'attribute'
              addPossibleAlias(name, source, access, memberName(value) ?? undefined)
            }
          }
        } else {
          used.push(name)
          mutated.push(name)
          if (value) updateCopyOnModifyMember(name, value)
          const replacementAccessor = biocReplacementAccessor(target)
          if (!replacementAccessor) {
            const member = memberName(target)
            memberWrites.push({ receiver: name, ...(member ? { member } : {}) })
          } else {
            const valueRoot = value ? rootName(value) : null
            receiverCalls.push({
              receiver: name,
              member: replacementAccessor,
              kind: 'generic',
              argumentNames: valueRoot ? [valueRoot] : []
            })
          }
          if (name === '.GlobalEnv' || name === '.BaseNamespaceEnv')
            unknown.push('dynamic-namespace')
          if (target) walkAssignmentTarget(target)
        }
      } else unknown.push('dynamic-assignment')
      if (!r6Summary && !constructed && !simpleAliasAssignment && value) walk(value, false)
      else if (constructed && value && isCall(value)) {
        const valueName = calledName(value)
        const valueQualified = qualifiedCall(value)
        const valueDependency = valueQualified
          ? `${valueQualified.package}::${valueQualified.name}`
          : valueName
        if (
          valueName &&
          (dataTableConstructors.has(valueName) ||
            valueName === 'copy' ||
            biocConstructors.has(valueName)) &&
          valueDependency
        ) {
          used.push(valueDependency)
          if (!defined.includes(valueDependency)) priorUsed.push(valueDependency)
          safeCallNames.push(valueDependency)
          if (valueName === 'fread') unknown.push('external-state')
        }
        if (dataTableQuery(value)) walkDataTableQuery(value)
        else {
          if (!callOperator(value)) {
            const constructorRoot = rootName(value.callee)
            if (constructorRoot) used.push(constructorRoot)
          }
          for (const arg of value.args) if (!isCharacter(arg)) walk(arg, false)
        }
      }
      if (used.length > usedBefore) {
        const assignmentReads = used.slice(usedBefore)
        const newPriorReads = assignmentReads.filter((item) => !definedBefore.includes(item))
        priorUsed.push(...newPriorReads.filter((item) => !priorUsed.includes(item)))
      }
      return
    }
    if (op === 'assign') unknown.push('dynamic-assignment')
    if (['get', 'eval', 'parse', 'substitute', 'do.call'].includes(op))
      unknown.push('dynamic-namespace')
    if (op === 'library' || op === 'require') {
      const pkg = staticPackageName(expr)
      if (pkg && knownAttachedPackages.has(pkg)) {
        used.push(op)
        if (!defined.includes(op)) priorUsed.push(op)
        safeCallNames.push(op)
        return
      }
      unknown.push('dynamic-namespace')
    }
    if (['attach', 'detach', 'load', 'source', 'sys.source'].includes(op))
      unknown.push('dynamic-namespace')
    if (dataTableMutators.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      if (expr.args[0]) {
        const receiver = rootName(expr.args[0])
        if (!receiver) unknown.push('dynamic-assignment')
        else {
          used.push(receiver)
          if (!defined.includes(receiver)) priorUsed.push(receiver)
          mutated.push(receiver)
          if (op === 'setDT') {
            addDataTableSummary()
            typeBindings.push({ target: receiver, typeName: 'data.table', argumentNames: [] })
          } else if (op === 'setDF') {
            addDataFrameSummary()
            typeBindings.push({ target: receiver, typeName: 'data.frame', argumentNames: [] })
          }
          receiverCalls.push({
            receiver,
            member: dependencyName,
            kind: 'mutating',
            argumentNames: []
          })
        }
      }
      for (const arg of expr.args.slice(1)) walk(arg, false)
      return
    }
    if (externalReadCalls.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      unknown.push('external-state')
      if (yamlReads.has(op) && yamlReadIsDynamic(expr))
        unknown.push('opaque-call', 'dynamic-namespace')
      const handleRoot = externalReadHandleRoot(expr)
      if (handleRoot) {
        possiblyMutated.push(handleRoot)
        unknown.push('opaque-mutation')
      }
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op === 'function') {
      unknown.push('function-scope')
      return
    }
    if (op === '$' || op === '@') {
      walk(expr.args[0], false)
      return
    }
    if (pipeOps.has(op) && expr.args.length >= 2) {
      walk(expr.args[0], false)
      const rhs = expr.args[1]
      const transformName = tabularTransformName(rhs)
      if (transformName && tabularTransform.has(transformName)) {
        const qualifiedRhs = qualifiedCall(rhs)
        const dependency = qualifiedRhs
          ? `${qualifiedRhs.package}::${qualifiedRhs.name}`
          : transformName
        used.push(dependency)
        if (!defined.includes(dependency)) priorUsed.push(dependency)
        safeCallNames.push(dependency)
        if (isCall(rhs)) for (const arg of rhs.args) walkDataMask(arg, true)
        return
      }
      walk(rhs, false)
      return
    }
    if (modelMask.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (let index = 0; index < expr.args.length; index += 1) {
        if (expr.names[index] === 'data') walk(expr.args[index], false)
        else walkDataMask(expr.args[index], true)
      }
      return
    }
    if (tabularTransform.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      if (expr.args[0]) walk(expr.args[0], false)
      for (const arg of expr.args.slice(1)) walkDataMask(arg, true)
      return
    }
    if (dataMaskCalls.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const arg of expr.args) walkDataMask(arg, true)
      return
    }
    if (op === 'tribble' && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const value of expr.args.filter((item) => !tribbleColumnDeclaration(item)))
        walk(value, false)
      return
    }
    if (
      op === 'for' &&
      expr.args.length >= 3 &&
      isSymbol(expr.args[0]) &&
      staticNonemptyIterable(expr.args[1]) &&
      effectOnlyLoopBody(expr.args[2])
    ) {
      const target = expr.args[0].name
      walk(expr.args[1], false)
      prepareAssignment(target)
      defined.push(target)
      const previous = localNames
      localNames = [...localNames, target]
      walk(expr.args[2], false)
      localNames = previous
      return
    }
    if (['if', 'for', 'while', 'repeat', 'switch'].includes(op)) {
      unknown.push('control-flow')
      controlDepth += 1
      for (const arg of expr.args) walk(arg, false)
      controlDepth -= 1
      return
    }
    const syntaxOps = [
      '{',
      '(',
      'if',
      'for',
      'while',
      'repeat',
      '+',
      '-',
      '*',
      '/',
      '^',
      ':',
      '::',
      ':::',
      '[[',
      '[',
      '!',
      '&',
      '&&',
      '|',
      '||',
      '<',
      '>',
      '<=',
      '>=',
      '==',
      '!='
    ]
    if (!syntaxOps.includes(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
    }
    const roots = unique(expr.args.map(rootName).filter((name): name is string => Boolean(name)))
    if (safeCalls.has(op) && dependencyName) {
      safeCallNames.push(dependencyName)
      safeCallArgumentNames.push(...roots)
    } else if (
      !syntaxOps.includes(op) &&
      !['assign', 'get', 'eval', 'parse', 'substitute', 'do.call'].includes(op)
    ) {
      if (roots.length) {
        receiverCalls.push({
          receiver: roots[0]!,
          member: op,
          kind: 'generic',
          argumentNames: roots
        })
      } else unknown.push('opaque-call')
    }
    for (const arg of expr.args) walk(arg, false)
  }

  for (const child of root.namedChildren) {
    const expr = convertR(child)
    if (expr) walk(expr, false)
  }
  const combinedAliases: NotebookDependencyAlias[] = [
    ...[...aliases.values()].map((alias) => ({
      target: alias.target,
      source: alias.source,
      kind: alias.kind
    })),
    ...possibleAliases
  ]
  const facts = {
    definedNames: unique(defined).sort(),
    usedNames: unique(used).sort(),
    priorUsedNames: unique(priorUsed).sort(),
    possiblyUsedNames: unique(possiblyUsed).sort(),
    mutatedNames: unique(mutated).sort(),
    possiblyMutatedNames: unique(possiblyMutated).sort(),
    aliases: combinedAliases,
    copyOnModifyNames: unique(copyOnModify).sort(),
    copyOnModifyBindings,
    copyOnModifyInvalidatedNames: unique(copyOnModifyInvalidated).sort(),
    safeCallNames: unique(safeCallNames).sort(),
    safeCallArgumentNames: unique(safeCallArgumentNames).sort(),
    typeSummaries,
    typeBindings,
    receiverCalls,
    memberWrites
  }
  if (unknown.length) return { state: 'unknown', reasons: unique(unknown).sort(), ...facts }
  return { state: 'available', ...facts }
}

const analyzeRSources = async (
  sources: readonly string[]
): Promise<NotebookRunDependencyFacts[]> => {
  const results: NotebookRunDependencyFacts[] = []
  for (const source of sources) {
    const parsed = await parseNotebookSource('r', source)
    if (parsed.state === 'error') {
      results.push({ state: 'unknown', reasons: [parsed.reason] })
      continue
    }
    results.push(analyzeRSource(parsed.tree.rootNode))
  }
  return results
}

export { analyzeRSources }
