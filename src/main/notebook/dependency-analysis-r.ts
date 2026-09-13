import {
  R_ATOMIC_VECTOR_CALLS,
  R_FUNCTIONAL_CALLS,
  R_TABLE_SELECTION_VALUE_ARGUMENTS,
  R_TIDYR_ARGUMENTS,
  R_DPLYR_VALUE_CALLS,
  R_TIDY_SELECT_CALLS,
  R_GGPLOT_GEOMS,
  R_PLOT_LAYER_PACKAGES,
  R_GGPLOT_STATS,
  R_GGPLOT_POSITIONS,
  R_GGPLOT_POSITION_CALLS,
  R_PLOT_COMPOSITION_CONSTRUCTORS,
  R_PLOT_VALUE_CALLS,
  R_SET_OPERATIONS,
  type RCallbackEvaluation
} from './dependency-analysis-r-evaluation'
import { notebookWriteOption, notebookWriteDisposition } from './notebook-write-semantics'
import { createHash } from 'node:crypto'
import { serializedSourcePath } from './serialized-file-provenance'
import {
  fieldChild,
  fieldChildren,
  withParsedNotebookSource,
  type Node
} from './dependency-analysis-parser'
import {
  isPotentialRFileWriteCall,
  R_FILE_CALL_EFFECTS,
  R_GRAPHICS_FILE_DEVICES,
  type NotebookFileCallEffect
} from './notebook-call-effects'
import type {
  NotebookSerializedValue,
  NotebookDependencyAlias,
  NotebookDependencyCopyBinding,
  NotebookDependencyMemberWrite,
  NotebookDependencyReceiverCall,
  NotebookDependencyTypeBinding,
  NotebookDependencyTypeSummary,
  NotebookFileCallEffectSummary,
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessContext,
  NotebookSourceFileAccessExtraction,
  NotebookSourceFileWriteScope
} from './dependency-analysis-types'

// pheatmap's filename is a late formal, not the second positional argument.
const R_PHEATMAP_PARAMETERS = [
  'mat',
  'color',
  'kmeans_k',
  'breaks',
  'border_color',
  'cellwidth',
  'cellheight',
  'scale',
  'cluster_rows',
  'cluster_cols',
  'clustering_distance_rows',
  'clustering_distance_cols',
  'clustering_method',
  'clustering_callback',
  'cutree_rows',
  'cutree_cols',
  'treeheight_row',
  'treeheight_col',
  'legend',
  'legend_breaks',
  'legend_labels',
  'annotation_row',
  'annotation_col',
  'annotation',
  'annotation_colors',
  'annotation_legend',
  'annotation_names_row',
  'annotation_names_col',
  'drop_levels',
  'show_rownames',
  'show_colnames',
  'main',
  'fontsize',
  'fontsize_row',
  'fontsize_col',
  'angle_col',
  'display_numbers',
  'number_format',
  'number_color',
  'fontsize_number',
  'gaps_row',
  'gaps_col',
  'labels_row',
  'labels_col',
  'filename',
  'width',
  'height',
  'silent',
  'na_col'
]

// Explicit drawing contracts; these calls use circlize's current layout. A
// checked plotting procedure must reset and initialize it before consuming it.
// https://jokergoo.github.io/circlize/reference/circos.trackPlotRegion.html
const R_CIRCULAR_PLOT_CALLS = new Set([
  'circos.clear',
  'circos.par',
  'circos.initialize',
  'chordDiagram',
  'circos.trackPlotRegion',
  'get.cell.meta.data',
  'circos.text',
  'circos.points',
  'circos.lines',
  'circos.axis'
])

type RExpr =
  | { kind: 'symbol'; name: string }
  | { kind: 'character'; value: string }
  | { kind: 'atomic'; logical?: boolean; number?: number }
  | { kind: 'null' }
  | { kind: 'formals'; names: string[]; values: Array<RExpr | null> }
  | {
      kind: 'call'
      operator: string | null
      callee: RExpr
      args: RExpr[]
      names: Array<string | null>
      resolvedFunction?: string
      staticBuiltinShadowed?: boolean
      staticDeviceShadowed?: boolean
      // Syntactic pipe expansion must retain magrittr's package dependency.
      pipedWithMagrittr?: boolean
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
// case_when evaluates both sides now; these formulas are not deferred callbacks.
// Keep stored formulas and dynamic dots opaque until their environments are known.
const rCaseWhenArguments = (
  expr: Extract<RExpr, { kind: 'call' }>,
  resultValuesOnly = false
): RExpr[] | undefined => {
  const values: RExpr[] = []
  for (let index = 0; index < expr.args.length; index++) {
    const arg = expr.args[index]!
    const name = expr.names[index]
    if (name && ['.default', '.ptype', '.size', '.unmatched'].includes(name)) {
      if (!resultValuesOnly || ['.default', '.ptype'].includes(name)) values.push(arg)
    } else if (isCall(arg) && arg.operator === '~' && arg.args.length === 2)
      values.push(...(resultValuesOnly ? arg.args.slice(1) : arg.args))
    else if (arg.kind !== 'null') return undefined
  }
  return values
}
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

type RStaticGluePart = { kind: 'text' | 'binding'; value: string }

const R_DIRECTORY_STATE_CALLS = new Set(['list.files'])
const R_ENVIRONMENT_OBSERVATIONS = new Map([
  ['installed.packages', 'utils'],
  ['packageVersion', 'utils'],
  ['dev.list', 'grDevices']
])
const R_PALETTE_FACTORIES = new Set(['colorRamp', 'colorRampPalette'])
const R_BASE_STRING_CALLS = [
  'chartr',
  'encodeString',
  'endsWith',
  'grep',
  'grepl',
  'gregexpr',
  'gregexec',
  'gsub',
  'nchar',
  'nzchar',
  'regexec',
  'regexpr',
  'regmatches',
  'startsWith',
  'strrep',
  'strsplit',
  'sub',
  'substr',
  'substring',
  'tolower',
  'toupper',
  'trimws'
]
type RCircularLayout = { reset: boolean; initialized: boolean }
const nextCircularLayout = (name: string, state: RCircularLayout): RCircularLayout | undefined => {
  if (name === 'circos.clear') return { reset: true, initialized: false }
  if (['chordDiagram', 'circos.initialize'].includes(name))
    return state.reset ? { ...state, initialized: true } : undefined
  return (name === 'circos.par' ? state.reset : state.initialized) ? state : undefined
}

// These observations do not consume file contents. Only discard their environment
// dependence when the whole expression is a known console-only diagnostic.
const R_FILESYSTEM_OBSERVATIONS = new Set([
  'getwd',
  'normalizePath',
  'file.info',
  'file.size',
  'file.exists',
  'dir.exists',
  'list.files',
  'list.dirs'
])
const R_DIAGNOSTIC_VALUE_CALLS = new Set([
  'print',
  'cat',
  'message',
  'sprintf',
  'format',
  'format.default',
  'formatC',
  'file.path',
  'paste',
  'paste0',
  'basename',
  'dirname',
  'as.character',
  'round',
  'signif',
  'c',
  'rownames',
  'names',
  '%in%',
  'unname'
])
const rConsoleDiagnostic = (
  expr: RExpr,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): { calls: string[]; names: string[] } | undefined => {
  const calls: string[] = []
  const names: string[] = []
  let observed = false
  const inspect = (node: RExpr): boolean => {
    if (isSymbol(node)) {
      if (!node.name) return true // Omitted subscript, e.g. file.info(paths)[, 'size'].
      if (!bindings.has(node.name) && !collections.has(node.name)) return false
      names.push(node.name)
      return true
    }
    if (!isCall(node)) return node.kind !== 'formals'
    if (node.staticBuiltinShadowed) return false
    if (node.operator === '$' && isSymbol(node.args[1])) return inspect(node.args[0])
    if (
      ['(', '[', '[[', '{', 'if', '!', '&&', '||', '+', '-', '*', '/', '^'].includes(
        node.operator ?? ''
      )
    )
      return node.args.every(inspect)
    const name = rCalledName(node)
    const qualified = rQualifiedCall(node)
    if (
      !name ||
      (qualified
        ? qualified.package !== (R_ENVIRONMENT_OBSERVATIONS.get(name) ?? 'base')
        : node.staticBuiltinShadowed)
    )
      return false
    if (
      !R_FILESYSTEM_OBSERVATIONS.has(name) &&
      !R_ENVIRONMENT_OBSERVATIONS.has(name) &&
      !R_DIAGNOSTIC_VALUE_CALLS.has(name)
    )
      return false
    // cat(file=...) is a file output, even if all values are diagnostic metadata.
    if (name === 'cat' && node.names.includes('file')) {
      const file = node.args[node.names.indexOf('file')]
      if (!isCharacter(file) || file.value !== '') return false
    }
    calls.push(qualified ? `${qualified.package}::${name}` : name)
    if (R_FILESYSTEM_OBSERVATIONS.has(name) || R_ENVIRONMENT_OBSERVATIONS.has(name)) observed = true
    return node.args.every(inspect)
  }
  return inspect(expr) && observed ? { calls, names } : undefined
}

type RPackageInspection = {
  calls: string[]
  reads: string[]
  writes: string[]
  conditional?: boolean
}
// Package metadata inspection does not invoke the functions it obtains. Keep this
// separate from dynamic get()/eval(), and leave loop-produced bindings uncertain.
const rPackageInspections = (expressions: readonly RExpr[]): Map<RExpr, RPackageInspection> => {
  const result = new Map<RExpr, RPackageInspection>()
  const listings = new Map<string, string>()
  const baseCall = (expr: RExpr, name: string): boolean =>
    isCall(expr) &&
    rCalledName(expr) === name &&
    (rQualifiedCall(expr)?.package === 'base' ||
      (!rQualifiedCall(expr) && !expr.staticBuiltinShadowed))
  const listing = (expr: RExpr | undefined): string | undefined => {
    if (
      !expr ||
      !baseCall(expr, 'ls') ||
      !isCall(expr) ||
      expr.args.length !== 1 ||
      (expr.names[0] && expr.names[0] !== 'name') ||
      !isCharacter(expr.args[0])
    )
      return undefined
    return /^package:([A-Za-z][A-Za-z0-9.]*)$/.exec(expr.args[0].value)?.[1]
  }
  for (const expression of expressions) {
    const summary: RPackageInspection = { calls: [], reads: [], writes: [] }
    if (isCall(expression) && expression.operator === '<-' && isSymbol(expression.args[0])) {
      const pkg = listing(expression.args[1])
      if (pkg) {
        listings.set(expression.args[0].name, pkg)
        summary.calls.push('ls')
        summary.writes.push(expression.args[0].name)
        result.set(expression, summary)
        continue
      }
    }
    if (
      isCall(expression) &&
      baseCall(expression, 'print') &&
      expression.args.length === 1 &&
      listing(expression.args[0])
    ) {
      summary.calls.push('print', 'ls')
      result.set(expression, summary)
      continue
    }
    if (
      isCall(expression) &&
      expression.operator === 'for' &&
      isSymbol(expression.args[0]) &&
      isSymbol(expression.args[1])
    ) {
      const pkg = listings.get(expression.args[1].name)
      const variable = expression.args[0].name
      type Role = 'name' | 'function' | 'metadata' | 'value'
      const roles = new Map<string, Role>([[variable, 'name']])
      const inspect = (node: RExpr | undefined): Role | undefined => {
        if (!node) return undefined
        if (node.kind === 'atomic' || node.kind === 'character' || node.kind === 'null')
          return 'value'
        if (isSymbol(node)) return roles.get(node.name)
        if (!isCall(node)) return undefined
        const name = rCalledName(node)
        if (node.operator === '<-' && isSymbol(node.args[0])) {
          const role = inspect(node.args[1])
          if (role) {
            roles.set(node.args[0].name, role)
            summary.writes.push(node.args[0].name)
          }
          return role
        }
        if (['{', 'if', '!', '&&', '||'].includes(node.operator ?? ''))
          return node.args.every((arg) => inspect(arg) !== undefined) ? 'value' : undefined
        if (!name || !baseCall(node, name)) return undefined
        summary.calls.push(name)
        if (name === 'get') {
          const environment = node.args[node.names.indexOf('envir')]
          return node.args.length === 2 &&
            (!node.names[0] || node.names[0] === 'x') &&
            inspect(node.args[0]) === 'name' &&
            environment &&
            baseCall(environment, 'asNamespace') &&
            isCall(environment) &&
            environment.args.length === 1 &&
            isCharacter(environment.args[0]) &&
            environment.args[0].value === pkg
            ? 'function'
            : undefined
        }
        if (name === 'formals' || name === 'is.function')
          return node.args.length === 1 && inspect(node.args[0]) === 'function'
            ? 'metadata'
            : undefined
        if (name === 'tryCatch') {
          const handler = node.args[node.names.indexOf('error')]
          return node.args.length === 2 &&
            isCall(handler) &&
            handler.operator === 'function' &&
            handler.args[0]?.kind === 'formals' &&
            handler.args[0].names.length === 1 &&
            handler.args[0].values.every((value) => !value) &&
            handler.args[1]?.kind === 'null'
            ? inspect(node.args[0])
            : undefined
        }
        if (!['cat', 'print', 'paste', 'names', 'is.null', 'any', 'grepl'].includes(name))
          return undefined
        if (name === 'cat' && node.names.some((arg) => arg && 'file'.startsWith(arg)))
          return undefined
        return node.args.every((arg) => {
          const role = inspect(arg)
          return role && role !== 'function'
        })
          ? 'value'
          : undefined
      }
      if (pkg && inspect(expression.args[2])) {
        summary.conditional = true
        summary.reads.push(expression.args[1].name)
        summary.writes.push(variable)
        result.set(expression, summary)
        continue
      }
    }
    // Do not carry a listing through code whose effects have not been proved.
    listings.clear()
  }
  return result
}

const rRedirectsConsole = (expr: RExpr): boolean =>
  isCall(expr) && (rCalledName(expr) === 'sink' || expr.args.some(rRedirectsConsole))

const R_FILESYSTEM_MUTATIONS = new Set(['file.copy', 'file.remove', 'file.rename', 'unlink'])
const R_UNCAPTURED_EXTERNAL_CALLS = new Map([
  ['system', 'base'],
  ['system2', 'base'],
  ['font_add', 'sysfonts']
])

const rPrimitiveFileMutation = (
  expr: RExpr,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): string | undefined => {
  if (!isCall(expr)) return undefined
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  if (
    !name ||
    !R_FILESYSTEM_MUTATIONS.has(name) ||
    (qualified ? qualified.package !== 'base' : expr.staticBuiltinShadowed)
  )
    return undefined
  // Primitive arguments cannot run user conversion methods. The filesystem effect
  // remains incomplete, but must not invalidate unrelated in-memory bindings.
  return expr.args.every(
    (arg) =>
      arg.kind === 'atomic' ||
      arg.kind === 'null' ||
      rStaticString(arg, bindings, collections) !== undefined ||
      rStaticStringCollection(arg, bindings, collections) !== undefined
  )
    ? qualified
      ? `base::${name}`
      : name
    : undefined
}

// Attribute only exact, non-recursive deletions without expanding filesystem patterns.
const rExactUnlinkPaths = (
  expr: RExpr,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): readonly string[] | undefined => {
  if (
    !isCall(expr) ||
    rCalledName(expr) !== 'unlink' ||
    !rPrimitiveFileMutation(expr, bindings, collections)
  )
    return undefined
  const parameters = ['x', 'recursive', 'force', 'expand']
  const values = new Map<string, RExpr>()
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.names[i] ?? parameters[i]
    if (!name || !parameters.includes(name) || values.has(name)) return undefined
    values.set(name, expr.args[i]!)
  }
  for (const name of parameters.slice(1)) {
    const value = values.get(name)
    if (
      value &&
      (value.kind !== 'atomic' ||
        typeof value.logical !== 'boolean' ||
        (name === 'recursive' && value.logical))
    )
      return undefined
  }
  const target = values.get('x')
  const scalar = target && rStaticString(target, bindings, collections)
  const paths =
    scalar !== undefined ? [scalar] : rStaticStringCollection(target, bindings, collections)?.values
  return paths?.length &&
    paths.every(
      (path) =>
        Boolean(serializedSourcePath(path)) &&
        !/[\\*?[\]~]/u.test(path) &&
        path !== '.' &&
        !path.endsWith('/')
    )
    ? paths
    : undefined
}

const parseRStaticGlueTemplate = (template: string): RStaticGluePart[] | undefined => {
  const parts: RStaticGluePart[] = []
  let text = ''
  const flushText = (): void => {
    if (!text) return
    parts.push({ kind: 'text', value: text })
    text = ''
  }
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index]!
    if (character === '{' && template[index + 1] === '{') {
      text += '{'
      index += 1
      continue
    }
    if (character === '}' && template[index + 1] === '}') {
      text += '}'
      index += 1
      continue
    }
    if (character === '}') return undefined
    if (character !== '{') {
      text += character
      continue
    }
    const end = template.indexOf('}', index + 1)
    if (end < 0) return undefined
    const name = template.slice(index + 1, end).trim()
    if (!/^(?:[A-Za-z]|\.(?!\d))[A-Za-z\d._]*$/u.test(name)) return undefined
    flushText()
    parts.push({ kind: 'binding', value: name })
    index = end
  }
  flushText()
  return parts
}

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
      return symbol(node.text.startsWith('`') ? node.text.slice(1, -1) : node.text)
    case 'dots':
    case 'dot_dot_i':
      return symbol(node.text)
    case 'string':
      return { kind: 'character', value: stringValue(node) }
    case 'integer': {
      const number = Number(node.text.replace(/L$/u, ''))
      return { kind: 'atomic', ...(Number.isFinite(number) ? { number } : {}) }
    }
    case 'float': {
      const number = Number(node.text)
      return { kind: 'atomic', ...(Number.isFinite(number) ? { number } : {}) }
    }
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

// Lower the unambiguous single-input pipe syntax once, before all analysis passes.
// Function identity, callback effects and return ownership are still checked by
// the direct-call rules. No package/function whitelist belongs at this boundary.
const normalizeRPipes = (expr: RExpr): RExpr => {
  if (expr.kind === 'formals')
    return { ...expr, values: expr.values.map((value) => value && normalizeRPipes(value)) }
  if (!isCall(expr)) return expr
  const op = expr.operator
  if (['quote', 'expression', 'substitute', 'bquote', '~'].includes(rCalledName(expr) ?? ''))
    return expr
  if (op === '|>' || op === '%>%') {
    const [input, rawRhs] = expr.args
    if (!input || !rawRhs || (op === '%>%' && expr.staticBuiltinShadowed)) return expr
    const rhs = isSymbol(rawRhs) && op === '%>%' ? rCall(rawRhs.name, []) : rawRhs
    if (
      !isCall(rhs) ||
      !rCalledName(rhs) ||
      [
        '{',
        '(',
        'function',
        '~',
        'if',
        'for',
        'while',
        'repeat',
        'quote',
        'expression',
        'substitute',
        'bquote'
      ].includes(rCalledName(rhs)!)
    )
      return expr
    const placeholder = op === '|>' ? '_' : '.'
    const contains = (value: RExpr): boolean =>
      isSymbol(value)
        ? value.name === placeholder
        : isCall(value) && (contains(value.callee) || value.args.some(contains))
    const slots = rhs.args.flatMap((arg, i) => (contains(arg) ? [i] : []))
    // Repeated/nested magrittr dots can change evaluation count and scoping.
    // Native placeholders must occur once in a named top-level argument.
    if (
      contains(rhs.callee) ||
      slots.length > 1 ||
      slots.some((i) => !isSymbol(rhs.args[i])) ||
      (op === '|>' && slots.some((i) => !rhs.names[i]))
    )
      return expr
    const lowered = {
      ...rhs,
      args: slots.length
        ? rhs.args.map((arg, i) => (i === slots[0] ? input : arg))
        : [input, ...rhs.args],
      names: slots.length ? rhs.names : [null, ...rhs.names],
      ...(op === '%>%' ? { pipedWithMagrittr: true } : {})
    }
    return { ...lowered, args: lowered.args.map(normalizeRPipes) }
  }
  return { ...expr, callee: normalizeRPipes(expr.callee), args: expr.args.map(normalizeRPipes) }
}
const removeFirst = (values: string[], item: string): string[] => {
  const index = values.indexOf(item)
  return index === -1 ? values : [...values.slice(0, index), ...values.slice(index + 1)]
}

const analyzeRSource = (
  root: Node,
  contextualFileWrappers: readonly NotebookFileCallEffectSummary[] = [],
  contextualStaticStrings: readonly { name: string; value: string }[] = [],
  contextualStaticCollections: NotebookSourceFileAccessContext['staticCollections'] = [],
  contextualFunctions: NotebookSourceFileAccessContext['rFunctions'] = [],
  contextualKernelNames: readonly string[] = [],
  contextualAtomicValueNames: readonly string[] = [],
  contextualCopyOnModifyNames: readonly string[] = [],
  verifiedSerializedValues: readonly NotebookSerializedValue[] = []
): NotebookRunDependencyFacts => {
  const shadowedCallbackCalls = new Set([
    ...contextualKernelNames,
    ...contextualStaticStrings.map(({ name }) => name),
    ...contextualStaticCollections.map(({ name }) => name)
  ])
  let expressions = root.namedChildren.flatMap((child) => {
    const converted = convertR(child)
    return converted ? [converted] : []
  })
  resolveRStaticCallIdentities(expressions, contextualFunctions, [...shadowedCallbackCalls])
  expressions = expressions.map(normalizeRPipes)
  const packageInspections = rPackageInspections(expressions)
  const consoleRedirected = expressions.some(rRedirectsConsole)
  const localFileWrappers = rLocalFileWrappers(expressions)
  const baseLabelFormatCalls = ['format', 'format.default', 'formatC', 'pretty', 'prettyNum']
  const pureSafeCalls = [
    ...baseLabelFormatCalls,
    ...R_BASE_STRING_CALLS,
    'abs',
    'acos',
    'all',
    'any',
    'asin',
    'as.character',
    'as.data.frame',
    'as.integer',
    'as.logical',
    'as.matrix',
    'identical',
    'unname',
    '%in%',
    'as.numeric',
    'atan',
    'atan2',
    'basename',
    'bzfile',
    'c',
    'ceiling',
    'character',
    'close',
    'colnames',
    'colSums',
    'complete.cases',
    'cos',
    'cosh',
    'cumsum',
    'cut',
    'data.frame',
    'desc',
    'droplevels',
    'dirname',
    'dim',
    'duplicated',
    'exp',
    'expm1',
    'log1p',
    'factor',
    'file',
    'file.path',
    'floor',
    'gzfile',
    'gzcon',
    'integer',
    'I',
    'is.na',
    'is.null',
    'is.numeric',
    'is.character',
    'is.logical',
    'is.integer',
    'length',
    'levels',
    'ifelse',
    'list',
    'log',
    'log10',
    'log2',
    'logical',
    'matrix',
    'max',
    'pmax',
    'pmin',
    'merge',
    'rbind',
    'cbind',
    'mean',
    'inherits',
    'class',
    'typeof',
    'p.adjust',
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
    'prop.table',
    'proportions',
    'quantile',
    'range',
    'rawConnection',
    'rank',
    'rep',
    'rev',
    'round',
    'rownames',
    'rowSums',
    'rowMeans',
    'colMeans',
    'cor',
    'sd',
    'seq',
    'seq_along',
    'seq_len',
    'signif',
    'sin',
    'sinh',
    'slot',
    'sort',
    'sqrt',
    'sprintf',
    'setNames',
    'structure',
    'sum',
    'suppressMessages',
    'suppressPackageStartupMessages',
    'suppressWarnings',
    'table',
    'tan',
    'tanh',
    'textConnection',
    'trunc',
    'unique',
    'unz',
    'var',
    'which',
    'which.max',
    'which.min',
    'xzfile'
  ]
  const environmentSafeCalls = ['baseenv', 'emptyenv', 'environment', 'globalenv', 'new.env']
  // Ordinary drawing and numeric helpers. Interactive input, expression-evaluating
  // curve(), and plotting callbacks remain subject to the normal unknown-call rules.
  const baseGraphicsCalls = [
    'abline',
    'arrows',
    'axTicks',
    'Axis',
    'axis',
    'axis.Date',
    'axis.POSIXct',
    'barplot',
    'barplot.default',
    'box',
    'boxplot',
    'boxplot.default',
    'bxp',
    'clip',
    'contour',
    'contour.default',
    'dotchart',
    'frame',
    'grconvertX',
    'grconvertY',
    'grid',
    'hist',
    'hist.default',
    'image',
    'image.default',
    'layout',
    'layout.show',
    'lcm',
    'legend',
    'lines',
    'lines.default',
    'matlines',
    'matplot',
    'matpoints',
    'mtext',
    'par',
    'pie',
    'plot',
    'plot.default',
    'plot.new',
    'plot.window',
    'plot.xy',
    'points',
    'points.default',
    'polygon',
    'polypath',
    'rasterImage',
    'rect',
    'rug',
    'segments',
    'stem',
    'strheight',
    'strwidth',
    'stripchart',
    'symbols',
    'text',
    'text.default',
    'title',
    'xinch',
    'xspline',
    'xyinch',
    'yinch'
  ]
  const graphicsDeviceCalls = [
    ...R_GRAPHICS_FILE_DEVICES,
    'adjustcolor',
    'as.graphicsAnnot',
    'as.raster',
    'axisTicks',
    'boxplot.stats',
    'chull',
    'cm.colors',
    'col2rgb',
    'colors',
    'colours',
    'contourLines',
    'convertColor',
    'dev.capabilities',
    'dev.cur',
    'dev.flush',
    'dev.hold',
    'dev.list',
    'dev.off',
    'dev.size',
    'extendrange',
    'graphics.off',
    'gray',
    'gray.colors',
    'grey',
    'grey.colors',
    'hcl',
    'hcl.colors',
    'hcl.pals',
    'heat.colors',
    'hsv',
    'is.raster',
    'n2mfrow',
    'nclass.FD',
    'nclass.Sturges',
    'nclass.scott',
    'palette.colors',
    'palette.pals',
    'rainbow',
    'rgb',
    'rgb2hsv',
    'terrain.colors',
    'topo.colors',
    'trans3d',
    'xy.coords',
    'xyz.coords'
  ]
  const graphicsSafeCalls = [...baseGraphicsCalls, ...graphicsDeviceCalls]
  const ggplot2PositionScaleCalls = [
    'scale_x_continuous',
    'scale_y_continuous',
    'scale_x_discrete',
    'scale_y_discrete',
    'scale_x_log10',
    'scale_y_log10',
    'scale_x_sqrt',
    'scale_y_sqrt',
    'scale_x_reverse',
    'scale_y_reverse',
    'scale_size_continuous',
    'scale_size_area',
    'scale_size',
    'scale_alpha',
    'scale_alpha_continuous',
    'scale_colour_continuous',
    'scale_color_continuous',
    'scale_fill_continuous',
    ...['color', 'colour', 'fill'].flatMap((aesthetic) =>
      ['gradient', 'gradient2', 'gradientn', 'brewer', 'distiller', 'fermenter'].map(
        (scale) => `scale_${aesthetic}_${scale}`
      )
    )
  ]
  const ggplot2SafeCalls = [
    ...ggplot2PositionScaleCalls,
    'aes',
    'aes_',
    'aes_string',
    'after_scale',
    'after_stat',
    'annotation_custom',
    'coord_cartesian',
    'coord_fixed',
    'coord_equal',
    'coord_flip',
    'coord_map',
    'coord_polar',
    'element_blank',
    'element_line',
    'element_rect',
    'element_text',
    'expand_limits',
    'expand_scale',
    'expansion',
    'facet_grid',
    'facet_wrap',
    ...R_GGPLOT_GEOMS,
    'ggplot',
    'ggsave',
    'ggtitle',
    'guides',
    'labs',
    'lims',
    'position_dodge',
    'position_dodge2',
    'position_fill',
    'position_identity',
    'position_jitter',
    'position_jitterdodge',
    'position_nudge',
    'position_stack',
    'qplot',
    'scale_color_manual',
    'scale_colour_manual',
    'scale_fill_manual',
    'scale_size_manual',
    'scale_alpha_manual',
    'scale_shape_manual',
    'scale_linetype_manual',
    'scale_linewidth_manual',
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
    'waiver',
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
  const readrReferenceReadCalls = ['read_file', 'read_lines', 'read_rds']
  // Column specifications construct values; their arguments still carry dependencies/effects.
  // https://readr.tidyverse.org/reference/cols.html
  const readrColumnConstructors = new Set([
    'cols',
    'cols_only',
    'col_character',
    'col_double',
    'col_integer',
    'col_logical',
    'col_factor',
    'col_date',
    'col_time',
    'col_datetime',
    'col_number',
    'col_skip',
    'col_guess'
  ])
  const readrOutputCalls = [
    'write_csv',
    'write_csv2',
    'write_delim',
    'write_file',
    'write_lines',
    'write_rds',
    'write_tsv'
  ]
  const readxlTabularReadCalls = ['read_excel', 'read_xls', 'read_xlsx', 'excel_sheets']
  const havenTabularReadCalls = ['read_dta', 'read_por', 'read_sas', 'read_sav', 'read_xpt']
  const havenOutputCalls = ['write_dta', 'write_sas', 'write_sav', 'write_xpt']
  const baseValueReadCalls = ['dget', 'read.fwf', 'readBin', 'readChar', 'readLines']
  const jsonliteValueReadCalls = ['fromJSON', 'read_json', 'parse_json']
  const jsonliteOutputCalls = ['write_json']
  const yamlValueReadCalls = ['read_yaml', 'yaml.load_file']
  const yamlOutputCalls = ['write_yaml']
  const vroomValueReadCalls = ['vroom', 'vroom_fwf', 'vroom_lines']
  const sfValueReadCalls = ['st_read']
  const matrixValueReadCalls = ['readMM']
  const seuratValueReadCalls = ['ReadMtx']
  const matrixOutputCalls = ['writeMM']
  const rhdf5ReferenceReadCalls = ['h5read']
  const rhdf5OutputCalls = ['h5write']
  const cairoOutputCalls = ['CairoJPEG', 'CairoPDF', 'CairoPNG', 'CairoSVG', 'CairoTIFF']
  const xml2ReferenceReadCalls = ['read_xml']
  const xml2OutputCalls = ['write_xml']
  const rMatlabReferenceReadCalls = ['readMat']
  const rMatlabOutputCalls = ['writeMat']
  const ncdf4ReferenceReadCalls = ['nc_open']
  const ncdf4OutputCalls = ['nc_close', 'nc_create']
  const biostringsReferenceReadCalls = ['readDNAStringSet']
  const biostringsOutputCalls = ['writeXStringSet']
  const readOdsTabularReadCalls = ['read_ods']
  const readOdsOutputCalls = ['write_ods']
  const magickReferenceReadCalls = ['image_read']
  const magickOutputCalls = ['image_write']
  const arrowReferenceReadCalls = [
    'read_csv_arrow',
    'read_delim_arrow',
    'read_feather',
    'read_ipc_file',
    'read_ipc_stream',
    'read_json_arrow',
    'read_parquet'
  ]
  const arrowOutputCalls = [
    'write_csv_arrow',
    'write_dataset',
    'write_feather',
    'write_ipc_file',
    'write_ipc_stream',
    'write_parquet'
  ]
  const fstReferenceReadCalls = ['read_fst']
  const fstOutputCalls = ['write_fst']
  const openxlsxReferenceReadCalls = ['loadWorkbook', 'read.xlsx']
  const openxlsxReferenceConstructors = ['createWorkbook']
  const openxlsxReferenceMutators = [
    'addStyle',
    'addWorksheet',
    'deleteData',
    'freezePane',
    'mergeCells',
    'removeWorksheet',
    'renameWorksheet',
    'setColWidths',
    'setRowHeights',
    'writeData',
    'writeDataTable'
  ]
  const openxlsxOutputCalls = ['saveWorkbook', 'write.xlsx']
  const raggOutputCalls = ['agg_jpeg', 'agg_png', 'agg_tiff']
  const svgliteOutputCalls = ['svglite']
  const hdf5ArrayOutputCalls = ['saveHDF5SummarizedExperiment']
  const openxlsx2ReferenceReadCalls = ['read_xlsx', 'wb_load']
  const openxlsx2OutputCalls = ['wb_save', 'write_xlsx']
  const qsReferenceReadCalls = ['qread']
  const qsOutputCalls = ['qsave']
  const terraReferenceReadCalls = ['rast', 'vect']
  const rioReferenceReadCalls = ['import']
  const rioOutputCalls = ['export']
  const writexlOutputCalls = ['write_xlsx']
  const htmlwidgetsSafeCalls = ['createWidget']
  const htmlwidgetsOutputCalls = ['saveWidget']
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
    'write.FCS',
    'cat',
    'capture.output',
    'dput',
    'dir.exists',
    'file.exists',
    'message',
    'print',
    'save',
    'saveRDS',
    'set.seed',
    'warning',
    'sink',
    'write.csv',
    'write.csv2',
    'writeBin',
    'writeLines',
    'write.table',
    ...arrowOutputCalls,
    ...fstOutputCalls,
    ...openxlsxOutputCalls,
    ...raggOutputCalls,
    ...svgliteOutputCalls,
    ...hdf5ArrayOutputCalls,
    ...jsonliteOutputCalls,
    ...matrixOutputCalls,
    ...rhdf5OutputCalls,
    ...cairoOutputCalls,
    ...yamlOutputCalls,
    ...xml2OutputCalls,
    ...rMatlabOutputCalls,
    ...ncdf4OutputCalls,
    ...biostringsOutputCalls,
    ...readOdsOutputCalls,
    ...magickOutputCalls,
    ...openxlsx2OutputCalls,
    ...qsOutputCalls,
    ...readrOutputCalls,
    ...havenOutputCalls,
    ...rioOutputCalls,
    ...writexlOutputCalls,
    ...htmlwidgetsOutputCalls
  ]
  const tidyDataMaskCalls = [
    ...R_TABLE_SELECTION_VALUE_ARGUMENTS.keys(),
    'arrange',
    'count',
    'distinct',
    'filter',
    'group_by',
    'ungroup',
    'reframe',
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
  const tableJoinCalls = new Set([
    'inner_join',
    'left_join',
    'right_join',
    'full_join',
    'semi_join',
    'anti_join',
    'cross_join'
  ])
  const modelDataMaskCalls = ['aov', 'glm', 'lm']
  const safeCalls = new Set([
    ...R_PLOT_LAYER_PACKAGES.keys(),
    ...pureSafeCalls,
    ...environmentSafeCalls,
    ...graphicsSafeCalls,
    ...R_DIRECTORY_STATE_CALLS,
    ...ggplot2SafeCalls,
    ...outputSafeCalls,
    ...tibbleConstructorCalls,
    ...dataTableOutputCalls,
    ...biocConstructorCalls,
    ...htmlwidgetsSafeCalls,
    ...htmlwidgetsOutputCalls,
    ...localFileWrappers.effects.keys(),
    ...contextualFileWrappers.map(({ name }) => name),
    ...R_PALETTE_FACTORIES
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
    'getSheetNames',
    ...tabularReadCalls,
    ...readrTabularReadCalls,
    ...readxlTabularReadCalls,
    ...havenTabularReadCalls,
    ...baseValueReadCalls,
    ...jsonliteValueReadCalls,
    ...yamlValueReadCalls,
    ...vroomValueReadCalls,
    ...sfValueReadCalls,
    ...matrixValueReadCalls,
    ...seuratValueReadCalls
  ])
  const externalReadCalls = new Set([
    ...R_ENVIRONMENT_OBSERVATIONS.keys(),
    ...R_FILESYSTEM_OBSERVATIONS,
    ...[...R_FILE_CALL_EFFECTS].flatMap(([name, effect]) => (effect.kind === 'read' ? [name] : []))
  ])
  const dataMaskCalls = new Set(['aes', 'aes_', 'aes_string', 'vars'])
  const knownAttachedPackages = new Set([
    'VennDiagram',
    'pheatmap',
    'venn',
    ...R_PLOT_LAYER_PACKAGES.values(),
    'circlize',
    ...[...R_PLOT_VALUE_CALLS.values()].flat(),
    ...R_PLOT_COMPOSITION_CONSTRUCTORS.values(),
    'flowCore',
    'tximport',
    'Seurat',
    'GEOquery',
    'arrow',
    'Biobase',
    'Biostrings',
    'rtracklayer',
    'Cairo',
    'data.table',
    'dplyr',
    'fst',
    'ggplot2',
    'glue',
    'grDevices',
    'HDF5Array',
    'haven',
    'htmlwidgets',
    'jsonlite',
    'Matrix',
    'magick',
    'magrittr',
    'ncdf4',
    'openxlsx',
    'openxlsx2',
    'purrr',
    'ragg',
    'qs',
    'readr',
    'readxl',
    'readODS',
    'rhdf5',
    'rio',
    'R.matlab',
    'sf',
    'SingleCellExperiment',
    'SummarizedExperiment',
    'svglite',
    'targets',
    'terra',
    'tibble',
    'tidyr',
    'tidyselect',
    'vroom',
    'writexl',
    'xml2',
    'yaml'
  ])
  const knownNamespacePackages = new Set([
    ...knownAttachedPackages,
    'cowplot',
    'eulerr',
    'gridExtra',
    'ggrepel',
    'ggpubr',
    'ggthemes',
    'scales',
    'xlsx',
    'XLConnect'
  ])
  const pipeOps = new Set(['%>%', '|>'])
  const dataTableMutators = new Set(dataTableReferenceMutators)
  const openxlsxMutators = new Set(openxlsxReferenceMutators)
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
  const functionalCallbacks = R_FUNCTIONAL_CALLS
  const callbackUnsafeCalls = new Set([
    'bzfile',
    'close',
    'file',
    'gzfile',
    'gzcon',
    'rawConnection',
    'textConnection',
    'unz',
    'xzfile'
  ])
  const pureCallbackOps = new Set([
    ...pureSafeCalls.filter((name) => !callbackUnsafeCalls.has(name)),
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
  ])
  // Fresh statistical/coercion results do not alias a caller's mutable object.
  const valueResultCalls = new Map([
    ...[
      'as.numeric',
      'as.integer',
      'as.character',
      'as.logical',
      'mean',
      'sum',
      'length',
      'rowMeans',
      'colMeans',
      'inherits',
      'class',
      'typeof',
      'which',
      'which.min',
      'which.max',
      'factor'
    ].map((name) => [name, 'base'] as const),
    ['p.adjust', 'stats'],
    ['t.test', 'stats']
  ])
  const copyValueCalls = new Set([
    ...R_BASE_STRING_CALLS,
    'data.frame',
    'list',
    'names',
    'colnames',
    'rownames',
    'levels',
    'order',
    ...R_ATOMIC_VECTOR_CALLS
  ])

  const summarizeCallback = (
    expr: RExpr | undefined,
    formulaParameters?: readonly string[],
    circularLayoutAvailable = false,
    conditionHandler = false,
    ordinaryInputs = false
  ): NotebookDependencyTypeSummary['methods'][number] | undefined => {
    if (!isCall(expr)) return undefined
    const formals = expr.args[0]
    const formula = callOperator(expr) === '~' && formulaParameters && expr.args.length === 1
    if (!formula && (callOperator(expr) !== 'function' || formals?.kind !== 'formals'))
      return undefined
    const parameters = formula
      ? [...formulaParameters]
      : formals.kind === 'formals'
        ? formals.names
        : []
    if (parameters.includes('...')) return undefined
    const locals = new Set(parameters)
    const bodyBindings = new Set(assignedNamesIn(formula ? expr.args.at(-1) : expr.args[1]))
    const valueLocals = new Set<string>()
    const copyValueLocals = new Set<string>()
    const reassignedParameters = new Set<string>()
    const valueCallbackCalls = new Set<RExpr>()
    let ordinaryReturns = true
    let copyReturns = true
    const returnsValue = (value: RExpr | undefined, ordinaryParameters = false): boolean => {
      if (!value) return false
      if (['atomic', 'character', 'null'].includes(value.kind)) return true
      if (isSymbol(value))
        return (
          valueLocals.has(value.name) ||
          // Immediate iteration may close over a captured ordinary table. Retain
          // its read dependency; never borrow outer type facts for callback locals.
          (ordinaryInputs &&
            !locals.has(value.name) &&
            !bodyBindings.has(value.name) &&
            copyOnModifySources(value)?.length === 0) ||
          (ordinaryParameters &&
            ((parameters.includes(value.name) && !reassignedParameters.has(value.name)) ||
              copyValueLocals.has(value.name)))
        )
      if (!isCall(value)) return false
      if (valueCallbackCalls.has(value)) return true
      const name = calledName(value)
      if (
        name &&
        !locals.has(name) &&
        ordinaryVennDataCall(value, (arg) => returnsValue(arg, ordinaryParameters))
      )
        return true
      const pkg = name && valueResultCalls.get(name)
      if (
        name &&
        pkg &&
        !locals.has(name) &&
        contractAvailable(name, qualifiedCall(value)?.package, pkg)
      )
        return true
      if (name === '{') return returnsValue(value.args.at(-1), ordinaryParameters)
      if (
        name &&
        ['na.omit', 'na.exclude'].includes(name) &&
        !locals.has(name) &&
        contractAvailable(name, qualifiedCall(value)?.package, 'stats')
      )
        return (
          value.args.length > 0 && value.args.every((arg) => returnsValue(arg, ordinaryParameters))
        )
      if (
        name === 'ifelse' &&
        !locals.has(name) &&
        contractAvailable(name, qualifiedCall(value)?.package, 'base')
      )
        return ['yes', 'no'].every((branch, index) =>
          returnsValue(
            value.args[
              callbackArgumentIndex(value, [branch], index === 0 ? ['test'] : ['test', 'yes'])
            ],
            ordinaryParameters
          )
        )
      if (name === 'if')
        return (
          returnsValue(value.args[1], ordinaryParameters) &&
          (!value.args[2] || returnsValue(value.args[2], ordinaryParameters))
        )
      if (
        name &&
        copyValueCalls.has(name) &&
        !locals.has(name) &&
        contractAvailable(name, qualifiedCall(value)?.package, 'base')
      )
        return value.args.every((arg) => returnsValue(arg, ordinaryParameters))
      if (name && ['+', '-', '*', '/', '^', ':'].includes(name))
        return value.args.every((arg) => returnsValue(arg, ordinaryParameters))
      if (
        name &&
        ['head', 'tail'].includes(name) &&
        !locals.has(name) &&
        contractAvailable(name, qualifiedCall(value)?.package, 'utils')
      )
        return returnsValue(value.args[callbackArgumentIndex(value, ['x'], [])], ordinaryParameters)
      if (
        name &&
        ['$', '[', '[[', '(', 'return', 'try', 'suppressWarnings', 'suppressMessages'].includes(
          name
        )
      )
        return returnsValue(value.args[0], ordinaryParameters)
      return false
    }
    const atomicLocals = new Set<string>()
    let circularReset = false
    let circularInitialized = circularLayoutAvailable
    const reads = new Set<string>()
    const calls = new Set<string>()
    const inspect = (value: RExpr): boolean => {
      if (isCall(value) && value.pipedWithMagrittr) {
        if (locals.has('%>%') || !contractAvailable('%>%', undefined, 'magrittr')) return false
        reads.add('%>%')
        calls.add('%>%')
      }
      if (value.kind === 'atomic' || value.kind === 'character' || value.kind === 'null')
        return true
      if (value.kind === 'symbol') {
        if (
          value.name === '.Platform' &&
          !locals.has(value.name) &&
          contractAvailable(value.name, undefined, 'base') &&
          !mutated.includes(value.name)
        ) {
          reads.add(value.name)
          calls.add(value.name)
          return true
        }
        if (value.name && !locals.has(value.name) && !['NULL', 'NA', 'pi'].includes(value.name))
          reads.add(value.name)
        return true
      }
      if (value.kind === 'formals') return false
      const op = calledName(value)
      if (op && ['na.omit', 'na.exclude'].includes(op)) {
        if (
          !ordinaryInputs ||
          locals.has(op) ||
          !contractAvailable(op, qualifiedCall(value)?.package, 'stats') ||
          !value.args.length ||
          !value.args.every((arg) => returnsValue(arg, true))
        )
          return false
        const dependency = qualifiedCall(value) ? `stats::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      if (op && ['<-', '=', '->'].includes(op)) {
        const target = value.args[op === '->' ? 1 : 0]
        const assigned = value.args[op === '->' ? 0 : 1]
        if (!assigned || !inspect(assigned)) return false
        if (
          isCall(target) &&
          ['[', '[['].includes(callOperator(target) ?? '') &&
          isSymbol(target.args[0]) &&
          atomicLocals.has(target.args[0].name)
        )
          return target.args.every(inspect)
        if (!isSymbol(target)) return false
        const ordinary = returnsValue(assigned)
        const copyValue = returnsValue(assigned, true)
        if (parameters.includes(target.name)) reassignedParameters.add(target.name)
        locals.add(target.name)
        valueLocals.delete(target.name)
        if (ordinary) valueLocals.add(target.name)
        copyValueLocals.delete(target.name)
        if (copyValue) copyValueLocals.add(target.name)
        atomicLocals.delete(target.name)
        if (
          isCall(assigned) &&
          ['as.integer', 'as.numeric', 'as.character', 'as.logical'].includes(
            calledName(assigned) ?? ''
          )
        )
          atomicLocals.add(target.name)
        // rep of an atomic literal remains an atomic vector even when its
        // length comes from a parameter. Local subassignment cannot mutate the caller.
        if (
          isCall(assigned) &&
          calledName(assigned) === 'rep' &&
          contractAvailable('rep', qualifiedCall(assigned)?.package, 'base') &&
          !locals.has('rep') &&
          ['atomic', 'character'].includes(assigned.args[0]?.kind ?? '')
        )
          atomicLocals.add(target.name)
        if (
          isCall(assigned) &&
          calledName(assigned) === 'suppressWarnings' &&
          isCall(assigned.args[0]) &&
          ['as.integer', 'as.numeric'].includes(calledName(assigned.args[0]) ?? '')
        )
          atomicLocals.add(target.name)
        return true
      }
      if (op === '$')
        return Boolean(value.args[0] && inspect(value.args[0]) && isSymbol(value.args[1]))
      if (op === 'if') {
        // A branch may return a value; conditional local bindings need a control-flow summary.
        if (value.args.some((arg) => assignedNamesIn(arg).length)) return false
        if (!value.args[0] || !inspect(value.args[0])) return false
        const before: [boolean, boolean] = [circularReset, circularInitialized]
        const states: boolean[][] = []
        for (const branch of [value.args[1], value.args[2]]) {
          ;[circularReset, circularInitialized] = before
          if (branch && !inspect(branch)) return false
          states.push([circularReset, circularInitialized])
        }
        circularReset = states.every((state) => state[0])
        circularInitialized = states.every((state) => state[1])
        return true
      }
      if (op === 'return') {
        const safe = value.args.every(inspect)
        ordinaryReturns &&= returnsValue(value.args[0])
        copyReturns &&= returnsValue(value.args[0], true)
        return safe
      }
      if (op === 'try') {
        if (
          locals.has(op) ||
          !contractAvailable(op, qualifiedCall(value)?.package, 'base') ||
          value.args.length > 2 ||
          value.names.some((name) => name && !['expr', 'silent'].includes(name)) ||
          value.args.some((arg) => assignedNamesIn(arg).length)
        )
          return false
        const dependency = qualifiedCall(value) ? `base::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      if (
        op === 'tryCatch' &&
        !locals.has(op) &&
        contractAvailable(op, qualifiedCall(value)?.package, 'base')
      ) {
        if (value.args.some((arg) => assignedNamesIn(arg).some((name) => locals.has(name))))
          return false
        reads.add(qualifiedCall(value) ? `base::${op}` : op)
        calls.add(qualifiedCall(value) ? `base::${op}` : op)
        let ordinary = true
        const beforeLocals = new Set(locals),
          beforeValues = new Set(valueLocals),
          beforeCopies = new Set(copyValueLocals),
          beforeAtomic = new Set(atomicLocals)
        const safe = value.args.every((arg, index) => {
          if (!value.names[index] || ['expr', 'finally'].includes(value.names[index]!)) {
            const safe = inspect(arg)
            if (value.names[index] !== 'finally') ordinary &&= returnsValue(arg)
            return safe
          }
          const handler = summarizeCallback(arg, undefined, false, true)
          if (!handler) return false
          ordinary &&= handler.returnType === 'r-value'
          for (const name of handler.usedNames ?? []) if (!locals.has(name)) reads.add(name)
          for (const name of handler.safeCallNames ?? []) {
            if (locals.has(name)) return false
            calls.add(name)
          }
          return true
        })
        // An error can stop before any local assignment. Only the returned value
        // is guaranteed by both paths; protected bindings do not escape as proven values.
        for (const [current, before] of [
          [locals, beforeLocals],
          [valueLocals, beforeValues],
          [copyValueLocals, beforeCopies],
          [atomicLocals, beforeAtomic]
        ]) {
          current.clear()
          for (const name of before) current.add(name)
        }
        if (safe && ordinary) valueCallbackCalls.add(value)
        return safe
      }
      if (op && ['head', 'tail', 'str', 'summary'].includes(op)) {
        const pkg = op === 'summary' ? 'base' : 'utils'
        if (locals.has(op) || !contractAvailable(op, qualifiedCall(value)?.package, pkg))
          return false
        const dependency = qualifiedCall(value) ? `${pkg}::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      const functional = op ? functionalCallbacks.get(op) : undefined
      if (op && functional && !functional.dataMask) {
        if (
          locals.has(op) ||
          !contractAvailable(op, qualifiedCall(value)?.package, functional.package)
        )
          return false
        const index = callbackArgumentIndex(
          value,
          functional.keywords,
          functional.precedingArguments
        )
        const callback = summarizeCallback(value.args[index], functional.formulaParameters)
        if (!callback) return false
        if (
          callback.returnType === 'r-value' &&
          ['apply', 'lapply', 'sapply', 'vapply'].includes(op)
        )
          valueCallbackCalls.add(value)
        const dependency = qualifiedCall(value) ? `${functional.package}::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        for (const name of callback.usedNames ?? []) if (!locals.has(name)) reads.add(name)
        for (const name of callback.safeCallNames ?? []) {
          if (locals.has(name)) return false
          calls.add(name)
        }
        return value.args.every((arg, i) => i === index || inspect(arg))
      }
      if (
        op &&
        !locals.has(op) &&
        ordinaryVennDataCall(value, (arg) => returnsValue(arg, ordinaryInputs))
      ) {
        const qualified = qualifiedCall(value)
        const dependency = qualified ? `${qualified.package}::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      if (op === 't.test') {
        if (locals.has(op) || !contractAvailable(op, qualifiedCall(value)?.package, 'stats'))
          return false
        // Only the vector interface. Formula dispatch has a separate data-mask contract.
        if (
          value.names.includes('formula') ||
          value.args.some((arg) => isCall(arg) && callOperator(arg) === '~')
        )
          return false
        const dependency = qualifiedCall(value) ? `stats::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      if (op && R_PLOT_LAYER_PACKAGES.has(op)) {
        const pkg = R_PLOT_LAYER_PACKAGES.get(op)!
        if (locals.has(op) || !contractAvailable(op, qualifiedCall(value)?.package, pkg))
          return false
        // Helpers constructing ordinary layers are values. Callback/extension
        // parameters still need the full deferred-evaluation contract.
        if (
          value.names.some(
            (name) =>
              name &&
              [
                'data',
                'mapping',
                'stat',
                'position',
                'key_glyph',
                'distribution',
                'geom',
                'method'
              ].includes(name)
          )
        )
          return false
        const dependency = qualifiedCall(value) ? `${pkg}::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      if (conditionHandler && op && ['cat', 'conditionMessage'].includes(op)) {
        if (locals.has(op) || !contractAvailable(op, qualifiedCall(value)?.package, 'base'))
          return false
        if (op === 'cat' && value.names.includes('file')) return false
        const dependency = qualifiedCall(value) ? `base::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      if (op && R_CIRCULAR_PLOT_CALLS.has(op)) {
        const qualified = qualifiedCall(value)
        if (!contractAvailable(op, qualified?.package, 'circlize') || locals.has(op)) return false
        if (
          circularLayoutAvailable &&
          ['circos.clear', 'circos.par', 'chordDiagram', 'circos.initialize'].includes(op)
        )
          return false
        const next = nextCircularLayout(op, {
          reset: circularReset,
          initialized: circularInitialized
        })
        if (!next) return false
        const dependency = qualified ? `circlize::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        const complete = value.args.every((arg, index) => {
          if (op === 'circos.trackPlotRegion' && value.names[index] === 'panel.fun') {
            const panel = summarizeCallback(arg, undefined, circularInitialized)
            if (!panel) return false
            for (const name of panel.usedNames ?? []) if (!locals.has(name)) reads.add(name)
            for (const name of panel.safeCallNames ?? []) calls.add(name)
            return true
          }
          return inspect(arg)
        })
        circularReset = next.reset
        circularInitialized = next.initialized
        return complete
      }
      if (op && (graphicsSafeCalls.includes(op) || R_PLOT_VALUE_CALLS.has(op))) {
        // This data constructor needs the ordinary-input and interactive-mode
        // checks of the main walker, which a generic helper summary cannot prove.
        if (op === 'ggVennDiagram') return false
        const qualified = qualifiedCall(value)
        const packages = R_PLOT_VALUE_CALLS.get(op) ?? [
          baseGraphicsCalls.includes(op) ? 'graphics' : 'grDevices'
        ]
        if (
          locals.has(op) ||
          !packages.some((pkg) => contractAvailable(op, qualified?.package, pkg))
        )
          return false
        const dependency = qualified ? `${qualified.package}::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return value.args.every(inspect)
      }
      const composed =
        op && !qualifiedCall(value) && !locals.has(op) ? functions.get(op)?.methods[0] : undefined
      if (composed) {
        if (composed.effect !== 'read') return false
        reads.add(op!)
        for (const name of composed.usedNames ?? []) reads.add(name)
        for (const name of composed.safeCallNames ?? []) calls.add(name)
        return value.args.every(inspect)
      }
      const quoted = quotedDataCall(value)
      if (quoted && (quoted.qualified || !locals.has(quoted.name))) {
        reads.add(quoted.dependency)
        calls.add(quoted.dependency)
        return true
      }

      if (op === 'case_when') {
        if (locals.has(op) || !contractAvailable(op, qualifiedCall(value)?.package, 'dplyr'))
          return false
        const argumentsToEvaluate = rCaseWhenArguments(value)
        if (!argumentsToEvaluate) return false
        const dependency = qualifiedCall(value) ? `dplyr::${op}` : op
        reads.add(dependency)
        calls.add(dependency)
        return argumentsToEvaluate.every(inspect)
      }
      if (op && dplyrValueCall(value)) {
        const qualified = qualifiedCall(value)
        if (!qualified && locals.has(op)) return false
        const name = qualified ? `${qualified.package}::${op}` : op
        reads.add(name)
        calls.add(name)
        return value.args.every(inspect)
      }
      if (!op || !pureCallbackOps.has(op)) return false
      const qualified = qualifiedCall(value)
      if (qualified && !knownQualifiedCall(qualified.package, op)) return false
      if (pureSafe.has(op)) {
        if (!qualified && (locals.has(op) || defined.includes(op) || shadowedCallbackCalls.has(op)))
          return false
        const name = qualified ? `${qualified.package}::${op}` : op
        reads.add(name)
        calls.add(name)
      }
      return value.args.every(inspect)
    }
    // R defaults are promises, evaluated in the callee when used. Only constant
    // defaults are summarized here; effectful or environment-dependent defaults stay opaque.
    if (
      !formula &&
      formals.kind === 'formals' &&
      formals.values.some((value) => value && !['atomic', 'character', 'null'].includes(value.kind))
    )
      return undefined
    const body = formula ? expr.args.at(-1) : expr.args[1]
    if (!body || !inspect(body)) return undefined
    const returnsOrdinary = ordinaryReturns && returnsValue(body)
    return {
      name: '__call__',
      effect: 'read',
      usedNames: [...reads].sort(),
      safeCallNames: [...calls].sort(),
      ...(returnsOrdinary ? { returnType: 'r-value' } : {}),
      ...(!returnsOrdinary && copyReturns && returnsValue(body, true)
        ? { returnCopyArguments: true }
        : {})
    }
  }

  const rPackageLoads = new Set<string>()
  const rPackageReads = new Set<string>()
  const packageCandidates = new Map<string, string[]>()
  const recordPackageRead = (name: string): void => {
    if (
      name.includes('::') ||
      defined.includes(name) ||
      localNames.includes(name) ||
      shadowedCallbackCalls.has(name)
    )
      return
    let candidates = packageCandidates.get(name)
    if (!candidates) {
      // Reuse the existing package call contracts, rather than a second list of
      // exported functions. Default R packages are already attached by the kernel.
      candidates = [...knownAttachedPackages].filter(
        (pkg) =>
          !['base', 'utils', 'stats', 'graphics', 'grDevices', 'methods', 'datasets'].includes(
            pkg
          ) && knownQualifiedCall(pkg, name)
      )
      packageCandidates.set(name, candidates)
    }
    for (const pkg of candidates) if (!rPackageLoads.has(pkg)) rPackageReads.add(pkg)
  }
  const defined: string[] = []
  const conditionallyDefined = new Set<string>()
  const isolatedConditionallyDefined = new Set<string>()
  const staticIterableNames = new Set(contextualStaticCollections.map(({ name }) => name))
  const staticNamedIterableNames = new Set(
    contextualStaticCollections.flatMap(({ name, entries }) => (entries ? [name] : []))
  )
  const staticScalarNames = new Set(contextualStaticStrings.map(({ name }) => name))
  const staticStrings = new Map(contextualStaticStrings.map(({ name, value }) => [name, value]))
  const staticCollections = rContextCollections(contextualStaticCollections)
  const localInputHandleNames = new Set<string>()
  const characterLoopNames = new Set<string>()
  const namespaceProbePackages = new Map<string, readonly string[]>()
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
  const serializedValueWrites = new Map<string, NotebookSerializedValue>()
  const serializedValuePaths = new Map(verifiedSerializedValues.map((value) => [value.path, value]))
  const invalidateSerializedValues = (path?: string): void => {
    if (path) {
      serializedValueWrites.delete(path)
      serializedValuePaths.delete(path)
    } else {
      serializedValueWrites.clear()
      serializedValuePaths.clear()
    }
  }
  const serializedValueReads = new Set<string>()
  let controlDepth = 0
  let staticFileMapInvocations = 0
  let localAggregationDepth = 0
  const ordinaryLoopValues = new Set<string>()
  let localNames: string[] = []
  const functions = new Map(contextualFunctions.map(({ name, summary }) => [name, summary]))
  const acceptedCallbacks = new Set<RExpr>()
  const quotedDataCall = (expr: RExpr | null | undefined): ReturnType<typeof rQuotedDataCall> => {
    const call = rQuotedDataCall(expr)
    return call &&
      (call.qualified ||
        (!defined.includes(call.name) &&
          !localNames.includes(call.name) &&
          !shadowedCallbackCalls.has(call.name) &&
          !functions.has(call.name)))
      ? call
      : undefined
  }
  const literalLabelNames = new Set<string>()
  const atomicValueNames = new Set([
    ...contextualAtomicValueNames,
    ...contextualStaticStrings.map(({ name }) => name),
    ...contextualStaticCollections.map(({ name }) => name)
  ])
  const literalLabelValue = (expr: RExpr | null | undefined): boolean => {
    if (quotedDataCall(expr)) return true
    if (isSymbol(expr)) return literalLabelNames.has(expr.name)
    if (expr?.kind === 'character' || expr?.kind === 'atomic' || expr?.kind === 'null') return true
    if (!expr || !isCall(expr)) return false
    const name = rCalledName(expr)
    const qualified = rQualifiedCall(expr)
    return Boolean(
      name &&
      ['c', 'list'].includes(name) &&
      (qualified
        ? qualified.package === 'base'
        : !defined.includes(name) && !shadowedCallbackCalls.has(name)) &&
      expr.args.every(literalLabelValue)
    )
  }

  const resolveCallback = (
    expr: RExpr | undefined,
    formulaParameters?: readonly string[],
    ordinaryInputs = false
  ): NotebookDependencyTypeSummary['methods'][number] | undefined => {
    const statsName = isSymbol(expr)
      ? expr.name
      : isCall(expr) &&
          callOperator(expr) === '::' &&
          isSymbol(expr.args[0]) &&
          expr.args[0].name === 'stats' &&
          isSymbol(expr.args[1])
        ? expr.args[1].name
        : undefined
    if (
      ordinaryInputs &&
      statsName &&
      ['na.omit', 'na.exclude'].includes(statsName) &&
      contractAvailable(statsName, isCall(expr) ? 'stats' : undefined, 'stats')
    ) {
      const dependency = isCall(expr) ? `stats::${statsName}` : statsName
      return {
        name: '__call__',
        effect: 'read',
        usedNames: [dependency],
        safeCallNames: [dependency],
        returnCopyArguments: true
      }
    }
    if (
      isCall(expr) &&
      callOperator(expr) === '::' &&
      isSymbol(expr.args[0]) &&
      isSymbol(expr.args[1])
    ) {
      const pkg = expr.args[0].name
      const name = expr.args[1].name
      if (pureSafe.has(name) && !callbackUnsafeCalls.has(name) && knownQualifiedCall(pkg, name)) {
        const dependency = `${pkg}::${name}`
        return {
          name: '__call__',
          effect: 'read',
          usedNames: [dependency],
          safeCallNames: [dependency],
          ...(pkg === 'base' && copyValueCalls.has(name) ? { returnCopyArguments: true } : {}),
          ...(valueResultCalls.get(name) === pkg ? { returnType: 'r-value' } : {})
        }
      }
    }
    if (isSymbol(expr)) {
      const known = functions.get(expr.name)?.methods[0]
      if (known) return known.effect === 'read' ? known : undefined
      if (
        pureSafe.has(expr.name) &&
        !callbackUnsafeCalls.has(expr.name) &&
        !defined.includes(expr.name) &&
        !shadowedCallbackCalls.has(expr.name)
      )
        return {
          name: '__call__',
          effect: 'read',
          usedNames: [expr.name],
          safeCallNames: [expr.name],
          ...(copyValueCalls.has(expr.name) ? { returnCopyArguments: true } : {}),
          ...(valueResultCalls.has(expr.name) ? { returnType: 'r-value' } : {})
        }
    }
    return summarizeCallback(expr, formulaParameters, false, false, ordinaryInputs)
  }
  const mergeCallbackReads = (summary: NotebookDependencyTypeSummary['methods'][number]): void => {
    if (summary.effect !== 'read') unknown.push('opaque-call', 'dynamic-namespace')
    for (const name of summary.usedNames ?? []) {
      used.push(name)
      if (!defined.includes(name)) priorUsed.push(name)
    }
    safeCallNames.push(...(summary.safeCallNames ?? []))
    for (const name of summary.safeCallNames ?? []) recordPackageRead(name)
    if (summary.safeCallNames?.some((name) => defined.includes(name))) unknown.push('opaque-call')
  }

  // Immediate callbacks read their closure now. Deferred callbacks with free variables
  // cannot be bound to this run until their eventual invocation can be tracked.
  const consumeCallback = (
    expr: RExpr | undefined,
    evaluation: RCallbackEvaluation,
    ordinaryInputs = false
  ): boolean => {
    if (evaluation.allowList && isCall(expr) && calledName(expr) === 'list') {
      const qualified = qualifiedCall(expr)
      if (
        qualified
          ? qualified.package !== 'base'
          : defined.includes('list') || shadowedCallbackCalls.has('list')
      )
        return false
      return expr.args
        .map((item) => consumeCallback(item, { ...evaluation, allowList: false }))
        .every(Boolean)
    }
    const summary = resolveCallback(expr, evaluation.formulaParameters, ordinaryInputs)
    if (
      !summary ||
      (evaluation.phase === 'deferred' &&
        (summary.usedNames ?? []).some((name) => !summary.safeCallNames?.includes(name)))
    )
      return false
    mergeCallbackReads(summary)
    if (isCall(expr)) acceptedCallbacks.add(expr)
    if (isSymbol(expr)) {
      used.push(expr.name)
      if (!defined.includes(expr.name)) priorUsed.push(expr.name)
    }
    return true
  }
  const callbackArgumentIndex = (
    expr: Extract<RExpr, { kind: 'call' }>,
    keywords: readonly string[],
    preceding: readonly string[]
  ): number => {
    const named = expr.names.findIndex((name) => keywords.includes(name ?? ''))
    if (named >= 0) return named
    const remaining = preceding.filter((parameter) => !expr.names.includes(parameter)).length
    return expr.names.flatMap((name, index) => (name ? [] : [index]))[remaining] ?? -1
  }
  const contractAvailable = (name: string, pkg: string | undefined, expected: string): boolean =>
    pkg
      ? pkg === expected || (expected === 'tidyselect' && pkg === 'dplyr')
      : !defined.includes(name) && !localNames.includes(name) && !shadowedCallbackCalls.has(name)

  const ordinaryFunctionalArguments = (
    expr: Extract<RExpr, { kind: 'call' }>,
    callbackIndex: number
  ): boolean =>
    callbackArgumentIndex(expr, ['X'], []) >= 0 &&
    expr.args.every(
      (arg, index) => index === callbackIndex || copyOnModifySources(arg)?.length === 0
    )

  // Query forms only. Named font definitions register device state and must not
  // share the contract of the zero-argument inspection used in font diagnostics.
  const runtimeQueryPackages = new Map([
    ['capabilities', 'base'],
    ...['pdfFonts', 'postscriptFonts', 'quartzFonts', 'windowsFonts'].map(
      (name) => [name, 'grDevices'] as const
    )
  ])
  const readOnlyRuntimeQuery = (expr: RExpr): boolean => {
    if (!isCall(expr)) return false
    const name = calledName(expr)
    const pkg = name && runtimeQueryPackages.get(name)
    if (!name || !pkg || !contractAvailable(name, qualifiedCall(expr)?.package, pkg)) return false
    if (name === 'capabilities')
      return (
        expr.args.length === 0 ||
        (expr.args.length === 1 &&
          (!expr.names[0] || expr.names[0] === 'what') &&
          isCharacter(expr.args[0]))
      )
    return expr.args.length === 0
  }

  const aggregateFormulaIndex = (expr: Extract<RExpr, { kind: 'call' }>): number => {
    const index = callbackArgumentIndex(expr, ['x', 'formula'], [])
    return isCall(expr.args[index]) && callOperator(expr.args[index]) === '~' ? index : -1
  }
  const aggregateDataIndex = (expr: Extract<RExpr, { kind: 'call' }>): number =>
    aggregateFormulaIndex(expr) >= 0
      ? callbackArgumentIndex(expr, ['data'], ['x'])
      : callbackArgumentIndex(expr, ['x'], [])

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
    (pkg === 'openxlsx' && name === 'getSheetNames') ||
    ((pkg === 'base' || pkg === 'utils') &&
      (tabularReadCalls.includes(name) || baseValueReadCalls.includes(name))) ||
    (pkg === 'haven' && havenTabularReadCalls.includes(name)) ||
    (pkg === 'jsonlite' && jsonliteValueReadCalls.includes(name)) ||
    (pkg === 'Matrix' && matrixValueReadCalls.includes(name)) ||
    (pkg === 'Seurat' && seuratValueReadCalls.includes(name)) ||
    (pkg === 'readr' && readrTabularReadCalls.includes(name)) ||
    (pkg === 'readxl' && readxlTabularReadCalls.includes(name)) ||
    (pkg === 'sf' && sfValueReadCalls.includes(name)) ||
    (pkg === 'vroom' && vroomValueReadCalls.includes(name)) ||
    (pkg === 'yaml' && yamlValueReadCalls.includes(name))
  const qualifiedReferenceFileRead = (pkg: string, name: string): boolean =>
    (pkg === 'arrow' && arrowReferenceReadCalls.includes(name)) ||
    (pkg === 'base' && name === 'readRDS') ||
    (pkg === 'fst' && fstReferenceReadCalls.includes(name)) ||
    (pkg === 'openxlsx' && openxlsxReferenceReadCalls.includes(name)) ||
    (pkg === 'openxlsx2' && openxlsx2ReferenceReadCalls.includes(name)) ||
    (pkg === 'qs' && qsReferenceReadCalls.includes(name)) ||
    (pkg === 'readr' && readrReferenceReadCalls.includes(name)) ||
    (pkg === 'rio' && rioReferenceReadCalls.includes(name)) ||
    (pkg === 'terra' && terraReferenceReadCalls.includes(name))
  const knownQualifiedCall = (pkg: string, name: string): boolean =>
    (pkg === 'base' && name === 'options') ||
    (pkg === 'VennDiagram' && ['get.venn.partitions', 'venn.diagram'].includes(name)) ||
    (pkg === 'ggVennDiagram' && ['Venn', 'process_region_data', 'process_data'].includes(name)) ||
    (pkg === 'venn' && name === 'venn') ||
    (pkg === 'pheatmap' && name === 'pheatmap') ||
    (pkg === 'methods' && name === 'slotNames') ||
    R_UNCAPTURED_EXTERNAL_CALLS.get(name) === pkg ||
    R_PLOT_LAYER_PACKAGES.get(name) === pkg ||
    (pkg === 'dplyr' &&
      (['case_when', 'pull', 'desc'].includes(name) || tableJoinCalls.has(name))) ||
    (pkg === 'ggplot2' &&
      ['annotate', 'theme_set', 'theme_get', 'theme_update', 'theme_replace'].includes(name)) ||
    (pkg === 'stats' && ['t.test', 'p.adjust', 'na.omit', 'na.exclude'].includes(name)) ||
    (pkg === 'base' && ['subset', 'try', 'formals'].includes(name)) ||
    runtimeQueryPackages.get(name) === pkg ||
    (pkg === 'scales' && name === 'rescale') ||
    (pkg === 'base' && ['with', 't', 'lengths'].includes(name)) ||
    (pkg === 'utils' && ['head', 'tail', 'str'].includes(name)) ||
    (pkg === 'grDevices' && R_PALETTE_FACTORIES.has(name)) ||
    (pkg === 'circlize' && R_CIRCULAR_PLOT_CALLS.has(name)) ||
    (pkg === 'base' &&
      [
        'summary',
        'unlist',
        'sign',
        ...R_SET_OPERATIONS,
        'is.finite',
        'is.infinite',
        'is.nan'
      ].includes(name)) ||
    (R_PLOT_VALUE_CALLS.get(name)?.includes(pkg) ?? false) ||
    R_PLOT_COMPOSITION_CONSTRUCTORS.get(name) === pkg ||
    (pkg === 'base' && name === 'requireNamespace') ||
    (pkg === 'flowCore' && ['read.FCS', 'read.flowSet', 'write.FCS'].includes(name)) ||
    (pkg === 'tximport' && name === 'tximport') ||
    (pkg === 'Seurat' && ['Read10X', 'Read10X_h5', 'Load10X_Spatial'].includes(name)) ||
    (pkg === 'GEOquery' && name === 'getGEO') ||
    (pkg === 'base' &&
      (pureSafe.has(name) ||
        outputSafe.has(name) ||
        R_DIRECTORY_STATE_CALLS.has(name) ||
        functionalCallbacks.get(name)?.package === 'base')) ||
    (['dplyr', 'tidyr', 'magrittr'].includes(pkg) && name === '%>%') ||
    (pkg === 'fs' && name === 'path') ||
    (pkg === 'glue' && name === 'glue') ||
    (pkg === 'stats' && ['setNames', 'complete.cases'].includes(name)) ||
    qualifiedValueFileRead(pkg, name) ||
    qualifiedReferenceFileRead(pkg, name) ||
    (pkg === 'arrow' && arrowOutputCalls.includes(name)) ||
    (pkg === 'Cairo' && cairoOutputCalls.includes(name)) ||
    (pkg === 'Biostrings' &&
      (biostringsReferenceReadCalls.includes(name) || biostringsOutputCalls.includes(name))) ||
    (['Biobase', 'SingleCellExperiment', 'SummarizedExperiment'].includes(pkg) &&
      (biocConstructors.has(name) || biocValue.has(name) || biocUnknown.has(name))) ||
    (pkg === 'data.table' &&
      (dataTableConstructors.has(name) ||
        dataTableMutators.has(name) ||
        dataTableOutputCalls.includes(name) ||
        name === 'copy')) ||
    (pkg === 'dplyr' && (tidyMask.has(name) || R_DPLYR_VALUE_CALLS.has(name))) ||
    functionalCallbacks.get(name)?.package === pkg ||
    (pkg === 'dplyr' && name === 'where') ||
    (['dplyr', 'tidyselect'].includes(pkg) && R_TIDY_SELECT_CALLS.has(name)) ||
    (pkg === 'fst' && fstOutputCalls.includes(name)) ||
    (pkg === 'ggplot2' && ggplot2SafeCalls.includes(name)) ||
    (pkg === 'graphics' && baseGraphicsCalls.includes(name)) ||
    (pkg === 'grDevices' && graphicsDeviceCalls.includes(name)) ||
    (pkg === 'HDF5Array' && hdf5ArrayOutputCalls.includes(name)) ||
    (pkg === 'htmlwidgets' &&
      (htmlwidgetsSafeCalls.includes(name) || htmlwidgetsOutputCalls.includes(name))) ||
    (pkg === 'haven' &&
      (havenTabularReadCalls.includes(name) || havenOutputCalls.includes(name))) ||
    (pkg === 'jsonlite' &&
      (jsonliteValueReadCalls.includes(name) || jsonliteOutputCalls.includes(name))) ||
    (pkg === 'Matrix' &&
      (matrixValueReadCalls.includes(name) || matrixOutputCalls.includes(name))) ||
    (pkg === 'magick' &&
      (magickReferenceReadCalls.includes(name) || magickOutputCalls.includes(name))) ||
    (pkg === 'ncdf4' &&
      (ncdf4ReferenceReadCalls.includes(name) || ncdf4OutputCalls.includes(name))) ||
    (pkg === 'openxlsx' &&
      (openxlsxReferenceConstructors.includes(name) ||
        openxlsxMutators.has(name) ||
        openxlsxOutputCalls.includes(name))) ||
    (pkg === 'openxlsx2' && openxlsx2OutputCalls.includes(name)) ||
    (pkg === 'qs' && qsOutputCalls.includes(name)) ||
    (pkg === 'ragg' && raggOutputCalls.includes(name)) ||
    (pkg === 'readr' &&
      (readrTabularReadCalls.includes(name) ||
        readrColumnConstructors.has(name) ||
        readrReferenceReadCalls.includes(name) ||
        readrOutputCalls.includes(name))) ||
    (pkg === 'readxl' && readxlTabularReadCalls.includes(name)) ||
    (pkg === 'readODS' &&
      (readOdsTabularReadCalls.includes(name) || readOdsOutputCalls.includes(name))) ||
    (pkg === 'rhdf5' &&
      (rhdf5ReferenceReadCalls.includes(name) || rhdf5OutputCalls.includes(name))) ||
    (pkg === 'rio' && rioOutputCalls.includes(name)) ||
    (pkg === 'R.matlab' &&
      (rMatlabReferenceReadCalls.includes(name) || rMatlabOutputCalls.includes(name))) ||
    (pkg === 'tibble' && tibbleConstructors.has(name)) ||
    (pkg === 'tidyr' && tidyrMask.has(name)) ||
    (pkg === 'stats' && (modelMask.has(name) || pureSafe.has(name))) ||
    (pkg === 'svglite' && svgliteOutputCalls.includes(name)) ||
    (pkg === 'utils' && outputSafe.has(name)) ||
    (pkg === 'writexl' && writexlOutputCalls.includes(name)) ||
    (pkg === 'xml2' && (xml2ReferenceReadCalls.includes(name) || xml2OutputCalls.includes(name))) ||
    (pkg === 'yaml' && (yamlValueReadCalls.includes(name) || yamlOutputCalls.includes(name)))
  const tabularTransformName = (expr: RExpr | null | undefined): string | null => {
    const name = calledName(expr)
    if (!name || !tabularTransform.has(name)) return null
    const qualified = qualifiedCall(expr)
    if (!qualified) return contractAvailable(name, undefined, 'dplyr') ? name : null
    if (qualified.package === 'dplyr' && tidyMask.has(name)) return name
    if (qualified.package === 'tidyr' && tidyrMask.has(name)) return name
    return null
  }
  const tabularDataIndex = (expr: Extract<RExpr, { kind: 'call' }>): number =>
    callbackArgumentIndex(expr, [tidyMask.has(calledName(expr) ?? '') ? '.data' : 'data'], [])

  const dplyrValueCall = (expr: RExpr): boolean => {
    const name = calledName(expr)
    return Boolean(
      name &&
      R_DPLYR_VALUE_CALLS.has(name) &&
      contractAvailable(name, qualifiedCall(expr)?.package, 'dplyr')
    )
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
    // A known character path is a value, not a connection whose cursor can be consumed.
    const handleRoot = (argument: RExpr | null | undefined): string | null =>
      (isSymbol(argument) && characterLoopNames.has(argument.name)) ||
      rStaticString(argument, staticStrings, staticCollections) !== undefined ||
      rStaticStringCollection(argument, staticStrings, staticCollections) !== undefined
        ? null
        : rootName(argument)
    for (const name of [
      'con',
      'file',
      'path',
      'input',
      'dsn',
      'txt',
      'x',
      'filename',
      'file_path',
      'filepath'
    ]) {
      const argument = namedArgument(expr, name)
      if (argument) return handleRoot(argument)
    }
    if (!isCall(expr) || !expr.args.length) return null
    const positional = expr.names
      .map((label, index) => ({ label, index }))
      .filter((item) => !item.label)
    if (!expr.names.some(Boolean)) return handleRoot(expr.args[0])
    if (!positional.length) return null
    return handleRoot(expr.args[positional[0]!.index])
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
  const baseReplacementName = (expr: RExpr | null | undefined): string | null => {
    const name = calledName(expr)
    const qualified = qualifiedCall(expr)
    if (
      !name ||
      !['names', 'colnames', 'rownames', 'dimnames', 'dim', 'storage.mode'].includes(name) ||
      !contractAvailable(name, qualified?.package, 'base') ||
      !contractAvailable(`${name}<-`, qualified?.package, 'base')
    )
      return null
    return name
  }
  const baseReplacementRoot = (expr: RExpr | null | undefined): string | null => {
    if (!isCall(expr)) return null
    const op = callOperator(expr)
    if (op && ['[', '[['].includes(op) && contractAvailable(`${op}<-`, undefined, 'base'))
      return baseReplacementRoot(expr.args[0])
    return baseReplacementName(expr) ? rootName(expr.args[0]) : null
  }
  const atomicValueExpression = (expr: RExpr | null | undefined): boolean => {
    if (!expr) return false
    if (['atomic', 'character', 'null'].includes(expr.kind)) return true
    if (isSymbol(expr))
      return (
        atomicValueNames.has(expr.name) ||
        (expr.name === 'pi' && contractAvailable('pi', undefined, 'base'))
      )
    if (!isCall(expr)) return false
    const name = calledName(expr)
    if (!name || !contractAvailable(name, qualifiedCall(expr)?.package, 'base')) return false
    // seq dispatches on its first supplied argument. A plain starting value selects
    // the numeric default even when the endpoint is computed from an input table.
    if (name === 'seq' && expr.args.length > 0 && atomicValueExpression(expr.args[0])) return true
    if (
      ['as.character', 'as.integer', 'as.numeric', 'as.logical', 'length', 'nrow', 'ncol'].includes(
        name
      ) &&
      expr.args.length > 0 &&
      expr.args.every((arg) => copyOnModifySources(arg)?.length === 0)
    )
      return true
    if (name === '(' && expr.args.length === 1) return atomicValueExpression(expr.args[0])
    if (name === '[' || name === '[[') {
      return (
        expr.args.length > 0 &&
        atomicValueExpression(expr.args[0]) &&
        expr.args
          .slice(1)
          .every((arg) => (isSymbol(arg) && arg.name === '') || atomicValueExpression(arg))
      )
    }
    const atomicOperator = [
      '+',
      '-',
      '*',
      '/',
      '^',
      ':',
      '!',
      '&',
      '|',
      '&&',
      '||',
      '<',
      '>',
      '<=',
      '>=',
      '==',
      '!='
    ].includes(name)
    return (
      (atomicOperator || R_ATOMIC_VECTOR_CALLS.has(name)) && expr.args.every(atomicValueExpression)
    )
  }

  const staticScalarExpression = (expr: RExpr | null | undefined): boolean => {
    if (expr?.kind === 'atomic' || expr?.kind === 'character') return true
    if (isSymbol(expr))
      return (
        (expr.name === 'pi' && contractAvailable('pi', undefined, 'base')) ||
        staticScalarNames.has(expr.name)
      )
    if (!isCall(expr)) return false
    const op = callOperator(expr)
    if (op === '(' && expr.args.length === 1) return staticScalarExpression(expr.args[0])
    if (!op || !['+', '-', '*', '/', '^'].includes(op) || !contractAvailable(op, undefined, 'base'))
      return false
    return expr.args.every(staticScalarExpression)
  }
  const staticCollectionExpression = (expr: RExpr | null | undefined): boolean => {
    if (isSymbol(expr)) return staticIterableNames.has(expr.name)
    const op = callOperator(expr)
    return Boolean(
      isCall(expr) &&
      (op === 'c' || op === 'list') &&
      expr.args.length > 0 &&
      expr.args.every(staticScalarExpression)
    )
  }
  const staticNamedCollectionExpression = (expr: RExpr | null | undefined): boolean => {
    if (!isCall(expr)) return false
    const name = calledName(expr)
    if (name === 'c' || name === 'list') {
      return (
        staticCollectionExpression(expr) &&
        expr.names.length === expr.args.length &&
        expr.names.every(Boolean)
      )
    }
    if (name === 'setNames') {
      const namesIndex = expr.names.findIndex((candidate) => candidate === 'nm')
      return (
        staticCollectionExpression(expr.args[0]) &&
        staticCollectionExpression(expr.args[namesIndex >= 0 ? namesIndex : 1])
      )
    }
    if (name === 'structure') {
      const namesIndex = expr.names.findIndex((candidate) => candidate === 'names')
      return (
        namesIndex >= 0 &&
        staticCollectionExpression(expr.args[0]) &&
        staticCollectionExpression(expr.args[namesIndex])
      )
    }
    return false
  }
  const knownNamedCollectionExpression = (expr: RExpr | null | undefined): boolean => {
    if (staticNamedCollectionExpression(expr)) return true
    if (!isCall(expr)) return false
    const name = calledName(expr)
    return Boolean(
      (name === 'c' || name === 'list') &&
      expr.args.length > 0 &&
      expr.names.length === expr.args.length &&
      expr.names.every(Boolean)
    )
  }
  const staticNonemptyIterable = (expr: RExpr | null | undefined): boolean => {
    const captured = rStaticStringCollection(expr, staticStrings, staticCollections)
    if (captured) return captured.values.length > 0
    if (isSymbol(expr)) return staticIterableNames.has(expr.name)
    if (!isCall(expr)) return false
    const op = callOperator(expr)
    // Ordinary arithmetic preserves a nonempty scalar/vector value. In particular,
    // computed axis breaks are values, not unresolved callbacks. Do not evaluate
    // the expression or extend this to unknown objects/operators.
    if (op === '(' && expr.args.length === 1) return staticNonemptyIterable(expr.args[0])
    if (
      op &&
      ['+', '-', '*', '/', '^'].includes(op) &&
      contractAvailable(op, undefined, 'base') &&
      expr.args.length > 0
    ) {
      return expr.args.every(
        (argument) => staticScalarExpression(argument) || staticNonemptyIterable(argument)
      )
    }
    if (
      op === 'names' &&
      expr.args.length === 1 &&
      ((isSymbol(expr.args[0]) && staticNamedIterableNames.has(expr.args[0].name)) ||
        knownNamedCollectionExpression(expr.args[0]))
    ) {
      return true
    }
    if (op === ':' && expr.args.length === 2 && expr.args.every(staticScalarExpression)) return true
    if (staticNamedCollectionExpression(expr)) return true
    const name = calledName(expr)
    if (
      name === 'seq_len' &&
      expr.args.length === 1 &&
      expr.args[0]?.kind === 'atomic' &&
      typeof expr.args[0].number === 'number'
    ) {
      return expr.args[0].number > 0
    }
    if (name === 'seq_along' && expr.args.length === 1) {
      return staticNonemptyIterable(expr.args[0])
    }
    if (rIsGlueCall(expr)) {
      const parts = rStaticGlueTemplate(expr)
      return Boolean(
        parts &&
        parts
          .filter((part) => part.kind === 'binding')
          .every(({ value }) => staticScalarNames.has(value) || staticIterableNames.has(value))
      )
    }
    if (name === 'sprintf') {
      return Boolean(
        expr.args.length > 1 &&
        expr.names.every(
          (candidate, index) => !candidate || (index === 0 && candidate === 'fmt')
        ) &&
        staticScalarExpression(expr.args[0]) &&
        expr.args
          .slice(1)
          .every((argument) => staticScalarExpression(argument) || staticNonemptyIterable(argument))
      )
    }
    const combination = rStringCombination(expr)
    if (combination) {
      return Boolean(
        combination.parts.length > 0 &&
        staticScalarExpression(combination.separator) &&
        combination.parts.every(
          (argument) => staticScalarExpression(argument) || staticNonemptyIterable(argument)
        )
      )
    }
    const pathPart = rPathPartArgument(expr)
    if (pathPart)
      return staticScalarExpression(pathPart.argument) || staticNonemptyIterable(pathPart.argument)
    if (
      (op === 'c' || op === 'list') &&
      expr.args.length > 0 &&
      expr.args.every(staticScalarExpression)
    ) {
      return true
    }
    return false
  }
  const tribbleColumnDeclaration = (expr: RExpr | null | undefined): boolean =>
    isCall(expr) && callOperator(expr) === '~' && expr.args.length === 1 && isSymbol(expr.args[0])
  const deterministicLoopBody = (
    expr: RExpr | null | undefined,
    loopBody: RExpr | null | undefined = expr
  ): boolean => {
    if (isSymbol(expr) && ['break', 'next'].includes(expr.name)) return false
    if (!isCall(expr)) return true
    const op = callOperator(expr)
    if (op === 'if') {
      const assigned = new Set(expr.args.slice(1).flatMap(assignedNamesIn))
      const mentionsOutside = (candidate: RExpr | null | undefined): boolean => {
        if (candidate === expr) return false
        if (isSymbol(candidate)) return assigned.has(candidate.name)
        return (
          isCall(candidate) &&
          (assigned.has(callOperator(candidate) ?? '') || candidate.args.some(mentionsOutside))
        )
      }
      // Conditional temporaries are safe only inside the branch that creates
      // them. Do not let a skipped branch borrow values from an earlier run.
      if (
        mentionsOutside(loopBody) ||
        namespaceLoadsIn(expr.args[0]).some((name) => assigned.has(name))
      )
        return false
      for (const branch of expr.args.slice(1)) {
        const bound = new Set<string>()
        const visitBranch = (candidate: RExpr | null | undefined): boolean => {
          if (isCall(candidate) && callOperator(candidate) === '{')
            return candidate.args.every(visitBranch)
          if (namespaceLoadsIn(candidate).some((name) => assigned.has(name) && !bound.has(name)))
            return false
          if (!deterministicLoopBody(candidate, loopBody)) return false
          // Only direct assignments prove a value exists on this branch.
          if (isCall(candidate) && ['<-', '=', '->'].includes(callOperator(candidate) ?? ''))
            for (const name of assignedNamesIn(candidate)) bound.add(name)
          return true
        }
        if (!visitBranch(branch)) return false
      }
      return deterministicLoopBody(expr.args[0], loopBody)
    }
    if (
      op &&
      [
        '<<-',
        '->>',
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
    return expr.args.every((argument) => deterministicLoopBody(argument, loopBody))
  }
  const assignmentRootName = (expr: RExpr | null | undefined): string | null => {
    if (isSymbol(expr)) return expr.name
    if (!isCall(expr) || !['$', '@', '[[', '['].includes(callOperator(expr) ?? '')) return null
    return assignmentRootName(expr.args[0])
  }
  const localAggregationLoopMutationNames = (
    expr: RExpr | null | undefined
  ): Set<string> | undefined => {
    const names = new Set<string>()
    let safe = true
    const inspect = (candidate: RExpr | null | undefined): void => {
      if (!candidate || !safe || !isCall(candidate)) return
      const op = callOperator(candidate)
      if (op && ['<-', '=', '->'].includes(op)) {
        const target = op === '->' ? candidate.args[1] : candidate.args[0]
        const value = op === '->' ? candidate.args[0] : candidate.args[1]
        const name = assignmentRootName(target)
        if (!name || !deterministicLoopBody(value)) {
          safe = false
          return
        }
        names.add(name)
        return
      }
      if (op === '{' || op === '(') {
        for (const arg of candidate.args) inspect(arg)
        return
      }
      if (op === 'if') {
        if (!deterministicLoopBody(candidate.args[0])) {
          safe = false
          return
        }
        for (const branch of candidate.args.slice(1)) inspect(branch)
        return
      }
      safe = false
    }
    inspect(expr)
    return safe && names.size ? names : undefined
  }
  const assignedNamesIn = (expr: RExpr | null | undefined): string[] => {
    if (!isCall(expr) || callOperator(expr) === 'function') return []
    const op = callOperator(expr)
    if (op && ['<-', '=', '->'].includes(op)) {
      const target = op === '->' ? expr.args[1] : expr.args[0]
      const value = op === '->' ? expr.args[0] : expr.args[1]
      return [...(isSymbol(target) && target.name ? [target.name] : []), ...assignedNamesIn(value)]
    }
    if (op === 'for') {
      const target = expr.args[0]
      return [
        ...(isSymbol(target) && target.name ? [target.name] : []),
        ...assignedNamesIn(expr.args[2])
      ]
    }
    return expr.args.flatMap(assignedNamesIn)
  }
  const namespaceLoadsIn = (
    expr: RExpr | null | undefined,
    localScope: ReadonlySet<string> = new Set()
  ): string[] => {
    if (isSymbol(expr)) {
      return expr.name && !localScope.has(expr.name) ? [expr.name] : []
    }
    if (!isCall(expr)) return []
    const op = callOperator(expr)
    if (op === 'function') {
      const formals = expr.args[0]
      const body = expr.args[1]
      const locals = new Set(localScope)
      if (formals?.kind === 'formals') {
        for (const name of formals.names) if (name) locals.add(name)
      }
      for (const name of assignedNamesIn(body)) locals.add(name)
      return namespaceLoadsIn(body, locals)
    }
    if (op && ['<-', '=', '->'].includes(op)) {
      const target = op === '->' ? expr.args[1] : expr.args[0]
      const value = op === '->' ? expr.args[0] : expr.args[1]
      return [
        ...(!isSymbol(target) && isCall(target)
          ? namespaceLoadsIn(target.args[0], localScope)
          : []),
        ...namespaceLoadsIn(value, localScope)
      ]
    }
    if (op === 'for') {
      const target = expr.args[0]
      const loopScope = new Set(localScope)
      if (isSymbol(target) && target.name) loopScope.add(target.name)
      return [
        ...namespaceLoadsIn(expr.args[1], localScope),
        ...namespaceLoadsIn(expr.args[2], loopScope)
      ]
    }
    return [
      ...(op && !localScope.has(op) ? [op] : []),
      ...expr.args.flatMap((arg) => namespaceLoadsIn(arg, localScope))
    ]
  }
  const isolatedConditionalLoops = new Map<RExpr, Set<string>>()
  const localAggregationLoops = new Map<RExpr, Set<string>>()
  for (const [index, expression] of expressions.entries()) {
    if (
      !isCall(expression) ||
      callOperator(expression) !== 'for' ||
      !isSymbol(expression.args[0])
    ) {
      continue
    }
    const deterministicBody = deterministicLoopBody(expression.args[2])
    const localAggregationNames = localAggregationLoopMutationNames(expression.args[2])
    if (!deterministicBody && !localAggregationNames) continue
    const assignedNames = new Set([expression.args[0].name, ...assignedNamesIn(expression.args[2])])
    const laterLoads = new Set(
      expressions.slice(index + 1).flatMap((candidate) => namespaceLoadsIn(candidate))
    )
    if (localAggregationNames && !laterLoads.has(expression.args[0].name)) {
      localAggregationLoops.set(expression, localAggregationNames)
    }
    if (deterministicBody && [...assignedNames].every((name) => !laterLoads.has(name))) {
      isolatedConditionalLoops.set(expression, assignedNames)
    }
  }
  const immediatePaletteFactory = (expr: RExpr): Extract<RExpr, { kind: 'call' }> | undefined => {
    if (!isCall(expr) || !isCall(expr.callee)) return undefined
    const factory = expr.callee
    const name = calledName(factory)
    return name &&
      R_PALETTE_FACTORIES.has(name) &&
      contractAvailable(name, qualifiedCall(factory)?.package, 'grDevices')
      ? factory
      : undefined
  }
  const ordinaryAcross = (expr: RExpr): boolean => {
    if (
      !isCall(expr) ||
      calledName(expr) !== 'across' ||
      !contractAvailable('across', qualifiedCall(expr)?.package, 'dplyr')
    )
      return false
    const callback = expr.args[callbackArgumentIndex(expr, ['.fns'], ['.cols'])]
    if (!callback || isNull(callback)) return true
    const ordinaryCallback = (fn: RExpr): boolean => {
      if (
        isCall(fn) &&
        calledName(fn) === 'list' &&
        contractAvailable('list', qualifiedCall(fn)?.package, 'base')
      )
        return fn.args.every(ordinaryCallback)
      const summary = resolveCallback(fn, ['.x'])
      return summary?.returnType === 'r-value' || summary?.returnCopyArguments === true
    }
    return ordinaryCallback(callback)
  }
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
  const valueOps = [
    '%in%',
    '+',
    '-',
    '*',
    '/',
    '^',
    ':',
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
  // Direct calls and pipes must preserve the same ownership for added or removed columns.
  const transformedTableSources = (
    dataSources: string[] | null,
    transformName: string,
    addedValues: RExpr[]
  ): string[] | null => {
    if (!dataSources) return null
    if (!['mutate', 'transmute', 'summarise', 'summarize'].includes(transformName))
      return dataSources
    const addedSources = addedValues.map((value) => {
      if (ordinaryAcross(value)) return [] as string[]
      if (value.kind === 'atomic' || value.kind === 'character' || value.kind === 'null')
        return [] as string[]
      if (isSymbol(value) || dplyrValueCall(value)) return copyOnModifySources(value)
      const valueOp = callOperator(value)
      if (valueOp && constructors.includes(valueOp)) return copyOnModifySources(value)
      if (valueOp && (valueOps.includes(valueOp) || pureSafe.has(valueOp))) return [] as string[]
      return null
    })
    if (addedSources.some((item) => item === null)) return null
    return unique([...dataSources, ...addedSources.flatMap((item) => item ?? [])])
  }
  const serializedPath = (expr: RExpr | null | undefined): string | undefined => {
    const path = rStaticString(expr, staticStrings, staticCollections)
    return path === undefined ? undefined : serializedSourcePath(path)
  }
  const serializedReader = (expr: RExpr): { format: 'rds' | 'qs' } | undefined => {
    if (!isCall(expr)) return undefined
    const name = calledName(expr)
    const pkg =
      name === 'readRDS'
        ? 'base'
        : name === 'read_rds'
          ? 'readr'
          : name === 'qread'
            ? 'qs'
            : undefined
    return pkg && name && contractAvailable(name, qualifiedCall(expr)?.package, pkg)
      ? { format: pkg === 'qs' ? 'qs' : 'rds' }
      : undefined
  }
  const ordinarySetReduction = (expr: RExpr): { dependency: string; index: number } | undefined => {
    if (
      !isCall(expr) ||
      calledName(expr) !== 'Reduce' ||
      !contractAvailable('Reduce', qualifiedCall(expr)?.package, 'base')
    )
      return undefined
    const index = callbackArgumentIndex(expr, ['f'], [])
    const callback = expr.args[index]
    const qualified =
      isCall(callback) &&
      callOperator(callback) === '::' &&
      isSymbol(callback.args[0]) &&
      isSymbol(callback.args[1])
        ? { package: callback.args[0].name, name: callback.args[1].name }
        : undefined
    const name = isSymbol(callback) ? callback.name : qualified?.name
    if (
      !name ||
      !R_SET_OPERATIONS.has(name) ||
      !contractAvailable(name, qualified?.package, 'base')
    )
      return undefined
    const input = expr.args[callbackArgumentIndex(expr, ['x'], ['f'])]
    if (
      !input ||
      copyOnModifySources(input)?.length !== 0 ||
      expr.args.some((arg, i) => i !== index && copyOnModifySources(arg)?.length !== 0)
    )
      return undefined
    return { dependency: qualified ? `base::${name}` : name, index }
  }

  // Venn stores ordinary set values in S4 slots; region/partition extraction returns
  // a table with ordinary list columns. Preserve ownership through CSV preparation,
  // but never infer it for deserialized objects or user-defined dispatch.
  const ordinaryVennDataCall = (
    expr: Extract<RExpr, { kind: 'call' }>,
    ordinaryValue: (arg: RExpr) => boolean = (arg) => copyOnModifySources(arg)?.length === 0
  ): boolean => {
    const name = calledName(expr)
    const parameters =
      name === 'get.venn.partitions'
        ? ['x', 'force.unique', 'keep.elements', 'hierarchical']
        : name === 'Venn'
          ? ['sets', 'names']
          : name === 'process_region_data'
            ? ['venn', 'sep', 'specific']
            : name === 'process_data'
              ? ['venn', 'nsets', 'shape_id', 'type']
              : undefined
    return Boolean(
      name &&
      parameters &&
      contractAvailable(
        name,
        qualifiedCall(expr)?.package,
        name === 'get.venn.partitions' ? 'VennDiagram' : 'ggVennDiagram'
      ) &&
      expr.args.length > 0 &&
      expr.args.length <= parameters.length &&
      expr.names.every((arg) => !arg || parameters.includes(arg)) &&
      callbackArgumentIndex(expr, [parameters[0]!], []) >= 0 &&
      expr.args.every(ordinaryValue)
    )
  }

  const copyOnModifySources = (expr: RExpr | null | undefined): string[] | null => {
    if (!expr || expr.kind === 'atomic' || expr.kind === 'character' || expr.kind === 'null')
      return []
    if (isSymbol(expr)) {
      if (!expr.name) return []
      if (localNames.includes(expr.name) && ordinaryLoopValues.has(expr.name)) return []
      if (
        ['.Machine', '.Platform'].includes(expr.name) &&
        contractAvailable(expr.name, undefined, 'base') &&
        !mutated.includes(expr.name)
      )
        return []
      if (copyOnModify.includes(expr.name)) return []
      const matching = copyOnModifyBindings.filter((binding) => binding.target === expr.name)
      if (matching.length) return matching[matching.length - 1]?.sourceNames ?? []
      if (copyOnModifyInvalidated.includes(expr.name)) return null
      if (defined.includes(expr.name)) return null
      if (contextualCopyOnModifyNames.includes(expr.name)) return []
      return [expr.name]
    }
    if (!isCall(expr)) return null
    if (readOnlyRuntimeQuery(expr)) return []
    const resultName = calledName(expr)
    if (resultName === 'venn.diagram' && ordinaryVennFilePlot(expr)) return []
    if (ordinaryVennDataCall(expr)) return []
    if (ordinarySetReduction(expr)) return []
    if (
      resultName &&
      R_SET_OPERATIONS.has(resultName) &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'base') &&
      expr.args.length >= 2 &&
      expr.args.every((arg) => copyOnModifySources(arg)?.length === 0)
    )
      return []
    // Arrow's eager table readers return a tibble by default; lazy Table objects do not.
    // https://arrow.apache.org/docs/r/reference/read_parquet.html
    if (
      resultName &&
      ['read_parquet', 'read_feather', 'read_ipc_file'].includes(resultName) &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'arrow')
    ) {
      const optionIndex = callbackArgumentIndex(expr, ['as_data_frame'], ['file', 'col_select'])
      const partialOption = expr.names.some(
        (name) => name && name !== 'as_data_frame' && 'as_data_frame'.startsWith(name)
      )
      const option = expr.args[optionIndex]
      if (
        !partialOption &&
        (optionIndex < 0 || (option?.kind === 'atomic' && option.logical === true))
      )
        return []
    }
    if (
      serializedReader(expr) &&
      (() => {
        const reader = serializedReader(expr)!
        const value = serializedValuePaths.get(
          serializedPath(expr.args[callbackArgumentIndex(expr, ['file'], [])]) ?? ''
        )
        return value?.format === reader.format && value.valueType === 'r-value'
      })()
    )
      return []
    if (
      resultName === 'pull' &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'dplyr')
    )
      return copyOnModifySources(expr.args[callbackArgumentIndex(expr, ['.data'], [])])
    if (
      resultName === 'ifelse' &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'base')
    ) {
      const sources = expr.args.map(copyOnModifySources)
      return sources.some((source) => source === null)
        ? null
        : unique(sources.flatMap((source) => source ?? []))
    }
    if (
      resultName === 'with' &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'base')
    ) {
      const data = expr.args[callbackArgumentIndex(expr, ['data'], [])]
      const body = expr.args[callbackArgumentIndex(expr, ['expr'], ['data'])]
      if (!data || !body || copyOnModifySources(data)?.length !== 0 || assignedNamesIn(body).length)
        return null
      // Reuse the callback return contract without treating mask columns as globals.
      const summary = summarizeCallback(
        { kind: 'call', operator: '~', callee: symbol('~'), args: [body], names: [null] },
        []
      )
      const predicate = calledName(body)
      const ordinaryPredicate =
        predicate &&
        ['!', '&', '&&', '|', '||', '<', '>', '<=', '>=', '==', '!=', '%in%'].includes(predicate) &&
        contractAvailable(predicate, qualifiedCall(body)?.package, 'base')
      return summary && (summary.returnType === 'r-value' || ordinaryPredicate) ? [] : null
    }
    if (resultName === 'seq' && atomicValueExpression(expr)) return []
    if (
      (resultName === 'lapply' || resultName === 'apply') &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'base')
    ) {
      const input = expr.args[callbackArgumentIndex(expr, ['X'], [])]
      const callbackIndex = callbackArgumentIndex(
        expr,
        ['FUN'],
        resultName === 'apply' ? ['X', 'MARGIN'] : ['X']
      )
      const callback = expr.args[callbackIndex]
      const ordinaryArguments = ordinaryFunctionalArguments(expr, callbackIndex)
      const summary = resolveCallback(callback, ['.x'], ordinaryArguments)
      if (
        input &&
        ordinaryArguments &&
        (summary?.returnType === 'r-value' || summary?.returnCopyArguments === true)
      )
        return []
      return null
    }
    if (
      resultName === 'rescale' &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'scales') &&
      atomicValueExpression(expr.args[callbackArgumentIndex(expr, ['x'], [])]) &&
      expr.args.every((arg) => copyOnModifySources(arg)?.length === 0)
    )
      return []
    if (
      resultName &&
      ['nrow', 'ncol', 't', 'lengths'].includes(resultName) &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'base') &&
      expr.args.length > 0 &&
      expr.args.every((arg) => copyOnModifySources(arg)?.length === 0)
    )
      return []
    if (
      resultName &&
      tableJoinCalls.has(resultName) &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'dplyr')
    ) {
      const x = expr.args[callbackArgumentIndex(expr, ['x'], [])]
      const y = expr.args[callbackArgumentIndex(expr, ['y'], ['x'])]
      return x && y && copyOnModifySources(x)?.length === 0 && copyOnModifySources(y)?.length === 0
        ? []
        : null
    }
    if (
      resultName &&
      ['na.omit', 'na.exclude'].includes(resultName) &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'stats')
    )
      return copyOnModifySources(expr.args[0])
    const resultPackage = resultName && valueResultCalls.get(resultName)
    if (
      resultName &&
      resultPackage &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, resultPackage)
    )
      return []
    if (
      resultName &&
      !qualifiedCall(expr) &&
      functions.get(resultName)?.methods[0]?.returnCopyArguments
    ) {
      const sources = expr.args.map(copyOnModifySources)
      return sources.some((source) => source === null)
        ? null
        : unique(sources.flatMap((source) => source ?? []))
    }
    if (
      resultName &&
      !qualifiedCall(expr) &&
      functions.get(resultName)?.methods[0]?.returnType === 'r-value'
    )
      return []
    if (
      resultName === 'subset' &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'base')
    )
      return copyOnModifySources(expr.args[callbackArgumentIndex(expr, ['x'], [])])
    if (
      resultName === 'aggregate' &&
      contractAvailable(resultName, qualifiedCall(expr)?.package, 'stats')
    ) {
      const index = callbackArgumentIndex(expr, ['FUN'], ['x', 'by'])
      const callback = expr.args[index]
      const callbackName = isSymbol(callback) ? callback.name : undefined
      // Only known value reducers establish ownership; arbitrary callbacks can return references.
      if (
        callbackName &&
        ['mean', 'sum', 'min', 'max', 'length'].includes(callbackName) &&
        contractAvailable(callbackName, undefined, 'base')
      ) {
        const formulaIndex = aggregateFormulaIndex(expr)
        const sources = expr.args
          .filter((_, i) => i !== index && i !== formulaIndex)
          .map(copyOnModifySources)
        return sources.some((source) => source === null)
          ? null
          : unique(sources.flatMap((source) => source ?? []))
      }
      return null
    }
    if (
      ['head', 'tail'].includes(calledName(expr) ?? '') &&
      contractAvailable(calledName(expr)!, qualifiedCall(expr)?.package, 'utils')
    ) {
      const inputIndex = callbackArgumentIndex(expr, ['x'], [])
      return copyOnModifySources(expr.args[inputIndex])
    }
    if (immediatePaletteFactory(expr)) return []
    let op = callOperator(expr)
    const qualified = qualifiedCall(expr)
    const transform = op ?? qualified?.name
    if (
      transform &&
      ['rowMeans', 'colMeans', 'rowSums', 'colSums'].includes(transform) &&
      contractAvailable(transform, qualified?.package, 'base')
    )
      return []
    if (op && ['$', '[', '[[', '('].includes(op)) return copyOnModifySources(expr.args[0])
    if (
      transform &&
      (R_ATOMIC_VECTOR_CALLS.has(transform) ||
        R_BASE_STRING_CALLS.includes(transform) ||
        [
          'names',
          'colnames',
          'rownames',
          'levels',
          'duplicated',
          'unlist',
          'merge',
          'rbind',
          'cbind'
        ].includes(transform)) &&
      contractAvailable(transform, qualified?.package, 'base')
    ) {
      const sources = expr.args.map(copyOnModifySources)
      return sources.some((source) => source === null)
        ? null
        : unique(sources.flatMap((source) => source ?? []))
    }
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
    // A frequency table owns its integer counts; it does not retain mutable input objects.
    if (op === 'table' || (qualified?.package === 'base' && qualified.name === 'table')) return []
    if (
      (op && ['as.data.frame', 'as.matrix'].includes(op)) ||
      (qualified?.package === 'base' && ['as.data.frame', 'as.matrix'].includes(qualified.name))
    ) {
      return copyOnModifySources(expr.args[0])
    }
    if (calledName(expr) === 'case_when' && dplyrValueCall(expr)) {
      const values = rCaseWhenArguments(expr, true)
      if (!values) return null
      const sources = values.map(copyOnModifySources)
      return sources.some((source) => source === null)
        ? null
        : unique(sources.flatMap((source) => source ?? []))
    }
    if (dplyrValueCall(expr)) {
      const sources = expr.args.map(copyOnModifySources)
      return sources.some((item) => item === null)
        ? null
        : unique(sources.flatMap((item) => item ?? []))
    }
    const transformName = tabularTransformName(expr)
    if (transformName && tabularTransform.has(transformName) && expr.args.length >= 1) {
      const dataIndex = tabularDataIndex(expr)
      const dataSources = copyOnModifySources(expr.args[dataIndex])
      return transformedTableSources(
        dataSources,
        transformName,
        expr.args.filter((_value, index) => index !== dataIndex)
      )
    }
    if (!op || ![...constructors, ...valueOps].includes(op)) return null
    const callArgs =
      op === 'tribble' ? expr.args.filter((value) => !tribbleColumnDeclaration(value)) : expr.args
    const sources = callArgs.map(copyOnModifySources)
    if (sources.some((item) => item === null)) return null
    return unique(sources.flatMap((item) => item ?? []))
  }
  const walkAssignmentTarget = (target: RExpr): void => {
    const replacement = baseReplacementName(target)
    if (replacement && isCall(target)) {
      const dependency = `${qualifiedCall(target) ? 'base::' : ''}${replacement}<-`
      used.push(dependency)
      if (!defined.includes(dependency)) priorUsed.push(dependency)
      safeCallNames.push(dependency)
      for (const arg of target.args) walk(arg, false)
      return
    }
    const op = callOperator(target)
    if (!op || !isCall(target)) return
    if (op === '$' || op === '@') {
      walk(target.args[0], false)
      return
    }
    if (op === '[[' || op === '[' || op === 'slot') {
      if (baseReplacementRoot(target.args[0])) {
        walkAssignmentTarget(target.args[0]!)
        for (const arg of target.args.slice(1)) walk(arg, false)
        return
      }
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
        const slot = slots.args[index]
        const slotType = isCharacter(slot) ? slot.value : 'ANY'
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
    if (
      qualified?.package === 'openxlsx' &&
      (qualified.name === 'loadWorkbook' || openxlsxReferenceConstructors.includes(qualified.name))
    ) {
      return 'openxlsx.Workbook'
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
  const addOpenxlsxWorkbookSummary = (): void => {
    if (!typeSummaries.some((summary) => summary.name === 'openxlsx.Workbook')) {
      typeSummaries.push({ name: 'openxlsx.Workbook', kind: 'r-r6', fields: [], methods: [] })
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
  const walkDataMask = (
    expr: RExpr | null | undefined,
    trackEnvironment = false,
    phase: RCallbackEvaluation['phase'] = 'immediate'
  ): void => {
    if (isSymbol(expr)) {
      // Immediate masks consume a value now. A binding established by this cell
      // cannot gain a dependency on a later redefinition (unlike deferred aes).
      if (
        phase === 'immediate' &&
        defined.includes(expr.name) &&
        !conditionallyDefined.has(expr.name)
      )
        return
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
    const targetOptions = rTargetDefinitionOptions(expr)
    if (targetOptions) {
      const dependency = isSymbol(expr.callee) ? expr.callee.name : R_TARGET_FUNCTION.name
      used.push(dependency)
      if (!defined.includes(dependency)) priorUsed.push(dependency)
      unknown.push('opaque-call')
      targetOptions.forEach((argument) => walk(argument))
      return
    }
    const quoted = quotedDataCall(expr)
    if (quoted) {
      used.push(quoted.dependency)
      if (!defined.includes(quoted.dependency)) priorUsed.push(quoted.dependency)
      safeCallNames.push(quoted.dependency)
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
    const callback = resolvedOp ? functionalCallbacks.get(resolvedOp) : undefined
    if (callback && resolvedOp && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (!contractAvailable(resolvedOp, qualified?.package, callback.package))
        unknown.push('opaque-call')
      else safeCallNames.push(dependencyName)
      const index = callbackArgumentIndex(expr, callback.keywords, callback.precedingArguments)
      const argument = expr.args[index]
      if (
        !(callback.optional && (!argument || isNull(argument))) &&
        !consumeCallback(argument, {
          phase,
          formulaParameters: callback.formulaParameters,
          allowList: callback.allowList
        })
      )
        unknown.push('opaque-call')
      for (let i = 0; i < expr.args.length; i += 1) {
        if (i === index) continue
        if (
          ['.names', '.unpack'].includes(expr.names[i] ?? '') ||
          callback.valueArguments?.some((name) => callbackArgumentIndex(expr, [name], []) === i)
        )
          walk(expr.args[i], false)
        else walkDataMask(expr.args[i], trackEnvironment, phase)
      }
      return
    }
    if (resolvedOp && R_TIDY_SELECT_CALLS.has(resolvedOp) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (!contractAvailable(resolvedOp, qualified?.package, 'tidyselect'))
        unknown.push('opaque-call')
      else safeCallNames.push(dependencyName)
      // all_of(column_names), for example, reads an environment value, not a column.
      for (const argument of expr.args) walk(argument, false)
      return
    }
    if (resolvedOp === 'case_when' && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      const argumentsToEvaluate = rCaseWhenArguments(expr)
      if (argumentsToEvaluate && contractAvailable(resolvedOp, qualified?.package, 'dplyr'))
        safeCallNames.push(dependencyName)
      else unknown.push('opaque-call')
      for (const argument of argumentsToEvaluate ?? expr.args)
        walkDataMask(argument, trackEnvironment, phase)
      return
    }
    if (resolvedOp && R_DPLYR_VALUE_CALLS.has(resolvedOp) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (dplyrValueCall(expr)) safeCallNames.push(dependencyName)
      else unknown.push('opaque-call')
      for (const argument of expr.args) walkDataMask(argument, trackEnvironment, phase)
      return
    }
    const composed = resolvedOp && !qualified ? functions.get(resolvedOp)?.methods[0] : undefined
    if (composed && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      mergeCallbackReads(composed)
      if (
        phase === 'deferred' &&
        (composed.usedNames ?? []).some((name) => !composed.safeCallNames?.includes(name))
      )
        unknown.push('opaque-call')
      for (const argument of expr.args) walkDataMask(argument, trackEnvironment, phase)
      return
    }
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
    for (const arg of expr.args) walkDataMask(arg, trackEnvironment, phase)
  }
  const walkTabularArguments = (expr: Extract<RExpr, { kind: 'call' }>): void => {
    const dataIndex = tabularDataIndex(expr)
    const valueArguments = R_TABLE_SELECTION_VALUE_ARGUMENTS.get(calledName(expr) ?? '') ?? []
    const tidyArguments = R_TIDYR_ARGUMENTS.get(calledName(expr) ?? '')
    const positional = tidyArguments?.positional ?? []
    const optionIndex = (name: string): number => {
      const named = expr.names.indexOf(name)
      if (named >= 0) return named
      const position = positional.indexOf(name)
      return position >= 0 ? callbackArgumentIndex(expr, [name], positional.slice(0, position)) : -1
    }
    const values = new Set(tidyArguments?.values.map(optionIndex) ?? [])
    const callbacks = new Set(tidyArguments?.callbacks?.map(optionIndex) ?? [])
    expr.args.forEach((argument, index) => {
      if (tidyArguments && expr.names[index] === 'names_glue') {
        // glue templates can execute arbitrary R expressions, not just rename columns.
        if (!isNull(argument)) unknown.push('dynamic-namespace')
        walk(argument, false)
      } else if (tidyArguments && index === optionIndex('names_repair')) {
        const policy = rStaticString(argument, staticStrings, staticCollections)
        if (
          !(
            policy &&
            [
              'minimal',
              'unique',
              'universal',
              'check_unique',
              'unique_quiet',
              'universal_quiet'
            ].includes(policy)
          ) &&
          !consumeCallback(argument, { phase: 'immediate', formulaParameters: ['.x'] })
        )
          unknown.push('opaque-call')
        walk(argument, false)
      } else if (callbacks.has(index)) {
        if (
          !isNull(argument) &&
          !consumeCallback(argument, {
            phase: 'immediate',
            allowList: true,
            formulaParameters: ['.x']
          })
        )
          unknown.push('opaque-call')
        walk(argument, false)
      } else if (
        index === dataIndex ||
        values.has(index) ||
        valueArguments.includes(expr.names[index] ?? '')
      )
        walk(argument, false)
      else walkDataMask(argument, true)
    })
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
    themeIndependentPlots.delete(name)
    const conditional = controlDepth > 0
    isolatedConditionallyDefined.delete(name)
    staticIterableNames.delete(name)
    staticNamedIterableNames.delete(name)
    staticScalarNames.delete(name)
    literalLabelNames.delete(name)
    atomicValueNames.delete(name)
    staticStrings.delete(name)
    staticCollections.delete(name)
    localInputHandleNames.delete(name)
    characterLoopNames.delete(name)
    namespaceProbePackages.delete(name)
    functions.delete(name)
    typeBindings = typeBindings.filter((binding) => binding.target !== name)
    copyOnModify = copyOnModify.filter((item) => item !== name)
    copyOnModifyBindings = copyOnModifyBindings.filter((binding) => binding.target !== name)
    copyOnModifyInvalidated = copyOnModifyInvalidated.filter((item) => item !== name)
    if (conditional) {
      conditionallyDefined.add(name)
      unknown.push('control-flow')
    } else conditionallyDefined.delete(name)
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
  let circularLayout: RCircularLayout = { reset: false, initialized: false }
  const ordinaryVennFilePlot = (expr: Extract<RExpr, { kind: 'call' }>): boolean => {
    const filename = expr.args[callbackArgumentIndex(expr, ['filename'], ['x'])]
    return (
      contractAvailable('venn.diagram', qualifiedCall(expr)?.package, 'VennDiagram') &&
      callbackArgumentIndex(expr, ['x'], []) >= 0 &&
      Boolean(filename && !isNull(filename)) &&
      expr.args.every((arg) => copyOnModifySources(arg)?.length === 0)
    )
  }
  let rGraphicsState: { readsPrior: boolean; resets: boolean } | undefined
  const rOptionWrites = new Set<string>()
  let rThemeState: { reads: boolean; writes: boolean } | undefined
  const themeIndependentPlots = new Set<string>()
  const themeIndependentConstructors = new Set<RExpr>()
  const completeThemeNames = new Set([
    'theme_bw',
    'theme_classic',
    'theme_gray',
    'theme_grey',
    'theme_light',
    'theme_dark',
    'theme_linedraw',
    'theme_minimal',
    'theme_test',
    'theme_void'
  ])
  // A complete theme belongs to this plot, not the session's theme_set provider.
  // Only recognize direct ggplot chains; compositions, arbitrary add methods and
  // theme values from another cell retain their prior-state dependency.
  const independentPlot = (expr: RExpr | undefined): boolean => {
    if (isSymbol(expr)) return themeIndependentPlots.has(expr.name)
    let base: RExpr | undefined = expr
    let complete = false
    while (isCall(base) && callOperator(base) === '+' && base.args.length === 2) {
      if (!contractAvailable('+', undefined, 'base')) return false
      const component = base.args[1]
      const name = calledName(component)
      if (
        !name ||
        ['ggplot', 'ggsave', 'qplot'].includes(name) ||
        !contractAvailable(name, qualifiedCall(component)?.package, 'ggplot2') ||
        !(ggplot2SafeCalls.includes(name) || R_PLOT_VALUE_CALLS.get(name)?.includes('ggplot2'))
      )
        return false
      if (completeThemeNames.has(name)) complete = true
      base = base.args[0]
    }
    if (isSymbol(base)) return themeIndependentPlots.has(base.name)
    const constructor = calledName(base)
    if (
      !complete ||
      !base ||
      !constructor ||
      !['ggplot', 'ggVennDiagram'].includes(constructor) ||
      !contractAvailable(
        constructor,
        qualifiedCall(base)?.package,
        constructor === 'ggplot' ? 'ggplot2' : 'ggVennDiagram'
      )
    )
      return false
    themeIndependentConstructors.add(base)
    return true
  }
  let freshPlot = false
  const walk = (expr: RExpr | null | undefined, assignmentTarget = false): void => {
    if (!expr) return
    const inspection = packageInspections.get(expr)
    if (inspection) {
      used.push(...inspection.calls, ...inspection.reads)
      priorUsed.push(
        ...inspection.calls,
        ...inspection.reads.filter((name) => !defined.includes(name))
      )
      safeCallNames.push(...inspection.calls)
      for (const name of inspection.writes) {
        prepareAssignment(name)
        if (inspection.conditional) {
          conditionallyDefined.add(name)
          isolatedConditionallyDefined.add(name)
        } else {
          defined.push(name)
          copyOnModify.push(name)
        }
      }
      return
    }
    if (isSymbol(expr)) {
      if (!expr.name) return
      if (!assignmentTarget && localNames.includes(expr.name)) return
      if (assignmentTarget) defined.push(expr.name)
      else {
        used.push(expr.name)
        if (!defined.includes(expr.name)) priorUsed.push(expr.name)
        if (
          ['.Machine', '.Platform'].includes(expr.name) &&
          contractAvailable(expr.name, undefined, 'base') &&
          !mutated.includes(expr.name)
        )
          safeCallNames.push(expr.name)
      }
      return
    }
    if (!isCall(expr)) return
    // R's function-position lookup skips non-function data bindings. Resolve
    // only an ordinary value and an unambiguous, explicitly loaded package;
    // unknown bindings and actual function overrides retain their barriers.
    if (
      isSymbol(expr.callee) &&
      !localNames.includes(expr.callee.name) &&
      copyOnModifySources(expr.callee)?.length === 0 &&
      !functions.has(expr.callee.name)
    ) {
      const name = expr.callee.name
      const providers = [...rPackageLoads].filter((pkg) => knownQualifiedCall(pkg, name))
      if (providers.length === 1) {
        walk(
          { ...expr, callee: rCall('::', [symbol(providers[0]!), symbol(name)]) },
          assignmentTarget
        )
        return
      }
    }
    if (expr.pipedWithMagrittr) {
      used.push('%>%')
      if (!defined.includes('%>%')) priorUsed.push('%>%')
      if (contractAvailable('%>%', undefined, 'magrittr')) safeCallNames.push('%>%')
      else unknown.push('opaque-call')
      recordPackageRead('%>%')
    }
    const targetOptions = rTargetDefinitionOptions(expr)
    if (targetOptions) {
      const dependency = isSymbol(expr.callee) ? expr.callee.name : R_TARGET_FUNCTION.name
      used.push(dependency)
      if (!defined.includes(dependency)) priorUsed.push(dependency)
      unknown.push('opaque-call')
      targetOptions.forEach((argument) => walk(argument))
      return
    }
    const quoted = quotedDataCall(expr)
    if (quoted) {
      used.push(quoted.dependency)
      if (!defined.includes(quoted.dependency)) priorUsed.push(quoted.dependency)
      safeCallNames.push(quoted.dependency)
      return
    }
    let op = callOperator(expr)
    const qualified = qualifiedCall(expr)
    if (!op && qualified && knownQualifiedCall(qualified.package, qualified.name))
      op = qualified.name
    const dependencyName = qualified ? `${qualified.package}::${qualified.name}` : op
    // An opaque local function can shadow a built-in reader or constructor.
    // Check it before applying any library contract with the same name.
    const opaqueFunction = op && !qualified ? functions.get(op)?.methods[0] : undefined
    if (
      opaqueFunction &&
      opaqueFunction.effect !== 'read' &&
      expr.resolvedFunction !== R_GLUE_FUNCTION.name
    ) {
      used.push(op!)
      if (!defined.includes(op!)) priorUsed.push(op!)
      mergeCallbackReads(opaqueFunction)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (
      op &&
      !qualified &&
      isSymbol(expr.callee) &&
      expr.resolvedFunction !== R_GLUE_FUNCTION.name &&
      (safeCalls.has(op) ||
        [...knownNamespacePackages, 'base', 'stats', 'utils'].some((pkg) =>
          knownQualifiedCall(pkg, op)
        )) &&
      (defined.includes(op) || shadowedCallbackCalls.has(op) || localNames.includes(op)) &&
      !functions.has(op) &&
      !localFileWrappers.names.has(op) &&
      !contextualFileWrappers.some((wrapper) => wrapper.name === op)
    ) {
      // Rebinding a built-in to an unknown callable invalidates the same
      // contract for both ordinary calls and syntactically expanded pipes.
      used.push(op)
      if (!defined.includes(op)) priorUsed.push(op)
      unknown.push('opaque-call')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (op && !qualified) recordPackageRead(op)
    // Record ownership at serialization time, not the variable's final cell value.
    const fileEffect = op ? R_FILE_CALL_EFFECTS.get(op) : undefined
    if (
      op &&
      (localFileWrappers.effects.get(op)?.kind === 'write' ||
        contextualFileWrappers.some((wrapper) => wrapper.name === op && wrapper.kind === 'write') ||
        // Opening/reopening a connection can truncate a file before any explicit write.
        ['file', 'gzfile', 'bzfile', 'xzfile', 'unz', 'gzcon', 'open'].includes(op) ||
        (op === 'cat' && expr.names.includes('file')))
    )
      invalidateSerializedValues()
    if (fileEffect?.kind === 'write') {
      const path = serializedPath(rFileCallArgument(expr, fileEffect))
      invalidateSerializedValues(path)
      if (
        ['saveRDS', 'write_rds', 'qsave'].includes(op ?? '') &&
        path &&
        controlDepth === 0 &&
        contractAvailable(
          op!,
          qualified?.package,
          op === 'saveRDS' ? 'base' : op === 'qsave' ? 'qs' : 'readr'
        ) &&
        copyOnModifySources(expr.args[callbackArgumentIndex(expr, ['object', 'x'], [])])?.length ===
          0
      ) {
        const value: NotebookSerializedValue = {
          path,
          format: op === 'qsave' ? 'qs' : 'rds',
          valueType: 'r-value'
        }
        serializedValueWrites.set(path, value)
        serializedValuePaths.set(path, value)
      }
    }
    if (op && ['readRDS', 'read_rds', 'qread'].includes(op))
      serializedValueReads.add(
        rStaticString(
          expr.args[callbackArgumentIndex(expr, ['file'], [])],
          staticStrings,
          staticCollections
        ) ?? '<dynamic>'
      )
    if (readOnlyRuntimeQuery(expr)) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      // Results describe the current runtime; querying does not mutate its namespace.
      unknown.push('external-state')
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op && runtimeQueryPackages.has(op)) unknown.push('opaque-call')
    if (op && ['get.venn.partitions', 'Venn', 'process_region_data', 'process_data'].includes(op)) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      if (ordinaryVennDataCall(expr)) safeCallNames.push(dependencyName!)
      else unknown.push('opaque-call')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (op === 'slotNames') {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      if (
        contractAvailable(op, qualified?.package, 'methods') &&
        expr.args.length === 1 &&
        (!expr.names[0] || expr.names[0] === 'x') &&
        copyOnModifySources(expr.args[0])?.length === 0
      )
        safeCallNames.push(dependencyName!)
      else unknown.push('opaque-call')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (op === 'formals') {
      const target = expr.args[0]
      const reference: RExpr | undefined = target && {
        kind: 'call',
        operator: null,
        callee: target,
        args: [],
        names: []
      }
      const targetName = calledName(reference)
      const targetPackage =
        targetName === 'venn'
          ? 'venn'
          : ['plot_venn', 'ggVennDiagram', 'process_data'].includes(targetName ?? '')
            ? 'ggVennDiagram'
            : undefined
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      if (
        contractAvailable(op, qualified?.package, 'base') &&
        expr.args.length === 1 &&
        (!expr.names[0] || expr.names[0] === 'fun') &&
        targetPackage &&
        targetName &&
        contractAvailable(targetName, qualifiedCall(reference)?.package, targetPackage)
      ) {
        const targetDependency = qualifiedCall(reference)
          ? `${targetPackage}::${targetName}`
          : targetName
        used.push(targetDependency)
        if (!defined.includes(targetDependency)) priorUsed.push(targetDependency)
        safeCallNames.push(dependencyName!, targetDependency)
        recordPackageRead(targetName)
      } else {
        unknown.push('opaque-call')
        expr.args.forEach((arg) => walk(arg))
      }
      return
    }
    if (op === 'venn') {
      const parameters = [
        'x',
        'snames',
        'ilabels',
        'ellipse',
        'zcolor',
        'opacity',
        'plotsize',
        'ilcs',
        'sncs',
        'borders',
        'box',
        'par',
        'ggplot'
      ]
      const ggplot = expr.args[callbackArgumentIndex(expr, ['ggplot'], parameters.slice(0, 12))]
      const par = expr.args[callbackArgumentIndex(expr, ['par'], parameters.slice(0, 11))]
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      if (
        contractAvailable(op, qualified?.package, 'venn') &&
        callbackArgumentIndex(expr, ['x'], []) >= 0 &&
        expr.args.length <= parameters.length &&
        expr.names.every((name) => !name || parameters.includes(name)) &&
        (!ggplot || (ggplot.kind === 'atomic' && ggplot.logical === false)) &&
        (!par || (par.kind === 'atomic' && par.logical === true)) &&
        expr.args.every((arg) => copyOnModifySources(arg)?.length === 0)
      ) {
        safeCallNames.push(dependencyName!)
        if (controlDepth === 0) freshPlot = true
      } else unknown.push('opaque-call')
      unknown.push('external-state')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (op === 'pheatmap') {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      const argument = (name: string): RExpr | undefined =>
        expr.args[
          callbackArgumentIndex(
            expr,
            [name],
            R_PHEATMAP_PARAMETERS.slice(0, R_PHEATMAP_PARAMETERS.indexOf(name))
          )
        ]
      // Ordinary matrix/annotation values are copy-on-modify. Custom callbacks
      // and k-means require separate effect/randomness contracts.
      if (
        contractAvailable(op, qualified?.package, 'pheatmap') &&
        argument('mat') &&
        argument('filename') &&
        !argument('clustering_callback') &&
        !argument('kmeans_k') &&
        // Do not let partial argument matching bypass the special controls.
        expr.names.every(
          (name) =>
            !name ||
            R_PHEATMAP_PARAMETERS.includes(name) ||
            !R_PHEATMAP_PARAMETERS.some((parameter) => parameter.startsWith(name))
        ) &&
        expr.args.every((arg) =>
          arg === argument('filename')
            ? Boolean(rStaticString(arg, staticStrings, staticCollections))
            : copyOnModifySources(arg)?.length === 0
        )
      )
        safeCallNames.push(dependencyName!)
      else unknown.push('opaque-call')
      invalidateSerializedValues(serializedPath(argument('filename')))
      unknown.push('external-state')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (op === 'venn.diagram') {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      if (ordinaryVennFilePlot(expr)) safeCallNames.push(dependencyName!)
      else unknown.push('opaque-call')
      unknown.push('external-state')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (op === 'rescale') {
      if (
        !contractAvailable(op, qualified?.package, 'scales') ||
        !expr.args.length ||
        !atomicValueExpression(expr.args[callbackArgumentIndex(expr, ['x'], [])]) ||
        expr.args.some((arg) => copyOnModifySources(arg)?.length !== 0)
      )
        unknown.push('opaque-call')
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      rPackageReads.add('scales')
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op === 'options' && contractAvailable(op, qualified?.package, 'base')) {
      const formattingOptions = ['scipen', 'digits', 'width', 'max.print']
      for (const name of expr.names) {
        if (name && formattingOptions.includes(name)) rOptionWrites.add(name)
      }
      const safeFormatting =
        expr.args.length > 0 &&
        expr.args.every((arg, index) => {
          const name = expr.names[index]
          return (
            name &&
            formattingOptions.includes(name) &&
            arg?.kind === 'atomic' &&
            typeof arg.number === 'number' &&
            Number.isFinite(arg.number)
          )
        })
      if (safeFormatting) {
        used.push(dependencyName!)
        if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
        safeCallNames.push(dependencyName!)
        return
      }
      unknown.push('opaque-call')
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (
      op &&
      [
        'theme_set',
        'theme_get',
        'theme_update',
        'theme_replace',
        'ggplot',
        'qplot',
        'ggsave'
      ].includes(op) &&
      contractAvailable(op, qualified?.package, 'ggplot2')
    ) {
      rThemeState ??= { reads: false, writes: false }
      const plot =
        op === 'ggsave' ? expr.args[callbackArgumentIndex(expr, ['plot'], ['filename'])] : undefined
      if (!(op === 'ggsave' ? independentPlot(plot) : themeIndependentConstructors.has(expr)))
        rThemeState.reads = true
      if (['theme_set', 'theme_update', 'theme_replace'].includes(op)) rThemeState.writes = true
      if (op.startsWith('theme_')) {
        used.push(dependencyName!)
        if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
        safeCallNames.push(dependencyName!)
        rPackageReads.add('ggplot2')
        for (const arg of expr.args) walk(arg, false)
        return
      }
    }

    if (
      op &&
      ['na.omit', 'na.exclude'].includes(op) &&
      contractAvailable(op, qualified?.package, 'stats') &&
      copyOnModifySources(expr.args[0])?.length === 0
    ) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (
      op === 't' &&
      contractAvailable(op, qualified?.package, 'base') &&
      copyOnModifySources(expr.args[callbackArgumentIndex(expr, ['x'], [])])?.length === 0
    ) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (op && ['unlist', 't'].includes(op) && !contractAvailable(op, qualified?.package, 'base'))
      unknown.push('opaque-call')
    if (op === 'p.adjust' && !contractAvailable(op, qualified?.package, 'stats'))
      unknown.push('opaque-call')

    const fileMutation = rPrimitiveFileMutation(expr, staticStrings, staticCollections)
    if (fileMutation) {
      const removedPaths = rExactUnlinkPaths(expr, staticStrings, staticCollections)
      if (removedPaths)
        removedPaths.forEach((path) => invalidateSerializedValues(serializedSourcePath(path)))
      else invalidateSerializedValues()
      used.push(fileMutation)
      if (!defined.includes(fileMutation)) priorUsed.push(fileMutation)
      safeCallNames.push(fileMutation)
      unknown.push('external-state')
      for (const argument of expr.args) walk(argument, false)
      return
    }

    // Primitive external calls cannot rewrite R bindings. Their filesystem /
    // font-registry effects remain unsupported by file capture; do not promote
    // that limitation into arbitrary mutation of every later Notebook variable.
    const externalPackage = op && R_UNCAPTURED_EXTERNAL_CALLS.get(op)
    const externalCall =
      externalPackage &&
      (externalPackage === 'base' || qualified) &&
      contractAvailable(op!, qualified?.package, externalPackage)
    if (
      externalCall &&
      expr.args.every(
        (arg) =>
          arg.kind === 'atomic' ||
          arg.kind === 'null' ||
          rStaticString(arg, staticStrings, staticCollections) !== undefined ||
          rStaticStringCollection(arg, staticStrings, staticCollections) !== undefined
      )
    ) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      unknown.push('external-state')
      for (const argument of expr.args) walk(argument, false)
      return
    }

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
    if (rIsGlueCall(expr) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(R_GLUE_FUNCTION.name)
      const template = rStaticGlueTemplate(expr)
      if (!template) unknown.push('opaque-call')
      else {
        for (const name of unique(
          template.filter((part) => part.kind === 'binding').map((part) => part.value)
        )) {
          used.push(name)
          if (!defined.includes(name)) priorUsed.push(name)
        }
      }
      return
    }
    if (R_DEVICE_EXPORT_CALLS.has(calledName(expr) ?? '')) {
      const device = rGraphicsDeviceExport(expr)
      const deviceName = device && calledName(device)
      const exporter = calledName(expr)!
      const dependency = qualified ? `grDevices::${exporter}` : exporter
      used.push(dependency)
      if (!defined.includes(dependency)) priorUsed.push(dependency)
      if (
        device &&
        deviceName &&
        contractAvailable(exporter, qualified?.package, 'grDevices') &&
        contractAvailable(deviceName, qualifiedCall(device)?.package, 'grDevices')
      ) {
        safeCallNames.push(dependency)
        // Copying the current display list is only self-contained after this run
        // created a plot. Exporting an earlier cell's device needs missing state.
        if (!freshPlot) unknown.push('opaque-call', 'external-state')
        const previousPlot = freshPlot
        walk(device)
        freshPlot = previousPlot
      } else {
        unknown.push('opaque-call', 'external-state')
        expr.args.forEach((argument) => walk(argument))
      }
      return
    }
    const paletteFactory = immediatePaletteFactory(expr)
    if (paletteFactory) {
      walk(paletteFactory)
      expr.args.forEach((argument) => walk(argument))
      return
    }
    if (
      op &&
      R_CIRCULAR_PLOT_CALLS.has(op) &&
      contractAvailable(op, qualified?.package, 'circlize')
    ) {
      rGraphicsState ??= { readsPrior: false, resets: false }
      if (op !== 'circos.clear' && !circularLayout.reset) rGraphicsState.readsPrior = true
      if (op === 'circos.clear' && controlDepth === 0) rGraphicsState.resets = true
      let next = op === 'circos.par' ? circularLayout : nextCircularLayout(op, circularLayout)
      // These initializers create the sector layout themselves, but preserve
      // package parameters. Missing a reset is an implicit-state gap, not an
      // unknown panel callback or unknown file I/O.
      if (!next && ['chordDiagram', 'circos.initialize'].includes(op)) {
        next = { reset: false, initialized: true }
      }
      if (op !== 'circos.clear' && !circularLayout.reset) unknown.push('graphics-state-unavailable')
      if (!next) unknown.push('external-state')
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      expr.args.forEach((argument, index) => {
        if (op === 'circos.trackPlotRegion' && expr.names[index] === 'panel.fun') {
          const panel = summarizeCallback(argument, undefined, circularLayout.initialized)
          if (panel) mergeCallbackReads(panel)
          else {
            unknown.push('function-scope', 'opaque-call')
            walk(argument)
          }
        } else walk(argument)
      })
      if (op === 'chordDiagram' && next && controlDepth === 0) freshPlot = true
      circularLayout = next ?? { reset: false, initialized: false }
      return
    }
    if (op === 'tryCatch' && contractAvailable(op, qualified?.package, 'base')) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      // Protected expressions can stop at any point. Bindings and device layout
      // established there are not guaranteed to survive an error handler.
      controlDepth += 1
      expr.args.forEach((argument, index) => {
        if (!expr.names[index] || ['expr', 'finally'].includes(expr.names[index]!)) walk(argument)
        else {
          const handler = summarizeCallback(argument, undefined, false, true)
          if (handler) mergeCallbackReads(handler)
          else {
            unknown.push('function-scope', 'opaque-call')
            walk(argument)
          }
        }
      })
      controlDepth -= 1
      circularLayout = { reset: false, initialized: false }
      freshPlot = false
      return
    }
    if (op === 'try' && contractAvailable(op, qualified?.package, 'base')) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      if (
        expr.args.length > 2 ||
        expr.names.some((name) => name && !['expr', 'silent'].includes(name))
      )
        unknown.push('opaque-call')
      else safeCallNames.push(dependencyName!)
      controlDepth += 1
      for (const argument of expr.args) walk(argument)
      controlDepth -= 1
      circularLayout = { reset: false, initialized: false }
      freshPlot = false
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
      const name = rootName(target) ?? baseReplacementRoot(target)
      const aliasedFunction = isSymbol(value) ? functions.get(value.name) : undefined
      const definedBefore = unique(defined)
      const usedBefore = used.length
      let r6Summary: NotebookDependencyTypeSummary | null = null
      let constructed: string | null = null
      let simpleAliasAssignment = false
      let functionDefinition = false
      if (name) {
        if (nonlocal) {
          used.push(name)
          possiblyMutated.push(name)
          unknown.push('nonlocal-assignment')
        } else if (isSymbol(target)) {
          const independentTheme = independentPlot(value)
          const literalLabel = literalLabelValue(value)
          // Read RHS knowledge before invalidating the target: x <- x * pi is
          // an ordinary value transformation, not an unresolved self-reference.
          const atomicValue = atomicValueExpression(value)
          const scalarValue = staticScalarExpression(value)
          const nonemptyIterable = staticNonemptyIterable(value)
          const copySources = copyOnModifySources(value)
          const staticString = rStaticString(value, staticStrings, staticCollections)
          const staticCollection = rStaticStringCollection(value, staticStrings, staticCollections)
          const inputHandleAlias = isSymbol(value) && localInputHandleNames.has(value.name)
          defined.push(name)
          prepareAssignment(name)
          if (controlDepth === 0 && independentTheme) themeIndependentPlots.add(name)
          if (controlDepth === 0 && literalLabel) literalLabelNames.add(name)
          if (controlDepth === 0 && atomicValue) atomicValueNames.add(name)
          if (controlDepth === 0 && staticString !== undefined)
            staticStrings.set(name, staticString)
          if (controlDepth === 0 && staticCollection) staticCollections.set(name, staticCollection)
          const valueCall = value ? calledName(value) : null
          const valueQualified = value ? qualifiedCall(value) : null
          if (
            controlDepth === 0 &&
            (inputHandleAlias ||
              (valueCall &&
                [
                  'I',
                  'rawConnection',
                  'textConnection',
                  'file',
                  'gzfile',
                  'bzfile',
                  'xzfile',
                  'unz',
                  'gzcon'
                ].includes(valueCall) &&
                (valueQualified?.package === 'base' ||
                  (!valueQualified && !localNames.includes(valueCall)))))
          ) {
            localInputHandleNames.add(name)
          }
          if (controlDepth === 0 && scalarValue) staticScalarNames.add(name)
          if (controlDepth === 0 && nonemptyIterable) staticIterableNames.add(name)
          if (
            controlDepth === 0 &&
            ((isSymbol(value) && staticNamedIterableNames.has(value.name)) ||
              knownNamedCollectionExpression(value))
          ) {
            staticNamedIterableNames.add(name)
          }
          if (copySources) {
            if (!copySources.length) copyOnModify.push(name)
            else copyOnModifyBindings.push({ target: name, sourceNames: copySources })
          }
          r6Summary = value ? summarizeR6(name, value) : null
          const callable =
            summarizeCallback(value) ??
            (isCall(value) &&
            calledName(value) === 'function' &&
            !localFileWrappers.effects.has(name)
              ? { name: '__call__', effect: 'unknown' as const, unknownScope: 'namespace' as const }
              : undefined)
          if (callable && controlDepth === 0) {
            const summary: NotebookDependencyTypeSummary = {
              name: `r-function:${name}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`,
              kind: 'r-function',
              fields: [],
              methods: [callable]
            }
            functions.set(name, summary)
            typeSummaries.push(summary)
            typeBindings.push({ target: name, typeName: summary.name, argumentNames: [] })
            functionDefinition = true
          }
          constructed = value ? constructorType(value) : null
          if (r6Summary) typeSummaries.push(r6Summary)
          else if (constructed) {
            if (constructed === 'data.table') addDataTableSummary()
            else if (constructed === 'openxlsx.Workbook') addOpenxlsxWorkbookSummary()
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
            if (aliasedFunction && controlDepth === 0) functions.set(name, aliasedFunction)
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
          // Editing ordinary layer aesthetics cannot replace the plot's theme.
          // Other nested writes can; invalidate aliases as well as the root.
          const parent = isCall(target) && target.operator === '$' ? target.args[0] : undefined
          const layer =
            isCall(parent) &&
            parent.operator === '$' &&
            isSymbol(parent.args[1]) &&
            parent.args[1].name === 'aes_params'
              ? parent.args[0]
              : undefined
          const layers = isCall(layer) && layer.operator === '[[' ? layer.args[0] : undefined
          const aestheticWrite =
            isCall(layers) &&
            layers.operator === '$' &&
            isSymbol(layers.args[0]) &&
            isSymbol(layers.args[1]) &&
            layers.args[1].name === 'layers' &&
            isCall(layer) &&
            layer.args.length === 2 &&
            layer.args[1].kind === 'atomic' &&
            Number.isInteger(layer.args[1].number) &&
            layer.args[1].number! > 0 &&
            copyOnModifySources(value)?.length === 0
          if (!aestheticWrite) themeIndependentPlots.clear()
          const targetOperator = callOperator(target)
          const atomicReplacement =
            controlDepth === 0 &&
            (targetOperator === '[' || targetOperator === '[[') &&
            contractAvailable(`${targetOperator}<-`, qualifiedCall(target)?.package, 'base') &&
            atomicValueExpression(target) &&
            atomicValueExpression(value)
          staticStrings.delete(name)
          staticCollections.delete(name)
          namespaceProbePackages.delete(name)
          atomicValueNames.delete(name)
          if (atomicReplacement) atomicValueNames.add(name)
          literalLabelNames.delete(name)
          staticScalarNames.delete(name)
          staticIterableNames.delete(name)
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
      if (!functionDefinition && !r6Summary && !constructed && !simpleAliasAssignment && value)
        walk(value, false)
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
      // Read-only functions may return an argument or a captured reference.
      // Preserve possible sharing; the projector can discharge ordinary R value copies.
      if (isSymbol(target) && isCall(value)) {
        const called = callOperator(value)
        const summary = called ? functions.get(called)?.methods[0] : undefined
        if (summary) {
          const sources = [
            ...value.args.map(rootName).filter((item): item is string => Boolean(item)),
            ...(summary.usedNames ?? []).filter((item) => !summary.safeCallNames?.includes(item))
          ]
          for (const source of unique(sources))
            if (source !== target.name) addPossibleAlias(target.name, source)
        }
      }
      return
    }
    if (op === 'assign') unknown.push('dynamic-assignment')
    if (
      op === 'save.image' ||
      (op === 'save' &&
        (namedArgument(expr, 'list') !== null || namedArgument(expr, 'envir') !== null))
    )
      unknown.push('dynamic-namespace')
    if (['get', 'eval', 'parse', 'substitute', 'do.call'].includes(op))
      unknown.push('dynamic-namespace')
    if (op === 'requireNamespace' && dependencyName) {
      const packageIndex = callbackArgumentIndex(expr, ['package'], [])
      const quietlyIndex = callbackArgumentIndex(expr, ['quietly'], ['package'])
      const packageExpr = expr.args[packageIndex]
      const packages = isCharacter(packageExpr)
        ? [packageExpr.value]
        : isSymbol(packageExpr)
          ? staticStrings.has(packageExpr.name)
            ? [staticStrings.get(packageExpr.name)!]
            : namespaceProbePackages.get(packageExpr.name)
          : undefined
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      // Namespace loading is distinct from attaching exports. Only recognize known packages
      // with the default library search; custom lib.loc/versionCheck still need evidence.
      if (
        contractAvailable(op, qualified?.package, 'base') &&
        packages?.length &&
        packages.every((pkg) => knownNamespacePackages.has(pkg)) &&
        expr.args.every((_, index) => index === packageIndex || index === quietlyIndex)
      )
        safeCallNames.push(dependencyName)
      else unknown.push('dynamic-namespace')
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op === 'subset' && contractAvailable(op, qualified?.package, 'base')) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      const dataIndex = callbackArgumentIndex(expr, ['x'], [])
      if (copyOnModifySources(expr.args[dataIndex])?.length !== 0) unknown.push('opaque-call')
      for (let i = 0; i < expr.args.length; i++) {
        const argument = expr.args[i]!
        if (i === dataIndex || expr.names[i] === 'drop') walk(argument)
        else {
          if (assignedNamesIn(argument).length) unknown.push('dynamic-data-mask-lookup')
          walkDataMask(argument, true)
        }
      }
      return
    }
    if (op === 'pull' && contractAvailable(op, qualified?.package, 'dplyr')) {
      const inputIndex = callbackArgumentIndex(expr, ['.data'], [])
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      if (copyOnModifySources(expr.args[inputIndex])?.length !== 0) unknown.push('opaque-call')
      expr.args.forEach((arg, index) =>
        index === inputIndex ? walk(arg) : walkDataMask(arg, true)
      )
      return
    }
    if (op === 'with' && contractAvailable(op, qualified?.package, 'base')) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      safeCallNames.push(dependencyName!)
      const dataIndex = callbackArgumentIndex(expr, ['data'], [])
      const expressionIndex = callbackArgumentIndex(expr, ['expr'], ['data'])
      // Assignments in a data mask are local to its evaluation environment;
      // retain the barrier until that scope can be represented explicitly.
      if (expr.args[expressionIndex] && assignedNamesIn(expr.args[expressionIndex]!).length)
        unknown.push('dynamic-data-mask-lookup')
      expr.args.forEach((arg, index) =>
        index === expressionIndex ? walkDataMask(arg, true) : walk(arg)
      )
      if (dataIndex < 0 || expressionIndex < 0) unknown.push('opaque-call')
      return
    }
    if (op === 'annotate' && contractAvailable(op, qualified?.package, 'ggplot2')) {
      used.push(dependencyName!)
      if (!defined.includes(dependencyName!)) priorUsed.push(dependencyName!)
      const geomIndex = callbackArgumentIndex(expr, ['geom'], [])
      const geom = expr.args[geomIndex]
      if (isCharacter(geom) && R_GGPLOT_GEOMS.has(`geom_${geom.value}`))
        safeCallNames.push(dependencyName!)
      else unknown.push('opaque-call')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    const compositionPackage = R_PLOT_COMPOSITION_CONSTRUCTORS.get(op)
    const valueConstructorPackages = readrColumnConstructors.has(op)
      ? ['readr']
      : compositionPackage
        ? [compositionPackage]
        : R_PLOT_VALUE_CALLS.get(op)
    if (valueConstructorPackages && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (valueConstructorPackages.some((pkg) => contractAvailable(op, qualified?.package, pkg))) {
        safeCallNames.push(dependencyName)
        safeCallArgumentNames.push(
          ...expr.args.map(rootName).filter((name): name is string => Boolean(name))
        )
      } else unknown.push('opaque-call')
      if (op === 'ggVennDiagram') {
        // plot_venn returns a ggplot; show_intersect switches to plotly and
        // cannot share the static-device contract. Inspect values without
        // executing user S3/S4 methods or allowing closures through `...`.
        const interactiveIndex = callbackArgumentIndex(
          expr,
          ['show_intersect'],
          ['x', 'category.names']
        )
        const interactive = expr.args[interactiveIndex]
        if (
          expr.names.some(
            (name) => name && name !== 'show_intersect' && 'show_intersect'.startsWith(name)
          ) ||
          (interactive && !(interactive.kind === 'atomic' && interactive.logical === false)) ||
          expr.args.some((arg) => copyOnModifySources(arg)?.length !== 0)
        )
          unknown.push('opaque-call')
        rThemeState ??= { reads: false, writes: false }
        if (!themeIndependentConstructors.has(expr)) rThemeState.reads = true
      }
      // grid units can carry a grob or expression evaluated later by a device.
      // A dimensional constant has no such payload; arbitrary data needs a
      // separate execution contract even when the constructor itself is known.
      if (op === 'unit') {
        const namedData = expr.names.findIndex((name) => name && 'data'.startsWith(name))
        const data =
          expr.args[
            namedData >= 0 ? namedData : callbackArgumentIndex(expr, ['data'], ['x', 'units'])
          ]
        if (data && !isNull(data)) unknown.push('opaque-call')
      }
      for (const arg of expr.args) {
        // Constructor parameters are values, not a callback evaluation contract.
        if (
          (isCall(arg) && ['function', '~'].includes(callOperator(arg) ?? '')) ||
          (isSymbol(arg) && functions.has(arg.name))
        )
          unknown.push('opaque-call')
        walk(arg, false)
      }
      return
    }
    if (op === 'library' || op === 'require') {
      const pkg = staticPackageName(expr)
      if (pkg && knownAttachedPackages.has(pkg)) {
        if (controlDepth === 0 && contractAvailable(op, qualified?.package, 'base'))
          rPackageLoads.add(pkg)
        if (expr.resolvedFunction === 'glue::attach' && controlDepth === 0) {
          defined.push('glue')
          typeSummaries.push(R_GLUE_FUNCTION)
          typeBindings.push({ target: 'glue', typeName: R_GLUE_FUNCTION.name, argumentNames: [] })
        }
        if (expr.resolvedFunction === 'targets::attach' && controlDepth === 0) {
          defined.push('tar_target')
          typeSummaries.push(R_TARGET_FUNCTION)
          typeBindings.push({
            target: 'tar_target',
            typeName: R_TARGET_FUNCTION.name,
            argumentNames: []
          })
        }
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
    if (qualified?.package === 'openxlsx' && openxlsxMutators.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      const receiver = rootName(namedArgument(expr, 'wb') ?? expr.args[0])
      if (!receiver) unknown.push('dynamic-assignment')
      else {
        used.push(receiver)
        if (!defined.includes(receiver)) priorUsed.push(receiver)
        mutated.push(receiver)
        receiverCalls.push({
          receiver,
          member: dependencyName,
          kind: 'mutating',
          argumentNames: unique(
            expr.args
              .slice(1)
              .map(rootName)
              .filter((name): name is string => Boolean(name))
          )
        })
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
        if (localInputHandleNames.has(handleRoot)) mutated.push(handleRoot)
        else {
          possiblyMutated.push(handleRoot)
          unknown.push('opaque-mutation')
        }
      }
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op && R_PLOT_LAYER_PACKAGES.has(op)) {
      if (!contractAvailable(op, qualified?.package, R_PLOT_LAYER_PACKAGES.get(op)!))
        unknown.push('opaque-call')
      for (let index = 0; index < expr.args.length; index += 1) {
        const argument = expr.args[index]
        const name = expr.names[index]
        const callbackValue =
          (isCall(argument) && ['function', '~'].includes(callOperator(argument) ?? '')) ||
          (isSymbol(argument) && functions.has(argument.name))
        if (callbackValue && name !== 'formula') {
          if (!consumeCallback(argument, { phase: 'deferred', formulaParameters: ['.x'] }))
            unknown.push('opaque-call')
        }
        // These arguments can dispatch arbitrary extension code by name or ggproto object.
        if (name === 'stat' && !(isCharacter(argument) && R_GGPLOT_STATS.has(argument.value)))
          unknown.push('opaque-call')
        if (
          name === 'position' &&
          !(isCharacter(argument) && R_GGPLOT_POSITIONS.has(argument.value)) &&
          !(
            isCall(argument) &&
            R_GGPLOT_POSITION_CALLS.has(calledName(argument) ?? '') &&
            contractAvailable(calledName(argument)!, qualifiedCall(argument)?.package, 'ggplot2')
          )
        )
          unknown.push('opaque-call')
        if (name === 'key_glyph' && !callbackValue) unknown.push('opaque-call')
        if (name === 'distribution' && !callbackValue) unknown.push('opaque-call')
        if (
          name === 'geom' &&
          !(isCharacter(argument) && R_GGPLOT_GEOMS.has(`geom_${argument.value}`))
        )
          unknown.push('opaque-call')
        if (
          name === 'method' &&
          !(isCharacter(argument) && ['auto', 'lm', 'loess'].includes(argument.value))
        )
          unknown.push('opaque-call')
      }
    }
    if (
      op &&
      ggplot2SafeCalls.includes(op) &&
      !contractAvailable(op, qualified?.package, 'ggplot2')
    )
      unknown.push('opaque-call')
    if (op && ggplot2PositionScaleCalls.includes(op)) {
      for (const argument of expr.args) {
        if (consumeCallback(argument, { phase: 'deferred', formulaParameters: ['.x'] })) continue
        if (
          (isCall(argument) && ['function', '~'].includes(callOperator(argument) ?? '')) ||
          (isSymbol(argument) &&
            !['NULL', 'NA'].includes(argument.name) &&
            !literalLabelNames.has(argument.name) &&
            !atomicValueNames.has(argument.name))
        )
          unknown.push('opaque-call')
      }
    }
    const fileMap =
      op && R_BOUNDED_FILE_ITERATORS.has(op)
        ? rBoundedFileMap(
            expr,
            staticStrings,
            staticCollections,
            new Set([...defined, ...localNames, ...shadowedCallbackCalls, ...functions.keys()])
          )
        : undefined
    if (
      fileMap &&
      staticFileMapInvocations + fileMap.calls.length <= MAX_STATIC_FILE_LOOP_ITERATIONS
    ) {
      staticFileMapInvocations += fileMap.calls.length
      const dependencyName = fileMap.dependency
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const argument of fileMap.arguments) walk(argument, false)
      for (const invocation of fileMap.calls) walk(invocation, false)
      return
    }
    const callback = op ? functionalCallbacks.get(op) : undefined
    const setReduction = ordinarySetReduction(expr)
    if (setReduction && dependencyName) {
      used.push(dependencyName, setReduction.dependency)
      for (const name of [dependencyName, setReduction.dependency])
        if (!defined.includes(name)) priorUsed.push(name)
      safeCallNames.push(dependencyName, setReduction.dependency)
      expr.args.forEach((arg, index) => {
        if (index !== setReduction.index) walk(arg)
      })
      return
    }
    if (op && callback && dependencyName) {
      if (
        op === 'aggregate' &&
        copyOnModifySources(expr.args[aggregateDataIndex(expr)])?.length !== 0
      )
        unknown.push('opaque-call')
      if (callback.dataMask) {
        walkDataMask(expr, true)
        return
      }
      const resolvedCallbackIndex = callbackArgumentIndex(
        expr,
        callback.keywords,
        callback.precedingArguments
      )
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      if (
        contractAvailable(op, qualified?.package, callback.package) &&
        consumeCallback(
          expr.args[resolvedCallbackIndex],
          {
            phase: 'immediate',
            formulaParameters: callback.formulaParameters
          },
          ['lapply', 'sapply', 'vapply'].includes(op) &&
            ordinaryFunctionalArguments(expr, resolvedCallbackIndex)
        )
      ) {
        safeCallNames.push(dependencyName)
      } else unknown.push('function-scope', 'opaque-call')
      for (let index = 0; index < expr.args.length; index += 1) {
        if (op === 'aggregate' && index === aggregateFormulaIndex(expr)) {
          walkDataMask(expr.args[index], true)
          continue
        }
        if (op === 'aggregate' && expr.names[index] === 'na.action') unknown.push('opaque-call')
        if (index !== resolvedCallbackIndex) walk(expr.args[index], false)
      }
      return
    }
    if (op === 'function') {
      if (acceptedCallbacks.has(expr)) return
      unknown.push('function-scope')
      return
    }
    if (acceptedCallbacks.has(expr)) return
    if (op && functions.has(op) && !qualified) {
      const summary = functions.get(op)!
      used.push(op)
      if (!defined.includes(op)) priorUsed.push(op)
      mergeCallbackReads(summary.methods[0]!)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (
      op &&
      !qualified &&
      (graphicsSafeCalls.includes(op) ||
        baseLabelFormatCalls.includes(op) ||
        R_PALETTE_FACTORIES.has(op)) &&
      !contractAvailable(
        op,
        undefined,
        baseLabelFormatCalls.includes(op)
          ? 'base'
          : baseGraphicsCalls.includes(op)
            ? 'graphics'
            : 'grDevices'
      )
    ) {
      unknown.push('opaque-call')
      used.push(op)
      if (!defined.includes(op)) priorUsed.push(op)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (
      op &&
      (R_GRAPHICS_FILE_DEVICES.has(op) || ['dev.off', 'dev.set', 'graphics.off'].includes(op))
    )
      freshPlot = false
    if (op && graphicsSafeCalls.includes(op)) {
      if (
        ['plot', 'plot.default', 'plot.new', 'barplot', 'pie', 'hist'].includes(op) &&
        controlDepth === 0 &&
        contractAvailable(op, qualified?.package, 'graphics')
      ) {
        const add = expr.args[expr.names.indexOf('add')]
        freshPlot = !add || (add.kind === 'atomic' && add.logical === false)
      }
      for (const [index, argument] of expr.args.entries()) {
        // hist() can invoke a breaks function. Arbitrary callbacks need file and
        // evaluation evidence; merely reading their function name is insufficient.
        if (
          (isCall(argument) && ['function', '~'].includes(callOperator(argument) ?? '')) ||
          (isSymbol(argument) && functions.has(argument.name)) ||
          (['hist', 'hist.default'].includes(op) &&
            (expr.names[index] === 'breaks' || (index === 1 && !expr.names[index])) &&
            isSymbol(argument) &&
            !atomicValueNames.has(argument.name))
        )
          unknown.push('opaque-call')
      }
    }
    if (op === '$' || op === '@') {
      walk(expr.args[0], false)
      return
    }
    if (pipeOps.has(op)) {
      unknown.push('opaque-call')
      expr.args.forEach((arg) => walk(arg))
      return
    }
    if (
      tableJoinCalls.has(op) &&
      dependencyName &&
      contractAvailable(op, qualified?.package, 'dplyr') &&
      copyOnModifySources(expr)?.length === 0
    ) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const arg of expr.args) walk(arg)
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
    if (tabularTransformName(expr) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      walkTabularArguments(expr)
      return
    }
    if (op === 'case_when' && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      const argumentsToEvaluate = rCaseWhenArguments(expr)
      if (argumentsToEvaluate && contractAvailable(op, qualified?.package, 'dplyr'))
        safeCallNames.push(dependencyName)
      else unknown.push('opaque-call')
      for (const argument of argumentsToEvaluate ?? expr.args) walk(argument)
      return
    }
    if (dplyrValueCall(expr) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      safeCallArgumentNames.push(
        ...expr.args.map(rootName).filter((name): name is string => Boolean(name))
      )
      for (const argument of expr.args) walk(argument, false)
      return
    }
    if (R_DPLYR_VALUE_CALLS.has(op)) unknown.push('opaque-call')
    if (dataMaskCalls.has(op) && dependencyName) {
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const arg of expr.args) walkDataMask(arg, true, 'deferred')
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
    const inspectorInput = ['head', 'tail'].includes(op)
      ? expr.args[callbackArgumentIndex(expr, ['x'], [])]
      : expr.args[0]
    if (op === 'sign' && !contractAvailable(op, qualified?.package, 'base'))
      unknown.push('opaque-call')
    if (
      op === 'summary' &&
      dependencyName &&
      contractAvailable(op, qualified?.package, 'base') &&
      isCall(inspectorInput) &&
      calledName(inspectorInput) === 'lm' &&
      contractAvailable('lm', qualifiedCall(inspectorInput)?.package, 'stats') &&
      contractAvailable('summary.lm', undefined, 'stats') &&
      inspectorInput.args.length === 1 &&
      callOperator(inspectorInput.args[0]) === '~' &&
      expr.args.length === 1
    ) {
      // Inspect a fresh standard fit without treating model objects (which can
      // retain environments) as ordinary copy-on-modify data.
      used.push(dependencyName, 'summary.lm')
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      priorUsed.push('summary.lm')
      safeCallNames.push(dependencyName, 'summary.lm')
      walk(inspectorInput)
      return
    }
    if (
      [
        'head',
        'tail',
        'str',
        'summary',
        'unlist',
        'lengths',
        'sign',
        ...R_SET_OPERATIONS,
        'is.finite',
        'is.infinite',
        'is.nan'
      ].includes(op) &&
      dependencyName &&
      inspectorInput &&
      contractAvailable(
        op,
        qualified?.package,
        ['head', 'tail', 'str'].includes(op) ? 'utils' : 'base'
      ) &&
      (!R_SET_OPERATIONS.has(op) ||
        expr.args.every((arg) => copyOnModifySources(arg)?.length === 0)) &&
      (copyOnModifySources(inspectorInput)?.length === 0 ||
        (isCall(inspectorInput) &&
          ['$', '[', '[['].includes(callOperator(inspectorInput) ?? '') &&
          copyOnModifySources(inspectorInput.args[0])?.length === 0))
    ) {
      // Generic inspectors are safe only for established ordinary values, not
      // arbitrary S3/S4 objects whose methods may read or mutate external state.
      used.push(dependencyName)
      if (!defined.includes(dependencyName)) priorUsed.push(dependencyName)
      safeCallNames.push(dependencyName)
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (
      op === 'for' &&
      expr.args.length >= 3 &&
      isSymbol(expr.args[0]) &&
      staticNonemptyIterable(expr.args[1]) &&
      deterministicLoopBody(expr.args[2])
    ) {
      const target = expr.args[0].name
      const characterValues = rStaticStringCollection(
        expr.args[1],
        staticStrings,
        staticCollections
      )
      walk(expr.args[1], false)
      prepareAssignment(target)
      if (characterValues?.values.length) characterLoopNames.add(target)
      if (characterValues?.values.length) namespaceProbePackages.set(target, characterValues.values)
      defined.push(target)
      const previous = localNames
      localNames = [...localNames, target]
      walk(expr.args[2], false)
      localNames = previous
      namespaceProbePackages.delete(target)
      for (const name of isolatedConditionalLoops.get(expr) ?? []) {
        if (conditionallyDefined.has(name)) isolatedConditionallyDefined.add(name)
      }
      return
    }
    if (op === 'for' && expr.args.length >= 3 && isSymbol(expr.args[0])) {
      const target = expr.args[0].name
      const ordinaryIteration = copyOnModifySources(expr.args[1])?.length === 0
      const previouslyOrdinary = ordinaryLoopValues.has(target)
      if (ordinaryIteration) ordinaryLoopValues.add(target)
      else ordinaryLoopValues.delete(target)
      const localAggregationNames = localAggregationLoops.get(expr)
      const localAggregation =
        localAggregationNames &&
        [...localAggregationNames].every(
          (name) =>
            defined.includes(name) &&
            !aliases.has(name) &&
            !possibleAliases.some((alias) => alias.target === name)
        )
      walk(expr.args[1], false)
      if (localAggregation) {
        const previous = localNames
        localNames = [...localNames, target]
        localAggregationDepth += 1
        walk(expr.args[2], false)
        localAggregationDepth -= 1
        localNames = previous
        if (previouslyOrdinary) ordinaryLoopValues.add(target)
        else ordinaryLoopValues.delete(target)
        return
      }
      controlDepth += 1
      prepareAssignment(target)
      defined.push(target)
      const previous = localNames
      localNames = [...localNames, target]
      walk(expr.args[2], false)
      localNames = previous
      controlDepth -= 1
      if (previouslyOrdinary) ordinaryLoopValues.add(target)
      else ordinaryLoopValues.delete(target)
      const iterable = expr.args[1]
      const iterableCall = calledName(iterable)
      const iterableQualified = qualifiedCall(iterable)
      // Base sequence constructors return value vectors even when empty. Keep
      // the loop's assignments conditional, but do not taint unrelated results.
      // This includes colon ranges computed from ordinary data or outer indices;
      // their loop-local reporting values need not become replay prerequisites.
      const baseSequence =
        isCall(iterable) &&
        (['seq_len', 'seq_along'].includes(iterableCall ?? '') ||
          (iterableCall === ':' && ordinaryIteration)) &&
        contractAvailable(iterableCall!, iterableQualified?.package, 'base')
      // Metadata vectors may be sliced, but list-valued iterables can introduce
      // aliases and must keep their existing conservative handling.
      let metadata = iterable
      while (isCall(metadata) && ['[', '[[', '('].includes(callOperator(metadata) ?? ''))
        metadata = metadata.args[0]
      const metadataName = calledName(metadata)
      const metadataVector =
        metadataName &&
        ['names', 'colnames', 'rownames', 'levels'].includes(metadataName) &&
        contractAvailable(metadataName, qualifiedCall(metadata)?.package, 'base') &&
        copyOnModifySources(iterable)?.length === 0
      const iterableIsValue =
        (isSymbol(iterable) && copyOnModify.includes(iterable.name)) ||
        metadataVector ||
        (isCall(iterable) && callOperator(iterable) === 'names') ||
        baseSequence
      if (iterableIsValue) {
        for (const name of isolatedConditionalLoops.get(expr) ?? []) {
          if (conditionallyDefined.has(name)) isolatedConditionallyDefined.add(name)
        }
      }
      return
    }
    if (op === 'if' && localAggregationDepth > 0) {
      for (const arg of expr.args) walk(arg, false)
      return
    }
    if (op === 'if' && expr.args[0]?.kind === 'atomic' && expr.args[0].logical !== undefined) {
      walk(expr.args[0], false)
      walk(expr.args[expr.args[0].logical ? 1 : 2], false)
      return
    }
    if (
      op === 'if' &&
      !expr.args[2] &&
      controlDepth === 0 &&
      copyOnModifySources(expr.args[0])?.length === 0
    ) {
      const branch = expr.args[1]
      const target =
        isCall(branch) && ['<-', '='].includes(callOperator(branch) ?? '')
          ? branch.args[0]
          : undefined
      if (
        isCall(target) &&
        ['[[', '$'].includes(callOperator(target) ?? '') &&
        isSymbol(target.args[0]) &&
        copyOnModifySources(target.args[0])?.length === 0 &&
        (isCharacter(target.args[1]) ||
          (callOperator(target) === '$' && isSymbol(target.args[1]))) &&
        isCall(branch) &&
        isNull(branch.args[1])
      ) {
        // Conditional removal changes an existing ordinary container; it cannot
        // introduce an unbound kernel variable. The predicate is still analyzed.
        expr.args.forEach((arg) => walk(arg))
        return
      }
    }
    if (op === 'if' && controlDepth === 0 && atomicValueExpression(expr.args[0])) {
      // Updating an already established ordinary value cannot create a missing
      // kernel binding. Inspect both branches, but do not retain either branch's
      // literal path/collection as if that branch had definitely executed.
      const updates = (branch: RExpr | undefined): string[] | undefined => {
        if (!branch) return []
        if (!isCall(branch)) return undefined
        if (callOperator(branch) === '{') {
          const names = branch.args.map(updates)
          return names.every((item) => item !== undefined)
            ? names.flatMap((item) => item ?? [])
            : undefined
        }
        if (callOperator(branch) === 'if' && atomicValueExpression(branch.args[0])) {
          const yes = updates(branch.args[1]),
            no = updates(branch.args[2])
          return yes && no ? unique([...yes, ...no]) : undefined
        }
        const target = branch.args[0]
        return ['<-', '='].includes(callOperator(branch) ?? '') &&
          isSymbol(target) &&
          atomicValueNames.has(target.name) &&
          atomicValueExpression(branch.args[1])
          ? [target.name]
          : undefined
      }
      const yes = updates(expr.args[1]),
        no = updates(expr.args[2])
      if (yes && no) {
        for (const name of new Set([...yes, ...no])) {
          if (yes.includes(name) && no.includes(name)) continue
          used.push(name)
          if (!defined.includes(name)) priorUsed.push(name)
        }
        for (const arg of expr.args) walk(arg, false)
        for (const name of [...yes, ...no]) {
          staticStrings.delete(name)
          staticCollections.delete(name)
          staticScalarNames.delete(name)
          staticIterableNames.delete(name)
          staticNamedIterableNames.delete(name)
          literalLabelNames.delete(name)
        }
        return
      }
    }
    if (op === 'while' && controlDepth === 0) {
      const condition = expr.args[0]
      const lengthCall = isCall(condition) ? condition.args[0] : undefined
      const reader = isCall(lengthCall) ? lengthCall.args[0] : undefined
      const handle = isCall(reader) ? (namedArgument(reader, 'con') ?? reader.args[0]) : undefined
      const chunkSize = isCall(reader) ? (namedArgument(reader, 'n') ?? reader.args[1]) : undefined
      const eof = isCall(condition) ? condition.args[1] : undefined
      const boundedRead =
        isCall(condition) &&
        ['>', '!='].includes(callOperator(condition) ?? '') &&
        eof?.kind === 'atomic' &&
        eof.number === 0 &&
        calledName(lengthCall) === 'length' &&
        contractAvailable('length', qualifiedCall(lengthCall)?.package, 'base') &&
        calledName(reader) === 'readLines' &&
        contractAvailable('readLines', qualifiedCall(reader)?.package, 'base') &&
        isSymbol(handle) &&
        localInputHandleNames.has(handle.name) &&
        chunkSize?.kind === 'atomic' &&
        (chunkSize.number ?? 0) > 0
      const updates = (body: RExpr | undefined): string[] | undefined => {
        if (!isCall(body)) return undefined
        if (callOperator(body) === '{') {
          const nested = body.args.map(updates)
          return nested.every((names) => names !== undefined)
            ? nested.flatMap((names) => names ?? [])
            : undefined
        }
        const target = body.args[0]
        return ['<-', '='].includes(callOperator(body) ?? '') &&
          isSymbol(target) &&
          atomicValueNames.has(target.name) &&
          atomicValueExpression(body.args[1])
          ? [target.name]
          : undefined
      }
      const counters = boundedRead ? updates(expr.args[1]) : undefined
      if (counters?.length) {
        // Initialized value counters exist even at immediate EOF. The connection
        // read is still visited and captured; arbitrary loop bodies stay uncertain.
        expr.args.forEach((argument) => walk(argument))
        for (const name of counters) {
          staticStrings.delete(name)
          staticCollections.delete(name)
          staticScalarNames.delete(name)
          staticIterableNames.delete(name)
          staticNamedIterableNames.delete(name)
          literalLabelNames.delete(name)
        }
        return
      }
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
    if (
      (safeCalls.has(op) || (qualified?.package === 'fs' && qualified.name === 'path')) &&
      dependencyName
    ) {
      safeCallNames.push(dependencyName)
      safeCallArgumentNames.push(...roots)
    } else if (
      !syntaxOps.includes(op) &&
      !['assign', 'get', 'eval', 'parse', 'substitute', 'do.call'].includes(op)
    ) {
      if (roots.length) {
        // Isolating conditional loop bindings does not prove the effects of an
        // unresolved call on them; retain that barrier when dropping control-flow.
        if (
          controlDepth > 0 &&
          expr.args.some((arg) => namespaceLoadsIn(arg).some((name) => localNames.includes(name)))
        )
          unknown.push('opaque-call')
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

  const walkDiscarded = (expr: RExpr): void => {
    if (isCall(expr) && expr.operator === '{') {
      expr.args.forEach(walkDiscarded)
      return
    }
    const diagnostic =
      !consoleRedirected && rConsoleDiagnostic(expr, staticStrings, staticCollections)
    if (!diagnostic) {
      walk(expr, false)
      return
    }
    for (const name of [...diagnostic.calls, ...diagnostic.names]) {
      used.push(name)
      if (!defined.includes(name)) priorUsed.push(name)
    }
    safeCallNames.push(...diagnostic.calls)
  }
  for (const expr of expressions) walkDiscarded(expr)
  const combinedAliases: NotebookDependencyAlias[] = [
    ...[...aliases.values()].map((alias) => ({
      target: alias.target,
      source: alias.source,
      kind: alias.kind
    })),
    ...possibleAliases
  ]
  const facts = {
    ...(serializedValueWrites.size
      ? { serializedValueWrites: [...serializedValueWrites.values()] }
      : {}),
    ...(serializedValueReads.size ? { serializedValueReads: [...serializedValueReads] } : {}),
    ...(rGraphicsState ? { rGraphicsState } : {}),
    ...(rThemeState ? { rThemeState } : {}),
    ...(rOptionWrites.size ? { rOptionWrites: [...rOptionWrites].sort() } : {}),
    ...(rPackageLoads.size ? { rPackageLoads: [...rPackageLoads] } : {}),
    ...(rPackageReads.size ? { rPackageReads: [...rPackageReads].sort() } : {}),
    definedNames: unique(defined).sort(),
    conditionallyDefinedNames: [...conditionallyDefined].sort(),
    usedNames: unique(used).sort(),
    priorUsedNames: unique(priorUsed).sort(),
    possiblyUsedNames: unique(possiblyUsed).sort(),
    mutatedNames: unique(mutated).sort(),
    possiblyMutatedNames: unique(possiblyMutated).sort(),
    aliases: combinedAliases,
    copyOnModifyNames: unique(copyOnModify).sort(),
    rAtomicValueNames: [...atomicValueNames]
      .filter((name) => defined.includes(name) && !conditionallyDefined.has(name))
      .sort(),
    copyOnModifyBindings,
    copyOnModifyInvalidatedNames: unique(copyOnModifyInvalidated).sort(),
    safeCallNames: unique(safeCallNames).sort(),
    safeCallArgumentNames: unique(safeCallArgumentNames).sort(),
    typeSummaries,
    typeBindings,
    receiverCalls,
    memberWrites
  }
  const reasons = new Set(unknown)
  if (
    conditionallyDefined.size > 0 &&
    isolatedConditionallyDefined.size > 0 &&
    [...conditionallyDefined].every((name) => isolatedConditionallyDefined.has(name)) &&
    possiblyMutated.length === 0 &&
    possibleAliases.every(
      (alias) => copyOnModify.includes(alias.source) && copyOnModify.includes(alias.target)
    )
  ) {
    reasons.delete('control-flow')
  }
  if (reasons.size) return { state: 'unknown', reasons: [...reasons].sort(), ...facts }
  return { state: 'available', ...facts }
}

const rQualifiedCall = (expr: RExpr): { package: string; name: string } | undefined => {
  if (!isCall(expr)) return undefined
  if (!isCall(expr.callee) || !['::', ':::'].includes(expr.callee.operator ?? '')) return undefined
  const pkg = expr.callee.args[0]
  const member = expr.callee.args[1]
  const packageName = isSymbol(pkg) ? pkg.name : isCharacter(pkg) ? pkg.value : undefined
  const name = isSymbol(member) ? member.name : isCharacter(member) ? member.value : undefined
  return packageName && name ? { package: packageName, name } : undefined
}

const rCalledName = (expr: RExpr): string | undefined => {
  if (!isCall(expr)) return undefined
  return isSymbol(expr.callee) ? expr.callee.name : rQualifiedCall(expr)?.name
}

const R_DEVICE_EXPORT_CALLS = new Set(['dev.copy', 'dev.print'])

// Device exporters immediately call an explicit device function with the remaining
// arguments. Normalize that call once so path/disposition/options use the same
// rules as png(), pdf(), etc. Existing-device copies and default printers stay opaque.
const rGraphicsDeviceExport = (expr: RExpr): Extract<RExpr, { kind: 'call' }> | undefined => {
  if (
    !isCall(expr) ||
    !R_DEVICE_EXPORT_CALLS.has(rCalledName(expr) ?? '') ||
    expr.staticBuiltinShadowed ||
    expr.staticDeviceShadowed
  )
    return undefined
  const qualified = rQualifiedCall(expr)
  if (qualified && qualified.package !== 'grDevices') return undefined
  if (expr.names.includes('which') || expr.names.filter((name) => name === 'device').length > 1)
    return undefined
  const index = expr.names.includes('device')
    ? expr.names.indexOf('device')
    : expr.names.findIndex((name) => !name)
  if (index < 0) return undefined
  const target = expr.args[index]!
  const call: Extract<RExpr, { kind: 'call' }> = {
    kind: 'call',
    operator: isSymbol(target) ? target.name : null,
    callee: target,
    args: expr.args.filter((_, i) => i !== index),
    names: expr.names.filter((_, i) => i !== index)
  }
  const device = rCalledName(call)
  const devicePackage = rQualifiedCall(call)?.package
  return device &&
    R_GRAPHICS_FILE_DEVICES.has(device) &&
    (!devicePackage || devicePackage === 'grDevices')
    ? call
    : undefined
}

// Share argument matching between scalar paths, vector paths and loop-shape analysis.
// In particular, file.path's fsep is a control argument, never a path component.
const rStringCombination = (
  expr: Extract<RExpr, { kind: 'call' }>
): { parts: RExpr[]; separator: RExpr } | undefined => {
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  const fsPath = qualified?.package === 'fs' && name === 'path'
  if (
    !fsPath &&
    (!['file.path', 'paste', 'paste0'].includes(name ?? '') ||
      (qualified && qualified.package !== 'base'))
  )
    return undefined
  const separatorName = name === 'file.path' ? 'fsep' : name === 'paste' ? 'sep' : undefined
  const separators = expr.names.flatMap((name, index) =>
    name && name === separatorName ? [index] : []
  )
  if (
    separators.length > 1 ||
    expr.names.some((candidate) => candidate && candidate !== separatorName)
  )
    return undefined
  const separatorIndex = separators[0] ?? -1
  return {
    parts: expr.args.filter((_argument, index) => index !== separatorIndex),
    separator: expr.args[separatorIndex] ?? {
      kind: 'character',
      value: name === 'file.path' || fsPath ? '/' : name === 'paste' ? ' ' : ''
    }
  }
}

const rPathPartArgument = (
  expr: Extract<RExpr, { kind: 'call' }>
): { name: 'basename' | 'dirname'; argument: RExpr } | undefined => {
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  if (
    (name !== 'basename' && name !== 'dirname') ||
    (qualified && qualified.package !== 'base') ||
    expr.args.length !== 1 ||
    (expr.names[0] && expr.names[0] !== 'path')
  )
    return undefined
  return { name, argument: expr.args[0]! }
}

const rLexicalPathPart = (path: string, name: 'basename' | 'dirname'): string | undefined => {
  // Tilde expansion needs the user's home; backslash interpretation depends on the
  // R host OS. Neither can be guessed by this platform-independent static parser.
  if (path.startsWith('~') || path.includes('\\')) return undefined
  const trimmed = path.replace(/\/+$/u, '')
  if (!trimmed) return name === 'dirname' && path ? '/' : ''
  const separator = trimmed.lastIndexOf('/')
  if (name === 'basename') return trimmed.slice(separator + 1)
  return separator < 0 ? '.' : trimmed.slice(0, separator).replace(/\/+$/u, '') || '/'
}

// These primitives construct language objects without evaluating their arguments.
// Keep this boundary shared by variable analysis and file discovery: plotmath symbols
// and calls inside quoted data are neither namespace reads nor file operations.
const rQuotedDataCall = (
  expr: RExpr | null | undefined
): { name: string; dependency: string; qualified: boolean } | undefined => {
  if (!expr || !isCall(expr)) return undefined
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  if (
    !name ||
    !['expression', 'quote'].includes(name) ||
    (qualified && qualified.package !== 'base')
  )
    return undefined
  return { name, dependency: qualified ? `base::${name}` : name, qualified: Boolean(qualified) }
}

const R_GLUE_FUNCTION: NotebookDependencyTypeSummary = {
  name: 'glue::glue',
  kind: 'r-function',
  fields: [],
  // Only the template-aware analysis below can certify an invocation. An arbitrary
  // call through a callback/alias must not inherit a blanket "pure function" claim.
  methods: [{ name: '__call__', effect: 'unknown', unknownScope: 'namespace' }]
}

const R_TARGET_FUNCTION: NotebookDependencyTypeSummary = {
  ...R_GLUE_FUNCTION,
  name: 'targets::tar_target'
}

// Task commands are quoted; only configuration options are evaluated at definition time.
// Tidy injection and scheduler execution still require external-state evidence.
const rTargetDefinitionOptions = (expr: RExpr): RExpr[] | undefined => {
  if (!isCall(expr)) return undefined
  const qualified = rQualifiedCall(expr)
  if (
    expr.resolvedFunction !== R_TARGET_FUNCTION.name &&
    !(qualified?.package === 'targets' && qualified.name === 'tar_target')
  )
    return undefined
  const quotedParameters = ['name', 'command', 'pattern']
  const namedQuoted = new Set(
    quotedParameters.map((parameter) => rOptionArgumentIndex(expr.names, parameter))
  )
  let remainingQuoted = quotedParameters.filter(
    (parameter) => rOptionArgumentIndex(expr.names, parameter) < 0
  ).length
  return expr.args.filter((_argument, index) => {
    if (namedQuoted.has(index)) return false
    if (!expr.names[index] && remainingQuoted > 0) {
      remainingQuoted -= 1
      return false
    }
    return true
  })
}

// Track shadowed static helpers and attached functions in statement order, reusing the
// existing R bindings. No new persistent import/package registry is needed.
const resolveRStaticCallIdentities = (
  expressions: RExpr[],
  functions: NotebookSourceFileAccessContext['rFunctions'] = [],
  kernelNames: readonly string[] = []
): void => {
  const known = new Map(
    functions
      .filter(({ summary }) =>
        [R_GLUE_FUNCTION.name, R_TARGET_FUNCTION.name].includes(summary.name)
      )
      .map(({ name, summary }) => [name, summary.name])
  )
  const assigned = new Set(
    [...kernelNames, ...functions.map(({ name }) => name)].filter((name) => !known.has(name))
  )
  let dynamicBindings = false
  const visit = (expr: RExpr, attachAllowed: boolean): void => {
    if (!isCall(expr)) return
    const name = rCalledName(expr)
    const qualified = rQualifiedCall(expr)

    expr.staticBuiltinShadowed =
      !qualified && (dynamicBindings || Boolean(name && assigned.has(name)))
    const exported = rGraphicsDeviceExport(expr)
    if (exported && isSymbol(exported.callee))
      expr.staticDeviceShadowed = dynamicBindings || assigned.has(exported.callee.name)
    if (['function', 'quote', 'expression', '~'].includes(name ?? '')) return
    if (!qualified && name && known.has(name)) expr.resolvedFunction = known.get(name)
    const targetOptions = rTargetDefinitionOptions(expr)
    if (targetOptions) {
      for (const argument of targetOptions) visit(argument, false)
      return
    }
    if (['if', 'for', 'while', 'repeat', 'switch'].includes(name ?? '')) {
      const before = new Map(known)
      if (name === 'for' && isSymbol(expr.args[0])) {
        known.delete(expr.args[0].name)
        assigned.add(expr.args[0].name)
      }
      for (const argument of expr.args) visit(argument, false)
      // Preserve existing identities only if every visited branch left them intact;
      // a conditional alias/import cannot establish a new identity after the branch.
      for (const [binding, identity] of known)
        if (before.get(binding) !== identity) known.delete(binding)
      return
    }
    if (['<-', '=', '->', '<<-', '->>'].includes(name ?? '')) {
      const rightward = name === '->' || name === '->>'
      const target = expr.args[rightward ? 1 : 0]
      const value = expr.args[rightward ? 0 : 1]
      if (value) visit(value, false)
      if (isSymbol(target)) {
        const alias = isSymbol(value) && known.get(value.name)
        known.delete(target.name)
        assigned.add(target.name)
        if (alias) known.set(target.name, alias)
      }
      return
    }
    if (name === 'library' || name === 'require') {
      const argument = expr.args[0]
      const pkg = isSymbol(argument)
        ? argument.name
        : isCharacter(argument)
          ? argument.value
          : undefined
      const callable = pkg === 'glue' ? 'glue' : pkg === 'targets' ? 'tar_target' : undefined
      if (
        attachAllowed &&
        (!qualified || qualified.package === 'base') &&
        !assigned.has(name) &&
        callable &&
        !assigned.has(callable) &&
        expr.args.length === 1 &&
        !expr.names.some(Boolean)
      ) {
        known.set(callable, `${pkg}::${callable}`)
        expr.resolvedFunction = `${pkg}::attach`
      } else known.clear()
      return
    }
    if (
      ['detach', 'attach', 'source', 'sys.source', 'load', 'assign', 'rm', 'remove'].includes(
        name ?? ''
      )
    ) {
      known.clear()
      dynamicBindings = true
      return
    }
    const transparent = name === '{' || name === 'suppressPackageStartupMessages'
    for (const argument of expr.args) visit(argument, attachAllowed && transparent)
  }
  for (const expression of expressions) visit(expression, true)
}

const rIsGlueCall = (expr: RExpr): boolean => {
  if (!isCall(expr)) return false
  const qualified = rQualifiedCall(expr)
  return (
    expr.resolvedFunction === R_GLUE_FUNCTION.name ||
    (qualified?.package === 'glue' && qualified.name === 'glue')
  )
}

const rStaticGlueTemplate = (expr: RExpr): RStaticGluePart[] | undefined => {
  if (!isCall(expr)) return undefined
  if (!rIsGlueCall(expr) || expr.names.some((name) => name && name !== '.sep')) return undefined
  const separators = expr.names.flatMap((name, index) => (name === '.sep' ? [index] : []))
  if (separators.length > 1) return undefined
  const separator = separators.length
    ? expr.args[separators[0]!]
    : { kind: 'character' as const, value: '' }
  const templates = expr.args.filter((_argument, index) => index !== separators[0])
  if (!isCharacter(separator) || !templates.length || !templates.every(isCharacter))
    return undefined
  const template = templates.map((part) => part.value).join(separator.value)
  // glue dedents multi-line templates. Keep those unsupported until that lexical
  // transformation is modeled, rather than capture a subtly different filename.
  return /[\r\n]/u.test(template) ? undefined : parseRStaticGlueTemplate(template)
}

const renderRStaticGlue = (
  parts: readonly RStaticGluePart[],
  bindings: ReadonlyMap<string, string>
): string | undefined => {
  const values = parts.map((part) => (part.kind === 'text' ? part.value : bindings.get(part.value)))
  return values.some((value) => value === undefined) ? undefined : (values as string[]).join('')
}

type RStaticFileCollection = {
  values: readonly string[]
  entries?: ReadonlyArray<readonly [string, string]>
  rKind?: 'vector' | 'list'
}

const rContextCollections = (
  collections: NotebookSourceFileAccessContext['staticCollections'] = []
): Map<string, RStaticFileCollection> =>
  new Map(
    collections.map((collection) => [
      collection.name,
      {
        values: collection.values,
        rKind: collection.rKind,
        ...(collection.entries
          ? { entries: collection.entries.map(({ key, value }) => [key, value] as const) }
          : {})
      }
    ])
  )

const applyRStaticSprintf = (format: string, values: readonly string[]): string | undefined => {
  let result = ''
  let valueIndex = 0
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index]!
    if (character !== '%') {
      result += character
      continue
    }
    const conversion = format[index + 1]
    if (conversion === '%') {
      result += '%'
      index += 1
      continue
    }
    if (conversion !== 's' || valueIndex >= values.length) return undefined
    result += values[valueIndex++]!
    index += 1
  }
  return valueIndex === values.length ? result : undefined
}

const rStaticString = (
  expr: RExpr | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): string | undefined => {
  if (isCharacter(expr)) return expr.value
  if (isSymbol(expr)) {
    const collection = collections.get(expr.name)
    return (
      bindings.get(expr.name) ??
      (collection?.rKind === 'vector' && collection.values.length === 1
        ? collection.values[0]
        : undefined)
    )
  }
  if (!isCall(expr) || (expr.staticBuiltinShadowed && !rIsGlueCall(expr))) return undefined
  const name = rCalledName(expr)
  const glueTemplate = rStaticGlueTemplate(expr)
  if (glueTemplate) return renderRStaticGlue(glueTemplate, bindings)
  if (name === '$' && expr.args.length === 2 && isSymbol(expr.args[1])) {
    const member = expr.args[1].name
    const receiver = rStaticStringCollection(expr.args[0], bindings, collections)
    if (receiver?.rKind !== 'list') return undefined
    return receiver.entries?.find(([key]) => key === member)?.[1]
  }
  if (name === '[') {
    const selected = rStaticStringCollection(expr, bindings, collections)
    return selected?.rKind === 'vector' && selected.values.length === 1
      ? selected.values[0]
      : undefined
  }
  if (name === '[[' && expr.args.length === 2) {
    const collection = rStaticStringCollection(expr.args[0], bindings, collections)
    const index = expr.args[1]
    if (
      index?.kind === 'atomic' &&
      index.number !== undefined &&
      Number.isInteger(index.number) &&
      index.number > 0
    ) {
      return collection?.values[index.number - 1]
    }
    const key = rStaticString(expr.args[1], bindings, collections)
    return key === undefined
      ? undefined
      : collection?.entries?.find(([entry]) => entry === key)?.[1]
  }
  if (rStringCombination(expr) || rPathPartArgument(expr)) {
    const values = rStaticStringCollection(expr, bindings, collections)?.values
    return values?.length === 1 ? values[0] : undefined
  }
  if (name === 'sprintf') {
    if (
      !expr.args.length ||
      !expr.names.every((candidate, index) => !candidate || (index === 0 && candidate === 'fmt'))
    ) {
      return undefined
    }
    const format = rStaticString(expr.args[0], bindings, collections)
    const values = expr.args
      .slice(1)
      .map((argument) => rStaticString(argument, bindings, collections))
    return format === undefined || values.some((value) => value === undefined)
      ? undefined
      : applyRStaticSprintf(format, values as string[])
  }
  return undefined
}

const MAX_STATIC_FILE_LOOP_ITERATIONS = 128

type RStaticSubsetSelector =
  { kind: 'integer'; values: number[] } | { kind: 'logical'; values: boolean[] }

// Evaluate only bounded base-R selector syntax, never notebook code or callbacks.
const rStaticSubsetSelector = (
  expr: RExpr | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>,
  depth = 0
): RStaticSubsetSelector | undefined => {
  if (depth > 32) return undefined
  if (expr?.kind === 'atomic') {
    if (expr.logical !== undefined) return { kind: 'logical', values: [expr.logical] }
    if (expr.number !== undefined && Number.isSafeInteger(expr.number))
      return { kind: 'integer', values: [expr.number] }
  }
  if (!isCall(expr) || expr.staticBuiltinShadowed) return undefined
  const qualified = rQualifiedCall(expr)
  if (qualified && qualified.package !== 'base') return undefined
  const name = rCalledName(expr)
  if (expr.names.some(Boolean)) return undefined
  const evaluate = (value: RExpr | undefined): RStaticSubsetSelector | undefined =>
    rStaticSubsetSelector(value, bindings, collections, depth + 1)
  if (name === '(' && expr.args.length === 1) return evaluate(expr.args[0])
  if (name === 'c') {
    const result: Array<number | boolean> = []
    let integer = false
    for (const argument of expr.args) {
      const selector = evaluate(argument)
      if (!selector || result.length + selector.values.length > MAX_STATIC_FILE_LOOP_ITERATIONS)
        return undefined
      integer ||= selector.kind === 'integer'
      result.push(...selector.values)
    }
    return integer
      ? { kind: 'integer', values: result.map(Number) }
      : { kind: 'logical', values: result as boolean[] }
  }
  if (['-', '+', '!'].includes(name ?? '') && expr.args.length === 1) {
    const value = evaluate(expr.args[0])
    if (!value) return undefined
    if (name === '!') return { kind: 'logical', values: value.values.map((item) => !item) }
    return {
      kind: 'integer',
      values: value.values.map((item) => Number(item) * (name === '-' ? -1 : 1))
    }
  }
  let start = 1
  let length: number | undefined
  let step = 1
  if (name === ':' && expr.args.length === 2) {
    const left = evaluate(expr.args[0])
    const right = evaluate(expr.args[1])
    if (
      left?.kind !== 'integer' ||
      right?.kind !== 'integer' ||
      left.values.length !== 1 ||
      right.values.length !== 1
    )
      return undefined
    start = left.values[0]!
    const end = right.values[0]!
    length = Math.abs(end - start) + 1
    step = end < start ? -1 : 1
  } else if (name === 'seq_len' && expr.args.length === 1) {
    const value = evaluate(expr.args[0])
    if (value?.kind === 'integer' && value.values.length === 1) length = value.values[0]
  } else if (name === 'seq_along' && expr.args.length === 1) {
    length = rStaticStringCollection(expr.args[0], bindings, collections)?.values.length
  }
  if (length === undefined || length < 0 || length > MAX_STATIC_FILE_LOOP_ITERATIONS)
    return undefined
  return { kind: 'integer', values: Array.from({ length }, (_item, index) => start + index * step) }
}

const rStaticStringCollection = (
  expr: RExpr | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): RStaticFileCollection | undefined => {
  if (isSymbol(expr)) {
    const value = bindings.get(expr.name)
    return (
      collections.get(expr.name) ??
      (value === undefined ? undefined : { rKind: 'vector', values: [value] })
    )
  }
  if (!isCall(expr) || (expr.staticBuiltinShadowed && !rIsGlueCall(expr))) return undefined
  const name = rCalledName(expr)
  if (name === '[' && expr.args.length === 2 && expr.names.every((tag) => !tag)) {
    if (expr.staticBuiltinShadowed) return undefined
    const receiver = rStaticStringCollection(expr.args[0], bindings, collections)
    if (!receiver?.rKind) return undefined
    const index = expr.args[1]
    if (isCall(index) && index.staticBuiltinShadowed) return undefined
    const selectedKeys = rStaticStringCollection(index, bindings, collections)
    const scalarKey = rStaticString(index, bindings, collections)
    const keys =
      selectedKeys?.rKind === 'vector'
        ? selectedKeys.values
        : scalarKey === undefined
          ? undefined
          : [scalarKey]
    let offsets: number[]
    if (keys) {
      offsets = keys.map((key) => receiver.entries?.findIndex(([name]) => name === key) ?? -1)
    } else {
      const selector = rStaticSubsetSelector(index, bindings, collections)
      if (!selector) return undefined
      const numbers = selector.values.map(Number)
      if (selector.kind === 'logical') {
        const length = selector.values.length
          ? Math.max(receiver.values.length, selector.values.length)
          : 0
        if (length > MAX_STATIC_FILE_LOOP_ITERATIONS) return undefined
        offsets = Array.from({ length }, (_value, offset) => offset).filter(
          (offset) => selector.values[offset % selector.values.length]
        )
      } else if (numbers.some((value) => value < 0)) {
        if (numbers.some((value) => value > 0)) return undefined
        const excluded = new Set(numbers.map((value) => -value - 1))
        offsets = receiver.values
          .map((_value, offset) => offset)
          .filter((offset) => !excluded.has(offset))
      } else {
        offsets = numbers.filter((value) => value !== 0).map((value) => value - 1)
      }
    }
    if (
      offsets.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
      offsets.some((offset) => receiver.values[offset] === undefined)
    )
      return undefined
    return {
      rKind: receiver.rKind,
      values: offsets.map((offset) => receiver.values[offset]!),
      ...(receiver.entries ? { entries: offsets.map((offset) => receiver.entries![offset]!) } : {})
    }
  }
  const vectorGroups = (
    expressions: readonly RExpr[]
  ): readonly (readonly string[])[] | undefined => {
    const groups = expressions.map((argument) => {
      const collection = rStaticStringCollection(argument, bindings, collections)?.values
      if (collection) return collection
      const scalar = rStaticString(argument, bindings, collections)
      return scalar === undefined ? undefined : [scalar]
    })
    if (!groups.length || groups.some((group) => !group?.length)) return undefined
    const staticGroups = groups as readonly (readonly string[])[]
    const length = Math.max(...staticGroups.map((group) => group.length))
    return length <= MAX_STATIC_FILE_LOOP_ITERATIONS &&
      staticGroups.every((group) => group.length === 1 || group.length === length)
      ? staticGroups
      : undefined
  }
  const glueTemplate = rStaticGlueTemplate(expr)
  if (glueTemplate) {
    const names = [
      ...new Set(glueTemplate.filter((part) => part.kind === 'binding').map((part) => part.value))
    ]
    if (!names.length)
      return { rKind: 'vector', values: [renderRStaticGlue(glueTemplate, bindings)!] }
    const groups = names.map((binding) => {
      const collection = collections.get(binding)?.values
      if (collection) return collection
      const scalar = bindings.get(binding)
      return scalar === undefined ? undefined : [scalar]
    })
    if (groups.some((group) => !group?.length)) return undefined
    const staticGroups = groups as readonly (readonly string[])[]
    const length = Math.max(...staticGroups.map((group) => group.length))
    if (
      length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
      staticGroups.some((group) => group.length !== 1 && group.length !== length)
    ) {
      return undefined
    }
    return {
      rKind: 'vector',
      values: Array.from({ length }, (_unused, index) =>
        renderRStaticGlue(
          glueTemplate,
          new Map(
            names.map((name, groupIndex) => [
              name,
              staticGroups[groupIndex]![staticGroups[groupIndex]!.length === 1 ? 0 : index]!
            ])
          )
        )!
      )
    }
  }
  if (name === 'setNames' || name === 'structure') {
    const qualified = rQualifiedCall(expr)
    const dataName = name === 'setNames' ? 'object' : '.Data'
    const namesName = name === 'setNames' ? 'nm' : 'names'
    // Extra attributes (notably class/dim) can change extraction and dispatch.
    if (
      expr.args.length !== 2 ||
      (qualified && qualified.package !== (name === 'setNames' ? 'stats' : 'base')) ||
      expr.names.some((tag) => tag && tag !== dataName && tag !== namesName) ||
      expr.names.filter(Boolean).length !== new Set(expr.names.filter(Boolean)).size
    )
      return undefined
    const namesIndex = expr.names.findIndex((candidate) => candidate === namesName)
    if (name === 'structure' && namesIndex < 0) return undefined
    const dataIndex = expr.names.indexOf(dataName)
    const selectedNamesIndex = namesIndex >= 0 ? namesIndex : dataIndex === 1 ? 0 : 1
    const namesExpression = expr.args[selectedNamesIndex]
    const data = rStaticStringCollection(expr.args[1 - selectedNamesIndex], bindings, collections)
    const values = data?.values
    const names = rStaticStringCollection(namesExpression, bindings, collections)?.values
    if (
      !values?.length ||
      !names ||
      values.length !== names.length ||
      names.some((candidate) => !candidate)
    ) {
      return undefined
    }
    return {
      rKind: data?.rKind,
      values,
      entries: values.map((value, index) => [names[index]!, value] as const)
    }
  }
  const pathPart = rPathPartArgument(expr)
  if (pathPart) {
    const groups = vectorGroups([pathPart.argument])
    if (!groups) return undefined
    const values = groups[0]!.map((path) => rLexicalPathPart(path, pathPart.name))
    return values.some((value) => value === undefined)
      ? undefined
      : { rKind: 'vector', values: values as string[] }
  }
  const combination = rStringCombination(expr)
  if (combination) {
    const separator = rStaticString(combination.separator, bindings, collections)
    const groups = vectorGroups(combination.parts)
    if (separator === undefined || !groups) return undefined
    const length = Math.max(...groups.map((group) => group.length))
    return {
      rKind: 'vector',
      values: Array.from({ length }, (_unused, index) =>
        groups.map((group) => group[group.length === 1 ? 0 : index]!).join(separator)
      )
    }
  }
  if (name === 'sprintf') {
    if (
      expr.args.length <= 1 ||
      !expr.names.every((candidate, index) => !candidate || (index === 0 && candidate === 'fmt'))
    ) {
      return undefined
    }
    const format = rStaticString(expr.args[0], bindings, collections)
    const groups = vectorGroups(expr.args.slice(1))
    if (format === undefined || !groups) return undefined
    const length = Math.max(...groups.map((group) => group.length))
    const values = Array.from({ length }, (_unused, index) =>
      applyRStaticSprintf(
        format,
        groups.map((group) => group[group.length === 1 ? 0 : index]!)
      )
    )
    return values.some((value) => value === undefined)
      ? undefined
      : { rKind: 'vector', values: values as string[] }
  }
  if (
    (name !== 'c' && name !== 'list') ||
    (rQualifiedCall(expr) && rQualifiedCall(expr)?.package !== 'base')
  )
    return undefined
  const values = expr.args.map((argument) => rStaticString(argument, bindings, collections))
  if (
    values.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
    values.some((value) => value === undefined)
  ) {
    return undefined
  }
  const staticValues = values as string[]
  const entries =
    expr.names.length === staticValues.length && expr.names.every(Boolean)
      ? staticValues.map((value, index) => [expr.names[index]!, value] as const)
      : undefined
  return {
    rKind: name === 'list' ? 'list' : 'vector',
    values: staticValues,
    ...(entries ? { entries } : {})
  }
}

const rStaticLoopValues = (
  expr: RExpr | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>
): string[] | undefined => {
  if (isSymbol(expr)) {
    const scalar = bindings.get(expr.name)
    if (scalar !== undefined) return [scalar]
  }
  if (isCall(expr) && rCalledName(expr) === 'names' && expr.args.length === 1) {
    return rStaticStringCollection(expr.args[0], bindings, collections)?.entries?.map(
      ([name]) => name
    )
  }
  return rStaticStringCollection(expr, bindings, collections)?.values.slice()
}

// Expand bounded file callbacks once for both dependency and file traversal.
// Preserve argument evaluation and callable identity; never execute user code.
const R_BOUNDED_FILE_ITERATORS = new Set(['map', 'map2', 'walk', 'walk2', 'lapply'])
const rBoundedFileMap = (
  expr: RExpr,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, RStaticFileCollection>,
  shadowed: ReadonlySet<string>
): { dependency: string; arguments: RExpr[]; calls: RExpr[] } | undefined => {
  if (!isCall(expr)) return undefined
  const name = rCalledName(expr)
  const qualified = rQualifiedCall(expr)
  const pkg =
    name === 'lapply' ? 'base' : R_BOUNDED_FILE_ITERATORS.has(name ?? '') ? 'purrr' : undefined
  if (
    !pkg ||
    (qualified ? qualified.package !== pkg : expr.staticBuiltinShadowed || shadowed.has(name!))
  )
    return undefined
  const paired = name === 'map2' || name === 'walk2'
  const parameters = name === 'lapply' ? ['X', 'FUN'] : paired ? ['.x', '.y', '.f'] : ['.x', '.f']
  if (expr.names.filter(Boolean).some((name, i, all) => all.indexOf(name) !== i)) return undefined
  const unnamed = expr.args.flatMap((_arg, i) => (expr.names[i] ? [] : [i]))
  const remaining = parameters.filter((parameter) => !expr.names.includes(parameter))
  const indexOf = (parameter: string): number => {
    const named = expr.names.indexOf(parameter)
    return named >= 0 ? named : (unnamed[remaining.indexOf(parameter)] ?? -1)
  }
  const inputs = parameters.slice(0, -1).map(indexOf)
  const callbackIndex = indexOf(parameters[parameters.length - 1])
  const callback = expr.args[callbackIndex]
  if (!callback || inputs.some((index) => index < 0)) return undefined
  const invocation: Extract<RExpr, { kind: 'call' }> = {
    kind: 'call',
    operator: null,
    callee: callback,
    args: [],
    names: []
  }
  const callable = rCalledName(invocation)
  const callablePackage = rQualifiedCall(invocation)?.package
  const writer = callable ? R_FILE_MAP_WRITERS.get(callable) : undefined
  const expected = writer?.package ?? (callable ? R_FILE_MAP_READERS.get(callable) : undefined)
  if (!expected || (callablePackage ? callablePackage !== expected : shadowed.has(callable!)))
    return undefined
  const elements = (input: RExpr): RExpr[] | undefined => {
    const scalar = rStaticString(input, bindings, collections)
    const paths =
      rStaticStringCollection(input, bindings, collections)?.values ??
      (scalar !== undefined ? [scalar] : undefined)
    if (paths) return paths.map((value) => ({ kind: 'character', value }))
    // An explicit unclassed list proves iteration length without materialising its data.
    if (
      writer &&
      isCall(input) &&
      rCalledName(input) === 'list' &&
      (rQualifiedCall(input)
        ? rQualifiedCall(input)?.package === 'base'
        : !input.staticBuiltinShadowed && !shadowed.has('list'))
    )
      return input.args
    return undefined
  }
  const first = elements(expr.args[inputs[0]])
  const second = paired ? elements(expr.args[inputs[1]]) : undefined
  if (!first || (paired && !second)) return undefined
  if (second && first.length !== second.length && first.length !== 1 && second.length !== 1)
    return undefined
  const length = second ? (first.length === 1 ? second.length : first.length) : first.length
  if (length > MAX_STATIC_FILE_LOOP_ITERATIONS) return undefined
  const extra = expr.args.flatMap((arg, index) =>
    inputs.includes(index) ||
    index === callbackIndex ||
    (pkg === 'purrr' && expr.names[index] === '.progress')
      ? []
      : [{ arg, name: expr.names[index] }]
  )
  const calls: RExpr[] = []
  for (let i = 0; i < length; i++) {
    const args = [
      first[first.length === 1 ? 0 : i],
      ...(second ? [second[second.length === 1 ? 0 : i]] : []),
      ...extra.map((item) => item.arg)
    ]
    const names: Array<string | null> = [
      ...inputs.map(() => null),
      ...extra.map((item) => item.name)
    ]
    if (writer) {
      // Name the data and path slots after R's exact matching, so e.g.
      // walk(paths, writeLines, text="ok") binds the iterated value to con.
      if (
        names.some(
          (name) => name && writer.parameters.some((p) => p.startsWith(name) && p !== name)
        )
      )
        return undefined
      const unbound = writer.parameters.filter((parameter) => !names.includes(parameter))
      let position = 0
      for (let j = 0; j < names.length; j++) {
        if (!names[j] && position < unbound.length) names[j] = unbound[position++]
      }
    }
    calls.push({ ...invocation, args, names })
  }
  return {
    dependency: qualified ? `${qualified.package}::${name}` : name!,
    arguments: expr.args.filter((_arg, index) => index !== callbackIndex),
    calls
  }
}

const R_FILE_MAP_WRITERS = new Map<string, { package: string; parameters: readonly string[] }>([
  ...['write.csv', 'write.csv2', 'write.table'].map(
    (name) => [name, { package: 'utils', parameters: ['x', 'file'] }] as const
  ),
  ...[
    'write_csv',
    'write_csv2',
    'write_tsv',
    'write_delim',
    'write_lines',
    'write_file',
    'write_rds'
  ].map((name) => [name, { package: 'readr', parameters: ['x', 'file'] }] as const),
  ['saveRDS', { package: 'base', parameters: ['object', 'file'] }],
  ['writeLines', { package: 'base', parameters: ['text', 'con'] }],
  ['write_json', { package: 'jsonlite', parameters: ['x', 'path'] }]
])

const R_FILE_MAP_READERS = new Map([
  ...['read.csv', 'read.csv2', 'read.delim', 'read.delim2', 'read.table'].map(
    (name) => [name, 'utils'] as const
  ),
  ...['read_csv', 'read_csv2', 'read_tsv', 'read_delim'].map((name) => [name, 'readr'] as const),
  ['readLines', 'base'],
  ['read_json', 'jsonlite'],
  ['import', 'rtracklayer']
])

const rLiteralNamedKeys = (expr: RExpr | null | undefined): string[] | undefined => {
  if (!isCall(expr)) return undefined
  const name = rCalledName(expr)
  return (name === 'c' || name === 'list') &&
    expr.args.length > 0 &&
    expr.names.length === expr.args.length &&
    expr.names.every((key): key is string => Boolean(key))
    ? expr.names
    : undefined
}

// R matches named arguments before positional arguments. Both direct calls and
// wrapper summaries must use this rule, including options preceding the input.
const rFileCallArgument = (
  expr: Extract<RExpr, { kind: 'call' }>,
  effect: NotebookFileCallEffect
): RExpr | undefined => {
  const namedIndex = expr.names.findIndex((name) => name && effect.keywords.includes(name))
  return namedIndex >= 0
    ? expr.args[namedIndex]
    : effect.position === 0
      ? expr.args.find((_arg, index) => !expr.names[index])
      : !expr.names[effect.position]
        ? expr.args[effect.position]
        : undefined
}

// The supported write/connection options accept R's partial argument names. Exact
// names win; ignoring a supplied prefix would incorrectly activate a default mode.
const rOptionArgumentIndex = (names: readonly (string | null)[], parameter: string): number => {
  const exact = names.indexOf(parameter)
  return exact >= 0 ? exact : names.findIndex((name) => Boolean(name && parameter.startsWith(name)))
}

const rWriterDisposition = (
  expr: Extract<RExpr, { kind: 'call' }>,
  name: string,
  bindings: ReadonlyMap<string, string>
): 'replace' | 'update' | 'unknown' => {
  const option = notebookWriteOption('r', name)
  if (!option) return 'replace'
  const namedIndex = rOptionArgumentIndex(expr.names, option.keyword)
  const argument =
    namedIndex >= 0
      ? expr.args[namedIndex]
      : option.precedingArguments
        ? expr.args.filter((_arg, index) => !expr.names[index])[
            option.precedingArguments.filter((name) => rOptionArgumentIndex(expr.names, name) < 0)
              .length
          ]
        : option.position === undefined || expr.names[option.position]
          ? undefined
          : expr.args[option.position]
  const value = !argument
    ? option.defaultValue
    : option.keyword === 'append'
      ? argument.kind === 'atomic'
        ? argument.logical
        : undefined
      : rStaticString(argument, bindings, new Map())
  return notebookWriteDisposition(option, value)
}

const rLocalFileWrappers = (
  expressions: RExpr[],
  includeDeviceBodies = false
): {
  effects: Map<string, NotebookFileCallEffectSummary>
  names: Set<string>
  complete: boolean
} => {
  const effects = new Map<string, NotebookFileCallEffectSummary>()
  const names = new Set<string>()
  const localNames = new Set(
    expressions.flatMap((expr) =>
      isCall(expr) &&
      ['<-', '='].includes(expr.operator ?? '') &&
      isSymbol(expr.args[0]) &&
      isCall(expr.args[1]) &&
      expr.args[1].operator === 'function'
        ? [expr.args[0].name]
        : []
    )
  )
  let complete = true
  for (const expr of expressions) {
    if (!isCall(expr) || !['<-', '='].includes(expr.operator ?? '')) continue
    const [target, value] = expr.args
    if (!isSymbol(target) || !isCall(value) || value.operator !== 'function') continue
    names.add(target.name)
    const formals = value.args[0]
    let body = value.args[1]
    // File extraction may summarize several device alternatives with the same
    // path parameter. Dependency analysis must still inspect the entire body;
    // discovering a device does not make an arbitrary function a safe call.
    if (includeDeviceBodies && isCall(body) && body.operator === '{') {
      const devices: Extract<RExpr, { kind: 'call' }>[] = []
      const assigned = new Set<string>()
      let unsupported = false
      const collect = (node: RExpr): void => {
        if (!isCall(node)) return
        const called = rCalledName(node)
        // Helper calls need their own path substitution;
        // do not publish a single destination while hiding another writer.
        if (called && localNames.has(called)) unsupported = true
        if (['<-', '=', '->', '<<-', '->>'].includes(called ?? '')) {
          let target = node.args[called === '->' || called === '->>' ? 1 : 0]
          while (isCall(target)) target = target.args[0]
          if (isSymbol(target)) assigned.add(target.name)
        }
        const effect = called ? R_FILE_CALL_EFFECTS.get(called) : undefined
        if (effect) {
          const qualified = rQualifiedCall(node)
          if (
            !['png', 'jpeg', 'bmp', 'tiff', 'pdf', 'svg'].includes(called!) ||
            node.staticBuiltinShadowed ||
            (qualified && qualified.package !== 'grDevices') ||
            rWriterDisposition(node, called!, new Map()) !== 'replace'
          )
            unsupported = true
          else devices.push(node)
        }
        node.args.forEach(collect)
      }
      collect(body)
      const path =
        devices[0] &&
        rFileCallArgument(devices[0], R_FILE_CALL_EFFECTS.get(rCalledName(devices[0])!)!)
      if (
        !unsupported &&
        isSymbol(path) &&
        formals?.kind === 'formals' &&
        formals.names.includes(path.name) &&
        !assigned.has(path.name) &&
        devices.every((device) => {
          const argument = rFileCallArgument(device, R_FILE_CALL_EFFECTS.get(rCalledName(device)!)!)
          return isSymbol(argument) && argument.name === path.name
        })
      )
        body = devices[0]
    }
    if (isCall(body) && body.operator === '{' && body.args.length === 1) body = body.args[0]
    const name = rCalledName(body)
    const effect = name ? R_FILE_CALL_EFFECTS.get(name) : undefined
    const parameters = formals?.kind === 'formals' ? formals.names : []
    const argument = isCall(body) && effect ? rFileCallArgument(body, effect) : undefined
    const parameterIndex = isSymbol(argument) ? parameters.indexOf(argument.name) : -1
    if (
      !effect ||
      effect.additionalPaths?.length ||
      [
        'getGEO',
        'read_exposure_data',
        'read_outcome_data',
        'tximport',
        'readMSData',
        'Spectra',
        'read.FCS',
        'read.flowSet',
        'write.FCS',
        'createArrowFiles',
        'ArchRProject',
        'saveArchRProject'
      ].includes(name ?? '') ||
      parameterIndex < 0 ||
      (effect.kind === 'write' &&
        isCall(body) &&
        rWriterDisposition(body, name!, new Map()) !== 'replace')
    ) {
      complete = false
      continue
    }
    effects.set(target.name, {
      name: target.name,
      kind: effect.kind,
      position: parameterIndex,
      keywords: [parameters[parameterIndex]!],
      ...(effect.inputForm ? { inputForm: effect.inputForm } : {}),
      dependencyNames:
        isCall(body) && isSymbol(body.callee)
          ? [body.callee.name]
          : includeDeviceBodies && name && R_GRAPHICS_FILE_DEVICES.has(name)
            ? [name]
            : []
    })
  }
  return { effects, names, complete }
}

const rLoopHasEarlyExit = (expr: RExpr): boolean => {
  if (isSymbol(expr)) return expr.name === 'break' || expr.name === 'next'
  if (!isCall(expr) || expr.operator === 'function') return false
  return expr.args.some(rLoopHasEarlyExit)
}

const rScientificWriteTarget = (
  qualified: ReturnType<typeof rQualifiedCall>,
  path: string
): 'exact' | NotebookSourceFileWriteScope['kind'] | 'unsupported' => {
  if (qualified?.package === 'arrow' && qualified.name === 'write_dataset') return 'directory'
  if (qualified?.package === 'HDF5Array' && qualified.name === 'saveHDF5SummarizedExperiment') {
    return 'directory'
  }
  const lowerPath = path.toLocaleLowerCase('en-US')
  if (qualified?.package === 'sf' && qualified.name === 'st_write') {
    if (lowerPath.endsWith('.shp')) return 'shapefile'
    return ['.fgb', '.geojson', '.gpkg', '.kml', '.kmz'].some((suffix) =>
      lowerPath.endsWith(suffix)
    )
      ? 'exact'
      : 'unsupported'
  }
  if (qualified?.package === 'terra' && qualified.name === 'writeRaster') {
    return lowerPath.endsWith('.tif') || lowerPath.endsWith('.tiff') ? 'geotiff' : 'unsupported'
  }
  return 'exact'
}

const rInMemoryInput = (
  expr: RExpr | null | undefined,
  bindings: ReadonlySet<string>,
  shadowedNames: ReadonlySet<string>
): boolean => {
  if (isSymbol(expr)) return bindings.has(expr.name)
  if (!isCall(expr)) return false
  const name = rCalledName(expr)
  if (!name || !['I', 'rawConnection', 'textConnection'].includes(name)) return false
  const qualified = rQualifiedCall(expr)
  return qualified?.package === 'base' || (!qualified && !shadowedNames.has(name))
}

const analyzeRFileAccessTree = (
  root: Node,
  context?: NotebookSourceFileAccessContext
): NotebookSourceFileAccessExtraction => {
  let expressions = root.namedChildren.flatMap((child) => {
    const converted = convertR(child)
    return converted ? [converted] : []
  })
  resolveRStaticCallIdentities(expressions, context?.rFunctions, [
    ...(context?.resolvedKernelNames ?? []),
    ...(context?.staticStrings.map(({ name }) => name) ?? []),
    ...(context?.staticCollections.map(({ name }) => name) ?? [])
  ])
  expressions = expressions.map(normalizeRPipes)
  const packageInspections = rPackageInspections(expressions)
  const consoleRedirected = expressions.some(rRedirectsConsole)
  const localWrappers = rLocalFileWrappers(expressions, true)
  const shadowedQuotationNames = new Set([
    ...localWrappers.names,
    ...(context?.resolvedKernelNames ?? []),
    ...(context?.staticStrings.map(({ name }) => name) ?? []),
    ...(context?.staticCollections.map(({ name }) => name) ?? []),
    ...(context?.rFunctions?.map(({ name }) => name) ?? []),
    ...(context?.localFileWrappers.map(({ name }) => name) ?? [])
  ])
  const bindings = new Map(context?.staticStrings.map(({ name, value }) => [name, value]) ?? [])
  const collections = rContextCollections(context?.staticCollections)
  const namedCollectionKeys = new Map(
    context?.staticCollections.flatMap((collection) =>
      collection.entries
        ? [[collection.name, collection.entries.map(({ key }) => key)] as const]
        : []
    ) ?? []
  )
  const contextualWrappers = new Map(
    context?.localFileWrappers.map((wrapper) => [wrapper.name, wrapper]) ?? []
  )
  const unresolvedLocalEffects = new Map<string, Set<'read' | 'write'>>()
  const localDefinitions = new Map(
    expressions.flatMap((expression) => {
      if (!isCall(expression) || !['<-', '='].includes(expression.operator ?? '')) return []
      const [target, value] = expression.args
      return isSymbol(target) && isCall(value) && value.operator === 'function'
        ? [[target.name, value] as const]
        : []
    })
  )
  for (const expression of expressions) {
    if (!isCall(expression) || !['<-', '='].includes(expression.operator ?? '')) continue
    const [target, value] = expression.args
    if (
      !isSymbol(target) ||
      !isCall(value) ||
      value.operator !== 'function' ||
      localWrappers.effects.has(target.name)
    )
      continue
    const effects = new Set<'read' | 'write'>()
    const visited = new Set<string>()
    const collect = (node: RExpr): void => {
      if (!isCall(node)) return
      const called = rCalledName(node) ?? ''
      const effect = R_FILE_CALL_EFFECTS.get(called)
      if (effect) effects.add(effect.kind)
      // A single-path wrapper summary cannot preserve mixed I/O or directory scope.
      if (called === 'createArrowFiles') effects.add('write')
      if (called === 'ArchRProject' || called === 'saveArchRProject') effects.add('read')
      const helper = localDefinitions.get(called)
      if (helper && !visited.has(called)) {
        visited.add(called)
        collect(helper)
      }
      node.args.forEach(collect)
    }
    collect(value)
    unresolvedLocalEffects.set(target.name, effects)
  }
  const reads = new Set<string>()
  const writes = new Set<string>()
  const definitelyWritten = new Set<string>()
  const inMemoryInputs = new Set<string>()
  type FileConnection = { path: string; mode: string | undefined }
  const fileConnections = new Map<string, FileConnection>()
  const writeScopes = new Map<string, NotebookSourceFileWriteScope>()
  let unresolvedReads = false
  let unresolvedWrites = false
  let unsupportedExternalState = false
  let directoryStateRead = false
  let staticLoopIterations = 0
  let conditionalDepth = 0

  const fcsReadParameters = [
    'filename',
    'transformation',
    'which.lines',
    'alter.names',
    'column.pattern',
    'invert.pattern',
    'decades',
    'ncdf',
    'min.limit',
    'truncate_max_range',
    'dataset',
    'emptyValue',
    'channel_alias'
  ]
  const flowSetReadParameters = [
    'files',
    'path',
    'pattern',
    'phenoData',
    'descriptions',
    'name.keyword',
    'alter.names',
    'transformation',
    'which.lines',
    'column.pattern',
    'invert.pattern',
    'decades',
    'sep',
    'as.is',
    'name',
    'ncdf',
    'dataset',
    'min.limit',
    'truncate_max_range',
    'emptyValue',
    'ignore.text.offset',
    'channel_alias'
  ]
  const geoParameters = [
    'GEO',
    'filename',
    'destdir',
    'GSElimits',
    'GSEMatrix',
    'AnnotGPL',
    'getGPL',
    'parseCharacteristics'
  ]
  const connectionArgument = (
    expr: Extract<RExpr, { kind: 'call' }>,
    parameters: string[],
    parameter: string
  ): RExpr | undefined => {
    const named = rOptionArgumentIndex(expr.names, parameter)
    if (named >= 0) return expr.args[named]
    const remaining = parameters.filter((name) => rOptionArgumentIndex(expr.names, name) < 0)
    return expr.args.filter((_value, index) => !expr.names[index])[remaining.indexOf(parameter)]
  }

  const fileConnection = (expr: RExpr | null | undefined): FileConnection | undefined => {
    if (isSymbol(expr)) return fileConnections.get(expr.name)
    if (!isCall(expr)) return undefined
    const connectionName = rCalledName(expr)
    const connectionQualified = rQualifiedCall(expr)
    if (
      connectionName === 'gzcon' &&
      (!connectionQualified || connectionQualified.package === 'base') &&
      !localWrappers.names.has(connectionName)
    ) {
      const named = expr.names.indexOf('con')
      return fileConnection(expr.args[named >= 0 ? named : 0])
    }
    if (
      !connectionName ||
      !['bzfile', 'file', 'gzfile', 'unz', 'xzfile'].includes(connectionName)
    ) {
      return undefined
    }
    if (
      (connectionQualified && connectionQualified.package !== 'base') ||
      (!connectionQualified && localWrappers.names.has(connectionName))
    ) {
      return undefined
    }
    const parameters =
      connectionName === 'unz' ? ['description', 'filename', 'open'] : ['description', 'open']
    const path = rStaticString(
      connectionArgument(expr, parameters, 'description'),
      bindings,
      collections
    )
    const modeArg = connectionArgument(expr, parameters, 'open')
    return path
      ? { path, mode: modeArg ? rStaticString(modeArg, bindings, collections) : '' }
      : undefined
  }
  const fileConnectionPath = (expr: RExpr | null | undefined): string | undefined =>
    fileConnection(expr)?.path

  const visit = (expr: RExpr, valueUsed = true): void => {
    if (packageInspections.has(expr)) return
    if (!isCall(expr)) return
    if (expr.operator === '|>' || expr.operator === '%>%') {
      unresolvedReads = true
      unresolvedWrites = true
      unsupportedExternalState = true
      expr.args.forEach((arg) => visit(arg))
      return
    }
    if (!valueUsed && !consoleRedirected && rConsoleDiagnostic(expr, bindings, collections)) return
    if (
      R_FILESYSTEM_OBSERVATIONS.has(rCalledName(expr) ?? '') ||
      R_ENVIRONMENT_OBSERVATIONS.has(rCalledName(expr) ?? '')
    )
      unsupportedExternalState = true
    if (R_DEVICE_EXPORT_CALLS.has(rCalledName(expr) ?? '')) {
      const device = rGraphicsDeviceExport(expr)
      if (device) visit(device)
      else {
        unresolvedWrites = true
        unsupportedExternalState = true
        expr.args.forEach((argument) => visit(argument))
      }
      return
    }
    if (R_FILESYSTEM_MUTATIONS.has(rCalledName(expr) ?? '')) {
      const removedPaths = !valueUsed && rExactUnlinkPaths(expr, bindings, collections)
      if (removedPaths) {
        for (const path of removedPaths) {
          writes.add(path)
          // Deletion does not prove that a later read will find a generated file.
          definitelyWritten.delete(path)
        }
        return
      }
      unresolvedReads = true
      unresolvedWrites = true
      unsupportedExternalState = true
      expr.args.forEach((argument) => visit(argument))
      return
    }
    const externalPackage = R_UNCAPTURED_EXTERNAL_CALLS.get(rCalledName(expr) ?? '')
    if (
      externalPackage &&
      (rQualifiedCall(expr)?.package === externalPackage ||
        (externalPackage === 'base' && !rQualifiedCall(expr)))
    ) {
      unresolvedReads = true
      unresolvedWrites = true
      unsupportedExternalState = true
      expr.args.forEach((argument) => visit(argument))
      return
    }
    const targetOptions = rTargetDefinitionOptions(expr)
    if (targetOptions) {
      unresolvedReads = true
      unresolvedWrites = true
      unsupportedExternalState = true
      targetOptions.forEach((argument) => visit(argument))
      return
    }
    const quoted = rQuotedDataCall(expr)
    if (quoted && (quoted.qualified || !shadowedQuotationNames.has(quoted.name))) return
    const fileMap = rBoundedFileMap(expr, bindings, collections, shadowedQuotationNames)
    if (fileMap) {
      if (staticLoopIterations + fileMap.calls.length > MAX_STATIC_FILE_LOOP_ITERATIONS) {
        unresolvedReads = true
        unresolvedWrites = true
        unsupportedExternalState = true
        return
      }
      staticLoopIterations += fileMap.calls.length
      for (const argument of fileMap.arguments) visit(argument)
      for (const invocation of fileMap.calls) visit(invocation)
      return
    }
    if (expr.operator === '{') {
      expr.args.forEach((argument, index) =>
        visit(argument, valueUsed && index === expr.args.length - 1)
      )
      return
    }
    if (expr.operator === 'for') {
      const [variable, sequence, body] = expr.args
      if (sequence) visit(sequence)
      const namedSequence =
        isCall(sequence) &&
        rCalledName(sequence) === 'names' &&
        isSymbol(sequence.args[0]) &&
        sequence.args.length === 1
          ? namedCollectionKeys.get(sequence.args[0].name)
          : undefined
      const values = namedSequence ?? rStaticLoopValues(sequence, bindings, collections)
      if (
        isSymbol(variable) &&
        values &&
        body &&
        !rLoopHasEarlyExit(body) &&
        staticLoopIterations + values.length <= MAX_STATIC_FILE_LOOP_ITERATIONS
      ) {
        for (const value of values) {
          staticLoopIterations += 1
          bindings.set(variable.name, value)
          collections.delete(variable.name)
          namedCollectionKeys.delete(variable.name)
          visit(body)
        }
      } else if (body) {
        if (isSymbol(variable)) {
          bindings.delete(variable.name)
          collections.delete(variable.name)
          namedCollectionKeys.delete(variable.name)
        }
        conditionalDepth += 1
        visit(body)
        conditionalDepth -= 1
      }
      return
    }
    if (['if', 'while', 'repeat', 'switch', 'tryCatch'].includes(rCalledName(expr) ?? '')) {
      conditionalDepth += 1
      expr.args.forEach((argument) => visit(argument))
      conditionalDepth -= 1
      return
    }
    if (['<-', '=', '->'].includes(expr.operator ?? '') && expr.args.length >= 2) {
      const left = expr.operator === '->' ? expr.args[1] : expr.args[0]
      const right = expr.operator === '->' ? expr.args[0] : expr.args[1]
      if (isCall(left)) {
        // R replacement assignment updates its root binding (ordinary vectors/lists copy on
        // modify). The old static value cannot describe the result of an arbitrary replacement.
        let receiver: RExpr | undefined = left
        while (isCall(receiver)) receiver = receiver.args[0]
        if (isSymbol(receiver)) {
          bindings.delete(receiver.name)
          collections.delete(receiver.name)
          namedCollectionKeys.delete(receiver.name)
          inMemoryInputs.delete(receiver.name)
          fileConnections.delete(receiver.name)
        }
      }
      if (isSymbol(left)) {
        shadowedQuotationNames.add(left.name)
        const value = rStaticString(right, bindings, collections)
        const namedValues =
          isCall(right) &&
          rCalledName(right) === 'names' &&
          isSymbol(right.args[0]) &&
          right.args.length === 1
            ? namedCollectionKeys.get(right.args[0].name)
            : undefined
        const collection =
          rStaticStringCollection(right, bindings, collections) ??
          (namedValues ? { values: namedValues } : undefined)
        const connectionPath = fileConnection(right)
        const namedKeys =
          rLiteralNamedKeys(right) ??
          (isSymbol(right) ? namedCollectionKeys.get(right.name) : undefined) ??
          collection?.entries?.map(([key]) => key)
        if (conditionalDepth > 0 || !namedKeys) namedCollectionKeys.delete(left.name)
        else namedCollectionKeys.set(left.name, namedKeys)
        if (conditionalDepth > 0) {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        } else if (value !== undefined && !collection?.entries) {
          bindings.set(left.name, value)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        } else if (collection) {
          bindings.delete(left.name)
          collections.set(left.name, collection)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        } else if (rInMemoryInput(right, inMemoryInputs, localWrappers.names)) {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.add(left.name)
          fileConnections.delete(left.name)
        } else if (connectionPath) {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.set(left.name, connectionPath)
        } else {
          bindings.delete(left.name)
          collections.delete(left.name)
          inMemoryInputs.delete(left.name)
          fileConnections.delete(left.name)
        }
      }
      if (!(isCall(right) && right.operator === 'function')) visit(right)
      return
    }
    const name = rCalledName(expr)
    const qualified = rQualifiedCall(expr)
    if (name === 'pheatmap') {
      const filename = connectionArgument(expr, R_PHEATMAP_PARAMETERS, 'filename')
      const path = filename && rStaticString(filename, bindings, collections)
      if (
        (qualified && qualified.package !== 'pheatmap') ||
        (!qualified && shadowedQuotationNames.has(name)) ||
        !path
      ) {
        unresolvedReads = true
        unresolvedWrites = true
        unsupportedExternalState = true
      } else {
        writes.add(path)
        if (conditionalDepth === 0) definitelyWritten.add(path)
      }
      expr.args.forEach((arg) => visit(arg))
      return
    }
    if (name === 'venn.diagram') {
      // venn.diagram writes its device file and, by default, a timestamped log
      // beside it. Restrict attribution to that filename family, not its directory.
      const parameters = ['x', 'filename', 'disable.logging']
      const filename = connectionArgument(expr, parameters, 'filename')
      const path = filename && rStaticString(filename, bindings, collections)
      const logging = connectionArgument(expr, parameters, 'disable.logging')
      if (
        (qualified && qualified.package !== 'VennDiagram') ||
        (!qualified && shadowedQuotationNames.has(name)) ||
        !path ||
        (logging && !(logging.kind === 'atomic' && typeof logging.logical === 'boolean'))
      ) {
        unresolvedReads = true
        unresolvedWrites = true
        unsupportedExternalState = true
      } else {
        writes.add(path)
        if (conditionalDepth === 0) definitelyWritten.add(path)
        if (!(logging?.kind === 'atomic' && logging.logical === true))
          writeScopes.set(`timestamped-log\0${path}`, { kind: 'timestamped-log', path })
      }
      expr.args.forEach((arg) => visit(arg))
      return
    }
    // Aliases share the same connection state. Explicit reopen/close must not leave
    // a stale append/replace mode behind for later consumers in this run.
    if (
      name &&
      ['open', 'close'].includes(name) &&
      (!qualified || qualified.package === 'base') &&
      !localWrappers.names.has(name)
    ) {
      const parameters = ['con', 'open']
      const connection = fileConnection(connectionArgument(expr, parameters, 'con'))
      if (connection) {
        if (name === 'close') connection.mode = undefined
        else if (connection.mode === '') {
          // R warns and leaves already-open connections unchanged. Only a known
          // unopened connection can acquire a new mode; conditional opens are uncertain.
          const modeArg = connectionArgument(expr, parameters, 'open')
          connection.mode =
            conditionalDepth === 0 && modeArg
              ? rStaticString(modeArg, bindings, collections)
              : undefined
        }
      }
    }

    const referenceOnlyCall =
      qualified?.package === 'openxlsx' &&
      [
        'addStyle',
        'addWorksheet',
        'createWorkbook',
        'deleteData',
        'freezePane',
        'mergeCells',
        'removeWorksheet',
        'renameWorksheet',
        'setColWidths',
        'setRowHeights',
        'writeData',
        'writeDataTable'
      ].includes(qualified.name)
    if (
      name &&
      R_DIRECTORY_STATE_CALLS.has(name) &&
      (qualified?.package === 'base' || (!qualified && !localWrappers.names.has(name)))
    ) {
      // A standalone listing only prints directory names; it neither reads file
      // contents nor supplies this artifact's data. Assigned/nested listings still
      // require directory evidence. Always inspect arguments for actual effects.
      if (!qualified && shadowedQuotationNames.has(name)) unsupportedExternalState = true
      else if (valueUsed) directoryStateRead = true
    }
    let call: NotebookFileCallEffect | undefined = name
      ? qualified
        ? R_FILE_CALL_EFFECTS.get(name)
        : (localWrappers.effects.get(name) ??
          (localWrappers.names.has(name)
            ? undefined
            : (contextualWrappers.get(name) ?? R_FILE_CALL_EFFECTS.get(name))))
      : undefined
    if (!qualified && name && !call) {
      if (unresolvedLocalEffects.get(name)?.has('read')) unresolvedReads = true
      if (unresolvedLocalEffects.get(name)?.has('write')) unresolvedWrites = true
    }
    let fileArgumentOverride: { value: RExpr | undefined } | undefined
    if (
      name &&
      R_GRAPHICS_FILE_DEVICES.has(name) &&
      qualified?.package !== undefined &&
      qualified.package !== 'grDevices'
    )
      call = undefined
    if (
      call &&
      name &&
      qualified &&
      ((['Read10X', 'Read10X_h5', 'Load10X_Spatial'].includes(name) &&
        qualified.package !== 'Seurat') ||
        (['ArchRProject', 'saveArchRProject', 'createArrowFiles'].includes(name) &&
          qualified.package !== 'ArchR') ||
        (name === 'readVcf' && qualified.package !== 'VariantAnnotation') ||
        (name === 'read.vcfR' && qualified.package !== 'vcfR'))
    ) {
      call = undefined
    }
    const archRCall = Boolean(
      call &&
      name &&
      ['ArchRProject', 'saveArchRProject', 'createArrowFiles'].includes(name) &&
      call === R_FILE_CALL_EFFECTS.get(name) &&
      (qualified?.package === 'ArchR' || (!qualified && !shadowedQuotationNames.has(name)))
    )
    if (archRCall && (name === 'ArchRProject' || name === 'saveArchRProject')) {
      fileArgumentOverride = {
        value: connectionArgument(
          expr,
          [name === 'ArchRProject' ? 'ArrowFiles' : 'ArchRProj', 'outputDirectory'],
          'outputDirectory'
        )
      }
    }
    if (call && ['read.FCS', 'read.flowSet', 'write.FCS'].includes(name ?? '')) {
      if (qualified && qualified.package !== 'flowCore') call = undefined
      else if (qualified || !localWrappers.names.has(name!)) {
        const parameters =
          name === 'read.FCS'
            ? fcsReadParameters
            : name === 'read.flowSet'
              ? flowSetReadParameters
              : ['x', 'filename', 'what', 'delimiter', 'endian']
        const option = (parameter: string): RExpr | undefined =>
          connectionArgument(expr, parameters, parameter)
        // A scalar event count samples the FCS using R's ambient RNG. Only an
        // explicit multi-event numeric selection can avoid that implicit state.
        const selection = name === 'write.FCS' ? undefined : option('which.lines')
        const selectionRange =
          isCall(selection) && selection.operator === ':' && selection.args.length === 2
            ? selection.args.map((arg) => (arg.kind === 'atomic' ? arg.number : undefined))
            : []
        const [firstEvent, lastEvent] = selectionRange
        const explicitEvents =
          firstEvent !== undefined &&
          lastEvent !== undefined &&
          Number.isFinite(firstEvent) &&
          Number.isFinite(lastEvent) &&
          Math.abs(lastEvent - firstEvent) >= 1
        // write.FCS also accepts disk-backed cytoframes. The destination is exact,
        // but the object's hidden backing files require runtime/type evidence.
        if (name === 'write.FCS') unsupportedExternalState = true
        if (!isNull(selection) && !explicitEvents) unsupportedExternalState = true
        if (
          expr.names.some(
            (key) =>
              key &&
              !parameters.some((parameter) => parameter.startsWith(key)) &&
              !(name === 'read.FCS' && key === 'ignore.text.offset')
          )
        )
          unsupportedExternalState = true
        const literalLocalPath = (value: string | undefined): value is string =>
          Boolean(value) &&
          value !== '-' &&
          value !== '/dev/stdin' &&
          !/^(?:[a-z][a-z0-9+.-]*:\/\/|\|)/iu.test(value!) &&
          !/[*?]/u.test(value!)
        if (name === 'read.flowSet') {
          const pathArg = option('path')
          const pathValue = !pathArg ? '.' : rStaticString(pathArg, bindings, collections)
          const path = literalLocalPath(pathValue) ? pathValue : undefined
          const phenotype = option('phenoData')
          const files = option('files')
          if (!isNull(phenotype)) {
            // Phenotype metadata overrides files, and its FCS_File column selects
            // additional inputs that cannot be inferred from the source alone.
            const metadata = rStaticString(phenotype, bindings, collections)
            if (path !== undefined && literalLocalPath(metadata)) {
              const input = path === '.' ? metadata : `${path}/${metadata}`
              if (!definitelyWritten.has(input)) reads.add(input)
            }
            unresolvedReads = true
          } else if (isNull(files) || path === undefined) {
            unresolvedReads = true
            if (isNull(files)) directoryStateRead = true
          } else {
            const scalar = rStaticString(files, bindings, collections)
            const paths =
              scalar === undefined
                ? rStaticStringCollection(files, bindings, collections)?.values
                : [scalar]
            if (
              !paths ||
              paths.length === 0 ||
              paths.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
              paths.some((file) => !literalLocalPath(file))
            )
              unresolvedReads = true
            else
              for (const file of paths) {
                const input = path === '.' ? file : `${path}/${file}`
                if (!definitelyWritten.has(input)) reads.add(input)
              }
          }
          expr.args.forEach((argument) => visit(argument))
          return
        }
        const filename = option('filename')
        const filenameValue = rStaticString(filename, bindings, collections)
        fileArgumentOverride = {
          value:
            name === 'read.FCS' && filenameValue !== undefined && !literalLocalPath(filenameValue)
              ? undefined
              : filename
        }
      }
    }
    if (qualified?.package === 'Spectra' && qualified.name === 'backendInitialize') {
      const object = connectionArgument(expr, ['object', 'files'], 'object')
      const backend = isCall(object) ? rQualifiedCall(object) : undefined
      if (backend?.package === 'Spectra' && backend.name === 'MsBackendMzR') {
        call = { kind: 'read', position: 1, keywords: ['files'], inputForm: 'paths' }
        fileArgumentOverride = { value: connectionArgument(expr, ['object', 'files'], 'files') }
        // Headers are read now; peak data and backend state remain lazy.
        unsupportedExternalState = true
      }
    } else if (qualified?.package === 'BiocFileCache' && qualified.name === 'bfcadd') {
      const parameters = ['x', 'rname', 'fpath']
      call = { kind: 'read', position: 2, keywords: ['fpath'] }
      fileArgumentOverride = {
        value:
          connectionArgument(expr, parameters, 'fpath') ??
          connectionArgument(expr, parameters, 'rname')
      }
      // Adding a local resource copies, moves, or references its existing bytes.
      // The cache database and resulting storage path cannot be certified here.
      unsupportedExternalState = true
    }
    if (call && ['tximport', 'readMSData', 'Spectra'].includes(name ?? '')) {
      const packageName = name === 'readMSData' ? 'MSnbase' : name
      if (qualified && qualified.package !== packageName) call = undefined
      else {
        // Other import modes can discover inferential replicates, annotations,
        // file-backed peaks, or user-supplied importers beyond the entry paths.
        const option = (key: string): RExpr | undefined => expr.args[expr.names.indexOf(key)]
        const txOut = option('txOut')
        const dropInfReps = option('dropInfReps')
        const type = option('type')
        const explicitSalmon =
          name === 'tximport' &&
          type?.kind === 'character' &&
          type.value === 'salmon' &&
          txOut?.kind === 'atomic' &&
          txOut.logical === true &&
          dropInfReps?.kind === 'atomic' &&
          dropInfReps.logical === true &&
          expr.names.filter((key) => !key).length <= 1 &&
          expr.names.every((key) => !key || ['files', 'type', 'txOut', 'dropInfReps'].includes(key))
        if (!explicitSalmon) unsupportedExternalState = true
      }
    }
    if (!call && qualified?.package === 'sf' && qualified.name === 'st_write') {
      call = { kind: 'write', position: 1, keywords: ['dsn'] }
    } else if (!call && qualified?.package === 'terra' && qualified.name === 'writeRaster') {
      call = { kind: 'write', position: 1, keywords: ['filename'] }
    } else if (
      !call &&
      qualified?.package === 'HDF5Array' &&
      qualified.name === 'saveHDF5SummarizedExperiment'
    ) {
      call = { kind: 'write', position: 1, keywords: ['dir'] }
    }
    if (call && ['read_exposure_data', 'read_outcome_data'].includes(name ?? '')) {
      // format_data can generate random IDs when the actual table lacks an ID
      // column. File names alone cannot prove the global RNG state is irrelevant.
      unsupportedExternalState = true
    }
    if (call && name === 'getGEO') {
      const getGPL = connectionArgument(expr, geoParameters, 'getGPL')
      const annotGPL = connectionArgument(expr, geoParameters, 'AnnotGPL')
      if (
        !(getGPL?.kind === 'atomic' && getGPL.logical === false) ||
        (annotGPL && !(annotGPL.kind === 'atomic' && annotGPL.logical === false))
      ) {
        unsupportedExternalState = true
      }
    }
    if (!call) {
      if (!referenceOnlyCall && name && isPotentialRFileWriteCall(name)) unresolvedWrites = true
    } else {
      if (qualified?.package === 'htmlwidgets' && qualified.name === 'saveWidget') {
        const selfContainedIndex = expr.names.findIndex(
          (candidate) => candidate === 'selfcontained'
        )
        if (
          selfContainedIndex >= 0 &&
          !(
            expr.args[selfContainedIndex]?.kind === 'atomic' &&
            expr.args[selfContainedIndex].logical === true
          )
        ) {
          unresolvedWrites = true
        }
      }
      const libraryFread =
        name === 'fread' &&
        (qualified?.package === 'data.table' || (!qualified && !localWrappers.names.has(name)))
      const textIndex = libraryFread
        ? expr.names.findIndex((candidate) => candidate === 'text')
        : -1
      const commandIndex = libraryFread
        ? expr.names.findIndex((candidate) => candidate === 'cmd')
        : -1
      if (archRCall && name === 'createArrowFiles') {
        // Arrow generation and QC/log companions remain incomplete even when
        // fragment inputs resolve to a bounded collection below.
        unresolvedWrites = true
        const parameters = [
          'inputFiles',
          'sampleNames',
          'outputNames',
          'validBarcodes',
          'geneAnnotation',
          'genomeAnnotation',
          'minTSS',
          'minFrags',
          'maxFrags',
          'minFragSize',
          'maxFragSize',
          'QCDir',
          'nucLength',
          'promoterRegion',
          'TSSParams',
          'excludeChr',
          'nChunk',
          'bcTag',
          'gsubExpression',
          'bamFlag',
          'offsetPlus',
          'offsetMinus',
          'addTileMat',
          'TileMatParams',
          'addGeneScoreMat',
          'GeneScoreMatParams',
          'force',
          'threads',
          'parallelParam',
          'subThreading',
          'verbose',
          'cleanTmp',
          'logFile',
          'filterFrags',
          'filterTSS'
        ]
        const validNames = expr.names.every(
          (parameter) =>
            !parameter ||
            parameters.includes(parameter) ||
            parameters.filter((formal) => formal.startsWith(parameter)).length === 1
        )
        const outputNames = validNames
          ? connectionArgument(expr, parameters, 'outputNames')
          : undefined
        const prefix = rStaticString(outputNames, bindings, collections)
        const prefixes =
          rStaticStringCollection(outputNames, bindings, collections)?.values ??
          (prefix ? [prefix] : undefined)
        if (prefixes && prefixes.length <= MAX_STATIC_FILE_LOOP_ITERATIONS) {
          for (const prefix of prefixes) writes.add(`${prefix}.arrow`)
        }
        const qcPath = validNames
          ? rStaticString(connectionArgument(expr, parameters, 'QCDir'), bindings, collections)
          : undefined
        if (qcPath) {
          writes.add(qcPath)
          writeScopes.set(`directory\0${qcPath}`, { kind: 'directory', path: qcPath })
        }
      }
      // Match all required formals together: named arguments consume their slots
      // before unnamed arguments, regardless of the order used at the call site.
      const pathEffects = [call, ...(call.additionalPaths ?? [])]
      const unmatchedEffects = pathEffects.filter(
        (effect) => !expr.names.some((name) => name && effect.keywords.includes(name))
      )
      const positionalArgs = expr.args.filter((_arg, index) => !expr.names[index])
      const pathArgument = (effect: (typeof pathEffects)[number]): RExpr | undefined => {
        const namedIndex = expr.names.findIndex((name) => name && effect.keywords.includes(name))
        return namedIndex >= 0
          ? expr.args[namedIndex]
          : positionalArgs[unmatchedEffects.indexOf(effect)]
      }
      for (const effect of call.additionalPaths ?? []) {
        const extraArgument = pathArgument(effect)
        const extraPath =
          fileConnectionPath(extraArgument) ?? rStaticString(extraArgument, bindings, collections)
        if (!extraPath) unresolvedReads = true
        else if (!definitelyWritten.has(extraPath)) reads.add(extraPath)
      }
      const argument = fileArgumentOverride
        ? fileArgumentOverride.value
        : name === 'getGEO'
          ? connectionArgument(expr, geoParameters, 'filename')
          : call.additionalPaths?.length
            ? pathArgument(call)
            : rFileCallArgument(expr, call)
      if (!argument && call.pathOptional) return
      let inlineJson = false
      if (
        argument &&
        (name === 'fromJSON' || name === 'parse_json') &&
        (qualified?.package === 'jsonlite' || (!qualified && !shadowedQuotationNames.has(name)))
      ) {
        const text = rStaticString(argument, bindings, collections)
        if (name === 'parse_json') {
          // Strings are JSON text, while R connections are actual input handles.
          // readLines returns text; its nested file read is still visited below.
          const reader = rCalledName(argument)
          const readerPackage = rQualifiedCall(argument)?.package
          inlineJson =
            text !== undefined ||
            (reader === 'readLines' &&
              (readerPackage === 'base' || (!readerPackage && !shadowedQuotationNames.has(reader))))
        } else if (text !== undefined) {
          try {
            JSON.parse(text)
            inlineJson = true
          } catch {
            /* Non-JSON text may name an actual file. */
          }
        }
      }
      const inMemoryRead =
        call.kind === 'read' &&
        (inlineJson ||
          textIndex >= 0 ||
          rInMemoryInput(argument, inMemoryInputs, localWrappers.names))
      const acceptsMultiplePaths = call.inputForm === 'paths'
      if (call.kind === 'read' && !inMemoryRead && acceptsMultiplePaths) {
        const paths =
          rStaticStringCollection(argument, bindings, collections)?.values ??
          (isCall(argument) && ['list', 'c'].includes(rCalledName(argument) ?? '')
            ? argument.args.map(fileConnectionPath)
            : undefined)
        if (
          paths &&
          paths.length <= MAX_STATIC_FILE_LOOP_ITERATIONS &&
          paths.every((path): path is string => path !== undefined)
        ) {
          for (const path of paths) if (!definitelyWritten.has(path)) reads.add(path)
          expr.args.forEach((argument) => visit(argument))
          return
        }
      }
      const path = inMemoryRead
        ? undefined
        : (fileConnectionPath(argument) ?? rStaticString(argument, bindings, collections))
      // These readers expand a directory into companion files at runtime. Keep
      // the proven root path but do not claim complete input coverage.
      if (call.kind === 'read' && (name === 'Read10X' || name === 'Load10X_Spatial') && path) {
        unresolvedReads = true
      }
      // Project creation and saving can read ArrowFiles referenced by the object.
      // Their input file coverage remains incomplete without runtime evidence.
      if (archRCall && (name === 'ArchRProject' || name === 'saveArchRProject')) {
        unresolvedReads = true
      }
      if (archRCall && name === 'ArchRProject') {
        const arrowArgument = connectionArgument(
          expr,
          ['ArrowFiles', 'outputDirectory'],
          'ArrowFiles'
        )
        const arrowPaths = rStaticStringCollection(arrowArgument, bindings, collections)?.values
        if (arrowPaths) {
          for (const arrowPath of arrowPaths)
            if (!definitelyWritten.has(arrowPath)) reads.add(arrowPath)
        }
      }
      // A device path may be a printf page template or a shell pipe, not an
      // exact output filename. Do not publish either as confirmed file evidence.
      const graphicsFileDevice = Boolean(
        name &&
        (R_GRAPHICS_FILE_DEVICES.has(name) ||
          (localWrappers.effects.get(name) ?? contextualWrappers.get(name))?.dependencyNames?.some(
            (dependency) => R_GRAPHICS_FILE_DEVICES.has(dependency)
          ))
      )
      const devicePipe = graphicsFileDevice && path?.trimStart().startsWith('|')
      if (graphicsFileDevice && name === 'postscript') {
        const parameters = [
          'file',
          'onefile',
          'family',
          'title',
          'fonts',
          'encoding',
          'bg',
          'fg',
          'width',
          'height',
          'horizontal',
          'pointsize',
          'paper',
          'pagecentre',
          'print.it',
          'command'
        ]
        const printValue = connectionArgument(expr, parameters, 'print.it')
        if (printValue && !(printValue.kind === 'atomic' && printValue.logical === false)) {
          unsupportedExternalState = true
        }
        if (connectionArgument(expr, parameters, 'command') || path === '') {
          unsupportedExternalState = true
        }
        if (connectionArgument(expr, parameters, 'encoding')) {
          // Encoding files can be resolved through R's installation search path.
          // A supplied encoding requires evidence beyond the output path.
          unresolvedReads = true
        }
      }
      if (graphicsFileDevice && (devicePipe || (path?.includes('%') ?? false))) {
        unresolvedWrites = true
        if (devicePipe) unsupportedExternalState = true
        expr.args.forEach((argument) => visit(argument))
        return
      }
      if (commandIndex >= 0) {
        unresolvedReads = true
        unsupportedExternalState = true
      } else if (!inMemoryRead) {
        if (!path) {
          if (call.kind === 'read') unresolvedReads = true
          else unresolvedWrites = true
        } else if (call.kind === 'write') {
          const target =
            archRCall && (name === 'ArchRProject' || name === 'saveArchRProject')
              ? 'directory'
              : rScientificWriteTarget(qualified, path)
          if (target === 'unsupported') {
            unresolvedWrites = true
          } else {
            const connection = fileConnection(argument)
            const disposition = connection
              ? connection.mode === ''
                ? 'replace'
                : notebookWriteDisposition({ keyword: 'mode', defaultValue: 'w' }, connection.mode)
              : rWriterDisposition(expr, name!, bindings)
            if (disposition === 'update' && !definitelyWritten.has(path)) reads.add(path)
            if (disposition === 'unknown') {
              unresolvedReads = true
              unresolvedWrites = true
            }
            writes.add(path)
            if (conditionalDepth === 0 && disposition !== 'unknown') definitelyWritten.add(path)
            if (target !== 'exact') {
              writeScopes.set(`${target}\0${path}`, { kind: target, path })
            }
          }
        } else if (!definitelyWritten.has(path)) {
          reads.add(path)
        }
      }
    }
    expr.args.forEach((argument) => visit(argument))
  }
  expressions.forEach((expression) => visit(expression, false))

  return {
    reads: [...reads].sort(),
    writes: [...writes].sort(),
    ...(writeScopes.size ? { writeScopes: [...writeScopes.values()] } : {}),
    unresolvedReads,
    unresolvedWrites,
    unsupportedExternalState,
    directoryStateRead,
    localFileWrappersComplete: localWrappers.complete,
    context: {
      staticStrings: [...bindings]
        .map(([name, value]) => ({ name, value }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      staticCollections: [...collections]
        .map(([name, collection]) => ({
          name,
          values: [...collection.values],
          ...(collection.rKind ? { rKind: collection.rKind } : {}),
          ...(collection.entries
            ? { entries: collection.entries.map(([key, value]) => ({ key, value })) }
            : {})
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      localFileWrappers: [...localWrappers.effects.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
      )
    }
  }
}

const analyzeRSources = async (
  sources: readonly string[],
  context?: NotebookSourceFileAccessContext
): Promise<NotebookRunDependencyFacts[]> => {
  const results: NotebookRunDependencyFacts[] = []
  for (const source of sources) {
    const parsed = await withParsedNotebookSource('r', source, (root) =>
      analyzeRSource(
        root,
        context?.localFileWrappers,
        context?.staticStrings,
        context?.staticCollections,
        context?.rFunctions,
        context?.resolvedKernelNames,
        context?.rAtomicValueNames,
        context?.rCopyOnModifyNames,
        context?.verifiedSerializedValues
      )
    )
    results.push(
      parsed.state === 'ok' ? parsed.value : { state: 'unknown', reasons: [parsed.reason] }
    )
  }
  return results
}

// Variable and file evidence share this invocation's tree; no AST survives the call.
const analyzeRNotebookSource = async (
  source: string,
  context?: NotebookSourceFileAccessContext,
  fileContextForFacts?: (
    facts: NotebookRunDependencyFacts
  ) => NotebookSourceFileAccessContext | undefined
): Promise<{
  facts: NotebookRunDependencyFacts
  fileAccess?: NotebookSourceFileAccessExtraction
}> => {
  const parsed = await withParsedNotebookSource('r', source, (root) => {
    const facts = analyzeRSource(
      root,
      context?.localFileWrappers,
      context?.staticStrings,
      context?.staticCollections,
      context?.rFunctions,
      context?.resolvedKernelNames,
      context?.rAtomicValueNames,
      context?.rCopyOnModifyNames,
      context?.verifiedSerializedValues
    )
    return {
      facts,
      fileAccess: analyzeRFileAccessTree(
        root,
        fileContextForFacts ? fileContextForFacts(facts) : context
      )
    }
  })
  return parsed.state === 'ok'
    ? parsed.value
    : { facts: { state: 'unknown', reasons: [parsed.reason] } }
}

const analyzeRFileAccesses = async (
  sources: readonly string[],
  context?: NotebookSourceFileAccessContext
): Promise<Array<NotebookSourceFileAccessExtraction | undefined>> => {
  const results: Array<NotebookSourceFileAccessExtraction | undefined> = []
  for (const source of sources) {
    const parsed = await withParsedNotebookSource('r', source, (root) =>
      analyzeRFileAccessTree(root, context)
    )
    results.push(parsed.state === 'ok' ? parsed.value : undefined)
  }
  return results
}

export { analyzeRFileAccesses, analyzeRSources, analyzeRNotebookSource }
