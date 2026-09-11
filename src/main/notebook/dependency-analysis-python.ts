import { serializedSourcePath } from './serialized-file-provenance'
import { notebookWriteOption, notebookWriteDisposition } from './notebook-write-semantics'
import {
  PYTHON_LIBRARY_EFFECTS,
  pythonLibraryMethodEffect,
  pythonArgumentShapeReturnType,
  type PythonArgumentShape,
  pythonUnpackedReturnType,
  type PythonLibraryMethodEffect
} from './python-library-effects'
import {
  isPotentialPythonFileWriteCall,
  PYTHON_FILE_CALL_EFFECTS,
  PYTHON_UNSUPPORTED_EXTERNAL_STATE_CALLS,
  PYTHON_FILESYSTEM_OBSERVATIONS,
  PYTHON_UNSUPPORTED_EXTERNAL_STATE_NAMESPACES,
  type NotebookFileCallEffect
} from './notebook-call-effects'
import {
  fieldChild,
  fieldChildren,
  withParsedNotebookSource,
  type Node
} from './dependency-analysis-parser'
import type {
  NotebookSerializedValue,
  NotebookDependencyAlias,
  NotebookDependencyMemberWrite,
  NotebookDependencyReceiverCall,
  NotebookDependencyTypeBinding,
  NotebookDependencyTypeSummary,
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessContext,
  NotebookSourceFileAccessExtraction,
  NotebookFileCallEffectSummary,
  NotebookSourceFileWriteScope
} from './dependency-analysis-types'

const MUTATING_METHODS = new Set([
  '__setitem__',
  '__delitem__',
  '__iadd__',
  '__imul__',
  '__ior__',
  'append',
  'extend',
  'insert',
  'remove',
  'pop',
  'clear',
  'sort',
  'reverse',
  'update',
  'setdefault',
  'add',
  'discard'
])
const DYNAMIC_CALLS = new Set([
  'eval',
  'exec',
  'globals',
  'locals',
  'vars',
  'compile',
  '__import__'
])
const SAFE_CALLS = new Set([
  'abs',
  'all',
  'any',
  'bool',
  'bytes',
  'callable',
  'complex',
  'dict',
  'enumerate',
  'filter',
  'float',
  'frozenset',
  'hash',
  'id',
  'int',
  'len',
  'list',
  'map',
  'max',
  'min',
  'print',
  'range',
  'repr',
  'reversed',
  'round',
  'set',
  'slice',
  'sorted',
  'str',
  'sum',
  'tuple',
  'type',
  'zip'
])
const EXTERNAL_READ_CALLS = new Set(['open'])
// Builtin type objects also occur as values (e.g. numpy dtype=object).
const BUILTIN_TYPE_VALUES = new Set([
  'bool',
  'bytes',
  'complex',
  'dict',
  'float',
  'frozenset',
  'int',
  'list',
  'object',
  'set',
  'str',
  'tuple',
  'type'
])
const SCOPED_MUTATION_CALLS = new Set(['next'])
const SCOPED_OPAQUE_CALLS = new Set(['getattr', 'hasattr', 'isinstance', 'issubclass'])
const SAFE_LITERAL_METHODS = new Set([
  'capitalize',
  'casefold',
  'endswith',
  'format',
  'join',
  'lower',
  'lstrip',
  'replace',
  'rstrip',
  'split',
  'startswith',
  'strip',
  'title',
  'upper'
])
const BUILTIN_CONTAINER_VIEW_METHODS = new Set(['items', 'keys', 'values'])
const SIMPLE_FORMULA_PATTERN = /^[A-Za-z0-9_~+*:/.-]+(?:\s+[A-Za-z0-9_~+*:/.-]+)*$/u

type PyCtx = 'Load' | 'Store' | 'Del'
type ConstKind = 'int' | 'float' | 'bool' | 'str' | 'bytes' | 'none' | 'complex'

type PyArg = { type: 'arg'; arg: string }
type PyKeyword = { type: 'keyword'; arg: string | null; value: PyNode; _fields: string[] }
type PyAlias = { type: 'alias'; name: string; asname: string | null }
type PyComprehension = { target: PyNode; iter: PyNode; ifs: PyNode[]; isAsync?: boolean }
type PyArguments = {
  posonlyargs: PyArg[]
  args: PyArg[]
  vararg: PyArg | null
  kwonlyargs: PyArg[]
  kwarg: PyArg | null
  defaults: PyNode[]
  kw_defaults: Array<PyNode | null>
}

type PyNode = {
  type: string
  lineno?: number
  col_offset?: number
  end_lineno?: number
  _fields: string[]
  id?: string
  attr?: string
  ctx?: PyCtx
  value?: unknown
  constKind?: ConstKind
  targets?: PyNode[]
  target?: PyNode
  op?: string
  operand?: PyNode
  func?: PyNode
  args?: PyNode[] | PyArguments
  keywords?: PyKeyword[]
  names?: PyAlias[] | string[]
  module?: string | null
  name?: string
  body?: PyNode[] | PyNode
  orelse?: PyNode[]
  iter?: PyNode
  test?: PyNode
  elt?: PyNode
  key?: PyNode
  keys?: Array<PyNode | null>
  values?: PyNode[]
  elts?: PyNode[]
  generators?: PyComprehension[]
  decorator_list?: PyNode[]
  bases?: PyNode[]
  classKeywords?: PyKeyword[]
  annotation?: PyNode | null
  slice?: PyNode
  lower?: PyNode
  upper?: PyNode
  step?: PyNode
  children?: PyNode[]
  left?: PyNode
  right?: PyNode
  alternate?: PyNode
  context_expr?: PyNode
  optional_vars?: PyNode
  items?: PyNode[]
  formatSafe?: boolean
  discardedExpression?: boolean
}

const isPyNode = (value: unknown): value is PyNode =>
  Boolean(value && typeof value === 'object' && typeof (value as PyNode).type === 'string')

const py = (
  type: string,
  fields: Omit<PyNode, 'type' | '_fields'>,
  fieldNames: string[]
): PyNode => ({
  type,
  ...fields,
  _fields: fieldNames
})

const locate = (node: Node, result: PyNode): PyNode => {
  result.col_offset = node.startPosition.column
  result.lineno = node.startPosition.row + 1
  result.end_lineno = node.endPosition.row + 1
  return result
}

const pyChildren = (node: PyNode): PyNode[] => {
  const children: PyNode[] = []
  const push = (value: unknown): void => {
    if (isPyNode(value)) children.push(value)
    else if (Array.isArray(value)) value.forEach(push)
    else if (value && typeof value === 'object') {
      const comprehension = value as PyComprehension
      if (comprehension.target && comprehension.iter) {
        children.push(comprehension.target, comprehension.iter, ...comprehension.ifs)
      }
    }
  }
  for (const field of node._fields) push((node as Record<string, unknown>)[field])
  return children
}

const walkPy = (node: PyNode): PyNode[] => [node, ...pyChildren(node).flatMap(walkPy)]

const pythonRedirectsConsole = (node: PyNode): boolean =>
  (node.type === 'Call' &&
    ['redirect_stdout', 'redirect_stderr'].includes(
      pythonDottedName(node.func)?.split('.').at(-1) ?? ''
    )) ||
  (node.type === 'Attribute' && ['stdout', 'stderr'].includes(node.attr ?? '')) ||
  pyChildren(node).some(pythonRedirectsConsole)

// A closed expression of builtin values and known filesystem observations can
// be printed without making that diagnostic part of an artifact's data inputs.
type PythonDiagnosticKind =
  'value' | 'string' | 'path' | 'stat' | 'strings' | 'walk' | 'package' | 'module'

const pythonDiagnosticValue = (
  expression: PyNode,
  imports: ReadonlyMap<string, string>,
  shadowed: ReadonlySet<string>,
  tainted: ReadonlySet<string>,
  knownValue: (name: string) => PythonDiagnosticKind | undefined,
  allowImportProbe = false
):
  | { kind: PythonDiagnosticKind; observed: boolean; names: string[]; safeCalls: string[] }
  | undefined => {
  if (tainted.has('*') || tainted.has('builtins')) return undefined
  const dependencies = new Set<string>()
  const safeCalls = new Set<string>()
  let observed = false
  const inspect = (node: PyNode | undefined): PythonDiagnosticKind | undefined => {
    if (!node) return undefined
    if (node.type === 'Constant') return node.constKind === 'str' ? 'string' : 'value'
    if (node.type === 'Name' && node.id) {
      const kind = knownValue(node.id)
      if (!kind || (kind === 'path' && tainted.has('pathlib'))) return undefined
      dependencies.add(node.id)
      return kind
    }
    if (
      allowImportProbe &&
      node.type === 'Attribute' &&
      node.attr === '__version__' &&
      inspect(node.value as PyNode) === 'module'
    )
      return 'string'
    if (node.type === 'JoinedStr' || node.type === 'FormattedValue') {
      return pyChildren(node).every((child) => inspect(child)) ? 'string' : undefined
    }
    if (['Compare', 'BoolOp', 'UnaryOp'].includes(node.type))
      return pyChildren(node).every((child) => inspect(child)) ? 'value' : undefined
    if (node.type === 'BinOp') {
      if (node.children?.length)
        return node.children.every((child) => inspect(child)) ? 'value' : undefined
      const left = inspect(node.left)
      const right = inspect(node.right)
      if (['Eq', 'NotEq', 'Lt', 'LtE', 'Gt', 'GtE'].includes(node.op ?? '') && left && right)
        return 'value'
      if (node.op === 'Add' && left === 'string' && right === 'string') return 'string'
      if (node.op === 'Div' && left === 'path' && right === 'string') return 'path'
      return undefined
    }
    if (
      node.type === 'Attribute' &&
      node.attr?.startsWith('st_') &&
      inspect(node.value as PyNode) === 'stat'
    )
      return 'value'
    if (node.type !== 'Call' || !isPyNode(node.func)) return undefined
    const args = Array.isArray(node.args) ? node.args : []
    if ((node.keywords ?? []).some((keyword) => !keyword.arg)) return undefined
    if (
      !args.every((arg) => inspect(arg)) ||
      !(node.keywords ?? []).every((keyword) => inspect(keyword.value))
    )
      return undefined
    const raw = pythonDottedName(node.func)
    const [root, ...members] = raw?.split('.') ?? []
    const imported = root ? imports.get(root) : undefined
    const canonical = imported ? [imported, ...members].join('.') : undefined
    // A literal standard-library lookup used only for console diagnostics does not
    // read file contents. Keep the importer as a dependency so rebinding it is detected.
    if (!canonical && !imports.has('__import__') && !shadowed.has('__import__')) {
      const attributes: string[] = []
      let receiver = node.func
      while (receiver.type === 'Attribute' && isPyNode(receiver.value)) {
        attributes.unshift(receiver.attr ?? '')
        receiver = receiver.value
      }
      const importArgs = Array.isArray(receiver.args) ? receiver.args : []
      if (
        receiver.type === 'Call' &&
        receiver.func?.type === 'Name' &&
        receiver.func.id === '__import__' &&
        importArgs.length === 1 &&
        importArgs[0].type === 'Constant' &&
        importArgs[0].value === 'os' &&
        !receiver.keywords?.length &&
        !tainted.has('os')
      ) {
        const candidate = ['os', ...attributes].join('.')
        if (PYTHON_FILESYSTEM_OBSERVATIONS.has(candidate)) {
          dependencies.add('__import__')
          safeCalls.add('__import__')
          observed = true
          return ['os.stat', 'os.lstat'].includes(candidate) ? 'stat' : 'value'
        }
      }
    }
    if (
      allowImportProbe &&
      ((canonical === 'importlib.import_module' && !tainted.has('importlib')) ||
        (raw === '__import__' && !imports.has('__import__') && !shadowed.has('__import__'))) &&
      args.length === 1 &&
      !node.keywords?.length &&
      inspect(args[0]) === 'package'
    ) {
      dependencies.add(root!)
      if (raw === '__import__') safeCalls.add('__import__')
      observed = true
      return 'module'
    }
    if (
      allowImportProbe &&
      root === 'getattr' &&
      !shadowed.has(root) &&
      !imports.has(root) &&
      args.length >= 2 &&
      args.length <= 3 &&
      !node.keywords?.length &&
      inspect(args[0]) === 'module' &&
      args[1]?.type === 'Constant' &&
      args[1].value === '__version__'
    ) {
      dependencies.add(root)
      safeCalls.add(root)
      return 'string'
    }
    if (canonical && !tainted.has(canonical.split('.')[0]!)) {
      if (canonical === 'os.listdir' || canonical === 'os.walk') {
        if ((node.keywords ?? []).some((keyword) => keyword.arg === 'onerror')) return undefined
        dependencies.add(root!)
        observed = true
        return canonical === 'os.walk' ? 'walk' : 'strings'
      }
      if (['pathlib.Path', 'pathlib.PosixPath', 'pathlib.WindowsPath'].includes(canonical)) {
        dependencies.add(root!)
        return 'path'
      }
      if (PYTHON_FILESYSTEM_OBSERVATIONS.has(canonical)) {
        observed = true
        dependencies.add(root!)
        return ['os.stat', 'os.lstat'].includes(canonical) ? 'stat' : 'value'
      }
      if (
        ['os.path.join', 'os.path.basename', 'os.path.dirname', 'os.fspath'].includes(canonical)
      ) {
        dependencies.add(root!)
        return 'string'
      }
    }
    if (
      node.func.type === 'Name' &&
      ['print', 'str', 'repr', 'format'].includes(root ?? '') &&
      !imports.has(root!) &&
      !shadowed.has(root!)
    ) {
      if (root === 'print') {
        const output = (node.keywords ?? []).find((keyword) => keyword.arg === 'file')?.value
        if (output && !(output.type === 'Constant' && output.value === null)) return undefined
      }
      dependencies.add(root!)
      safeCalls.add(root!)
      return root === 'print' ? 'value' : 'string'
    }
    if (
      node.func.type === 'Attribute' &&
      inspect(node.func.value as PyNode) === 'string' &&
      [
        'lower',
        'upper',
        'casefold',
        'strip',
        'lstrip',
        'rstrip',
        'replace',
        'startswith',
        'endswith'
      ].includes(node.func.attr ?? '')
    )
      return ['startswith', 'endswith'].includes(node.func.attr ?? '') ? 'value' : 'string'
    if (node.func.type === 'Attribute' && inspect(node.func.value as PyNode) === 'path') {
      const member = node.func.attr ?? ''
      if (
        [
          'resolve',
          'absolute',
          'stat',
          'lstat',
          'exists',
          'is_file',
          'is_dir',
          'is_symlink'
        ].includes(member)
      ) {
        observed = true
        return ['resolve', 'absolute'].includes(member)
          ? 'path'
          : ['stat', 'lstat'].includes(member)
            ? 'stat'
            : 'value'
      }
      if (['joinpath', 'with_name', 'with_suffix'].includes(member)) return 'path'
      if (member === 'as_posix') return 'string'
    }
    return undefined
  }
  const kind = inspect(expression)
  return kind ? { kind, observed, names: [...dependencies], safeCalls: [...safeCalls] } : undefined
}

const pythonConsoleDiagnostic = (
  ...args: Parameters<typeof pythonDiagnosticValue>
): ReturnType<typeof pythonDiagnosticValue> => {
  if (!args[0].discardedExpression) return undefined
  const value = pythonDiagnosticValue(...args)
  return value?.observed ? value : undefined
}

// Recognize closed, console-only directory inspection without treating filenames
// printed during exploration as data inputs. Any computation or mutation falls back.
const pythonConsoleControlDiagnostic = (
  node: PyNode,
  imports: ReadonlyMap<string, string>,
  shadowed: ReadonlySet<string>,
  tainted: ReadonlySet<string>,
  knownValue: (name: string) => PythonDiagnosticKind | undefined
): { names: string[]; safeCalls: string[]; locals: string[] } | undefined => {
  if (!['For', 'If'].includes(node.type)) return undefined
  const locals = new Set<string>(),
    names = new Set<string>(),
    safeCalls = new Set<string>()
  let budget = 300,
    observed = false
  const expression = (
    value: PyNode | undefined,
    scope: Map<string, PythonDiagnosticKind>
  ): ReturnType<typeof pythonDiagnosticValue> => {
    if (!value || --budget < 0) return undefined
    const result = pythonDiagnosticValue(
      value,
      imports,
      shadowed,
      tainted,
      (name) => scope.get(name) ?? knownValue(name),
      true
    )
    if (result) {
      observed ||= result.observed
      for (const name of result.names) if (!scope.has(name)) names.add(name)
      for (const name of result.safeCalls) safeCalls.add(name)
    }
    return result
  }
  const inspect = (item: PyNode, scope: Map<string, PythonDiagnosticKind>): boolean => {
    if (--budget < 0) return false
    if (item.type === 'For') {
      const packages =
        ['List', 'Tuple'].includes(item.iter?.type ?? '') &&
        Boolean(item.iter?.elts?.length) &&
        item.iter!.elts!.length <= 64 &&
        item.iter!.elts!.every(
          (value) =>
            value.type === 'Constant' &&
            value.constKind === 'str' &&
            /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(String(value.value))
        )
      const iterable = packages ? undefined : expression(item.iter, scope)
      const targets = loopTargetNames(item.target)
      const kinds: PythonDiagnosticKind[] = packages
        ? ['package']
        : iterable?.kind === 'walk'
          ? ['string', 'strings', 'strings']
          : iterable?.kind === 'strings'
            ? ['string']
            : []
      if (!kinds.length || targets.length !== kinds.length || !simpleLoopTarget(item.target))
        return false
      const nested = new Map(scope)
      for (const [index, name] of targets.entries()) {
        if (imports.has(name)) return false
        locals.add(name)
        nested.set(name, kinds[index]!)
      }
      return (
        (Array.isArray(item.body) ? item.body : []).every((child) => inspect(child, nested)) &&
        (item.orelse ?? []).every((child) => inspect(child, scope))
      )
    }
    if (item.type === 'Assign' && item.targets?.length === 1 && item.targets[0].type === 'Name') {
      const name = item.targets[0].id!
      if (imports.has(name) || expression(item.value as PyNode, scope)?.kind !== 'module')
        return false
      scope.set(name, 'module')
      locals.add(name)
      return true
    }
    if (item.type === 'Try') {
      const children = item.children ?? []
      if (
        children.length !== 2 ||
        children[0]?.type !== 'Module' ||
        children[1]?.type !== 'ExceptHandler' ||
        children[1].test?.type !== 'Name' ||
        children[1].test.id !== 'ImportError' ||
        imports.has('ImportError') ||
        shadowed.has('ImportError')
      )
        return false
      names.add('ImportError')
      safeCalls.add('ImportError')
      return children.every((clause) => {
        const nested = new Map(scope)
        return (Array.isArray(clause.body) ? clause.body : []).every((statement) =>
          inspect(statement, nested)
        )
      })
    }
    if (item.type === 'If') {
      if (!expression(item.test, scope)) return false
      return [...(Array.isArray(item.body) ? item.body : []), ...(item.orelse ?? [])].every(
        (child) => inspect(child, new Map(scope))
      )
    }
    if (item.type !== 'Call') return false
    const result = expression(item, scope)
    return Boolean(
      result &&
      ((item.func?.type === 'Name' && item.func.id === 'print') ||
        (item.discardedExpression && result.kind === 'module'))
    )
  }
  return inspect(node, new Map()) && observed
    ? { names: [...names], safeCalls: [...safeCalls], locals: [...locals] }
    : undefined
}

const summarizeInlineCallback = (
  node: PyNode | undefined,
  containers: ReadonlySet<string> = new Set(),
  scalarParameters: ReadonlySet<string> = new Set(),
  readOnlyProperty: (node: PyNode) => boolean = () => false
): NotebookDependencyTypeSummary['methods'][number] | undefined => {
  if (node?.type !== 'Lambda' || !isPyNode(node.body)) return undefined
  const args = node.args as PyArguments | undefined
  if (!args || args.defaults.length || args.kw_defaults.some(Boolean)) return undefined
  const unsafeNodes = new Set([
    'Attribute',
    'Await',
    'DictComp',
    'FunctionDef',
    'GeneratorExp',
    'Generic',
    'Lambda',
    'ListComp',
    'NamedExpr',
    'SetComp',
    'Yield',
    'YieldFrom'
  ])
  if (walkPy(node.body).some((child) => unsafeNodes.has(child.type))) {
    const parameters = new Set(
      [...args.posonlyargs, ...args.args, ...args.kwonlyargs].map((arg) => arg.arg)
    )
    if (args.vararg || args.kwarg) return undefined
    const nodes = walkPy(node.body)
    const localNames = new Set([
      ...parameters,
      ...nodes.flatMap((child) =>
        (child.generators ?? []).flatMap((generator) => loopTargetNames(generator.target))
      )
    ])
    const allowed = new Set(['Attribute', 'ListComp', 'SetComp', 'DictComp'])
    if (
      nodes.length > 300 ||
      nodes.some((child) => unsafeNodes.has(child.type) && !allowed.has(child.type))
    )
      return undefined
    for (const child of nodes) {
      if (
        child.type === 'Attribute' &&
        !(readOnlyProperty(child) && !localNames.has(rootName(child) ?? '')) &&
        !(
          child.value &&
          isPyNode(child.value) &&
          child.value.type === 'Name' &&
          ((containers.has(child.value.id ?? '') &&
            !localNames.has(child.value.id ?? '') &&
            ['index', 'count'].includes(child.attr ?? '')) ||
            (parameters.has(child.value.id ?? '') &&
              scalarParameters.has(child.value.id ?? '') &&
              [
                'replace',
                'lstrip',
                'rstrip',
                'strip',
                'lower',
                'upper',
                'startswith',
                'endswith'
              ].includes(child.attr ?? '')))
        )
      )
        return undefined
      if (
        child.type === 'Call' &&
        !(
          child.func?.type === 'Attribute' ||
          (child.func?.type === 'Name' &&
            SAFE_CALLS.has(child.func.id ?? '') &&
            !localNames.has(child.func.id ?? ''))
        )
      )
        return undefined
      for (const generator of child.generators ?? []) {
        if (
          generator.isAsync ||
          generator.iter?.type !== 'Name' ||
          !(parameters.has(generator.iter.id ?? '') || containers.has(generator.iter.id ?? ''))
        )
          return undefined
      }
    }
    const loads = new NamespaceLoadLineVisitor()
    loads.visit(node)
    return {
      name: '__call__',
      effect: 'read',
      usedNames: [...loads.loaded.keys()].sort(),
      safeCallNames: [
        ...new Set(
          nodes
            .filter((child) => child.type === 'Call' && child.func?.type === 'Name')
            .map((child) => child.func!.id!)
        )
      ].sort()
    }
  }
  // Reuse the function effect summary: parameters stay local, while closure
  // reads and builtin calls become dependencies of the invocation.
  return summarizeLambda(node, '<inline-callback>')?.methods[0]
}

const pythonArgumentShape = (node: PyNode): PythonArgumentShape => {
  if (node.type === 'List') return 'list'
  if (node.type !== 'Constant') return 'unknown'
  if (node.value === null) return 'none'
  return ['str', 'int'].includes(node.constKind ?? '') ? 'scalar' : 'unknown'
}

const staticBoolean = (node: PyNode | null | undefined): boolean | undefined =>
  node?.type === 'Constant' && node.constKind === 'bool' ? Boolean(node.value) : undefined

const decodePythonStringBody = (text: string): string =>
  text
    .replaceAll(String.raw`\\`, '\u0000')
    .replaceAll(String.raw`\n`, '\n')
    .replaceAll(String.raw`\t`, '\t')
    .replaceAll(String.raw`\'`, "'")
    .replaceAll(String.raw`\"`, '"')
    .replaceAll('\u0000', '\\')

const decodePythonString = (text: string): { value: string; kind: ConstKind } | undefined => {
  let rest = text
  let kind: ConstKind = 'str'
  while (rest && /^[rRuUbBfF]/u.test(rest[0] ?? '')) {
    if (rest[0]?.toLowerCase() === 'b') kind = 'bytes'
    if (rest[0]?.toLowerCase() === 'f') return undefined
    rest = rest.slice(1)
  }
  const quote =
    rest.startsWith('"""') || rest.startsWith("'''")
      ? rest.slice(0, 3)
      : rest.startsWith("'") || rest.startsWith('"')
        ? rest.slice(0, 1)
        : undefined
  if (!quote || !rest.endsWith(quote)) return undefined
  const inner = rest.slice(quote.length, rest.length - quote.length)
  return {
    kind,
    value: decodePythonStringBody(inner)
  }
}

const parsePythonInteger = (text: string): number | undefined => {
  const cleaned = text.replaceAll('_', '')
  if (/^0[xX]/u.test(cleaned)) return Number.parseInt(cleaned, 16)
  if (/^0[oO]/u.test(cleaned)) return Number.parseInt(cleaned.slice(2), 8)
  if (/^0[bB]/u.test(cleaned)) return Number.parseInt(cleaned.slice(2), 2)
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}

const convertPattern = (node: Node, ctx: PyCtx): PyNode => {
  if (node.type === 'identifier') return locate(node, py('Name', { id: node.text, ctx }, []))
  if (node.type === 'pattern_list' || node.type === 'tuple_pattern' || node.type === 'tuple') {
    return locate(
      node,
      py(
        'Tuple',
        { elts: pythonSyntaxChildren(node).map((child) => convertPattern(child, ctx)), ctx },
        ['elts']
      )
    )
  }
  if (node.type === 'list_pattern' || node.type === 'list') {
    return locate(
      node,
      py(
        'List',
        { elts: pythonSyntaxChildren(node).map((child) => convertPattern(child, ctx)), ctx },
        ['elts']
      )
    )
  }
  return convertExpr(node, ctx)
}

const convertParameters = (node: Node | null): PyArguments => {
  const posonlyargs: PyArg[] = []
  const args: PyArg[] = []
  const kwonlyargs: PyArg[] = []
  const defaults: PyNode[] = []
  const kw_defaults: Array<PyNode | null> = []
  let vararg: PyArg | null = null
  let kwarg: PyArg | null = null
  let seenStar = false
  let currentArgs = args
  if (!node) {
    return { posonlyargs, args, vararg, kwonlyargs, kwarg, defaults, kw_defaults }
  }
  for (const child of pythonSyntaxChildren(node)) {
    if (child.type === 'positional_separator') {
      posonlyargs.push(...args.splice(0, args.length))
      continue
    }
    if (child.type === 'keyword_separator') {
      seenStar = true
      currentArgs = kwonlyargs
      continue
    }
    if (child.type === 'list_splat' || child.type === 'list_splat_pattern') {
      const name = child.namedChildren[0]?.text
      if (name) vararg = { type: 'arg', arg: name }
      seenStar = true
      currentArgs = kwonlyargs
      continue
    }
    if (child.type === 'dictionary_splat' || child.type === 'dictionary_splat_pattern') {
      const name = child.namedChildren[0]?.text
      if (name) kwarg = { type: 'arg', arg: name }
      continue
    }
    const nameNode = child.type === 'identifier' ? child : fieldChild(child, 'name')
    const argName = nameNode?.type === 'identifier' ? nameNode.text : nameNode?.text
    if (!argName) continue
    const arg = { type: 'arg' as const, arg: argName }
    const defaultValue = fieldChild(child, 'value')
    if (seenStar) {
      kwonlyargs.push(arg)
      kw_defaults.push(defaultValue ? convertExpr(defaultValue, 'Load') : null)
    } else {
      currentArgs.push(arg)
      if (defaultValue) defaults.push(convertExpr(defaultValue, 'Load'))
    }
  }
  return { posonlyargs, args, vararg, kwonlyargs, kwarg, defaults, kw_defaults }
}

// Tree-sitter exposes comments as named nodes; Python AST does not treat them as values.
const pythonSyntaxChildren = (node: Node): Node[] =>
  node.namedChildren.filter((child) => child.type !== 'comment')

const convertCallArgs = (node: Node | null): { args: PyNode[]; keywords: PyKeyword[] } => {
  const args: PyNode[] = []
  const keywords: PyKeyword[] = []
  if (!node) return { args, keywords }
  if (node.type === 'generator_expression') {
    args.push(convertExpr(node, 'Load'))
    return { args, keywords }
  }
  for (const child of pythonSyntaxChildren(node)) {
    if (child.type === 'keyword_argument') {
      const name = fieldChild(child, 'name')?.text ?? null
      const value = fieldChild(child, 'value')
      if (value) {
        keywords.push({
          type: 'keyword',
          arg: name,
          value: convertExpr(value, 'Load'),
          _fields: ['value']
        })
      }
      continue
    }
    if (child.type === 'dictionary_splat') {
      const value = child.namedChildren[0]
      if (value) {
        keywords.push({
          type: 'keyword',
          arg: null,
          value: convertExpr(value, 'Load'),
          _fields: ['value']
        })
      }
      continue
    }
    if (child.type === 'list_splat') {
      const value = child.namedChildren[0]
      if (value) args.push(convertExpr(value, 'Load'))
      continue
    }
    args.push(convertExpr(child, 'Load'))
  }
  return { args, keywords }
}

const convertComprehensions = (node: Node): PyComprehension[] => {
  const generators: PyComprehension[] = []
  for (const child of pythonSyntaxChildren(node)) {
    if (child.type === 'for_in_clause') {
      const left = fieldChild(child, 'left')
      const rights = fieldChildren(child, 'right')
      generators.push({
        target: left ? convertPattern(left, 'Store') : py('Name', { id: '', ctx: 'Store' }, []),
        iter: rights[0]
          ? convertExpr(rights[0], 'Load')
          : py('Constant', { value: null, constKind: 'none' }, []),
        ifs: [],
        isAsync: child.children.some((token) => token.type === 'async')
      })
      continue
    }
    if (child.type === 'if_clause' && generators.length) {
      generators[generators.length - 1]!.ifs.push(
        convertExpr(child.namedChildren[0] ?? child, 'Load')
      )
    }
  }
  return generators
}

const convertBlock = (node: Node | null): PyNode[] =>
  node
    ? pythonSyntaxChildren(node)
        .map((child) => convertStmt(child))
        .filter((child): child is PyNode => Boolean(child))
    : []

const convertIf = (node: Node): PyNode => {
  const test = fieldChild(node, 'condition')
  const body = convertBlock(fieldChild(node, 'consequence'))
  const alternatives = fieldChildren(node, 'alternative')
  let orelse: PyNode[] = []
  for (let index = alternatives.length - 1; index >= 0; index -= 1) {
    const alternative = alternatives[index]
    if (!alternative) continue
    if (alternative.type === 'else_clause') {
      orelse = convertBlock(fieldChild(alternative, 'body'))
      continue
    }
    orelse = [
      locate(
        alternative,
        py(
          'If',
          {
            test: fieldChild(alternative, 'condition')
              ? convertExpr(fieldChild(alternative, 'condition')!, 'Load')
              : py('Constant', { value: false, constKind: 'bool' }, []),
            body: convertBlock(fieldChild(alternative, 'consequence')),
            orelse
          },
          ['test', 'body', 'orelse']
        )
      )
    ]
  }
  return locate(
    node,
    py(
      'If',
      {
        test: test
          ? convertExpr(test, 'Load')
          : py('Constant', { value: false, constKind: 'bool' }, []),
        body,
        orelse
      },
      ['test', 'body', 'orelse']
    )
  )
}

const convertAssignment = (node: Node): PyNode => {
  const annotation = fieldChild(node, 'type')
  const targets: PyNode[] = []
  let current: Node | null = node
  let value: PyNode | undefined
  while (current?.type === 'assignment') {
    const left = fieldChild(current, 'left')
    if (left) targets.push(convertPattern(left, 'Store'))
    const right = fieldChild(current, 'right')
    if (right?.type === 'assignment' && !fieldChild(right, 'type')) {
      current = right
      continue
    }
    value = right ? convertExpr(right, 'Load') : undefined
    break
  }
  if (annotation) {
    return locate(
      node,
      py(
        'AnnAssign',
        {
          target: targets[0],
          annotation: convertExpr(annotation, 'Load'),
          value: value ?? null
        },
        ['value', 'annotation', 'target']
      )
    )
  }
  return locate(node, py('Assign', { targets, value }, ['value', 'targets']))
}

const arithmeticOperators: Record<string, string> = {
  '+': 'Add',
  '-': 'Sub',
  '*': 'Mult',
  '/': 'Div',
  '//': 'FloorDiv',
  '%': 'Mod',
  '**': 'Pow',
  '&': 'BitAnd',
  '|': 'BitOr',
  '^': 'BitXor'
}

const convertExpr = (node: Node, ctx: PyCtx = 'Load'): PyNode => {
  switch (node.type) {
    case 'identifier':
      return locate(node, py('Name', { id: node.text, ctx }, []))
    case 'true':
      return locate(node, py('Constant', { value: true, constKind: 'bool' }, []))
    case 'false':
      return locate(node, py('Constant', { value: false, constKind: 'bool' }, []))
    case 'none':
      return locate(node, py('Constant', { value: null, constKind: 'none' }, []))
    case 'integer': {
      const value = parsePythonInteger(node.text)
      return locate(node, py('Constant', { value: value ?? node.text, constKind: 'int' }, []))
    }
    case 'float':
      return locate(node, py('Constant', { value: Number(node.text), constKind: 'float' }, []))
    case 'string': {
      if (pythonSyntaxChildren(node).some((child) => child.type === 'interpolation')) {
        return locate(
          node,
          py(
            'JoinedStr',
            {
              formatSafe: node.children.every((child) => {
                if (child.type === 'string_content') return !child.text.includes('\\')
                if (child.type === 'interpolation') return /^\{[A-Za-z_]\w*\}$/u.test(child.text)
                return true
              }),
              children: node.children.flatMap((child) => {
                if (child.type === 'string_content') {
                  return [
                    py(
                      'Constant',
                      { value: decodePythonStringBody(child.text), constKind: 'str' },
                      []
                    )
                  ]
                }
                if (child.type !== 'interpolation') return []
                const expression = fieldChild(child, 'expression')
                if (!expression) return []
                return [
                  py(
                    'FormattedValue',
                    {
                      value: convertExpr(expression, 'Load'),
                      formatSafe: /^\{[A-Za-z_]\w*\}$/u.test(child.text)
                    },
                    ['value']
                  )
                ]
              })
            },
            ['children']
          )
        )
      }
      const decoded = decodePythonString(node.text)
      return locate(
        node,
        py(
          'Constant',
          { value: decoded?.value ?? node.text, constKind: decoded?.kind ?? 'str' },
          []
        )
      )
    }
    case 'concatenated_string':
      return locate(
        node,
        py(
          'JoinedStr',
          { children: pythonSyntaxChildren(node).map((child) => convertExpr(child, ctx)) },
          ['children']
        )
      )
    case 'attribute':
      return locate(
        node,
        py(
          'Attribute',
          {
            value: fieldChild(node, 'object')
              ? convertExpr(
                  fieldChild(node, 'object')!,
                  ctx === 'Store' || ctx === 'Del' ? 'Load' : ctx
                )
              : py('Name', { id: '', ctx: 'Load' }, []),
            attr: fieldChild(node, 'attribute')?.text ?? '',
            ctx
          },
          ['value']
        )
      )
    case 'subscript': {
      // Tree-sitter repeats the subscript field for each axis. Python's AST keeps
      // comma-separated indices in a tuple, including a trailing singleton comma.
      const indices = fieldChildren(node, 'subscript').map((index) => convertExpr(index, 'Load'))
      const slice = node.children.some((child) => child.type === ',')
        ? py('Tuple', { elts: indices, ctx: 'Load' }, ['elts'])
        : (indices[0] ?? py('Constant', { value: null, constKind: 'none' }, []))
      return locate(
        node,
        py(
          'Subscript',
          {
            value: fieldChild(node, 'value')
              ? convertExpr(
                  fieldChild(node, 'value')!,
                  ctx === 'Store' || ctx === 'Del' ? 'Load' : ctx
                )
              : py('Name', { id: '', ctx: 'Load' }, []),
            slice,
            ctx
          },
          ['value', 'slice']
        )
      )
    }
    case 'slice': {
      // Keep omitted bounds distinct: [::-1] and [:-1] have different meanings.
      const bounds: Array<PyNode | undefined> = []
      let index = 0
      for (const child of node.children) {
        if (child.type === ':') index += 1
        else if (child.isNamed) bounds[index] = convertExpr(child, 'Load')
      }
      return locate(
        node,
        py('Slice', { lower: bounds[0], upper: bounds[1], step: bounds[2] }, [
          'lower',
          'upper',
          'step'
        ])
      )
    }
    case 'call': {
      const func = fieldChild(node, 'function')
      const { args, keywords } = convertCallArgs(fieldChild(node, 'arguments'))
      return locate(
        node,
        py(
          'Call',
          {
            func: func ? convertExpr(func, 'Load') : py('Name', { id: '', ctx: 'Load' }, []),
            args,
            keywords
          },
          ['func', 'args', 'keywords']
        )
      )
    }
    case 'list':
      return locate(
        node,
        py(
          'List',
          { elts: pythonSyntaxChildren(node).map((child) => convertExpr(child, ctx)), ctx },
          ['elts']
        )
      )
    case 'list_splat':
      return locate(
        node,
        py('Starred', { value: convertExpr(pythonSyntaxChildren(node)[0], ctx), ctx }, ['value'])
      )
    case 'expression_list':
    case 'tuple':
      return locate(
        node,
        py(
          'Tuple',
          { elts: pythonSyntaxChildren(node).map((child) => convertExpr(child, ctx)), ctx },
          ['elts']
        )
      )
    case 'set':
      return locate(
        node,
        py('Set', { elts: pythonSyntaxChildren(node).map((child) => convertExpr(child, 'Load')) }, [
          'elts'
        ])
      )
    case 'dictionary':
      return locate(
        node,
        py(
          'Dict',
          {
            keys: pythonSyntaxChildren(node).map((child) =>
              child.type === 'pair' ? convertExpr(fieldChild(child, 'key') ?? child, 'Load') : null
            ),
            values: pythonSyntaxChildren(node).map((child) =>
              child.type === 'pair'
                ? convertExpr(fieldChild(child, 'value') ?? child, 'Load')
                : convertExpr(child.namedChildren[0] ?? child, 'Load')
            )
          },
          ['keys', 'values']
        )
      )
    case 'parenthesized_expression':
      return convertExpr(pythonSyntaxChildren(node)[0] ?? node, ctx)
    case 'conditional_expression': {
      const [body, test, orelse] = pythonSyntaxChildren(node)
      return locate(
        node,
        py(
          'IfExp',
          {
            body: body
              ? convertExpr(body, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, []),
            test: test
              ? convertExpr(test, 'Load')
              : py('Constant', { value: false, constKind: 'bool' }, []),
            alternate: orelse
              ? convertExpr(orelse, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, [])
          },
          ['body', 'test', 'alternate']
        )
      )
    }
    case 'named_expression':
      return locate(
        node,
        py(
          'NamedExpr',
          {
            target: fieldChild(node, 'name')
              ? convertPattern(fieldChild(node, 'name')!, 'Store')
              : py('Name', { id: '', ctx: 'Store' }, []),
            value: fieldChild(node, 'value')
              ? convertExpr(fieldChild(node, 'value')!, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, [])
          },
          ['value', 'target']
        )
      )
    case 'unary_operator': {
      const operator = fieldChild(node, 'operator')?.text ?? node.child(0)?.text ?? ''
      const argument = fieldChild(node, 'argument')
      return locate(
        node,
        py(
          'UnaryOp',
          {
            op:
              operator === '+'
                ? 'UAdd'
                : operator === '-'
                  ? 'USub'
                  : operator === '~'
                    ? 'Invert'
                    : operator,
            operand: argument
              ? convertExpr(argument, 'Load')
              : py('Constant', { value: 0, constKind: 'int' }, [])
          },
          ['operand']
        )
      )
    }
    case 'not_operator':
      return locate(
        node,
        py(
          'UnaryOp',
          {
            op: 'Not',
            operand: fieldChild(node, 'argument')
              ? convertExpr(fieldChild(node, 'argument')!, 'Load')
              : py('Constant', { value: false, constKind: 'bool' }, [])
          },
          ['operand']
        )
      )
    case 'boolean_operator':
      return locate(
        node,
        py(
          'BoolOp',
          {
            values: [
              fieldChild(node, 'left') ? convertExpr(fieldChild(node, 'left')!, 'Load') : undefined,
              fieldChild(node, 'right')
                ? convertExpr(fieldChild(node, 'right')!, 'Load')
                : undefined
            ].filter((value): value is PyNode => Boolean(value))
          },
          ['values']
        )
      )
    case 'comparison_operator': {
      const operands = pythonSyntaxChildren(node).map((child) => convertExpr(child, 'Load'))
      const comparison = (
        { '==': 'Eq', '!=': 'NotEq', '<': 'Lt', '<=': 'LtE', '>': 'Gt', '>=': 'GtE' } as Record<
          string,
          string
        >
      )[node.child(1)?.text ?? '']
      // Preserve all reads for chained comparisons, but only a single comparison
      // produces a reusable vector mask (Python chains use scalar truth testing).
      return locate(
        node,
        py(
          'BinOp',
          operands.length === 2 && comparison
            ? {
                op: comparison,
                left: operands[0],
                right: operands[1]
              }
            : { op: '', children: operands },
          operands.length === 2 && comparison ? ['left', 'right'] : ['children']
        )
      )
    }
    case 'binary_operator':
      return locate(
        node,
        py(
          'BinOp',
          {
            op: arithmeticOperators[node.child(1)?.text ?? ''] ?? '',
            left: fieldChild(node, 'left')
              ? convertExpr(fieldChild(node, 'left')!, 'Load')
              : undefined,
            right: fieldChild(node, 'right')
              ? convertExpr(fieldChild(node, 'right')!, 'Load')
              : undefined,
            children: []
          },
          ['left', 'right', 'children']
        )
      )
    case 'lambda':
      return locate(
        node,
        py(
          'Lambda',
          {
            args: convertParameters(fieldChild(node, 'parameters')),
            body: fieldChild(node, 'body')
              ? convertExpr(fieldChild(node, 'body')!, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, [])
          },
          ['args', 'body']
        )
      )
    case 'list_comprehension':
    case 'set_comprehension':
    case 'generator_expression':
      return locate(
        node,
        py(
          node.type === 'list_comprehension'
            ? 'ListComp'
            : node.type === 'set_comprehension'
              ? 'SetComp'
              : 'GeneratorExp',
          {
            elt: fieldChild(node, 'body')
              ? convertExpr(fieldChild(node, 'body')!, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, []),
            generators: convertComprehensions(node)
          },
          ['elt', 'generators']
        )
      )
    case 'dictionary_comprehension':
      return locate(
        node,
        py(
          'DictComp',
          {
            key: fieldChild(node, 'body')
              ? convertExpr(fieldChild(node, 'body')!, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, []),
            value: py('Constant', { value: null, constKind: 'none' }, []),
            generators: convertComprehensions(node),
            children: pythonSyntaxChildren(node).map((child) => convertExpr(child, 'Load'))
          },
          ['key', 'value', 'generators', 'children']
        )
      )
    case 'assignment':
      return convertAssignment(node)
    case 'augmented_assignment':
      return locate(
        node,
        py(
          'AugAssign',
          {
            target: fieldChild(node, 'left')
              ? convertPattern(fieldChild(node, 'left')!, 'Store')
              : py('Name', { id: '', ctx: 'Store' }, []),
            value: fieldChild(node, 'right')
              ? convertExpr(fieldChild(node, 'right')!, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, [])
          },
          ['target', 'value']
        )
      )
    default:
      return locate(
        node,
        py(
          'Generic',
          { children: pythonSyntaxChildren(node).map((child) => convertExpr(child, ctx)) },
          ['children']
        )
      )
  }
}

const convertFunction = (node: Node, asyncFn = false): PyNode => {
  const decorators =
    node.parent?.type === 'decorated_definition'
      ? node.parent.namedChildren
          .filter((child) => child.type === 'decorator')
          .map((child) => convertExpr(child, 'Load'))
      : []
  return locate(
    node,
    py(
      asyncFn ? 'AsyncFunctionDef' : 'FunctionDef',
      {
        name: fieldChild(node, 'name')?.text ?? '',
        args: convertParameters(fieldChild(node, 'parameters')),
        body: convertBlock(fieldChild(node, 'body')),
        decorator_list: decorators
      },
      ['decorator_list', 'args', 'body']
    )
  )
}

const convertClass = (node: Node): PyNode => {
  const superclasses = fieldChild(node, 'superclasses')
  const { args, keywords } = convertCallArgs(superclasses)
  const decorators =
    node.parent?.type === 'decorated_definition'
      ? node.parent.namedChildren
          .filter((child) => child.type === 'decorator')
          .map((child) => convertExpr(child, 'Load'))
      : []
  return locate(
    node,
    py(
      'ClassDef',
      {
        name: fieldChild(node, 'name')?.text ?? '',
        bases: args,
        classKeywords: keywords,
        body: convertBlock(fieldChild(node, 'body')),
        decorator_list: decorators
      },
      ['decorator_list', 'bases', 'classKeywords', 'body']
    )
  )
}

const convertStmt = (node: Node): PyNode | undefined => {
  switch (node.type) {
    case 'comment':
      return undefined
    case 'expression_statement': {
      const expression = pythonSyntaxChildren(node)[0]
        ? convertExpr(pythonSyntaxChildren(node)[0], 'Load')
        : undefined
      if (expression) expression.discardedExpression = true
      return expression
    }
    case 'assignment':
    case 'augmented_assignment':
      return convertExpr(node, 'Load')
    case 'function_definition':
      return convertFunction(node)
    case 'class_definition':
      return convertClass(node)
    case 'decorated_definition': {
      const definition = fieldChild(node, 'definition')
      return definition ? convertStmt(definition) : undefined
    }
    case 'if_statement':
      return convertIf(node)
    case 'for_statement':
      return locate(
        node,
        py(
          'For',
          {
            target: fieldChild(node, 'left')
              ? convertPattern(fieldChild(node, 'left')!, 'Store')
              : py('Name', { id: '', ctx: 'Store' }, []),
            iter: fieldChild(node, 'right')
              ? convertExpr(fieldChild(node, 'right')!, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, []),
            body: convertBlock(fieldChild(node, 'body')),
            orelse: convertBlock(fieldChild(fieldChild(node, 'alternative'), 'body'))
          },
          ['iter', 'target', 'body', 'orelse']
        )
      )
    case 'while_statement':
      return locate(
        node,
        py(
          'While',
          {
            test: fieldChild(node, 'condition')
              ? convertExpr(fieldChild(node, 'condition')!, 'Load')
              : py('Constant', { value: false, constKind: 'bool' }, []),
            body: convertBlock(fieldChild(node, 'body')),
            orelse: convertBlock(fieldChild(fieldChild(node, 'alternative'), 'body'))
          },
          ['test', 'body', 'orelse']
        )
      )
    case 'with_statement':
    case 'async_with_statement': {
      const items: PyNode[] = []
      const collectWithItems = (current: Node): void => {
        if (current.type === 'with_item') {
          const value = fieldChild(current, 'value') ?? current.namedChildren[0]
          if (value?.type === 'as_pattern') {
            const alias = fieldChild(value, 'alias')
            const expression = value.namedChildren.find(
              (child) => child.type !== 'as_pattern_target'
            )
            const target = alias?.namedChildren[0] ?? alias
            items.push(
              py(
                'withitem',
                {
                  context_expr: expression
                    ? convertExpr(expression, 'Load')
                    : py('Constant', { value: null, constKind: 'none' }, []),
                  optional_vars: target ? convertPattern(target, 'Store') : undefined
                },
                ['context_expr', 'optional_vars']
              )
            )
            return
          }
          if (value) {
            items.push(
              py('withitem', { context_expr: convertExpr(value, 'Load') }, ['context_expr'])
            )
          }
          return
        }
        for (const child of current.namedChildren) collectWithItems(child)
      }
      collectWithItems(node)
      return locate(
        node,
        py('With', { items, body: convertBlock(fieldChild(node, 'body')) }, ['items', 'body'])
      )
    }
    case 'block':
      return locate(node, py('Module', { body: convertBlock(node) }, ['body']))
    case 'except_clause':
      return locate(
        node,
        py(
          'ExceptHandler',
          {
            test: fieldChild(node, 'value')
              ? convertExpr(fieldChild(node, 'value')!, 'Load')
              : undefined,
            body: convertBlock(
              fieldChild(node, 'body') ??
                node.namedChildren.find((child) => child.type === 'block') ??
                null
            )
          },
          ['test', 'body']
        )
      )
    case 'try_statement':
    case 'match_statement':
    case 'async_for_statement':
      return locate(
        node,
        py(
          node.type === 'async_for_statement'
            ? 'AsyncFor'
            : node.type === 'match_statement'
              ? 'Match'
              : 'Try',
          {
            children: pythonSyntaxChildren(node).map(
              (child) => convertStmt(child) ?? convertExpr(child, 'Load')
            )
          },
          ['children']
        )
      )
    case 'delete_statement':
      return locate(
        node,
        py(
          'Delete',
          { targets: pythonSyntaxChildren(node).map((child) => convertPattern(child, 'Del')) },
          ['targets']
        )
      )
    case 'import_statement':
      return locate(
        node,
        py(
          'Import',
          {
            names: fieldChildren(node, 'name').map((alias) =>
              alias.type === 'aliased_import'
                ? {
                    type: 'alias' as const,
                    name: fieldChild(alias, 'name')?.text ?? '',
                    asname: fieldChild(alias, 'alias')?.text ?? null
                  }
                : { type: 'alias' as const, name: alias.text, asname: null }
            )
          },
          []
        )
      )
    case 'import_from_statement':
      return locate(
        node,
        py(
          'ImportFrom',
          {
            module: fieldChild(node, 'module_name')?.text ?? null,
            names: pythonSyntaxChildren(node).some((child) => child.type === 'wildcard_import')
              ? [{ type: 'alias' as const, name: '*', asname: null }]
              : fieldChildren(node, 'name').map((alias) =>
                  alias.type === 'aliased_import'
                    ? {
                        type: 'alias' as const,
                        name: fieldChild(alias, 'name')?.text ?? '',
                        asname: fieldChild(alias, 'alias')?.text ?? null
                      }
                    : { type: 'alias' as const, name: alias.text, asname: null }
                )
          },
          []
        )
      )
    case 'global_statement':
      return locate(
        node,
        py('Global', { names: pythonSyntaxChildren(node).map((child) => child.text) }, [])
      )
    case 'nonlocal_statement':
      return locate(
        node,
        py('Nonlocal', { names: pythonSyntaxChildren(node).map((child) => child.text) }, [])
      )
    case 'return_statement':
      return locate(
        node,
        py(
          'Return',
          {
            value: pythonSyntaxChildren(node)[0]
              ? convertExpr(pythonSyntaxChildren(node)[0], 'Load')
              : null
          },
          ['value']
        )
      )
    case 'pass_statement':
    case 'break_statement':
    case 'continue_statement':
      return locate(
        node,
        py(
          node.type === 'pass_statement'
            ? 'Pass'
            : node.type === 'break_statement'
              ? 'Break'
              : 'Continue',
          {},
          []
        )
      )
    default:
      return convertExpr(node, 'Load')
  }
}

const convertModule = (root: Node): PyNode =>
  locate(root, py('Module', { body: convertBlock(root) }, ['body']))

class NodeVisitor {
  visit(node: PyNode | null | undefined): void {
    if (!node) return
    const method = (this as Record<string, unknown>)[`visit_${node.type}`]
    if (typeof method === 'function') (method as (node: PyNode) => void).call(this, node)
    else this.genericVisit(node)
  }

  genericVisit(node: PyNode): void {
    for (const child of pyChildren(node)) this.visit(child)
  }
}

const simpleFormulaNames = (node: PyNode | null | undefined): Set<string> | undefined => {
  if (
    !node ||
    node.type !== 'Constant' ||
    node.constKind !== 'str' ||
    typeof node.value !== 'string'
  ) {
    return undefined
  }
  const formula = node.value.trim()
  if ((formula.match(/~/gu) ?? []).length !== 1 || !SIMPLE_FORMULA_PATTERN.test(formula))
    return undefined
  return new Set(formula.match(/[A-Za-z_]\w*/gu) ?? [])
}

const rootName = (node: PyNode | null | undefined): string | undefined => {
  let current = node
  while (current && (current.type === 'Attribute' || current.type === 'Subscript')) {
    current = current.value as PyNode | undefined
  }
  return current?.type === 'Name' ? current.id : undefined
}

const memberName = (node: PyNode | null | undefined): string | undefined => {
  if (!node) return undefined
  if (node.type === 'Attribute') return node.attr
  if (
    node.type === 'Subscript' &&
    isPyNode(node.slice) &&
    node.slice.type === 'Constant' &&
    (node.slice.constKind === 'str' || node.slice.constKind === 'int')
  ) {
    return String(node.slice.value)
  }
  return undefined
}

const dynamicMemberWrite = (node: PyNode): [string | undefined, boolean] | undefined => {
  if (node.type === 'Attribute') {
    const typeWide =
      isPyNode(node.value) && node.value.type === 'Attribute' && node.value.attr === '__class__'
    return [memberName(node), typeWide]
  }
  if (
    node.type === 'Subscript' &&
    isPyNode(node.value) &&
    node.value.type === 'Attribute' &&
    node.value.attr === '__dict__'
  ) {
    return [memberName(node), false]
  }
  return undefined
}

const pythonFieldRelationship = (
  node: PyNode | null | undefined
): 'value' | 'reference' | 'unknown' => {
  if (!node) return 'unknown'
  if (node.type === 'Constant') return 'value'
  if (node.type === 'Call' && isPyNode(node.func) && node.func.type === 'Name') {
    if (
      ['bool', 'bytes', 'complex', 'float', 'frozenset', 'int', 'str'].includes(node.func.id ?? '')
    )
      return 'value'
    if (['dict', 'list', 'set'].includes(node.func.id ?? '')) return 'reference'
  }
  if (['Dict', 'List', 'Set', 'ListComp', 'SetComp', 'DictComp'].includes(node.type))
    return 'reference'
  return 'unknown'
}

const staticInteger = (node: PyNode | null | undefined): number | undefined => {
  if (!node) return undefined
  if (node.type === 'Constant' && node.constKind === 'int' && typeof node.value === 'number')
    return node.value
  if (node.type === 'UnaryOp' && (node.op === 'UAdd' || node.op === 'USub')) {
    const value = staticInteger(node.operand)
    if (value === undefined) return undefined
    return node.op === 'UAdd' ? value : -value
  }
  return undefined
}

const staticScalar = (node: PyNode | null | undefined): boolean => {
  if (!node) return false
  if (node.type === 'Constant' && node.constKind) return true
  return staticInteger(node) !== undefined
}

const immutableLiteral = (node: PyNode | null | undefined): boolean =>
  staticScalar(node) || (node?.type === 'Tuple' && (node.elts ?? []).every(immutableLiteral))

const staticNonemptyIterable = (
  node: PyNode | null | undefined,
  contextualNames: ReadonlySet<string> = new Set()
): boolean => {
  if (!node) return false
  if (node.type === 'Name' && node.id) return contextualNames.has(node.id)
  if (node.type === 'List' || node.type === 'Tuple' || node.type === 'Set') {
    return Boolean(node.elts?.length) && (node.elts ?? []).every(staticScalar)
  }
  if (
    node.type === 'Call' &&
    isPyNode(node.func) &&
    node.func.type === 'Attribute' &&
    isPyNode(node.func.value) &&
    node.func.value.type === 'Name' &&
    node.func.value.id &&
    contextualNames.has(node.func.value.id) &&
    ['items', 'keys', 'values'].includes(node.func.attr ?? '') &&
    !(Array.isArray(node.args) && node.args.length) &&
    !(node.keywords ?? []).length
  ) {
    return true
  }
  if (
    node.type !== 'Call' ||
    !isPyNode(node.func) ||
    node.func.type !== 'Name' ||
    (node.keywords ?? []).length
  ) {
    return false
  }
  const args = Array.isArray(node.args) ? node.args : []
  if (node.func.id === 'range' && args.length >= 1 && args.length <= 3) {
    const values = args.map(staticInteger)
    if (values.some((value) => value === undefined)) return false
    try {
      const [start, stop, step] =
        values.length === 1
          ? [0, values[0]!, 1]
          : values.length === 2
            ? [values[0]!, values[1]!, 1]
            : values
      if (!step) return false
      return Math.ceil(((stop ?? 0) - (start ?? 0)) / step) > 0
    } catch {
      return false
    }
  }
  if ((node.func.id === 'enumerate' || node.func.id === 'reversed') && args.length === 1) {
    return staticNonemptyIterable(args[0], contextualNames)
  }
  if (node.func.id === 'zip' && args.length)
    return args.every((argument) => staticNonemptyIterable(argument, contextualNames))
  return false
}

const simpleLoopTarget = (node: PyNode | null | undefined): boolean => {
  if (!node) return false
  if (node.type === 'Name') return true
  if ((node.type === 'Tuple' || node.type === 'List') && node.elts?.length) {
    return node.elts.every(simpleLoopTarget)
  }
  return false
}

const loopTargetNames = (node: PyNode | null | undefined): string[] => {
  if (!node) return []
  if (node.type === 'Tuple' || node.type === 'List') {
    return (node.elts ?? []).flatMap(loopTargetNames)
  }
  return node.type === 'Name' && node.id ? [node.id] : []
}

class EffectOnlyLoopBody extends NodeVisitor {
  safe = true
  reject(): void {
    this.safe = false
  }
  visit_Assign = this.reject
  visit_AnnAssign = this.reject
  visit_AugAssign = this.reject
  visit_NamedExpr = this.reject
  visit_Delete = this.reject
  visit_Import = this.reject
  visit_ImportFrom = this.reject
  visit_FunctionDef = this.reject
  visit_AsyncFunctionDef = this.reject
  visit_ClassDef = this.reject
  visit_Lambda = this.reject
  visit_If = this.reject
  visit_IfExp = this.reject
  visit_BoolOp = this.reject
  visit_For = this.reject
  visit_AsyncFor = this.reject
  visit_While = this.reject
  visit_Try = this.reject
  visit_Match = this.reject
  visit_With = this.reject
  visit_AsyncWith = this.reject
  visit_ListComp = this.reject
  visit_SetComp = this.reject
  visit_DictComp = this.reject
  visit_GeneratorExp = this.reject
  visit_Break = this.reject
  visit_Continue = this.reject
  visit_Return = this.reject
  visit_Raise = this.reject
  visit_Yield = this.reject
  visit_YieldFrom = this.reject
}

class DeterministicLoopBody extends EffectOnlyLoopBody {
  visit_Assign = (node?: PyNode): void => {
    if (node) this.genericVisit(node)
  }
  visit_AnnAssign = this.visit_Assign
  visit_AugAssign = this.visit_Assign
  visit_If = this.visit_Assign
  visit_For = this.visit_Assign
  // Lambda invocation and captures are checked separately by Analyzer.
  visit_Lambda = this.visit_Assign
}

// Early exits do not make loop-local values escape. Scope and definite-assignment
// checks below still reject values consumed after the loop or before initialization.
class IsolatedLoopBody extends DeterministicLoopBody {
  visit_FunctionDef = (node?: PyNode): void => {
    if (!node) return
    if (node.decorator_list?.length) {
      this.reject()
      return
    }
    const args = node.args as PyArguments
    for (const value of [...args.defaults, ...args.kw_defaults.filter(isPyNode)]) this.visit(value)
  }
  visit_Call(node: PyNode): void {
    const args = Array.isArray(node.args) ? node.args : []
    // These builtins consume the generator in this invocation. Deferred
    // generators still fail the structural check; shadowing is checked by Analyzer.
    if (
      ((node.func?.type === 'Name' &&
        ['sum', 'min', 'max', 'list', 'tuple', 'set', 'sorted', 'next'].includes(
          node.func.id ?? ''
        )) ||
        (node.func?.type === 'Attribute' &&
          node.func.attr === 'join' &&
          isPyNode(node.func.value) &&
          node.func.value.type === 'Constant' &&
          node.func.value.constKind === 'str')) &&
      args.length === 1 &&
      args[0]?.type === 'GeneratorExp' &&
      !node.keywords?.length
    ) {
      this.genericVisit(args[0])
      return
    }
    this.genericVisit(node)
  }
  visit_NamedExpr = this.visit_Assign
  visit_Continue = (): void => {}
  visit_Break = (): void => {}
  // Invocation effects are checked by the main analyzer. A lambda inside an
  // eager, verified callback does not itself make loop temporaries escape.
  visit_Lambda = this.visit_Assign
  visit_IfExp = this.visit_Assign
  visit_BoolOp = this.visit_Assign
  visit_ListComp = this.visit_Assign
  visit_SetComp = this.visit_Assign
  visit_DictComp = this.visit_Assign
}

class LocalAggregationLoopBody extends EffectOnlyLoopBody {
  readonly mutatedNames = new Set<string>()

  visit_Expr = this.reject

  private collectTargets(nodes: Array<PyNode | undefined>): void {
    for (const target of nodes) {
      const name = rootName(target)
      if (!name) {
        this.reject()
        return
      }
      this.mutatedNames.add(name)
    }
  }

  visit_Assign = (node?: PyNode): void => {
    this.collectTargets(node?.targets ?? [])
  }

  visit_AnnAssign = (node?: PyNode): void => {
    this.collectTargets([node?.target])
  }

  visit_AugAssign = (node?: PyNode): void => {
    this.collectTargets([node?.target])
  }

  visit_If = (node?: PyNode): void => {
    if (!node) return
    if (node.test) this.visit(node.test)
    const body = Array.isArray(node.body) ? node.body : []
    const alternative = Array.isArray(node.orelse) ? node.orelse : []
    for (const statement of [...body, ...alternative]) {
      this.visit(statement)
      if (!this.safe) return
    }
  }
}

const effectOnlyLoopBody = (statements: PyNode[]): boolean => {
  const visitor = new EffectOnlyLoopBody()
  for (const statement of statements) {
    visitor.visit(statement)
    if (!visitor.safe) return false
  }
  return true
}

// Straight-line loop effects can use intermediate values without making every
// call conditional. The assignments still may not occur (an iterable can be
// empty), and their names must not escape the loop in the current source.
const loopBodyWithTemporaryValues = (statements: PyNode[]): boolean =>
  statements.every((statement) => {
    if (!['Assign', 'AnnAssign'].includes(statement.type)) return effectOnlyLoopBody([statement])
    const targets = statement.type === 'AnnAssign' ? [statement.target] : (statement.targets ?? [])
    return (
      targets.every(simpleLoopTarget) &&
      isPyNode(statement.value) &&
      effectOnlyLoopBody([statement.value, ...(statement.annotation ? [statement.annotation] : [])])
    )
  })

const deterministicLoopBody = (statements: PyNode[], calculatedReturnName?: string): boolean => {
  const visitor = new DeterministicLoopBody()
  if (calculatedReturnName)
    visitor.visit_Return = (node?: PyNode): void => {
      if (
        !isPyNode(node?.value) ||
        node.value.type !== 'Name' ||
        node.value.id !== calculatedReturnName
      )
        visitor.reject()
    }
  for (const statement of statements) {
    visitor.visit(statement)
    if (!visitor.safe) return false
  }
  return true
}

const localAggregationLoopMutationNames = (statements: PyNode[]): Set<string> | undefined => {
  const visitor = new LocalAggregationLoopBody()
  for (const statement of statements) {
    visitor.visit(statement)
    if (!visitor.safe) return undefined
  }
  return visitor.mutatedNames.size ? visitor.mutatedNames : undefined
}

const knownNonemptyIterableShape = (node: PyNode | null | undefined): boolean => {
  if (!node) return false
  if (node.type === 'List' || node.type === 'Tuple') return Boolean(node.elts?.length)
  if (node.type === 'Dict') return Boolean(node.keys?.length)
  if (node.type !== 'Call' || !isPyNode(node.func) || node.func.type !== 'Name') return false
  const args = Array.isArray(node.args) ? node.args : []
  if (node.func.id === 'zip' && args.length && !(node.keywords ?? []).length) {
    return args.every(knownNonemptyIterableShape)
  }
  if (node.func.id === 'enumerate' && args.length >= 1 && args.length <= 2) {
    return knownNonemptyIterableShape(args[0])
  }
  if (['list', 'reversed', 'sorted', 'tuple'].includes(node.func.id ?? '') && args.length === 1) {
    return knownNonemptyIterableShape(args[0])
  }
  return false
}

class NamespaceLoadLineVisitor extends NodeVisitor {
  readonly loaded = new Map<string, number[]>()
  private readonly localScopes: Array<Set<string>> = []

  visit_Name(node: PyNode): void {
    if (node.ctx !== 'Load' || !node.id || this.localScopes.some((scope) => scope.has(node.id!))) {
      return
    }
    const lines = this.loaded.get(node.id) ?? []
    lines.push(node.lineno ?? 0)
    this.loaded.set(node.id, lines)
  }

  visit_FunctionDef(node: PyNode): void {
    const fnArgs = node.args as PyArguments | undefined
    for (const value of [
      ...(node.decorator_list ?? []),
      ...(fnArgs?.defaults ?? []),
      ...(fnArgs?.kw_defaults ?? []).filter((item): item is PyNode => Boolean(item))
    ]) {
      this.visit(value)
    }
    const names = new MethodNameVisitor()
    for (const argument of [
      ...(fnArgs?.posonlyargs ?? []),
      ...(fnArgs?.args ?? []),
      ...(fnArgs?.kwonlyargs ?? [])
    ]) {
      names.locals.add(argument.arg)
    }
    if (fnArgs?.vararg) names.locals.add(fnArgs.vararg.arg)
    if (fnArgs?.kwarg) names.locals.add(fnArgs.kwarg.arg)
    const body = Array.isArray(node.body) ? node.body : []
    for (const statement of body) names.visit(statement)
    this.localScopes.push(new Set([...names.locals].filter((name) => !names.globals.has(name))))
    for (const statement of body) this.visit(statement)
    this.localScopes.pop()
  }
  visit_AsyncFunctionDef = this.visit_FunctionDef

  visit_Lambda(node: PyNode): void {
    const fnArgs = node.args as PyArguments | undefined
    for (const value of [
      ...(fnArgs?.defaults ?? []),
      ...(fnArgs?.kw_defaults ?? []).filter((item): item is PyNode => Boolean(item))
    ]) {
      this.visit(value)
    }
    const names = new MethodNameVisitor()
    for (const argument of [
      ...(fnArgs?.posonlyargs ?? []),
      ...(fnArgs?.args ?? []),
      ...(fnArgs?.kwonlyargs ?? [])
    ]) {
      names.locals.add(argument.arg)
    }
    if (fnArgs?.vararg) names.locals.add(fnArgs.vararg.arg)
    if (fnArgs?.kwarg) names.locals.add(fnArgs.kwarg.arg)
    if (isPyNode(node.body)) names.visit(node.body)
    this.localScopes.push(new Set([...names.locals].filter((name) => !names.globals.has(name))))
    if (isPyNode(node.body)) this.visit(node.body)
    this.localScopes.pop()
  }

  visit_Assign(node: PyNode): void {
    if (isPyNode(node.value)) this.visit(node.value)
    for (const target of node.targets ?? []) {
      if (simpleLoopTarget(target) && this.branchDepth === 0) {
        for (const name of loopTargetNames(target)) this.localScopes.at(-1)?.add(name)
      } else this.visit(target)
    }
  }

  private branchDepth = 0
  visit_If(node: PyNode): void {
    if (node.test) this.visit(node.test)
    const assignedByBranch: Set<string>[] = []
    for (const branch of [Array.isArray(node.body) ? node.body : [], node.orelse ?? []]) {
      this.localScopes.push(new Set())
      for (const statement of branch) this.visit(statement)
      assignedByBranch.push(this.localScopes.pop()!)
    }
    // Both branches replace this value before subsequent reads in the same
    // loop/function. Those reads do not consume an earlier loop's temporary.
    for (const name of assignedByBranch[0]!)
      if (assignedByBranch[1]!.has(name)) this.localScopes.at(-1)?.add(name)
  }
  visit_Try(node: PyNode): void {
    this.branchDepth += 1
    this.genericVisit(node)
    this.branchDepth -= 1
  }
  visit_While = this.visit_Try

  visit_For(node: PyNode): void {
    if (node.iter) this.visit(node.iter)
    this.localScopes.push(new Set(loopTargetNames(node.target)))
    for (const statement of Array.isArray(node.body) ? node.body : []) this.visit(statement)
    this.localScopes.pop()
    for (const statement of node.orelse ?? []) this.visit(statement)
  }
  visit_AsyncFor = this.visit_For

  private visitComprehension(node: PyNode, values: Array<PyNode | undefined>): void {
    const scope = new Set<string>()
    this.localScopes.push(scope)
    for (const generator of node.generators ?? []) {
      this.visit(generator.iter)
      for (const name of loopTargetNames(generator.target)) scope.add(name)
      for (const condition of generator.ifs) this.visit(condition)
    }
    for (const value of values) this.visit(value)
    this.localScopes.pop()
  }

  visit_ListComp(node: PyNode): void {
    this.visitComprehension(node, [node.elt])
  }
  visit_SetComp(node: PyNode): void {
    this.visitComprehension(node, [node.elt])
  }
  visit_DictComp(node: PyNode): void {
    this.visitComprehension(node, [node.key, isPyNode(node.value) ? node.value : undefined])
  }
  visit_GeneratorExp(node: PyNode): void {
    this.visitComprehension(node, [node.elt])
  }
}

const namespaceLoadLines = (tree: PyNode): Map<string, number[]> => {
  const visitor = new NamespaceLoadLineVisitor()
  visitor.visit(tree)
  return visitor.loaded
}

const scopedEffectLoops = (tree: PyNode): Set<PyNode> => {
  const loadedAfter = namespaceLoadLines(tree)
  const result = new Set<PyNode>()
  for (const candidate of walkPy(tree)) {
    if (candidate.type !== 'For') continue
    const body = Array.isArray(candidate.body) ? candidate.body : []
    const localAggregationNames = localAggregationLoopMutationNames(body)
    if (
      !simpleLoopTarget(candidate.target) ||
      (!effectOnlyLoopBody(body) &&
        !(knownNonemptyIterableShape(candidate.iter) && deterministicLoopBody(body)) &&
        !localAggregationNames)
    ) {
      continue
    }
    const targetNames = loopTargetNames(candidate.target)
    const bodyLoads = new Set(
      body
        .flatMap(walkPy)
        .filter((child) => child.type === 'Name' && child.ctx === 'Load' && child.id)
        .map((child) => child.id as string)
    )
    if (!localAggregationNames && !targetNames.some((name) => bodyLoads.has(name))) continue
    const endLine = candidate.end_lineno ?? candidate.lineno ?? 0
    if (
      targetNames.every((name) => !(loadedAfter.get(name) ?? []).some((line) => line > endLine))
    ) {
      result.add(candidate)
    }
  }
  return result
}

const isolatedConditionalLoopNames = (tree: PyNode): Map<PyNode, Set<string>> => {
  const loadedAfter = namespaceLoadLines(tree)
  const result = new Map<PyNode, Set<string>>()
  for (const candidate of walkPy(tree)) {
    if (
      candidate.type !== 'For' ||
      (candidate.orelse?.length && walkPy(candidate).some((node) => node.type === 'Break')) ||
      !simpleLoopTarget(candidate.target) ||
      knownNonemptyIterableShape(candidate.iter)
    ) {
      continue
    }
    const body = Array.isArray(candidate.body) ? candidate.body : []
    const visitor = new IsolatedLoopBody()
    for (const statement of body) visitor.visit(statement)
    if (!visitor.safe) continue
    // Function bodies execute in a separate namespace. Their local stores must
    // not become loop temporaries (or collide with a callback's parameter names).
    const loopNodes = (node: PyNode): PyNode[] => [
      node,
      ...(node.type === 'FunctionDef' ? [] : pyChildren(node).flatMap(loopNodes))
    ]
    const assignedNames = new Set([
      ...loopTargetNames(candidate.target),
      ...body
        .flatMap(loopNodes)
        .filter((child) => child.type === 'Name' && child.ctx === 'Store' && child.id)
        .map((child) => child.id as string),
      ...body
        .flatMap(loopNodes)
        .filter((child) => child.type === 'FunctionDef' && child.name)
        .map((child) => child.name!)
    ])
    const endLine = candidate.end_lineno ?? candidate.lineno ?? 0
    if (
      assignedNames.size > 0 &&
      [...assignedNames].every(
        (name) => !(loadedAfter.get(name) ?? []).some((line) => line > endLine)
      )
    ) {
      result.set(candidate, assignedNames)
    }
  }
  return result
}

// Loop-local names must be assigned on every path reaching a read. Otherwise a
// successful run may have borrowed a value left in the kernel by an earlier cell.
const loopReadsUninitializedTemporary = (
  body: PyNode[],
  candidates: Set<string>,
  initialized: Set<string>
): boolean => {
  let unsafe = false
  const visit = (node: PyNode, assigned: Set<string>): void => {
    if (node.type === 'FunctionDef') {
      const args = node.args as PyArguments
      for (const value of [
        ...(node.decorator_list ?? []),
        ...args.defaults,
        ...args.kw_defaults.filter(isPyNode)
      ])
        visit(value, assigned)
      if (node.name) assigned.add(node.name)
      return
    }
    if (node.type === 'Name') {
      if (node.ctx === 'Load' && candidates.has(node.id ?? '') && !assigned.has(node.id!))
        unsafe = true
      return
    }
    if (['Assign', 'AnnAssign', 'NamedExpr'].includes(node.type)) {
      if (isPyNode(node.value)) visit(node.value, assigned)
      for (const target of node.type === 'Assign'
        ? (node.targets ?? [])
        : node.target
          ? [node.target]
          : []) {
        if (simpleLoopTarget(target)) for (const name of loopTargetNames(target)) assigned.add(name)
        else visit(target, assigned)
      }
      return
    }
    if (node.type === 'If') {
      if (node.test) visit(node.test, assigned)
      const yes = new Set(assigned),
        no = new Set(assigned)
      for (const statement of Array.isArray(node.body) ? node.body : []) visit(statement, yes)
      for (const statement of node.orelse ?? []) visit(statement, no)
      for (const name of yes) if (no.has(name)) assigned.add(name)
      return
    }
    if (node.type === 'For') {
      if (node.iter) visit(node.iter, assigned)
      const iteration = new Set([...assigned, ...loopTargetNames(node.target)])
      for (const statement of Array.isArray(node.body) ? node.body : []) visit(statement, iteration)
      for (const statement of node.orelse ?? []) visit(statement, assigned)
      return
    }
    if (['ListComp', 'SetComp', 'DictComp', 'GeneratorExp'].includes(node.type)) {
      const scope = new Set(assigned)
      for (const generator of node.generators ?? []) {
        visit(generator.iter, scope)
        for (const name of loopTargetNames(generator.target)) scope.add(name)
        for (const condition of generator.ifs) visit(condition, scope)
      }
      for (const value of [node.elt, node.key, isPyNode(node.value) ? node.value : undefined]) {
        if (value) visit(value, scope)
      }
      return
    }
    for (const child of pyChildren(node)) visit(child, assigned)
  }
  const assigned = new Set(initialized)
  for (const statement of body) visit(statement, assigned)
  return unsafe
}

class MethodEffectVisitor extends NodeVisitor {
  effect: 'read' | 'mutate' | 'unknown' = 'read'
  controlDepth = 0
  namespaceUnknown = false

  constructor(private readonly receiver: string) {
    super()
  }

  mutate(): void {
    if (this.controlDepth > 0) this.unknown()
    else if (this.effect !== 'unknown') this.effect = 'mutate'
  }

  unknown(namespace = false): void {
    this.effect = 'unknown'
    if (namespace) this.namespaceUnknown = true
  }

  visit_FunctionDef(): void {
    this.unknown()
  }
  visit_AsyncFunctionDef = this.visit_FunctionDef
  visit_Lambda(): void {
    this.unknown()
  }
  visit_Global(): void {
    this.unknown(true)
  }
  visit_Nonlocal(): void {
    this.unknown(true)
  }
  visit_ListComp(): void {
    this.unknown()
  }
  visit_SetComp = this.visit_ListComp
  visit_DictComp = this.visit_ListComp
  visit_GeneratorExp = this.visit_ListComp

  visit_control(node: PyNode): void {
    this.controlDepth += 1
    this.genericVisit(node)
    this.controlDepth -= 1
  }
  visit_If = this.visit_control
  visit_For = this.visit_control
  visit_AsyncFor = this.visit_control
  visit_While = this.visit_control
  visit_Try = this.visit_control
  visit_Match = this.visit_control

  visit_Assign(node: PyNode): void {
    if ((node.targets ?? []).some((target) => rootName(target) === this.receiver)) this.mutate()
    else if (
      (node.targets ?? []).some(
        (target) => target.type === 'Attribute' || target.type === 'Subscript'
      )
    ) {
      this.unknown(true)
    }
    this.genericVisit(node)
  }

  visit_AnnAssign(node: PyNode): void {
    if (rootName(node.target) === this.receiver) this.mutate()
    else if (node.target?.type === 'Attribute' || node.target?.type === 'Subscript')
      this.unknown(true)
    this.genericVisit(node)
  }

  visit_AugAssign(node: PyNode): void {
    if (rootName(node.target) === this.receiver) this.mutate()
    else if (node.target?.type === 'Attribute' || node.target?.type === 'Subscript')
      this.unknown(true)
    this.genericVisit(node)
  }

  visit_Delete(node: PyNode): void {
    if ((node.targets ?? []).some((target) => rootName(target) === this.receiver)) this.mutate()
    else if (
      (node.targets ?? []).some(
        (target) => target.type === 'Attribute' || target.type === 'Subscript'
      )
    ) {
      this.unknown(true)
    }
    this.genericVisit(node)
  }

  visit_Call(node: PyNode): void {
    if (isPyNode(node.func) && node.func.type === 'Name' && SAFE_CALLS.has(node.func.id ?? '')) {
      this.genericVisit(node)
      return
    }
    if (
      isPyNode(node.func) &&
      node.func.type === 'Attribute' &&
      rootName(node.func.value as PyNode) === this.receiver
    ) {
      const inplace = (node.keywords ?? []).some(
        (keyword) =>
          keyword.arg === 'inplace' &&
          keyword.value.type === 'Constant' &&
          keyword.value.value === true
      )
      if (MUTATING_METHODS.has(node.func.attr ?? '') || inplace) this.mutate()
      else this.unknown(true)
    } else this.unknown(true)
    this.genericVisit(node)
  }
}

class FunctionEffectVisitor extends NodeVisitor {
  effect: 'read' | 'unknown' = 'read'
  namespaceUnknown = false

  unknown(namespace = false): void {
    this.effect = 'unknown'
    if (namespace) this.namespaceUnknown = true
  }

  visit_FunctionDef(): void {
    this.unknown(true)
  }
  visit_AsyncFunctionDef = this.visit_FunctionDef
  visit_Lambda(): void {
    this.unknown()
  }
  visit_Global(): void {
    this.unknown(true)
  }
  visit_Nonlocal(): void {
    this.unknown(true)
  }
  visit_ListComp(): void {
    this.unknown()
  }
  visit_SetComp = this.visit_ListComp
  visit_DictComp = this.visit_ListComp
  visit_GeneratorExp = this.visit_ListComp

  visit_Return(node: PyNode): void {
    const value = isPyNode(node.value) ? node.value : undefined
    if (value && value.type !== 'JoinedStr' && pythonFieldRelationship(value) !== 'value')
      this.unknown(true)
    this.genericVisit(node)
  }

  visitImplicitEffect(node: PyNode): void {
    this.unknown()
    this.genericVisit(node)
  }
  visit_With = this.visitImplicitEffect
  visit_AsyncWith = this.visitImplicitEffect
  visit_For = this.visitImplicitEffect
  visit_AsyncFor = this.visitImplicitEffect
  visit_Await = this.visitImplicitEffect
  visit_Yield = this.visitImplicitEffect
  visit_YieldFrom = this.visitImplicitEffect

  visitImport(node: PyNode): void {
    this.unknown(true)
    this.genericVisit(node)
  }
  visit_Import = this.visitImport
  visit_ImportFrom = this.visitImport

  visit_Assign(node: PyNode): void {
    if (
      (node.targets ?? []).some(
        (target) => target.type === 'Attribute' || target.type === 'Subscript'
      )
    ) {
      this.unknown()
    }
    this.genericVisit(node)
  }

  visit_AnnAssign(node: PyNode): void {
    if (node.target?.type === 'Attribute' || node.target?.type === 'Subscript') this.unknown()
    this.genericVisit(node)
  }

  visit_AugAssign = this.visit_AnnAssign

  visit_Delete(node: PyNode): void {
    if (
      (node.targets ?? []).some(
        (target) => target.type === 'Attribute' || target.type === 'Subscript'
      )
    ) {
      this.unknown()
    }
    this.genericVisit(node)
  }

  visit_Call(node: PyNode): void {
    if (isPyNode(node.func) && node.func.type === 'Name') {
      if (DYNAMIC_CALLS.has(node.func.id ?? '')) this.unknown(true)
      else if (!SAFE_CALLS.has(node.func.id ?? '')) this.unknown()
    } else this.unknown()
    this.genericVisit(node)
  }
}

class FieldVisitor extends NodeVisitor {
  constructor(
    private readonly receiver: string,
    private readonly record: (target: PyNode, value: PyNode | undefined, receiver: string) => void
  ) {
    super()
  }
  visit_FunctionDef(_node: PyNode): void {
    void _node
  }
  visit_AsyncFunctionDef = this.visit_FunctionDef
  visit_Lambda(_node: PyNode): void {
    void _node
  }
  visit_ListComp(_node: PyNode): void {
    void _node
  }
  visit_SetComp = this.visit_ListComp
  visit_DictComp = this.visit_ListComp
  visit_GeneratorExp = this.visit_ListComp

  visit_Assign(node: PyNode): void {
    for (const target of node.targets ?? [])
      this.record(target, isPyNode(node.value) ? node.value : undefined, this.receiver)
    if (isPyNode(node.value)) this.genericVisit(node.value)
  }

  visit_AnnAssign(node: PyNode): void {
    if (node.target)
      this.record(node.target, isPyNode(node.value) ? node.value : undefined, this.receiver)
    if (isPyNode(node.value)) this.visit(node.value)
  }

  visit_AugAssign(node: PyNode): void {
    if (node.target) this.record(node.target, undefined, this.receiver)
    if (node.operand) this.visit(node.operand)
    if (isPyNode(node.value)) this.visit(node.value)
  }
}

class MethodNameVisitor extends NodeVisitor {
  locals = new Set<string>()
  globals = new Set<string>()
  loaded = new Set<string>()
  safeCalls = new Set<string>()

  visit_FunctionDef(_node: PyNode): void {
    void _node
  }
  visit_AsyncFunctionDef = this.visit_FunctionDef
  visit_Lambda(_node: PyNode): void {
    void _node
  }
  visit_Global(node: PyNode): void {
    for (const name of node.names ?? []) if (typeof name === 'string') this.globals.add(name)
  }
  visit_Nonlocal(node: PyNode): void {
    for (const name of node.names ?? []) if (typeof name === 'string') this.globals.add(name)
  }
  visit_Name(node: PyNode): void {
    if (!node.id) return
    if (node.ctx === 'Load') this.loaded.add(node.id)
    else if (node.ctx === 'Store' || node.ctx === 'Del') this.locals.add(node.id)
  }
  visit_Call(node: PyNode): void {
    if (isPyNode(node.func) && node.func.type === 'Name' && SAFE_CALLS.has(node.func.id ?? '')) {
      this.safeCalls.add(node.func.id ?? '')
    }
    this.genericVisit(node)
  }
}

const summarizeClass = (node: PyNode): NotebookDependencyTypeSummary | undefined => {
  if (
    (node.bases ?? []).length ||
    (node.classKeywords ?? []).length ||
    (node.decorator_list ?? []).length
  ) {
    return undefined
  }
  const methods: NotebookDependencyTypeSummary['methods'] = []
  const fields: Record<string, 'value' | 'reference' | 'unknown'> = {}
  const recordField = (target: PyNode, value: PyNode | undefined, receiver: string): void => {
    if (target.type !== 'Attribute' || rootName(target) !== receiver || !target.attr) return
    const previous = fields[target.attr]
    if (value === undefined && previous !== undefined) return
    const relationship = value ? pythonFieldRelationship(value) : 'unknown'
    fields[target.attr] =
      previous === undefined || previous === relationship ? relationship : 'unknown'
  }
  for (const item of Array.isArray(node.body) ? node.body : []) {
    if (item.type === 'FunctionDef' || item.type === 'AsyncFunctionDef') {
      if ((item.decorator_list ?? []).length) return undefined
      const fnArgs = item.args as PyArguments | undefined
      const positional = [...(fnArgs?.posonlyargs ?? []), ...(fnArgs?.args ?? [])]
      if (!positional.length) return undefined
      const receiver = positional[0]!.arg
      const visitor = new MethodEffectVisitor(receiver)
      const names = new MethodNameVisitor()
      for (const argument of [
        ...(fnArgs?.posonlyargs ?? []),
        ...(fnArgs?.args ?? []),
        ...(fnArgs?.kwonlyargs ?? [])
      ]) {
        names.locals.add(argument.arg)
      }
      if (fnArgs?.vararg) names.locals.add(fnArgs.vararg.arg)
      if (fnArgs?.kwarg) names.locals.add(fnArgs.kwarg.arg)
      const body = Array.isArray(item.body) ? item.body : []
      for (const statement of body) visitor.visit(statement)
      for (const statement of body) names.visit(statement)
      const shadowedSafeCalls = new Set(
        [...names.safeCalls].filter((name) => names.locals.has(name) && !names.globals.has(name))
      )
      if (shadowedSafeCalls.size) visitor.unknown(true)
      const usedNames = [...names.loaded]
        .filter(
          (name) => !(names.locals.has(name) && !names.globals.has(name)) && name !== receiver
        )
        .sort()
      methods.push({
        name: item.name ?? '',
        effect: visitor.effect,
        usedNames,
        safeCallNames: [...names.safeCalls].filter((name) => !shadowedSafeCalls.has(name)).sort(),
        unknownScope: visitor.namespaceUnknown ? 'namespace' : 'receiver'
      })
      const fieldVisitor = new FieldVisitor(receiver, recordField)
      for (const statement of body) fieldVisitor.visit(statement)
    } else if (
      item.type === 'Pass' ||
      (item.type === 'Constant' && item.constKind === 'str') ||
      (item.type === 'Expr' &&
        isPyNode(item.value) &&
        item.value.type === 'Constant' &&
        item.value.constKind === 'str')
    ) {
      continue
    } else return undefined
  }
  return {
    name: node.name ?? '',
    kind: 'python-class',
    fields: Object.keys(fields)
      .sort()
      .map((name) => ({ name, relationship: fields[name]! })),
    methods
  }
}

const summarizeFunction = (node: PyNode): NotebookDependencyTypeSummary | undefined => {
  if ((node.decorator_list ?? []).length || !node.name) return undefined
  const fnArgs = node.args as PyArguments | undefined
  const names = new MethodNameVisitor()
  for (const argument of [
    ...(fnArgs?.posonlyargs ?? []),
    ...(fnArgs?.args ?? []),
    ...(fnArgs?.kwonlyargs ?? [])
  ]) {
    names.locals.add(argument.arg)
  }
  if (fnArgs?.vararg) names.locals.add(fnArgs.vararg.arg)
  if (fnArgs?.kwarg) names.locals.add(fnArgs.kwarg.arg)
  const visitor = new FunctionEffectVisitor()
  const body = Array.isArray(node.body) ? node.body : []
  for (const statement of body) visitor.visit(statement)
  for (const statement of body) names.visit(statement)
  const shadowedSafeCalls = new Set(
    [...names.safeCalls].filter((name) => names.locals.has(name) && !names.globals.has(name))
  )
  if (shadowedSafeCalls.size) visitor.unknown(true)
  return {
    name: `python-function:${node.name}`,
    kind: 'python-class',
    fields: [],
    methods: [
      {
        name: '__call__',
        effect: visitor.effect,
        usedNames: [...names.loaded]
          .filter((name) => !(names.locals.has(name) && !names.globals.has(name)))
          .sort(),
        safeCallNames: [...names.safeCalls].filter((name) => !shadowedSafeCalls.has(name)).sort(),
        unknownScope: visitor.namespaceUnknown ? 'namespace' : 'receiver'
      }
    ]
  }
}

const summarizeLambda = (
  node: PyNode,
  bindingName: string
): NotebookDependencyTypeSummary | undefined => {
  const fnArgs = node.args as PyArguments | undefined
  const names = new MethodNameVisitor()
  for (const argument of [
    ...(fnArgs?.posonlyargs ?? []),
    ...(fnArgs?.args ?? []),
    ...(fnArgs?.kwonlyargs ?? [])
  ]) {
    names.locals.add(argument.arg)
  }
  if (fnArgs?.vararg) names.locals.add(fnArgs.vararg.arg)
  if (fnArgs?.kwarg) names.locals.add(fnArgs.kwarg.arg)
  const body = isPyNode(node.body) ? node.body : undefined
  if (!body) return undefined
  const visitor = new FunctionEffectVisitor()
  visitor.visit(body)
  names.visit(body)
  const shadowedSafeCalls = new Set(
    [...names.safeCalls].filter((name) => names.locals.has(name) && !names.globals.has(name))
  )
  if (shadowedSafeCalls.size) visitor.unknown(true)
  if (visitor.effect === 'unknown') return undefined
  return {
    name: `python-function:${bindingName}`,
    kind: 'python-class',
    fields: [],
    methods: [
      {
        name: '__call__',
        effect: 'read',
        usedNames: [...names.loaded]
          .filter((name) => !(names.locals.has(name) && !names.globals.has(name)))
          .sort(),
        safeCallNames: [...names.safeCalls].filter((name) => !shadowedSafeCalls.has(name)).sort(),
        unknownScope: 'receiver'
      }
    ]
  }
}

const serializationSite = (node: PyNode): string => `${node.lineno}:${node.col_offset}`
const PYTHON_SERIALIZED_TYPES = new Set(['pandas.DataFrame', 'pandas.Series', 'numpy.ndarray'])

class Analyzer extends NodeVisitor {
  serializedValueWrites = new Map<string, NotebookSerializedValue>()
  serializedValueReads = new Set<string>()
  serializedValues = new Map<string, NotebookSerializedValue>()
  serializedPathBindings = new Map<string, string>()
  serializedConnections = new Map<string, string>()
  acceptedSerializedReads = new Map<string, string>()

  serializationPath(node: PyNode | undefined): string | undefined {
    const raw =
      pythonStaticString(node, this.serializedPathBindings, {
        collections: new Map(),
        importedNames: this.importedCanonicalNames,
        shadowedNames: this.defined
      }) ?? (node?.type === 'Name' ? this.serializedConnections.get(node.id ?? '') : undefined)
    return raw === undefined ? undefined : serializedSourcePath(raw)
  }

  serializationCallName(node: PyNode): string | undefined {
    if (this.taintedNamespaces.has('*')) return undefined
    const receiver = rootName(node.func)
    if (this.memberWrites.some((write) => write.receiver === receiver)) return undefined
    if (node.func?.type === 'Attribute' && isPyNode(node.func.value)) {
      const owner = this.libraryTypeName(node.func.value)
      return owner && !this.taintedNamespaces.has(owner.split('.')[0]!)
        ? `${owner}.${node.func.attr}`
        : undefined
    }
    if (node.func?.type === 'Name' && this.importedFunctions.has(node.func.id ?? ''))
      return this.importedCanonicalNames.get(node.func.id ?? '')
    return undefined
  }

  serializedReadType(node: PyNode): string | undefined {
    if (this.checkingFunction || this.functionDepth > 0 || this.controlDepth > 0) return undefined
    const accepted = this.acceptedSerializedReads.get(serializationSite(node))
    if (accepted) return accepted
    const name = this.serializationCallName(node)
    const format =
      name === 'numpy.load'
        ? 'npy'
        : name === 'joblib.load'
          ? 'joblib'
          : ['pandas.read_pickle', 'pickle.load'].includes(name ?? '')
            ? 'python-pickle'
            : undefined
    if (!format) return undefined
    const mmap =
      node.keywords?.find((k) => k.arg === 'mmap_mode')?.value ??
      (['joblib.load', 'numpy.load'].includes(name ?? '') && Array.isArray(node.args)
        ? node.args[1]
        : undefined)
    if (mmap && !(mmap.type === 'Constant' && mmap.value === null)) return undefined
    const path = this.serializationPath(
      pythonFileCallArgument(node, {
        kind: 'read',
        position: 0,
        keywords: ['filepath_or_buffer', 'file', 'filename']
      })
    )
    const value = path ? this.serializedValues.get(path) : undefined
    return value?.format === format && PYTHON_SERIALIZED_TYPES.has(value.valueType)
      ? value.valueType
      : undefined
  }

  trackSerializationCall(node: PyNode): void {
    if (this.checkingFunction || this.functionDepth > 0) return
    const name = this.serializationCallName(node)
    const member = memberName(node.func) ?? ''
    const effect = PYTHON_FILE_CALL_EFFECTS.get(name ?? '') ?? PYTHON_FILE_CALL_EFFECTS.get(member)
    const pathArgument = effect ? pythonFileCallArgument(node, effect) : undefined
    let path = this.serializationPath(pathArgument)
    const connection =
      pathArgument?.type === 'Name' && this.serializedConnections.has(pathArgument.id ?? '')
    if (path && effect?.appendedSuffix && !connection && !path.endsWith(effect.appendedSuffix))
      path += effect.appendedSuffix
    const reader = ['pandas.read_pickle', 'pickle.load', 'joblib.load', 'numpy.load'].includes(
      name ?? ''
    )
    if (reader) this.serializedValueReads.add(path ?? '<dynamic>')
    const readType = this.serializedReadType(node)
    if (readType) this.acceptedSerializedReads.set(serializationSite(node), readType)
    const raw = pythonDottedName(node.func)
    const openCall = raw === 'open' && !this.defined.has('open')
    const modeArgument =
      node.keywords?.find((k) => k.arg === 'mode')?.value ??
      (Array.isArray(node.args) ? node.args[1] : undefined)
    const readMode = modeArgument
      ? pythonStaticString(modeArgument, this.serializedPathBindings)
      : 'r'
    const writes =
      effect?.kind === 'write' ||
      ((openCall || member === 'open') &&
        (!openCall || !['r', 'rb', 'rt'].includes(readMode ?? ''))) ||
      [
        'write',
        'write_text',
        'write_bytes',
        'truncate',
        'remove',
        'unlink',
        'rename',
        'replace',
        'copy',
        'copyfile'
      ].includes(member)
    if (writes) {
      if (path) {
        this.serializedValueWrites.delete(path)
        this.serializedValues.delete(path)
      } else {
        this.serializedValueWrites.clear()
        this.serializedValues.clear()
      }
    }
    const pandasMethod = name === 'pandas.DataFrame.to_pickle' || name === 'pandas.Series.to_pickle'
    const format =
      name === 'numpy.save'
        ? 'npy'
        : name === 'joblib.dump'
          ? 'joblib'
          : pandasMethod || ['pandas.to_pickle', 'pickle.dump'].includes(name ?? '')
            ? 'python-pickle'
            : undefined
    const object =
      name === 'numpy.save'
        ? (node.keywords?.find((k) => k.arg === 'arr')?.value ??
          (Array.isArray(node.args) ? node.args[1] : undefined))
        : pandasMethod
          ? (node.func?.value as PyNode)
          : (node.keywords?.find((k) => ['obj', 'value'].includes(k.arg ?? ''))?.value ??
            (Array.isArray(node.args) ? node.args[0] : undefined))
    const valueType = object
      ? (this.libraryTypeName(object) ?? this.arithmeticResultType(object))
      : undefined
    if (
      format &&
      path &&
      valueType &&
      (format !== 'npy' || valueType === 'numpy.ndarray') &&
      PYTHON_SERIALIZED_TYPES.has(valueType) &&
      this.controlDepth === 0
    ) {
      const value: NotebookSerializedValue = {
        path,
        format,
        valueType: valueType as NotebookSerializedValue['valueType']
      }
      this.serializedValueWrites.set(path, value)
      this.serializedValues.set(path, value)
    }
  }

  visit_With(node: PyNode): void {
    const names: string[] = []
    for (const item of node.items ?? []) {
      this.visit(item.context_expr)
      this.visit(item.optional_vars)
      const call = item.context_expr
      if (
        call?.type !== 'Call' ||
        pythonDottedName(call.func) !== 'open' ||
        this.defined.has('open')
      )
        continue
      const path = this.serializationPath(
        pythonFileCallArgument(call, { kind: 'read', position: 0, keywords: ['file'] })
      )
      const target = item.optional_vars
      if (path && target?.type === 'Name' && target.id) {
        this.serializedConnections.set(target.id, path)
        names.push(target.id)
      }
    }
    for (const statement of Array.isArray(node.body) ? node.body : []) this.visit(statement)
    for (const name of names) this.serializedConnections.delete(name)
  }

  comprehensionDepth = 0
  contextualKernelNames = new Set<string>()
  freshCalculatedNames = new Set<string>()
  calculatedValueTypes = new WeakMap<PyNode, string>()
  calculatedReturnName?: string
  literalBindings = new Map<string, PyNode>()
  localFunctions = new Map<string, PyNode>()
  assignmentVersions = new Map<string, number>()
  localFunctionDefaultVersions = new Map<PyNode, Map<string, number>>()
  checkingFunction = false
  functionDepth = 0
  procedureBudget = { remaining: 6000 }
  procedureReturnTypes = new Map<PyNode, string>()
  procedureReturnShapes = new Map<PyNode, string[]>()
  procedureReturnAliases = new Map<PyNode, Map<number, string[]>>()
  unresolvedFunctionCall = false
  consoleRedirected = false
  pythonRandomStateReads = false
  pythonPlottingState = { reads: false, writes: false }
  diagnosticValues = new Map<string, PythonDiagnosticKind>()
  namespaceLoads = new Map<string, number[]>()
  defined = new Set<string>()
  conditionallyDefined = new Set<string>()
  isolatedConditionallyDefined = new Set<string>()
  used = new Map<string, number>()
  priorUsed = new Map<string, number>()
  mutated = new Set<string>()
  possiblyMutated = new Set<string>()
  aliases = new Map<string, string>()
  possibleAliases = new Set<string>()
  builtinContainers = new Set<string>()
  safeCallNames = new Set<string>()
  safeCallArgumentNames = new Set<string>()
  possiblyUsed = new Set<string>()
  typeSummaries: NotebookDependencyTypeSummary[] = []
  typeBindings: NotebookDependencyTypeBinding[] = []
  receiverCalls: NotebookDependencyReceiverCall[] = []
  memberWrites: NotebookDependencyMemberWrite[] = []
  constructorNodes = new Set<PyNode>()
  callResultNames = new Map<PyNode, string[]>()
  callResultPaths = new Map<PyNode, number[][]>()
  pureInlineCallbacks = new Map<PyNode, NonNullable<ReturnType<typeof summarizeInlineCallback>>>()
  unknown = new Set<string>()
  controlDepth = 0
  localAggregationDepth = 0
  isolatedLoopEffects: Array<{
    depth: number
    localNames: Set<string>
    assignmentDepth: number
    initializedNames: Set<string>
  }> = []
  localScopes: Array<Record<string, string | undefined>> = []
  localLibraryTypeScopes: Array<Record<string, string | undefined>> = []
  concatenatedIterationSources: string[][] = []
  builtinModuleNames = new Set(['builtins', '__builtins__'])
  importedModules = new Map<string, string>()
  importedFunctions = new Map<string, string>()
  localLibraryTypes = new Map<string, string>()
  taintedNamespaces = new Set<string>()
  importedCanonicalNames = new Map<string, string>()

  constructor(
    private readonly scopedLoops: Set<PyNode>,
    private readonly isolatedConditionalLoops: Map<PyNode, Set<string>>,
    private readonly contextualStaticCollections: Set<string> = new Set()
  ) {
    super()
  }

  visit(node: PyNode | null | undefined): void {
    if (!node) return
    const consoleControl =
      !this.consoleRedirected &&
      pythonConsoleControlDiagnostic(
        node,
        this.importedCanonicalNames,
        this.defined,
        this.taintedNamespaces,
        (name) => this.diagnosticValues.get(name)
      )
    if (
      consoleControl &&
      consoleControl.locals.every(
        (name) =>
          !(this.namespaceLoads.get(name) ?? []).some((line) => line > (node.end_lineno ?? 0))
      )
    ) {
      for (const name of consoleControl.names) this.addUsed(name)
      for (const name of consoleControl.safeCalls) this.safeCallNames.add(name)
      this.controlDepth += 1
      this.prepareAssignment(consoleControl.locals, true)
      for (const name of consoleControl.locals) {
        this.defined.add(name)
        this.isolatedConditionallyDefined.add(name)
      }
      this.controlDepth -= 1
      return
    }
    if (node.type === 'For' && node.iter?.type === 'BinOp' && node.iter.op === 'Add') {
      const sources = this.concatenatedSources(node.iter)
      if (sources.length > 1) {
        const start = this.receiverCalls.length
        this.concatenatedIterationSources.push(sources)
        super.visit(node)
        this.concatenatedIterationSources.pop()
        for (const record of this.receiverCalls.slice(start)) {
          if (record.receiver === sources[0])
            for (const receiver of sources.slice(1))
              this.receiverCalls.push({ ...record, receiver })
        }
        return
      }
    }
    const diagnostic =
      !this.consoleRedirected &&
      this.localScopes.length === 0 &&
      pythonConsoleDiagnostic(
        node,
        this.importedCanonicalNames,
        this.defined,
        this.taintedNamespaces,
        (name) => this.diagnosticValues.get(name)
      )
    if (!diagnostic) {
      super.visit(node)
      return
    }
    for (const name of diagnostic.names) this.addUsed(name)
    for (const name of diagnostic.safeCalls) this.safeCallNames.add(name)
  }

  addUsed(name: string): void {
    this.used.set(name, (this.used.get(name) ?? 0) + 1)
    if (!this.defined.has(name)) this.priorUsed.set(name, (this.priorUsed.get(name) ?? 0) + 1)
  }

  removeUsed(name: string): void {
    const count = this.used.get(name) ?? 0
    if (count <= 1) this.used.delete(name)
    else this.used.set(name, count - 1)
    const priorCount = this.priorUsed.get(name) ?? 0
    if (priorCount <= 1) this.priorUsed.delete(name)
    else this.priorUsed.set(name, priorCount - 1)
  }

  addMutation(name: string): void {
    this.literalBindings.delete(name)
    for (const [binding, value] of this.literalBindings)
      if (!staticScalar(value)) this.literalBindings.delete(binding)
    for (const sources of this.concatenatedIterationSources) {
      if (sources[0] === name)
        for (const source of sources.slice(1)) {
          if (this.controlDepth > 0 && !this.isolatedLoopEffects.at(-1)?.localNames.has(source))
            this.possiblyMutated.add(source)
          else this.mutated.add(source)
        }
    }
    this.diagnosticValues.delete(name)
    const scoped = this.isolatedLoopEffects.at(-1)
    if (
      this.controlDepth > 0 &&
      !scoped?.localNames.has(name) &&
      !this.freshCalculatedNames.has(name)
    )
      this.possiblyMutated.add(name)
    else this.mutated.add(name)
    this.freshCalculatedNames.delete(name)
  }

  conditionalFact(): { conditional?: true } {
    return this.controlDepth > (this.isolatedLoopEffects.at(-1)?.depth ?? 0)
      ? { conditional: true }
      : {}
  }

  addPossibleAlias(target: string, source: string, access?: string, member?: string): void {
    this.possibleAliases.add(`${target}\0${source}\0${access ?? ''}\0${member ?? ''}`)
  }

  clearPossibleAliases(target: string): void {
    for (const alias of this.possibleAliases) {
      if (alias.split('\0', 1)[0] === target) this.possibleAliases.delete(alias)
    }
  }

  visibleRootName(node: PyNode | null | undefined): string | undefined {
    const name = rootName(node)
    for (let index = this.localScopes.length - 1; index >= 0; index -= 1) {
      if (name && name in this.localScopes[index]!) return this.localScopes[index]![name]
    }
    return name
  }

  visibleRoots(nodes: Array<PyNode | undefined | null>): string[] {
    const result: string[] = []
    for (const node of nodes) {
      for (const name of this.expressionVisibleRoots(node)) {
        if (!result.includes(name)) result.push(name)
      }
    }
    return result
  }

  expressionVisibleRoots(node: PyNode | null | undefined): string[] {
    const name = this.visibleRootName(node)
    if (name) return [name]
    if (node && (node.type === 'List' || node.type === 'Tuple' || node.type === 'Set')) {
      return this.visibleRoots(node.elts ?? [])
    }
    if (node?.type === 'Dict') {
      return this.visibleRoots([...(node.keys ?? []), ...(node.values ?? [])])
    }
    return []
  }

  libraryTypeName(node: PyNode | null | undefined): string | undefined {
    if (node?.type === 'Constant' && node.constKind === 'str') return 'python.string'
    if (node?.type === 'Subscript') {
      const type = this.librarySubscriptType(node)
      if (type) return type
    }
    if (node?.type === 'Attribute') {
      const property = this.libraryPropertyEffect(node)
      if (property?.returnType) return property.returnType
    }
    const localName = rootName(node)
    for (let index = this.localScopes.length - 1; index >= 0; index -= 1) {
      if (localName && localName in this.localScopes[index]!) {
        return this.localLibraryTypeScopes[index]?.[localName]
      }
    }
    const visibleName = this.visibleRootName(node)
    return visibleName
      ? (this.importedModules.get(visibleName) ?? this.localLibraryTypes.get(visibleName))
      : undefined
  }

  librarySubscriptType(node: PyNode): string | undefined {
    if (node.type !== 'Subscript' || !isPyNode(node.value)) return undefined
    const owner =
      node.value.type === 'Call'
        ? this.libraryCallEffect(node.value)?.returnType
        : this.libraryTypeName(node.value)
    if (
      node.value.type === 'Attribute' &&
      ['loc', 'iloc'].includes(node.value.attr ?? '') &&
      this.libraryTypeName(node.value.value as PyNode) === 'pandas.DataFrame'
    ) {
      const selectors =
        node.slice?.type === 'Tuple' ? (node.slice.elts ?? []) : node.slice ? [node.slice] : []
      const scalar = (selector: PyNode): boolean =>
        selector.type === 'Constant' ||
        ['python.string', 'python.scalar'].includes(this.arithmeticResultType(selector) ?? '')
      const multiple = (selector: PyNode): boolean =>
        ['List', 'Tuple', 'Slice'].includes(selector.type) ||
        ['python.strings', 'python.container', 'numpy.ndarray', 'pandas.Series'].includes(
          this.libraryTypeName(selector) ?? ''
        )
      if (selectors.length === 2 && selectors.every(scalar)) return 'python.scalar'
      if (
        selectors.length === 2 &&
        selectors.every((selector) => scalar(selector) || multiple(selector))
      )
        return selectors.some(scalar) ? 'pandas.Series' : 'pandas.DataFrame'
      if (selectors.length === 1 && scalar(selectors[0]!)) return 'pandas.Series'
      if (selectors.length === 1 && multiple(selectors[0]!)) return 'pandas.DataFrame'
      return undefined
    }
    if (owner === 'python.string') return 'python.string'
    if (owner === 'python.numbers') return node.slice?.type === 'Slice' ? owner : 'python.scalar'
    if (
      owner === 'numpy.ndarray' &&
      node.slice &&
      ((node.slice.type === 'Constant' && node.slice.constKind === 'int') ||
        (node.slice.type === 'Name' && this.libraryTypeName(node.slice) === 'python.scalar'))
    )
      return 'numpy.ndarray'
    if (owner === 'python.strings')
      return node.slice?.type === 'Slice' ? 'python.strings' : 'python.string'
    if (
      owner === 'pandas.DataFrame' &&
      ((node.slice?.type === 'Constant' && node.slice.constKind === 'str') ||
        (node.slice?.type === 'Name' &&
          ['python.string', 'python.scalar'].includes(this.libraryTypeName(node.slice) ?? '')))
    )
      return 'pandas.Series'
    return undefined
  }

  iterationSource(node: PyNode | null | undefined): string | undefined {
    if (!node) return undefined
    if (node.type === 'Name') {
      const source = this.visibleRootName(node)
      const typeName = this.libraryTypeName(node)
      return source && typeName && PYTHON_LIBRARY_EFFECTS[typeName]?.iterationTypes
        ? source
        : undefined
    }
    if (node.type === 'Attribute' && node.attr === 'flat') {
      return this.iterationSource(node.value as PyNode)
    }
    if (node.type !== 'Call' || !isPyNode(node.func)) {
      return undefined
    }
    const args = Array.isArray(node.args) ? node.args : []
    if (node.func.type === 'Name') {
      const sourceIndex = node.func.id === 'filter' ? 1 : 0
      return ['enumerate', 'filter', 'list', 'reversed', 'sorted', 'tuple'].includes(
        node.func.id ?? ''
      )
        ? this.iterationSource(args[sourceIndex])
        : undefined
    }
    if (node.func.type !== 'Attribute') return undefined
    const effect = this.libraryCallEffect(node)
    if (effect?.preservesIterationTypesFrom === 'receiver') {
      return this.iterationSource(node.func.value as PyNode)
    }
    if (effect?.preservesIterationTypesFrom !== 'firstArgument') return undefined
    return this.iterationSource(args[0])
  }

  iterationTypes(node: PyNode | null | undefined): string[] {
    if (node?.type === 'ListComp') {
      const generator = node.generators?.[0]
      if (
        generator &&
        node.elt?.type === 'Name' &&
        generator.target.type === 'Name' &&
        node.elt.id === generator.target.id
      )
        return this.iterationTypes(generator.iter)
      const element = this.arithmeticResultType(node.elt)
      if (element) return [element]
    }

    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Name') {
      const args = Array.isArray(node.args) ? node.args : []
      if (node.func.id === 'range' && !this.defined.has('range')) return ['python.scalar']
      if (node.func.id === 'enumerate') return ['python.scalar', ...this.iterationTypes(args[0])]
      const sourceIndex = node.func.id === 'filter' ? 1 : 0
      if (['filter', 'list', 'reversed', 'sorted', 'tuple'].includes(node.func.id ?? '')) {
        return this.iterationTypes(args[sourceIndex])
      }
    }
    if (
      node &&
      ['List', 'Tuple'].includes(node.type) &&
      node.elts?.length &&
      node.elts.every((value) => this.arithmeticResultType(value) === 'python.scalar')
    )
      return ['python.scalar']
    const source = this.iterationSource(node)
    const sourceType = source ? this.localLibraryTypes.get(source) : undefined
    const directType =
      node?.type === 'Call'
        ? this.libraryCallEffect(node)?.returnType
        : node && ['BinOp', 'List', 'Tuple'].includes(node.type)
          ? this.arithmeticResultType(node)
          : this.libraryTypeName(node)
    return PYTHON_LIBRARY_EFFECTS[sourceType ?? directType ?? '']?.iterationTypes ?? []
  }

  loopLibraryTypes(node: PyNode | null | undefined, targetNames: string[]): string[] {
    if (
      node?.type === 'Call' &&
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      node.func.id === 'zip'
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      return targetNames.map((_, index) => this.iterationTypes(args[index])[0] ?? '')
    }
    const types = this.iterationTypes(node)
    return targetNames.map((_, index) => types[index] ?? (types.length === 1 ? types[0]! : ''))
  }

  concatenatedSources(node: PyNode | undefined): string[] {
    if (!node) return []
    if (node.type === 'Name' && this.builtinContainers.has(node.id ?? ''))
      return this.expressionVisibleRoots(node)
    if (node.type !== 'BinOp' || node.op !== 'Add') return []
    const left = this.concatenatedSources(node.left),
      right = this.concatenatedSources(node.right)
    return left.length && right.length ? [...new Set([...left, ...right])] : []
  }

  loopSourceNames(node: PyNode | null | undefined): Array<string | undefined> {
    if (node?.type === 'BinOp') return this.concatenatedSources(node)
    if (
      node?.type === 'Call' &&
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      node.func.id === 'zip'
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      return args.map((argument) => this.expressionVisibleRoots(argument)[0])
    }
    if (
      node?.type === 'Call' &&
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      node.func.id === 'enumerate'
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      return [undefined, this.iterationSource(args[0])]
    }
    const iterationSource = this.iterationSource(node)
    if (iterationSource) return [iterationSource]
    return this.expressionVisibleRoots(node)
  }

  bindTypedLoopValues(
    iterator: PyNode | undefined,
    names: string[],
    sources: Array<string | undefined>,
    types: string[]
  ): void {
    const aliases = this.receiverValueRoots(iterator)
    const primarySource = sources[0]
    for (const [index, name] of names.entries()) {
      const typeName = types[index]
      if (!typeName || sources[index] || primarySource) continue
      sources[index] = name
      this.addLibrarySummaries()
      this.typeBindings.push({ target: name, typeName, argumentNames: [] })
      if (typeName !== 'python.scalar')
        for (const source of aliases) this.addPossibleAlias(name, source)
    }
  }

  receiverRootName(node: PyNode | null | undefined): string | undefined {
    const name = this.visibleRootName(node)
    if (name) return name
    if (node && (node.type === 'Attribute' || node.type === 'Subscript')) {
      return this.receiverRootName(node.value as PyNode)
    }
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Attribute') {
      return this.receiverRootName(node.func.value as PyNode)
    }
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Name' && node.func.id) {
      return this.importedFunctions.get(node.func.id) ?? node.func.id
    }
    return undefined
  }

  receiverCallChain(node: PyNode | null | undefined): string[] {
    if (node?.type === 'Attribute' && this.libraryPropertyEffect(node))
      return [...this.receiverCallChain(node.value as PyNode), `@${node.attr}`]
    if (node?.type === 'Subscript' && this.librarySubscriptType(node) === 'pandas.Series')
      return [...this.receiverCallChain(node.value as PyNode), '@column']
    if (node?.type === 'Subscript') return this.receiverCallChain(node.value as PyNode)
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Attribute') {
      return [...this.receiverCallChain(node.func.value as PyNode), node.func.attr ?? '']
    }
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Name')
      return ['__call__']
    return []
  }

  receiverChainFirstArguments(node: PyNode | null | undefined): string[][] {
    if (node?.type === 'Attribute' && this.libraryPropertyEffect(node))
      return [...this.receiverChainFirstArguments(node.value as PyNode), []]
    if (node?.type === 'Subscript' && this.librarySubscriptType(node) === 'pandas.Series')
      return [...this.receiverChainFirstArguments(node.value as PyNode), []]
    if (node?.type === 'Subscript') return this.receiverChainFirstArguments(node.value as PyNode)
    if (node?.type === 'Call') {
      const prior =
        isPyNode(node.func) && node.func.type === 'Attribute'
          ? this.receiverChainFirstArguments(node.func.value as PyNode)
          : []
      const args = Array.isArray(node.args) ? node.args : []
      return [...prior, args.length ? this.expressionVisibleRoots(args[0]) : []]
    }
    return []
  }

  receiverChainArguments(node: PyNode | null | undefined): Array<{
    positionalArgumentNames: string[][]
    positionalStaticShapes: PythonArgumentShape[]
    positionalStaticBooleans: Array<boolean | null>
    keywordArguments: ReturnType<Analyzer['keywordArgumentRecord']>[]
  }> {
    if (node?.type === 'Attribute' && this.libraryPropertyEffect(node))
      return [
        ...this.receiverChainArguments(node.value as PyNode),
        {
          positionalArgumentNames: [],
          positionalStaticShapes: [],
          positionalStaticBooleans: [],
          keywordArguments: []
        }
      ]
    if (node?.type === 'Subscript' && this.librarySubscriptType(node) === 'pandas.Series')
      return [
        ...this.receiverChainArguments(node.value as PyNode),
        {
          positionalArgumentNames: [],
          positionalStaticShapes: [],
          positionalStaticBooleans: [],
          keywordArguments: []
        }
      ]
    if (node?.type === 'Subscript') return this.receiverChainArguments(node.value as PyNode)
    if (node?.type === 'Call') {
      const prior =
        isPyNode(node.func) && node.func.type === 'Attribute'
          ? this.receiverChainArguments(node.func.value as PyNode)
          : []
      const args = Array.isArray(node.args) ? node.args : []
      return [
        ...prior,
        {
          positionalArgumentNames: args.map((argument) => this.expressionVisibleRoots(argument)),
          positionalStaticShapes: args.map(pythonArgumentShape),
          positionalStaticBooleans: args.map((argument) =>
            argument.type === 'Constant' && argument.constKind === 'bool'
              ? Boolean(argument.value)
              : null
          ),
          keywordArguments: this.callKeywordArgumentRecords(node)
        }
      ]
    }
    return []
  }

  receiverValueRoots(node: PyNode | null | undefined): string[] {
    if (node?.type === 'Subscript') return this.receiverValueRoots(node.value as PyNode)
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Attribute') {
      const effect = this.libraryCallEffect(node)
      const base = this.receiverValueRoots(node.func.value as PyNode)
      const args = Array.isArray(node.args) ? node.args : []
      if (effect) {
        const firstKeyword = effect.firstArgumentKeyword
        const first =
          (node.keywords ?? []).find((keyword) => keyword.arg === firstKeyword)?.value ?? args[0]
        const firstRoots = first ? this.expressionVisibleRoots(first) : []
        const aliasValue = (node.keywords ?? []).find(
          (keyword) => keyword.arg === effect.returnsAliasOfKeyword
        )?.value
        if (aliasValue) return this.expressionVisibleRoots(aliasValue)
        if (effect.returnsAliasOfReceiver) return base
        if (effect.returnsPossibleAliasOf === 'receiver') return base
        if (effect.returnsPossibleAliasOf === 'firstArgument') return firstRoots
        const conditional = effect.returnsPossibleAliasWhenKeywordFalse
        if (conditional) {
          const keyword = (node.keywords ?? []).find((item) => item.arg === conditional.keyword)
          const position = conditional.positionalArgument
          const flag =
            keyword?.value.type === 'Constant' && keyword.value.constKind === 'bool'
              ? Boolean(keyword.value.value)
              : typeof position === 'number' &&
                  args[position]?.type === 'Constant' &&
                  args[position]?.constKind === 'bool'
                ? Boolean(args[position]?.value)
                : undefined
          if (flag !== true) {
            const roots: string[] = []
            for (const source of conditional.sources) {
              if (source === 'receiver') roots.push(...base)
              else if (source === 'firstArgument') roots.push(...firstRoots)
              else if (source === 'secondArgument') {
                const second =
                  (node.keywords ?? []).find((item) => item.arg === effect.secondArgumentKeyword)
                    ?.value ?? args[1]
                if (second) roots.push(...this.expressionVisibleRoots(second))
              } else if (source === 'arguments') {
                roots.push(
                  ...this.visibleRoots([
                    ...args,
                    ...(node.keywords ?? []).map((item) => item.value)
                  ])
                )
              }
            }
            return [...new Set(roots)]
          }
        }
        if (effect.returnType || effect.destructuredReturnTypes) return []
      }
      if (node.func.attr === 'merge') {
        const copyKeyword = (node.keywords ?? []).find((item) => item.arg === 'copy')
        const copyPosition = 9
        const hasCopyPosition = copyPosition < args.length
        const copyFlag =
          copyKeyword?.value.type === 'Constant' && copyKeyword.value.constKind === 'bool'
            ? Boolean(copyKeyword.value.value)
            : hasCopyPosition &&
                args[copyPosition]?.type === 'Constant' &&
                args[copyPosition]?.constKind === 'bool'
              ? Boolean(args[copyPosition]?.value)
              : undefined
        if (copyKeyword || hasCopyPosition) {
          if (copyFlag !== true) {
            const right =
              (node.keywords ?? []).find((item) => item.arg === 'right')?.value ?? args[0]
            if (right) return [...new Set([...base, ...this.expressionVisibleRoots(right)])]
          }
        }
      }
      return base
    }
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Name') {
      const effect = this.libraryCallEffect(node)
      const args = Array.isArray(node.args) ? node.args : []
      const first = args[0]
      const firstRoots = first ? this.expressionVisibleRoots(first) : []
      if (effect) {
        const aliasValue = (node.keywords ?? []).find(
          (keyword) => keyword.arg === effect.returnsAliasOfKeyword
        )?.value
        if (aliasValue) return this.expressionVisibleRoots(aliasValue)
        if (effect.returnsPossibleAliasOf === 'firstArgument') return firstRoots
        if (effect.returnType || effect.destructuredReturnTypes) return []
      }
      return this.visibleRoots([...args, ...(node.keywords ?? []).map((item) => item.value)])
    }
    const name = this.visibleRootName(node)
    return name ? [name] : []
  }

  hasLocalRoot(node: PyNode | null | undefined): boolean {
    const name = rootName(node)
    if (name && this.localScopes.some((scope) => name in scope)) return true
    if (node && (node.type === 'List' || node.type === 'Tuple' || node.type === 'Set')) {
      return (node.elts ?? []).some((element) => this.hasLocalRoot(element))
    }
    if (node?.type === 'Dict') {
      return [...(node.keys ?? []), ...(node.values ?? [])].some((item) =>
        this.hasLocalRoot(item ?? undefined)
      )
    }
    return false
  }

  callableReferences(
    node: PyNode | null | undefined,
    container?: 'list' | 'dict'
  ): Array<{ root: string; member?: string; container?: 'list' | 'dict' }> {
    if (node && this.pureInlineCallbacks.has(node)) return []
    const suffix = container ? { container } : {}
    if (node?.type === 'Name' && node.id) {
      const alias = this.aliases.get(node.id) ?? node.id
      return [{ root: this.importedFunctions.get(alias) ?? alias, ...suffix }]
    }
    if (node?.type === 'Attribute') {
      const root = this.visibleRootName(node.value as PyNode)
      const alias = root ? (this.aliases.get(root) ?? root) : undefined
      return alias ? [{ root: alias, member: node.attr, ...suffix }] : []
    }
    if (node && (node.type === 'List' || node.type === 'Tuple' || node.type === 'Set')) {
      return (node.elts ?? []).flatMap((element) => this.callableReferences(element, 'list'))
    }
    if (node?.type === 'Dict') {
      return (node.values ?? []).flatMap((value) => this.callableReferences(value, 'dict'))
    }
    return []
  }

  callKeywordArgumentRecords(
    node: PyNode,
    trackLocal = false
  ): ReturnType<Analyzer['keywordArgumentRecord']>[] {
    const keywords = [...(node.keywords ?? [])]
    const args = Array.isArray(node.args) ? node.args : []
    for (const [position, name] of Object.entries(
      this.libraryCallEffect(node)?.callbackPositionalKeywords ?? {}
    )) {
      const value = args[Number(position)]
      if (value) keywords.push({ type: 'keyword', arg: name, value, _fields: ['value'] })
    }
    return keywords.map((keyword) => this.keywordArgumentRecord(keyword, trackLocal))
  }

  keywordArgumentRecord(
    keyword: PyKeyword,
    trackLocal = false
  ): NonNullable<NotebookDependencyReceiverCall['keywordArguments']>[number] {
    const roots = this.visibleRoots([keyword.value])
    const local = trackLocal && this.hasLocalRoot(keyword.value)
    const staticBoolean =
      keyword.value.type === 'Constant' && keyword.value.constKind === 'bool'
        ? Boolean(keyword.value.value)
        : null
    return {
      name: keyword.arg ?? '**',
      argumentNames: local ? [] : roots,
      possibleArgumentNames: local ? roots : [],
      staticBoolean,
      staticShape: pythonArgumentShape(keyword.value),
      callableReferences: this.callableReferences(keyword.value)
    }
  }

  addLibrarySummaries(): void {
    const existing = new Set(this.typeSummaries.map((summary) => summary.name))
    for (const [name, summary] of Object.entries(PYTHON_LIBRARY_EFFECTS)) {
      if (existing.has(name)) continue
      const methods = Object.entries(summary.methods).map(([methodName, effect]) => ({
        name: methodName,
        effect: effect.effect,
        ...(effect.unknownScope ? { unknownScope: effect.unknownScope } : {}),
        ...(effect.returnType ? { returnType: effect.returnType } : {}),
        ...(effect.destructuredReturnTypes
          ? { destructuredReturnTypes: effect.destructuredReturnTypes }
          : {}),
        ...(effect.mutatesKeyword ? { mutatesKeyword: effect.mutatesKeyword } : {})
      }))
      this.typeSummaries.push({
        name,
        kind: summary.kind === 'module' ? 'python-module' : 'python-class',
        fields: [],
        methods
      })
    }
  }

  bindLibraryModule(target: string, module: string): void {
    if (this.taintedNamespaces.has('*') || this.taintedNamespaces.has(module.split('.')[0]!)) {
      this.unknown.add('dynamic-namespace')
      return
    }
    const summary = PYTHON_LIBRARY_EFFECTS[module]
    if (!summary || summary.kind !== 'module') return
    this.addLibrarySummaries()
    this.importedModules.set(target, module)
    if (target !== module) this.aliases.set(target, module)
    this.typeBindings.push({ target, typeName: module, argumentNames: [] })
  }

  bindLibraryFunction(target: string, module: string, member: string): void {
    if (this.taintedNamespaces.has('*') || this.taintedNamespaces.has(module.split('.')[0]!)) {
      this.unknown.add('dynamic-namespace')
      return
    }
    const effect = PYTHON_LIBRARY_EFFECTS[module]?.methods[member]
    if (!effect) return
    this.addLibrarySummaries()
    const callableType = `python-callable:${module}.${member}`
    const method = {
      name: '__call__',
      effect: effect.effect,
      ...(effect.unknownScope ? { unknownScope: effect.unknownScope } : {}),
      ...(effect.returnType ? { returnType: effect.returnType } : {}),
      ...(effect.destructuredReturnTypes
        ? { destructuredReturnTypes: effect.destructuredReturnTypes }
        : {}),
      ...(effect.mutatesKeyword ? { mutatesKeyword: effect.mutatesKeyword } : {})
    }
    if (!this.typeSummaries.some((existing) => existing.name === callableType)) {
      this.typeSummaries.push({
        name: callableType,
        kind: 'python-class',
        fields: [],
        methods: [method]
      })
    }
    this.typeBindings.push({ target, typeName: callableType, argumentNames: [] })
    this.importedFunctions.set(target, callableType)
  }

  bindUnknownImport(target: string, module: string, member: string): void {
    const callableType = `python-callable:unknown.${module}.${member}`
    if (!this.typeSummaries.some((existing) => existing.name === callableType)) {
      this.typeSummaries.push({
        name: callableType,
        kind: 'python-class',
        fields: [],
        methods: [{ name: '__call__', effect: 'unknown', unknownScope: 'namespace' }]
      })
    }
    this.typeBindings.push({ target, typeName: callableType, argumentNames: [] })
    this.importedFunctions.set(target, callableType)
  }

  arithmeticResultType(node: PyNode | null | undefined): string | undefined {
    if (!node) return undefined
    if (node.type === 'JoinedStr') return 'python.string'
    if (node.type === 'Constant' && node.constKind === 'str') return 'python.string'
    if (node.type === 'Subscript') return this.librarySubscriptType(node)
    const elements =
      node.type === 'Dict'
        ? node.values
        : ['List', 'Tuple'].includes(node.type)
          ? node.elts
          : undefined
    if (
      (node.type !== 'Dict' ||
        node.keys?.every((key) => key && this.arithmeticResultType(key) === 'python.string')) &&
      elements?.length &&
      elements.every((element) => this.arithmeticResultType(element) === 'python.string')
    )
      return 'python.strings'
    if (
      ['List', 'Tuple'].includes(node.type) &&
      node.elts?.length &&
      node.elts.every((value) => this.arithmeticResultType(value) === 'python.scalar')
    )
      return 'python.numbers'
    if (node.type === 'ListComp' && this.arithmeticResultType(node.elt) === 'python.string')
      return 'python.strings'
    if (node.type === 'ListComp' && this.iterationTypes(node)[0] === 'python.scalar')
      return 'python.numbers'
    if (
      node.type === 'Constant' &&
      ['int', 'float', 'complex', 'bool'].includes(node.constKind ?? '')
    )
      return 'python.scalar'
    if (node.type === 'Name') return this.libraryTypeName(node)
    if (node.type === 'Attribute') return this.libraryPropertyEffect(node)?.returnType
    if (node.type === 'Call') {
      const effect = this.libraryCallEffect(node)
      if (effect?.returnType) return effect.returnType
      if (
        node.func?.type === 'Attribute' &&
        ['sum', 'min', 'max', 'mean'].includes(node.func.attr ?? '') &&
        this.arithmeticResultType(node.func.value as PyNode) === 'pandas.Series' &&
        effect?.effect === 'read'
      )
        return 'python.scalar'
      return undefined
    }
    if (
      node.type === 'BinOp' &&
      ['Eq', 'NotEq', 'Lt', 'LtE', 'Gt', 'GtE'].includes(node.op ?? '')
    ) {
      const left = this.arithmeticResultType(node.left)
      const right = this.arithmeticResultType(node.right)
      const arrays = ['pandas.Series', 'pandas.DataFrame', 'numpy.ndarray']
      if (
        left &&
        arrays.includes(left) &&
        (right === left || ['python.scalar', 'python.string'].includes(right ?? ''))
      )
        return left
      if (
        right &&
        arrays.includes(right) &&
        ['python.scalar', 'python.string'].includes(left ?? '')
      )
        return right
    }
    if (node.type === 'UnaryOp' && ['UAdd', 'USub', 'Invert'].includes(node.op ?? ''))
      return this.arithmeticResultType(node.operand)
    if (
      node.type !== 'BinOp' ||
      ![
        'Add',
        'Sub',
        'Mult',
        'Div',
        'FloorDiv',
        'Mod',
        'Pow',
        'BitAnd',
        'BitOr',
        'BitXor'
      ].includes(node.op ?? '')
    )
      return undefined
    const left = this.arithmeticResultType(node.left)
    const right = this.arithmeticResultType(node.right)
    const arrays = ['pandas.Series', 'pandas.DataFrame', 'numpy.ndarray']
    if (
      node.op === 'Add' &&
      left === right &&
      ['python.string', 'python.strings'].includes(left ?? '')
    )
      return left
    if (left === 'python.scalar' && right === 'python.scalar') return left
    if (left && arrays.includes(left) && (right === left || right === 'python.scalar')) return left
    if (right && arrays.includes(right) && left === 'python.scalar') return right
    return undefined
  }

  libraryPropertyEffect(node: PyNode): PythonLibraryMethodEffect | undefined {
    if (node.type !== 'Attribute') return undefined
    const receiver = node.value as PyNode
    const owner =
      receiver.type === 'Call'
        ? this.libraryCallEffect(receiver)?.returnType
        : this.libraryTypeName(receiver)
    return owner ? PYTHON_LIBRARY_EFFECTS[owner]?.methods[`@${node.attr}`] : undefined
  }

  specializeLibraryReturn(
    effect: PythonLibraryMethodEffect,
    node: PyNode
  ): PythonLibraryMethodEffect {
    if (
      effect.preservesPandasType &&
      Array.isArray(node.args) &&
      node.args.length === 1 &&
      !node.keywords?.some((keyword) => keyword.arg === 'out' || !keyword.arg)
    ) {
      const inputType = this.arithmeticResultType(node.args[0])
      if (inputType === 'pandas.DataFrame' || inputType === 'pandas.Series')
        return { ...effect, returnType: inputType }
    }
    if (
      effect.scalarInputReturnType &&
      Array.isArray(node.args) &&
      node.args.length === 1 &&
      !node.keywords?.some((keyword) => keyword.arg === 'out' || !keyword.arg) &&
      this.arithmeticResultType(node.args[0]) === 'python.scalar'
    )
      return { ...effect, returnType: effect.scalarInputReturnType }
    if (!effect.returnTypeByArgumentShape) return effect
    return {
      ...effect,
      returnType: pythonArgumentShapeReturnType(
        effect,
        (Array.isArray(node.args) ? node.args : []).map(pythonArgumentShape),
        (node.keywords ?? []).map((keyword) => ({
          name: keyword.arg ?? '**',
          staticShape: pythonArgumentShape(keyword.value)
        }))
      )
    }
  }

  libraryCallEffect(node: PyNode): PythonLibraryMethodEffect | undefined {
    const serializedType = this.serializedReadType(node)
    if (serializedType) return { effect: 'read', returnType: serializedType }
    if (this.serializationCallName(node) === 'numpy.load') {
      const pickle =
        node.keywords?.find((k) => k.arg === 'allow_pickle')?.value ??
        (Array.isArray(node.args) ? node.args[2] : undefined)
      return {
        effect: 'read',
        unsafeNamespace: Boolean(pickle && !(pickle.type === 'Constant' && pickle.value === false))
      }
    }
    const specialized = this.procedureReturnTypes.get(node)
    if (specialized)
      return {
        effect: 'read',
        returnType: specialized,
        destructuredReturnTypes: this.procedureReturnShapes.get(node)
      }
    if (isPyNode(node.func) && node.func.type === 'Name' && node.func.id) {
      if (!this.defined.has(node.func.id) && !this.importedFunctions.has(node.func.id)) {
        if (['sorted', 'list', 'tuple', 'dict', 'set'].includes(node.func.id))
          return { effect: 'read', returnType: 'python.container' }
        if (['float', 'int', 'len', 'bool'].includes(node.func.id))
          return { effect: 'read', returnType: 'python.scalar' }
        if (node.func.id === 'str') return { effect: 'read', returnType: 'python.string' }
        if (
          ['sum', 'min', 'max'].includes(node.func.id) &&
          Array.isArray(node.args) &&
          node.args.length === 1 &&
          !node.keywords?.length
        ) {
          const type = this.arithmeticResultType(node.args[0])
          if (type === 'numpy.ndarray') return { effect: 'read', returnType: type }
        }
      }
      const callableType = this.importedFunctions.get(node.func.id) ?? ''
      const prefix = 'python-callable:'
      if (!callableType.startsWith(prefix)) return undefined
      const canonical = callableType.slice(prefix.length)
      const modules = Object.entries(PYTHON_LIBRARY_EFFECTS)
        .filter(([name, summary]) => summary.kind === 'module' && canonical.startsWith(`${name}.`))
        .sort((left, right) => right[0].length - left[0].length)
      const module = modules[0]?.[0]
      if (!module) return undefined
      const effect = pythonLibraryMethodEffect(module, canonical.slice(module.length + 1))
      return effect ? this.specializeLibraryReturn(effect, node) : undefined
    }
    if (!isPyNode(node.func) || node.func.type !== 'Attribute') return undefined
    let receiverNode = node.func.value as PyNode
    while (
      receiverNode.type === 'Subscript' &&
      isPyNode(receiverNode.value) &&
      !this.librarySubscriptType(receiverNode)
    )
      receiverNode = receiverNode.value
    const typeName =
      receiverNode.type === 'Call'
        ? this.libraryCallEffect(receiverNode)?.returnType
        : ['BinOp', 'UnaryOp'].includes(receiverNode.type)
          ? this.arithmeticResultType(receiverNode)
          : (this.libraryTypeName(receiverNode) ??
            (this.builtinContainers.has(rootName(receiverNode) ?? '')
              ? 'python.container'
              : undefined))
    if (!typeName) return undefined
    const member = node.func.attr ?? ''
    const effect = pythonLibraryMethodEffect(typeName, member)
    const registered = effect ? this.specializeLibraryReturn(effect, node) : undefined
    if (
      registered &&
      typeName === 'numpy.ndarray' &&
      ['sum', 'min', 'max', 'mean'].includes(member) &&
      !(Array.isArray(node.args) && node.args.length) &&
      !node.keywords?.length
    )
      return { ...registered, returnType: 'python.scalar' }
    if (registered)
      return member === 'to_dict' && ['pandas.DataFrame', 'pandas.Series'].includes(typeName)
        ? { ...registered, returnType: 'python.container' }
        : registered
    const args = Array.isArray(node.args) ? node.args : []
    const callback = args[0]
    if (!summarizeInlineCallback(callback)) return undefined
    if (typeName === 'pandas.DataFrame' && member === 'apply') return { effect: 'read' }
    if (typeName === 'pandas.Series' && (member === 'apply' || member === 'map')) {
      return { effect: 'read', returnType: 'pandas.Series' }
    }
    return undefined
  }

  isReadOnlyArithmeticCall(node: PyNode): boolean {
    if (node.type !== 'Call' || node.func?.type !== 'Attribute' || !isPyNode(node.func.value))
      return false
    const effect = this.libraryCallEffect(node)
    const args = Array.isArray(node.args) ? node.args : []
    if (
      effect?.effect !== 'read' ||
      effect.callbackKeywords?.length ||
      effect.callbackAllKeywords ||
      effect.callbackContainerKeywords?.length ||
      effect.externalState ||
      (effect.mutatesKeyword &&
        node.keywords?.some(
          (keyword) => keyword.arg === null || keyword.arg === effect.mutatesKeyword
        )) ||
      effect.mutatesReceiverUnlessKeywordFalse ||
      (effect.mutatesPositionalArgument !== undefined &&
        (args.length > effect.mutatesPositionalArgument ||
          args.some((arg) => arg.type === 'Starred'))) ||
      effect.possiblyMutatesFirstArgument ||
      effect.possiblyMutatesKeyword ||
      effect.possiblyMutatesPositionalArgument !== undefined ||
      (node.keywords ?? []).some(
        (keyword) =>
          keyword.arg === 'inplace' &&
          !(keyword.value.type === 'Constant' && keyword.value.value === false)
      )
    )
      return false
    const receiver = node.func.value
    return ['BinOp', 'UnaryOp'].includes(receiver.type)
      ? ['pandas.Series', 'pandas.DataFrame', 'numpy.ndarray'].includes(
          this.arithmeticResultType(receiver) ?? ''
        )
      : this.isReadOnlyArithmeticCall(receiver)
  }

  assignedNames(node: PyNode | null | undefined): string[] {
    return loopTargetNames(node)
  }

  clearAlias(name: string, conditional = false): void {
    const source = this.aliases.get(name)
    this.aliases.delete(name)
    if (!source) return
    if (conditional) this.addPossibleAlias(name, source)
    else this.removeUsed(source)
  }

  prepareAssignment(targetNames: string[], isolated = false): void {
    const loop = this.isolatedLoopEffects.at(-1)
    if (loop && this.controlDepth === loop.assignmentDepth)
      for (const name of targetNames) loop.initializedNames.add(name)
    const conditional = this.controlDepth > 0
    for (const name of targetNames) this.isolatedConditionallyDefined.delete(name)
    if (conditional) {
      this.unknown.add('control-flow')
      for (const name of targetNames) this.conditionallyDefined.add(name)
    } else {
      for (const name of targetNames) this.conditionallyDefined.delete(name)
    }
    for (const name of targetNames) {
      this.assignmentVersions.set(name, (this.assignmentVersions.get(name) ?? 0) + 1)
      this.freshCalculatedNames.delete(name)
      this.literalBindings.delete(name)
      this.serializedPathBindings.delete(name)
      this.serializedConnections.delete(name)
      if (
        conditional &&
        !isolated &&
        !loop?.initializedNames.has(name) &&
        !this.defined.has(name) &&
        this.contextualKernelNames.has(name)
      )
        this.addUsed(name)
      this.localFunctions.delete(name)
      this.diagnosticValues.delete(name)
      this.contextualStaticCollections.delete(name)
      if (!conditional) this.clearPossibleAliases(name)
      this.importedModules.delete(name)
      this.importedFunctions.delete(name)
      this.importedCanonicalNames.delete(name)
      this.localLibraryTypes.delete(name)
      this.typeBindings = this.typeBindings.filter((binding) => binding.target !== name)
      this.typeSummaries = this.typeSummaries.filter((summary) => summary.name !== name)
      this.builtinContainers.delete(name)
      for (const [target, source] of [...this.aliases.entries()]) {
        if (source === name) {
          this.addPossibleAlias(target, source)
          this.aliases.delete(target)
          this.unknown.add('alias-rebind')
        }
      }
      this.clearAlias(name, conditional)
    }
  }

  visit_control(node: PyNode): void {
    this.unknown.add('control-flow')
    this.controlDepth += 1
    this.genericVisit(node)
    this.controlDepth -= 1
    // A conservatively analyzed loop can still leave an element alias in the kernel.
    // Retain literal-container sources so later mutations cannot lose that dependency.
    if (node.type === 'For' && ['List', 'Tuple', 'Set'].includes(node.iter?.type ?? '')) {
      for (const target of loopTargetNames(node.target))
        for (const source of this.expressionVisibleRoots(node.iter))
          this.addPossibleAlias(target, source)
    }
  }

  visit_Name(node: PyNode): void {
    if (!node.id || this.localScopes.some((scope) => node.id! in scope)) return
    if (node.ctx === 'Load') {
      this.addUsed(node.id)
      if (
        BUILTIN_TYPE_VALUES.has(node.id) &&
        !this.defined.has(node.id) &&
        !this.taintedNamespaces.has('*') &&
        !this.taintedNamespaces.has('builtins')
      )
        this.safeCallNames.add(node.id)
    } else if (node.ctx === 'Store') {
      this.defined.add(node.id)
      if (this.controlDepth > 0) this.conditionallyDefined.add(node.id)
    } else if (node.ctx === 'Del') {
      this.prepareAssignment([node.id])
      this.addMutation(node.id)
    }
  }

  visit_Import(node: PyNode): void {
    const aliases = (node.names as PyAlias[] | undefined) ?? []
    const names = aliases.map((alias) => alias.asname || alias.name.split('.')[0] || alias.name)
    this.prepareAssignment(names)
    for (const alias of aliases) {
      const name = alias.asname || alias.name.split('.')[0] || alias.name
      this.defined.add(name)
      if (alias.name === 'builtins') {
        this.builtinModuleNames.add(name)
        if (name !== 'builtins') this.aliases.set(name, 'builtins')
      }
      this.importedCanonicalNames.set(name, alias.asname ? alias.name : alias.name.split('.')[0]!)
      this.bindLibraryModule(name, alias.name)
    }
  }

  visit_ImportFrom(node: PyNode): void {
    const aliases = (node.names as PyAlias[] | undefined) ?? []
    this.prepareAssignment(
      aliases.filter((alias) => alias.name !== '*').map((alias) => alias.asname || alias.name)
    )
    for (const alias of aliases) {
      if (alias.name === '*') this.unknown.add('wildcard-import')
      else {
        const name = alias.asname || alias.name
        this.defined.add(name)
        if (node.module === 'builtins' && alias.name === '__dict__') {
          this.addPossibleAlias(name, 'builtins', 'attribute')
        }
        if (node.module) {
          this.importedCanonicalNames.set(name, `${node.module}.${alias.name}`)
          this.bindLibraryModule(name, `${node.module}.${alias.name}`)
          this.bindLibraryFunction(name, node.module, alias.name)
          if (!this.importedModules.has(name) && !this.importedFunctions.has(name)) {
            this.bindUnknownImport(name, node.module, alias.name)
          }
        }
      }
    }
  }

  bindAssignmentValue(
    node: PyNode,
    target: PyNode | undefined,
    value: PyNode | undefined,
    targetNames: string[]
  ): void {
    if (value?.type === 'IfExp') {
      const selected = staticBoolean(value.test)
      if (selected !== undefined) {
        const branch = selected ? value.body : value.alternate
        if (isPyNode(branch)) value = branch
      }
    }
    const diagnosticValue =
      value && this.localScopes.length === 0 && this.controlDepth === 0
        ? pythonDiagnosticValue(
            value,
            this.importedCanonicalNames,
            this.defined,
            this.taintedNamespaces,
            (name) => this.diagnosticValues.get(name)
          )
        : undefined
    const lambdaSummary =
      target?.type === 'Name' && target.id && value?.type === 'Lambda'
        ? summarizeLambda(value, target.id)
        : undefined
    const resultPaths: number[][] = []
    const collectResultPaths = (pattern: PyNode | undefined, path: number[]): void => {
      if (pattern?.type === 'Name') resultPaths.push(path)
      else if (pattern?.type === 'Tuple' || pattern?.type === 'List') {
        for (const [index, child] of (pattern.elts ?? []).entries()) {
          collectResultPaths(child, [...path, index])
        }
      }
    }
    collectResultPaths(target, [])
    const nestedUnpacking =
      resultPaths.length === targetNames.length && resultPaths.some((path) => path.length > 1)
    if (value?.type === 'Call') {
      this.callResultNames.set(value, targetNames)
      if (nestedUnpacking) this.callResultPaths.set(value, resultPaths)
    }
    const aliasSource =
      value?.type === 'Name' && value.id ? (this.aliases.get(value.id) ?? value.id) : undefined
    const memberSource =
      value && (value.type === 'Attribute' || value.type === 'Subscript')
        ? this.visibleRootName(value)
        : undefined
    const memberAccess = value?.type === 'Subscript' ? 'subscript' : 'attribute'
    const member = memberSource ? memberName(value) : undefined
    const importedMemberModule = memberSource ? this.importedModules.get(memberSource) : undefined
    const conditionalSources =
      value?.type === 'IfExp'
        ? new Set(
            [
              this.visibleRootName(isPyNode(value.body) ? value.body : undefined),
              this.visibleRootName(value.alternate)
            ].filter((name): name is string => Boolean(name))
          )
        : new Set<string>()
    const constructor =
      target?.type === 'Name' &&
      value?.type === 'Call' &&
      isPyNode(value.func) &&
      value.func.type === 'Name' &&
      value.func.id &&
      !SAFE_CALLS.has(value.func.id) &&
      !DYNAMIC_CALLS.has(value.func.id) &&
      !EXTERNAL_READ_CALLS.has(value.func.id) &&
      !SCOPED_MUTATION_CALLS.has(value.func.id) &&
      !SCOPED_OPAQUE_CALLS.has(value.func.id) &&
      !this.importedFunctions.has(value.func.id)
    let constructorArguments = new Set<string>()
    if (constructor && value) {
      const args = Array.isArray(value.args) ? value.args : []
      constructorArguments = new Set(
        [...args, ...(value.keywords ?? []).map((keyword) => keyword.value)]
          .map((item) => this.visibleRootName(item))
          .filter((name): name is string => Boolean(name))
      )
      this.constructorNodes.add(value)
    }
    if (value?.type === 'Lambda' && lambdaSummary) {
      const fnArgs = value.args as PyArguments | undefined
      for (const defaultValue of [
        ...(fnArgs?.defaults ?? []),
        ...(fnArgs?.kw_defaults ?? []).filter((item): item is PyNode => Boolean(item))
      ]) {
        this.visit(defaultValue)
      }
    } else if (value) this.visit(value)
    const libraryEffect = value?.type === 'Call' ? this.libraryCallEffect(value) : undefined
    const arithmeticValue =
      ['python.string', 'python.strings', 'python.numbers'].includes(
        this.arithmeticResultType(value) ?? ''
      ) ||
      (value?.type === 'Name' && this.arithmeticResultType(value) === 'python.scalar') ||
      (value?.type === 'Constant' &&
        ['int', 'float', 'complex', 'bool'].includes(value.constKind ?? '')) ||
      value?.type === 'BinOp' ||
      value?.type === 'UnaryOp' ||
      (value && this.isReadOnlyArithmeticCall(value))
    const returnType =
      libraryEffect?.returnType ??
      (value?.type === 'Attribute' ? this.libraryPropertyEffect(value)?.returnType : undefined) ??
      (value?.type === 'Subscript' ? this.librarySubscriptType(value) : undefined) ??
      (arithmeticValue ? this.arithmeticResultType(value) : undefined)
    const destructuredReturnTypes = libraryEffect?.destructuredReturnTypes
    // Preserve fresh containers and scalars in simultaneous unpacking. Resolve all
    // RHS types before rebinding any target (including swaps and repeated names).
    const literalParts =
      ['Tuple', 'List'].includes(target?.type ?? '') &&
      ['Tuple', 'List'].includes(value?.type ?? '') &&
      target?.elts?.every((item) => item.type === 'Name') &&
      target.elts.length === value?.elts?.length
        ? value.elts.map((item) =>
            ['List', 'Tuple', 'Dict', 'Set'].includes(item.type)
              ? 'python.container'
              : this.arithmeticResultType(item) === 'python.scalar'
                ? 'python.scalar'
                : undefined
          )
        : undefined
    if (value && ['BinOp', 'UnaryOp'].includes(value.type)) {
      const type = this.arithmeticResultType(value)
      if (type) this.calculatedValueTypes.set(value, type)
    }
    const literalBinding =
      value?.type === 'Name'
        ? this.literalBindings.get(value.id ?? '')
        : staticScalar(value) || staticNonemptyIterable(value)
          ? value
          : undefined
    const preservedIterationSource = this.iterationSource(value)
    const preservedIterationType = preservedIterationSource
      ? this.localLibraryTypes.get(preservedIterationSource)
      : undefined
    const unpackedTypes =
      target?.type === 'Tuple' || target?.type === 'List' ? this.iterationTypes(value) : []
    const freshCalculatedAlias =
      value?.type === 'Name' && this.freshCalculatedNames.has(value.id ?? '')
    const freshCallResult =
      libraryEffect?.returnsFreshValue &&
      value &&
      !(value.keywords ?? []).some(
        (keyword) => !keyword.arg || keyword.arg === libraryEffect.mutatesKeyword
      ) &&
      (libraryEffect.mutatesPositionalArgument === undefined ||
        (Array.isArray(value.args) ? value.args.length : 0) <=
          libraryEffect.mutatesPositionalArgument)

    const subscriptType =
      value?.type === 'Subscript' ? this.iterationTypes(value.value as PyNode)[0] : undefined
    if (node.type === 'AnnAssign' && node.annotation) this.visit(node.annotation)
    this.prepareAssignment(targetNames)
    if (
      target?.type === 'Name' &&
      target.id &&
      value &&
      (['BinOp', 'UnaryOp', 'Constant'].includes(value.type) ||
        freshCalculatedAlias ||
        freshCallResult ||
        (libraryEffect?.effect === 'read' && returnType === 'python.scalar'))
    )
      this.freshCalculatedNames.add(target.id)
    if (target?.type === 'Name' && target.id && literalBinding && this.controlDepth === 0)
      this.literalBindings.set(target.id, literalBinding)
    if (literalParts?.every(Boolean)) {
      this.addLibrarySummaries()
      for (const [index, name] of targetNames.entries()) {
        const typeName = literalParts[index]!
        this.localLibraryTypes.set(name, typeName)
        this.builtinContainers.delete(name)
        if (typeName === 'python.container') {
          this.builtinContainers.add(name)
          for (const source of this.expressionVisibleRoots(value!.elts![index]))
            this.addPossibleAlias(name, source)
        }
        this.typeBindings.push({ target: name, typeName, argumentNames: [] })
      }
    }
    if (diagnosticValue && !diagnosticValue.observed && target?.type === 'Name' && target.id) {
      this.diagnosticValues.set(target.id, diagnosticValue.kind)
    }
    if (
      this.controlDepth === 0 &&
      target?.type === 'Name' &&
      target.id &&
      knownNonemptyIterableShape(value)
    ) {
      this.contextualStaticCollections.add(target.id)
    }
    if (target?.type === 'Name' && target.id && preservedIterationType) {
      this.addLibrarySummaries()
      this.localLibraryTypes.set(target.id, preservedIterationType)
    } else if (
      target?.type === 'Name' &&
      target.id &&
      returnType &&
      PYTHON_LIBRARY_EFFECTS[returnType]
    ) {
      this.addLibrarySummaries()
      this.localLibraryTypes.set(target.id, returnType)
      if (['python.container', 'python.strings', 'python.numbers'].includes(returnType))
        this.builtinContainers.add(target.id)
      if (
        arithmeticValue ||
        value?.type === 'Attribute' ||
        (value && this.procedureReturnTypes.has(value))
      )
        this.typeBindings.push({ target: target.id, typeName: returnType, argumentNames: [] })
    } else if (destructuredReturnTypes?.length) {
      this.addLibrarySummaries()
      for (const [index, targetName] of targetNames.entries()) {
        const typeName = pythonUnpackedReturnType(
          destructuredReturnTypes,
          nestedUnpacking ? resultPaths[index]! : [index]
        )
        if (typeName && PYTHON_LIBRARY_EFFECTS[typeName]) {
          this.localLibraryTypes.set(targetName, typeName)
          if (typeName === 'python.container') this.builtinContainers.add(targetName)
        }
      }
    } else if (unpackedTypes.length) {
      this.addLibrarySummaries()
      for (const [index, targetName] of targetNames.entries()) {
        const typeName =
          unpackedTypes[index] ?? (unpackedTypes.length === 1 ? unpackedTypes[0] : '')
        if (typeName && PYTHON_LIBRARY_EFFECTS[typeName]) {
          this.localLibraryTypes.set(targetName, typeName)
        }
      }
    } else if (target?.type === 'Name' && target.id && subscriptType) {
      this.addLibrarySummaries()
      this.localLibraryTypes.set(target.id, subscriptType)
    }
    if (target?.type === 'Name' && target.id && lambdaSummary) {
      this.typeSummaries.push(lambdaSummary)
      this.typeBindings.push({
        target: target.id,
        typeName: lambdaSummary.name,
        argumentNames: []
      })
    } else if (target?.type === 'Name' && target.id && conditionalSources.size) {
      const localSources = [...conditionalSources].every((source) => {
        const pending = [source],
          seen = new Set<string>()
        while (pending.length) {
          const name = pending.pop()!
          if (seen.has(name)) continue
          seen.add(name)
          if (!this.defined.has(name)) return false
          const alias = this.aliases.get(name)
          if (alias) pending.push(alias)
          for (const possible of this.possibleAliases) {
            const [target, source] = possible.split('\0')
            if (target === name) pending.push(source!)
          }
        }
        return true
      })
      if (!this.isolatedLoopEffects.length || !localSources)
        this.unknown.add('conditional-expression')
      for (const source of conditionalSources) this.addPossibleAlias(target.id, source)
    } else if (
      target?.type === 'Name' &&
      target.id &&
      value?.type === 'Name' &&
      aliasSource &&
      returnType !== 'python.scalar'
    ) {
      if (this.controlDepth > 0) this.addPossibleAlias(target.id, aliasSource)
      else this.aliases.set(target.id, aliasSource)
    } else if (
      target?.type === 'Name' &&
      target.id &&
      value &&
      (value.type === 'Attribute' || value.type === 'Subscript')
    ) {
      if (memberSource) this.addPossibleAlias(target.id, memberSource, memberAccess, member)
      if (value.type === 'Attribute' && importedMemberModule && member) {
        this.bindLibraryModule(target.id, `${importedMemberModule}.${member}`)
        this.bindLibraryFunction(target.id, importedMemberModule, member)
        if (!this.importedModules.has(target.id) && !this.importedFunctions.has(target.id)) {
          this.bindUnknownImport(target.id, importedMemberModule, member)
        }
      }
    } else if (
      constructor &&
      !(value && this.procedureReturnTypes.has(value)) &&
      target?.type === 'Name' &&
      target.id &&
      isPyNode(value?.func) &&
      value?.func.type === 'Name'
    ) {
      this.typeBindings.push({
        target: target.id,
        typeName: value.func.id ?? '',
        argumentNames: [...constructorArguments].sort()
      })
    } else if (
      target?.type === 'Name' &&
      target.id &&
      value &&
      ['Dict', 'List', 'Tuple', 'Set', 'ListComp', 'DictComp', 'SetComp'].includes(value.type)
    ) {
      this.builtinContainers.add(target.id)
    }
    if (value && this.procedureReturnAliases.has(value)) {
      for (const [index, sources] of this.procedureReturnAliases.get(value)!) {
        const name = target?.type === 'Name' ? target.id : targetNames[index]
        if (name) for (const source of sources) this.addPossibleAlias(name, source)
      }
    }
  }

  visit_Assign(node: PyNode): void {
    const pathValue = pythonStaticString(
      isPyNode(node.value) ? node.value : undefined,
      this.serializedPathBindings,
      {
        collections: new Map(),
        importedNames: this.importedCanonicalNames,
        shadowedNames: this.defined
      }
    )
    const targetNames = (node.targets ?? []).flatMap((target) => this.assignedNames(target))
    const target = (node.targets ?? []).length === 1 ? node.targets![0] : undefined
    this.bindAssignmentValue(
      node,
      target,
      isPyNode(node.value) ? node.value : undefined,
      targetNames
    )
    for (const assigned of node.targets ?? []) this.visit(assigned)
    if (pathValue !== undefined && this.controlDepth === 0)
      for (const assigned of node.targets ?? [])
        if (assigned.type === 'Name' && assigned.id)
          this.serializedPathBindings.set(assigned.id, pathValue)
  }

  visit_AnnAssign(node: PyNode): void {
    this.bindAssignmentValue(
      node,
      node.target,
      isPyNode(node.value) ? node.value : undefined,
      this.assignedNames(node.target)
    )
    if (node.target) this.visit(node.target)
  }

  visit_NamedExpr(node: PyNode): void {
    if (this.comprehensionDepth) this.unknown.add('comprehension-scope')
    this.bindAssignmentValue(
      node,
      node.target,
      isPyNode(node.value) ? node.value : undefined,
      this.assignedNames(node.target)
    )
    if (node.target) this.visit(node.target)
  }

  visit_If(node: PyNode): void {
    const selected = staticBoolean(node.test)
    if (selected !== undefined) {
      if (node.test) this.visit(node.test)
      const statements = selected ? node.body : node.orelse
      for (const statement of Array.isArray(statements) ? statements : []) this.visit(statement)
      return
    }
    // Conditional replacement of an existing scalar retains a definite scalar
    // binding on either path. Visit the condition and RHS normally so their
    // dependencies and any unsupported effects are still recorded.
    const replacements = [...(Array.isArray(node.body) ? node.body : []), ...(node.orelse ?? [])]
    if (
      this.controlDepth === 0 &&
      replacements.length > 0 &&
      replacements.every((statement) => {
        const target = statement.targets?.[0]
        return (
          statement.type === 'Assign' &&
          statement.targets?.length === 1 &&
          target?.type === 'Name' &&
          this.defined.has(target.id ?? '') &&
          !this.conditionallyDefined.has(target.id ?? '') &&
          !this.aliases.has(target.id ?? '') &&
          ![...this.possibleAliases].some((alias) => alias.split('\0')[0] === target.id) &&
          this.arithmeticResultType(target) === 'python.scalar' &&
          this.arithmeticResultType(statement.value as PyNode) === 'python.scalar'
        )
      })
    ) {
      if (node.test) this.visit(node.test)
      for (const statement of replacements) this.visit(statement)
      return
    }
    if (this.localAggregationDepth === 0) {
      const branchValue = (
        branch: PyNode | PyNode[] | undefined
      ): { name: string; type: string } | undefined => {
        if (!Array.isArray(branch) || branch.length !== 1) return undefined
        const assignment = branch[0]!
        const target = assignment.targets?.[0]
        if (
          assignment.type !== 'Assign' ||
          assignment.targets?.length !== 1 ||
          target?.type !== 'Name' ||
          !target.id ||
          !isPyNode(assignment.value) ||
          assignment.value.type !== 'Call'
        )
          return undefined
        const effect = this.libraryCallEffect(assignment.value)
        const readOnly = walkPy(assignment.value)
          .filter((value) => value.type === 'Call')
          .every((value) => {
            const call = this.libraryCallEffect(value)
            return (
              call?.effect === 'read' &&
              !call.unsafeNamespace &&
              !call.externalState &&
              !call.scopedOpaque &&
              !call.callbackKeywords?.length &&
              !call.callbackAllKeywords &&
              !call.callbackContainerKeywords?.length &&
              !call.mutatesKeyword &&
              !call.mutatesReceiverUnlessKeywordFalse &&
              call.mutatesPositionalArgument === undefined &&
              !call.possiblyMutatesFirstArgument &&
              !call.possiblyMutatesKeyword &&
              call.possiblyMutatesPositionalArgument === undefined
            )
          })
        return readOnly && effect?.returnType
          ? { name: target.id, type: effect.returnType }
          : undefined
      }
      const yes = branchValue(node.body),
        no = branchValue(node.orelse)
      // Both alternatives produce the same known value type. The selected value
      // still depends on the condition and both possible inputs, but never on an
      // earlier kernel binding. Keep call effects and possible aliases intact.
      if (this.controlDepth === 0 && yes && no && yes.name === no.name && yes.type === no.type) {
        if (node.test) this.visit(node.test)
        const firstCall = this.receiverCalls.length
        this.controlDepth += 1
        for (const statement of [
          ...(Array.isArray(node.body) ? node.body : []),
          ...(node.orelse ?? [])
        ])
          this.visit(statement)
        this.controlDepth -= 1
        this.conditionallyDefined.delete(yes.name)
        for (const call of this.receiverCalls.slice(firstCall)) delete call.conditional
        return
      }
      this.visit_control(node)
      return
    }
    if (node.test) this.visit(node.test)
    const body = Array.isArray(node.body) ? node.body : []
    const alternative = Array.isArray(node.orelse) ? node.orelse : []
    for (const statement of [...body, ...alternative]) this.visit(statement)
  }

  knownProcedureIterator(node: PyNode | undefined): boolean {
    if (!node) return false
    if (['List', 'Tuple', 'Set', 'Dict'].includes(node.type)) return true
    if (this.builtinContainers.has(rootName(node) ?? '')) return true
    if (
      node.type === 'Call' &&
      node.func?.type === 'Attribute' &&
      BUILTIN_CONTAINER_VIEW_METHODS.has(node.func.attr ?? '') &&
      this.builtinContainers.has(rootName(node.func.value as PyNode) ?? '') &&
      !(Array.isArray(node.args) && node.args.length) &&
      !node.keywords?.length
    )
      return true
    if (
      node.type === 'Call' &&
      node.func?.type === 'Name' &&
      !this.defined.has(node.func.id ?? '')
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      if (node.func.id === 'range') return true
      if (node.func.id === 'enumerate') return this.knownProcedureIterator(args[0])
      if (node.func.id === 'zip') return args.every((arg) => this.knownProcedureIterator(arg))
    }
    return this.iterationTypes(node).length > 0
  }

  visit_For(node: PyNode): void {
    if (this.checkingFunction && !this.knownProcedureIterator(node.iter))
      this.unresolvedFunctionCall = true
    const deterministic = staticNonemptyIterable(
      node.iter?.type === 'Name'
        ? (this.literalBindings.get(node.iter.id ?? '') ?? node.iter)
        : node.iter,
      this.contextualStaticCollections
    )
    const structurallyNonempty = knownNonemptyIterableShape(node.iter)
    const scoped = this.scopedLoops.has(node)
    const isolatedConditionalNames = this.isolatedConditionalLoops.get(node)
    const body = Array.isArray(node.body) ? node.body : []
    if (
      isolatedConditionalNames &&
      loopReadsUninitializedTemporary(
        body,
        isolatedConditionalNames,
        new Set(
          [...this.defined]
            .filter((name) => !this.conditionallyDefined.has(name))
            .concat(
              this.assignedNames(node.target),
              this.isolatedLoopEffects.flatMap((loop) => [...loop.initializedNames]),
              this.checkingFunction ? [] : [...this.contextualKernelNames]
            )
        )
      )
    ) {
      this.visit_control(node)
      return
    }
    const localAggregationNames = scoped ? localAggregationLoopMutationNames(body) : undefined
    const localAggregation =
      localAggregationNames &&
      [...localAggregationNames].every(
        (name) =>
          this.defined.has(name) &&
          !this.aliases.has(name) &&
          ![...this.possibleAliases].some((alias) => alias.startsWith(`${name}\0`))
      )
    const effectOnly = effectOnlyLoopBody(body)
    const bodyIsSafe =
      effectOnly ||
      ((deterministic || structurallyNonempty) &&
        deterministicLoopBody(body, this.calculatedReturnName)) ||
      Boolean(localAggregation)
    // A statically nonempty iterator still needs scoped effects when an early
    // exit prevents treating its body as unconditional.
    const needsScopedControl =
      !bodyIsSafe &&
      body.some(
        (statement) =>
          statement.type === 'For' ||
          walkPy(statement).some((child) => ['Break', 'Continue'].includes(child.type))
      )
    if (isolatedConditionalNames && !localAggregation && (!deterministic || needsScopedControl)) {
      const temporaryValuesOnly = loopBodyWithTemporaryValues(body)
      const localNames = new Set(
        [...this.defined].filter((name) => {
          const seen = new Set<string>()
          while (!seen.has(name)) {
            seen.add(name)
            if (!this.defined.has(name) || this.conditionallyDefined.has(name)) return false
            const source = this.aliases.get(name)
            if (!source || this.importedModules.has(name) || this.importedFunctions.has(name))
              return true
            name = source
          }
          return false
        })
      )
      for (const loop of this.isolatedLoopEffects)
        for (const name of loop.initializedNames) localNames.add(name)
      if (node.iter) this.visit(node.iter)
      const targetNames = this.assignedNames(node.target)
      this.controlDepth += 1
      this.prepareAssignment(targetNames)
      for (const name of targetNames) this.defined.add(name)
      const sources = this.loopSourceNames(node.iter)
      const targetTypes = this.loopLibraryTypes(node.iter, targetNames)
      this.bindTypedLoopValues(node.iter, targetNames, sources, targetTypes)
      this.localScopes.push(
        Object.fromEntries(targetNames.map((name, index) => [name, sources[index] ?? sources[0]]))
      )
      this.localLibraryTypeScopes.push(
        Object.fromEntries(targetNames.map((name, index) => [name, targetTypes[index]]))
      )
      this.isolatedLoopEffects.push({
        depth: this.controlDepth + 1,
        localNames,
        assignmentDepth: this.controlDepth,
        initializedNames: new Set(targetNames)
      })
      for (const statement of body) {
        const scopedEffect =
          temporaryValuesOnly && !['Assign', 'AnnAssign'].includes(statement.type)
        if (scopedEffect) this.controlDepth -= 1
        this.visit(statement)
        if (scopedEffect) this.controlDepth += 1
      }
      this.isolatedLoopEffects.pop()
      this.localLibraryTypeScopes.pop()
      this.localScopes.pop()
      this.controlDepth -= 1
      for (const name of isolatedConditionalNames) {
        if (this.conditionallyDefined.has(name)) this.isolatedConditionallyDefined.add(name)
      }
      for (const statement of node.orelse ?? []) this.visit(statement)
      return
    }
    if (!simpleLoopTarget(node.target) || !bodyIsSafe || !(deterministic || scoped)) {
      this.visit_control(node)
      return
    }
    if (node.iter) this.visit(node.iter)
    const targetNames = this.assignedNames(node.target)
    if (deterministic) {
      this.prepareAssignment(targetNames)
      for (const name of targetNames) this.defined.add(name)
    }
    const sources = this.loopSourceNames(node.iter)
    const targetTypes = this.loopLibraryTypes(node.iter, targetNames)
    this.bindTypedLoopValues(node.iter, targetNames, sources, targetTypes)
    this.localScopes.push(
      Object.fromEntries(targetNames.map((name, index) => [name, sources[index] ?? sources[0]]))
    )
    this.localLibraryTypeScopes.push(
      Object.fromEntries(targetNames.map((name, index) => [name, targetTypes[index]]))
    )
    if (localAggregation) this.localAggregationDepth += 1
    for (const statement of body) this.visit(statement)
    if (localAggregation) this.localAggregationDepth -= 1
    this.localLibraryTypeScopes.pop()
    this.localScopes.pop()
    for (const statement of node.orelse ?? []) this.visit(statement)
  }

  visit_Return(node: PyNode): void {
    if (
      this.calculatedReturnName &&
      (!['python.scalar', 'numpy.ndarray'].includes(
        this.arithmeticResultType(node.value as PyNode) ?? ''
      ) ||
        this.conditionallyDefined.has(this.calculatedReturnName))
    )
      this.unresolvedFunctionCall = true
    this.genericVisit(node)
  }

  visit_AsyncFor = this.visit_control
  visit_While = this.visit_control
  visit_Try = this.visit_control
  visit_Match = this.visit_control

  knownLibraryPredicate(node: PyNode | undefined): boolean | undefined {
    if (
      node?.type !== 'Call' ||
      node.func?.type !== 'Name' ||
      node.func.id !== 'hasattr' ||
      this.defined.has('hasattr') ||
      this.importedFunctions.has('hasattr') ||
      node.keywords?.length
    )
      return undefined
    const args = Array.isArray(node.args) ? node.args : []
    if (args.length !== 2 || args[1]?.type !== 'Constant' || args[1].value !== 'iloc')
      return undefined
    const type = this.libraryTypeName(args[0])
    if (type === 'numpy.ndarray') return false
    if (type === 'pandas.DataFrame' || type === 'pandas.Series') return true
    return undefined
  }

  visit_IfExp(node: PyNode): void {
    const selected = staticBoolean(node.test) ?? this.knownLibraryPredicate(node.test)
    if (selected !== undefined) {
      if (node.test) this.visit(node.test)
      const branch = selected ? node.body : node.alternate
      if (isPyNode(branch)) this.visit(branch)
      return
    }
    this.controlDepth += 1
    this.genericVisit(node)
    this.controlDepth -= 1
  }

  visit_FunctionDef(node: PyNode): void {
    if (node.name) {
      this.prepareAssignment([node.name])
      this.defined.add(node.name)
    }
    if (
      node.name &&
      node.type === 'FunctionDef' &&
      (this.controlDepth === 0 || this.isolatedLoopEffects.length > 0)
    ) {
      const signature = node.args as PyArguments
      this.localFunctions.set(node.name, {
        ...node,
        args: {
          ...signature,
          defaults: (signature.defaults ?? []).map((value) =>
            value.type === 'Name' ? (this.literalBindings.get(value.id ?? '') ?? value) : value
          )
        }
      })
      const definition = this.localFunctions.get(node.name)!
      this.localFunctionDefaultVersions.set(
        definition,
        new Map(
          (signature.defaults ?? []).flatMap((value) =>
            value.type === 'Name' &&
            this.freshCalculatedNames.has(value.id ?? '') &&
            ['python.scalar', 'numpy.ndarray'].includes(this.arithmeticResultType(value) ?? '')
              ? [[value.id!, this.assignmentVersions.get(value.id!) ?? 0]]
              : []
          )
        )
      )
    }
    const summary = summarizeFunction(node)
    if (node.name && summary) {
      this.typeSummaries.push(summary)
      this.typeBindings.push({ target: node.name, typeName: summary.name, argumentNames: [] })
    } else this.unknown.add('function-scope')
    const fnArgs = node.args as PyArguments | undefined
    for (const value of [
      ...(node.decorator_list ?? []),
      ...(fnArgs?.defaults ?? []),
      ...(fnArgs?.kw_defaults ?? []).filter((item): item is PyNode => Boolean(item))
    ]) {
      this.visit(value)
    }
  }
  visit_AsyncFunctionDef = this.visit_FunctionDef

  visit_ClassDef(node: PyNode): void {
    if (node.name) {
      this.prepareAssignment([node.name])
      this.defined.add(node.name)
    }
    const summary = summarizeClass(node)
    if (summary) this.typeSummaries.push(summary)
    else this.unknown.add('class-scope')
    for (const value of [
      ...(node.decorator_list ?? []),
      ...(node.bases ?? []),
      ...(node.classKeywords ?? [])
    ]) {
      this.visit(isPyNode(value) ? value : (value as PyKeyword).value)
    }
  }

  visit_Lambda(node: PyNode): void {
    const summary = this.pureInlineCallbacks.get(node)
    if (!summary) {
      this.unknown.add('lambda-scope')
      return
    }
    for (const name of summary.usedNames ?? []) this.addUsed(name)
    for (const name of summary.safeCallNames ?? []) this.safeCallNames.add(name)
  }

  visitComprehension(node: PyNode, values: Array<PyNode | undefined>): void {
    this.comprehensionDepth += 1
    const scope: Record<string, string | undefined> = {}
    const typeScope: Record<string, string | undefined> = {}
    this.localScopes.push(scope)
    this.localLibraryTypeScopes.push(typeScope)
    for (const generator of node.generators ?? []) {
      if (this.checkingFunction && !this.knownProcedureIterator(generator.iter))
        this.unresolvedFunctionCall = true
      this.visit(generator.iter)
      const sources = this.loopSourceNames(generator.iter)
      const targetNames = this.assignedNames(generator.target)
      const targetTypes = this.loopLibraryTypes(generator.iter, targetNames)
      for (const [index, name] of targetNames.entries()) {
        scope[name] = sources[index] ?? sources[0]
        typeScope[name] = targetTypes[index]
      }
      for (const condition of generator.ifs) this.visit(condition)
    }
    for (const value of values) this.visit(value)
    this.comprehensionDepth -= 1
    this.localLibraryTypeScopes.pop()
    this.localScopes.pop()
  }

  visit_ListComp(node: PyNode): void {
    this.visitComprehension(node, [node.elt])
  }
  visit_SetComp(node: PyNode): void {
    this.visitComprehension(node, [node.elt])
  }
  visit_DictComp(node: PyNode): void {
    this.visitComprehension(node, [node.key, isPyNode(node.value) ? node.value : undefined])
  }
  visit_GeneratorExp(node: PyNode): void {
    this.visitComprehension(node, [node.elt])
  }

  visit_AugAssign(node: PyNode): void {
    const name = this.visibleRootName(node.target)
    if (name) {
      if (node.target?.type === 'Name')
        this.assignmentVersions.set(name, (this.assignmentVersions.get(name) ?? 0) + 1)
      const retainsFreshValue =
        node.target?.type === 'Name' &&
        this.freshCalculatedNames.has(name) &&
        staticScalar(isPyNode(node.value) ? node.value : undefined)
      this.addUsed(name)
      const patchedMember = node.target ? dynamicMemberWrite(node.target) : undefined
      if (!patchedMember || !patchedMember[1]) this.addMutation(name)
      if (patchedMember) {
        const [member, typeWide] = patchedMember
        this.memberWrites.push({
          receiver: name,
          ...this.conditionalFact(),
          ...(member ? { member } : {}),
          ...(typeWide ? { scope: 'type' as const } : {})
        })
      }
      if (this.builtinModuleNames.has(name)) this.unknown.add('dynamic-namespace')
      if (retainsFreshValue) this.freshCalculatedNames.add(name)
    } else {
      this.unknown.add('dynamic-assignment')
      if (node.target) this.visit(node.target)
    }
    if (isPyNode(node.value)) this.visit(node.value)
  }

  visit_Subscript(node: PyNode): void {
    if (isPyNode(node.value) && this.libraryTypeName(node.value) === 'matplotlib.RcParams') {
      if (!this.checkingFunction) {
        this.pythonPlottingState.reads = true
        if (node.ctx === 'Store' || node.ctx === 'Del') this.pythonPlottingState.writes = true
      } else if (node.ctx === 'Store' || node.ctx === 'Del') this.unresolvedFunctionCall = true
      // Updating a configuration mapping does not replace methods on its owning module.
      this.visit(node.value)
      if (node.slice) this.visit(node.slice)
      return
    }
    if (node.ctx === 'Store' || node.ctx === 'Del') {
      const name = this.visibleRootName(node)
      if (name) {
        this.addUsed(name)
        const patchedMember = dynamicMemberWrite(node)
        if (!patchedMember || !patchedMember[1]) this.addMutation(name)
        if (patchedMember) {
          const [member, typeWide] = patchedMember
          this.memberWrites.push({
            receiver: name,
            ...this.conditionalFact(),
            ...(member ? { member } : {}),
            ...(typeWide ? { scope: 'type' as const } : {})
          })
        }
        if (this.builtinModuleNames.has(name)) this.unknown.add('dynamic-namespace')
      } else {
        this.unknown.add('dynamic-assignment')
        if (isPyNode(node.value)) this.visit(node.value)
      }
      if (node.slice) this.visit(node.slice)
      return
    }
    this.genericVisit(node)
  }

  visit_Attribute(node: PyNode): void {
    if (node.ctx === 'Store' || node.ctx === 'Del') {
      const name = this.visibleRootName(node)
      if (name) {
        const imported = this.importedCanonicalNames.get(name)
        if (imported) {
          this.taintedNamespaces.add(imported.split('.')[0]!)
          this.unknown.add('dynamic-namespace')
        }
        if (this.diagnosticValues.get(name) === 'path') this.taintedNamespaces.add('pathlib')
        this.diagnosticValues.delete(name)
        this.addUsed(name)
        const patchedMember = dynamicMemberWrite(node)
        const [member, typeWide] = patchedMember ?? [node.attr, false]
        if (!typeWide) this.addMutation(name)
        this.memberWrites.push({
          receiver: name,
          ...this.conditionalFact(),
          ...(member ? { member } : {}),
          ...(typeWide ? { scope: 'type' as const } : {})
        })
        if (this.builtinModuleNames.has(name)) this.unknown.add('dynamic-namespace')
      } else {
        this.unknown.add('dynamic-assignment')
        if (isPyNode(node.value)) this.visit(node.value)
      }
      return
    }
    this.genericVisit(node)
  }

  // Specialize a same-cell helper against its actual argument types and fresh return values.
  // The ordinary conservative callable summary remains valid for other calls/cells.
  // No function body is executed and no live kernel objects enter this analysis.
  analyzeLocalProcedure(call: PyNode): boolean {
    if (this.functionDepth >= 3 || call.func?.type !== 'Name') return false
    const definition = this.localFunctions.get(call.func.id ?? '')
    if (!definition || (definition.decorator_list ?? []).length || this.memberWrites.length)
      return false
    const signature = definition.args as PyArguments
    if (
      signature.vararg ||
      signature.kwarg ||
      signature.kwonlyargs?.length ||
      signature.posonlyargs?.length
    )
      return false
    const parameters = signature.args ?? []
    const args = Array.isArray(call.args) ? call.args : []
    if (args.length > parameters.length || args.some((arg) => arg.type === 'Starred')) return false
    const supplied = new Map<string, PyNode>()
    parameters.forEach((parameter, index) => {
      if (args[index]) supplied.set(parameter.arg, args[index]!)
    })
    for (const keyword of call.keywords ?? []) {
      if (
        !keyword.arg ||
        supplied.has(keyword.arg) ||
        !parameters.some((parameter) => parameter.arg === keyword.arg)
      )
        return false
      supplied.set(keyword.arg, keyword.value)
    }
    const defaults = signature.defaults ?? []
    for (const [index, parameter] of parameters.entries()) {
      if (supplied.has(parameter.arg)) continue
      const fallback = defaults[index - (parameters.length - defaults.length)]
      // Mutable/captured defaults have definition-time identity; do not rebind them at invocation.
      const capturedVersion =
        fallback?.type === 'Name'
          ? this.localFunctionDefaultVersions.get(definition)?.get(fallback.id ?? '')
          : undefined
      // Keep definition-time identity only while that binding has not been replaced.
      // The actual name/type is retained so mutation of an array default is exported.
      if (
        !fallback ||
        (!immutableLiteral(fallback) &&
          (capturedVersion === undefined ||
            this.assignmentVersions.get(fallback.id!) !== capturedVersion))
      )
        return false
      supplied.set(parameter.arg, fallback)
    }
    const body = Array.isArray(definition.body) ? definition.body : []
    const scopedNodes = (node: PyNode): PyNode[] => [
      node,
      ...(node.type === 'FunctionDef' ? [] : pyChildren(node).flatMap(scopedNodes))
    ]
    const nodes = body.flatMap(scopedNodes)
    this.procedureBudget.remaining -= nodes.length
    if (this.procedureBudget.remaining < 0) return false
    if (
      nodes.some((node) =>
        [
          'Global',
          'Nonlocal',
          'Import',
          'ImportFrom',
          'AsyncFunctionDef',
          'ClassDef',
          'Lambda',
          'Yield',
          'YieldFrom',
          'Await',
          'With',
          'AsyncWith',
          'Try',
          'While',
          'Delete',
          'Raise',
          'Break'
        ].includes(node.type)
      )
    )
      return false
    const parameterTypes = new Map(
      [...supplied].flatMap(([name, value]) => {
        const type =
          value.type === 'Call'
            ? this.libraryCallEffect(value)?.returnType
            : (this.arithmeticResultType(value) ?? this.libraryTypeName(value))
        return type ? [[name, type] as const] : []
      })
    )
    const returns = nodes.filter((node) => node.type === 'Return')
    const finalReturn = returns.at(-1)
    const sameCalculatedReturns =
      returns.length > 1 &&
      finalReturn === body.at(-1) &&
      isPyNode(finalReturn?.value) &&
      finalReturn.value.type === 'Name' &&
      returns.every(
        (node) =>
          isPyNode(node.value) &&
          node.value.type === 'Name' &&
          node.value.id === (finalReturn!.value as PyNode).id
      )
    if (
      (returns.length > 1 && !sameCalculatedReturns) ||
      (returns.length === 1 && returns[0] !== body.at(-1))
    )
      return false
    if (!returns.length && !parameterTypes.size) return false
    const tree = py('Module', { body }, ['body'])
    const child = new Analyzer(scopedEffectLoops(tree), isolatedConditionalLoopNames(tree))
    child.calculatedReturnName = sameCalculatedReturns
      ? (finalReturn!.value as PyNode).id
      : undefined
    child.checkingFunction = true
    child.namespaceLoads = namespaceLoadLines(tree)
    child.consoleRedirected = this.consoleRedirected || pythonRedirectsConsole(tree)
    child.functionDepth = this.functionDepth + 1
    child.procedureBudget = this.procedureBudget
    child.localFunctions = new Map(this.localFunctions)
    child.assignmentVersions = new Map(this.assignmentVersions)
    child.localFunctionDefaultVersions = new Map(this.localFunctionDefaultVersions)
    child.literalBindings = new Map(this.literalBindings)
    child.localFunctions.delete(call.func.id ?? '')
    child.importedModules = new Map(this.importedModules)
    child.importedFunctions = new Map(this.importedFunctions)
    child.importedCanonicalNames = new Map(this.importedCanonicalNames)
    child.localLibraryTypes = new Map(this.localLibraryTypes)
    child.builtinContainers = new Set(this.builtinContainers)
    child.taintedNamespaces = new Set(this.taintedNamespaces)
    // Globals are captured at call time; parameters shadow them.
    for (const [name] of supplied) {
      child.prepareAssignment([name])
      child.defined.add(name)
      if (parameterTypes.has(name)) child.localLibraryTypes.set(name, parameterTypes.get(name)!)
      if (
        ['python.container', 'python.strings', 'python.numbers'].includes(
          parameterTypes.get(name) ?? ''
        )
      )
        child.builtinContainers.add(name)
    }
    const locals = new MethodNameVisitor()
    for (const statement of body) locals.visit(statement)
    for (const node of nodes)
      if (node.type === 'FunctionDef' && node.name) locals.locals.add(node.name)
    if (
      [...locals.locals].some(
        (name) =>
          supplied.has(name) &&
          !['python.string', 'python.scalar'].includes(parameterTypes.get(name) ?? '')
      )
    )
      return false
    for (const name of locals.locals) if (!supplied.has(name)) child.prepareAssignment([name])
    for (const statement of body) child.visit(statement)
    if (
      child.unresolvedFunctionCall ||
      child.memberWrites.length ||
      [...child.unknown].some((reason) => reason !== 'control-flow')
    )
      return false
    if (
      [...child.aliases.values()].some(
        (source) => !locals.locals.has(source) && !supplied.has(source)
      ) ||
      [...child.possibleAliases].some((alias) => {
        const [target, source] = alias.split('\0')
        if (locals.locals.has(source!)) return false
        // A borrowed global may be read while constructing a fresh result. The
        // return checks below still reject escaped views; mutations remain unknown.
        return (
          child.mutated.has(target!) ||
          child.possiblyMutated.has(target!) ||
          child.receiverCalls.some((record) => record.receiver === target)
        )
      })
    )
      return false
    let returnedType: string | undefined
    let returnedShape: string[] | undefined
    const returnedAliases = new Map<number, string[]>()
    if (returns.length) {
      const returned = isPyNode(returns[0]?.value) ? returns[0].value : undefined
      // Eager value aggregates are common in geometry helpers. Only accept freshly
      // calculated leaves; returning an argument or a view still needs alias analysis.
      const freshValue = (value: PyNode | undefined, seen = new Set<string>()): boolean => {
        if (--this.procedureBudget.remaining < 0) return false
        if (!value) return false
        if (staticScalar(value)) return true
        if (
          value.type === 'Name' &&
          ['python.scalar', 'python.string'].includes(child.arithmeticResultType(value) ?? '')
        )
          return true
        if (value.type === 'Starred') return freshValue(value.value as PyNode, seen)
        if (value.type === 'Name' && locals.locals.has(value.id ?? '') && !seen.has(value.id!)) {
          const assignments = nodes.filter(
            (item) =>
              item.type === 'Assign' &&
              item.targets?.some((target) => target.type === 'Name' && target.id === value.id)
          )
          if (assignments.length !== 1 || child.conditionallyDefined.has(value.id!)) return false
          const aliases = new Set([value.id!])
          for (let size = 0; size !== aliases.size;) {
            size = aliases.size
            for (const [target, source] of child.aliases)
              if (aliases.has(source)) aliases.add(target)
          }
          if (
            nodes.some(
              (item) =>
                (item.type === 'Call' &&
                  item.func?.type === 'Attribute' &&
                  aliases.has(rootName(item.func.value as PyNode) ?? '')) ||
                (['Assign', 'AnnAssign', 'AugAssign'].includes(item.type) &&
                  [...(item.targets ?? []), item.target].some(
                    (target) =>
                      target && target.type !== 'Name' && aliases.has(rootName(target) ?? '')
                  ))
            )
          )
            return false
          return freshValue(assignments[0]!.value as PyNode, new Set([...seen, value.id!]))
        }
        if (value.type === 'Tuple' || value.type === 'List')
          return (value.elts ?? []).every((item) => freshValue(item, seen))
        if (value.type === 'ListComp') return freshValue(value.elt, seen)
        if (value.type === 'BinOp' || value.type === 'UnaryOp') {
          return ['python.scalar', 'numpy.ndarray'].includes(
            child.calculatedValueTypes.get(value) ?? child.arithmeticResultType(value) ?? ''
          )
        }
        if (value.type !== 'Call') return false
        const eagerArgs = Array.isArray(value.args) ? value.args : []
        if (
          value.func?.type === 'Name' &&
          ['tuple', 'list'].includes(value.func.id ?? '') &&
          !child.defined.has(value.func.id ?? '') &&
          !value.keywords?.length &&
          eagerArgs.length === 1 &&
          eagerArgs[0]?.type === 'GeneratorExp'
        )
          return freshValue(eagerArgs[0].elt, seen)
        const effect = child.libraryCallEffect(value)
        return Boolean(
          effect?.returnType &&
          [
            'python.scalar',
            'python.string',
            'python.calculated-sequence',
            'numpy.ndarray'
          ].includes(effect.returnType) &&
          effect.effect === 'read' &&
          !effect.returnsPossibleAliasOf &&
          !effect.returnsAliasOfReceiver &&
          !effect.returnsAliasOfKeyword &&
          !(
            effect.returnsPossibleAliasWhenKeywordFalse &&
            value.keywords?.some(
              (keyword) =>
                keyword.arg === effect.returnsPossibleAliasWhenKeywordFalse!.keyword &&
                !(keyword.value.type === 'Constant' && keyword.value.value === true)
            )
          ) &&
          !(
            effect.mutatesKeyword &&
            value.keywords?.some((keyword) => keyword.arg === effect.mutatesKeyword)
          ) &&
          !(
            effect.mutatesPositionalArgument !== undefined &&
            Array.isArray(value.args) &&
            value.args.length > effect.mutatesPositionalArgument
          )
        )
      }
      const returnedExpression =
        returned?.type === 'Name' && locals.locals.has(returned.id ?? '')
          ? (nodes.find(
              (item) =>
                item.type === 'Assign' &&
                item.targets?.some((target) => target.type === 'Name' && target.id === returned.id)
            )?.value as PyNode | undefined)
          : returned
      const ownedContainer = (value: PyNode): boolean => {
        if (
          value.type !== 'Name' ||
          !locals.locals.has(value.id ?? '') ||
          child.conditionallyDefined.has(value.id!)
        )
          return false
        const assignments = nodes.filter(
          (item) =>
            item.type === 'Assign' &&
            item.targets?.some((target) => target.type === 'Name' && target.id === value.id)
        )
        const initial = assignments[0]?.value as PyNode | undefined
        if (assignments.length !== 1 || initial?.type !== 'List' || initial.elts?.length)
          return false
        if (
          [...child.aliases.values()].includes(value.id!) ||
          [...child.possibleAliases].some((alias) => alias.split('\0')[1] === value.id)
        )
          return false
        return child.receiverCalls
          .filter((record) => record.receiver === value.id)
          .every((record) => record.member === 'append' && !record.receiverChain?.length)
      }
      const parts = returned?.type === 'Tuple' ? returned.elts : undefined
      const borrowedContainerSources = (): string[] => [
        ...new Set([
          ...[...supplied.values()].flatMap((value) => this.expressionVisibleRoots(value)),
          ...[...child.used.keys()].filter(
            (name) =>
              !locals.locals.has(name) &&
              !supplied.has(name) &&
              !child.importedModules.has(name) &&
              !child.importedFunctions.has(name) &&
              !child.safeCallNames.has(name)
          )
        ])
      ]
      if (returned && ownedContainer(returned)) {
        returnedType = 'python.container'
        returnedAliases.set(0, borrowedContainerSources())
      } else if (
        parts?.some(ownedContainer) &&
        parts.every(
          (part) => ownedContainer(part) || child.arithmeticResultType(part) === 'python.scalar'
        )
      ) {
        returnedType = 'python.calculated-sequence'
        returnedShape = parts.map((part, index) => {
          if (!ownedContainer(part)) return 'python.scalar'
          // The outer list is new, but its entries may contain caller-owned objects.
          // Preserve these relationships rather than treating a builder as a deep copy.
          returnedAliases.set(index, borrowedContainerSources())
          return 'python.container'
        })
      } else if (
        returned &&
        ['python.scalar', 'python.string', 'numpy.ndarray'].includes(
          child.arithmeticResultType(returned) ?? ''
        ) &&
        freshValue(returned)
      ) {
        returnedType = child.arithmeticResultType(returned)
      } else if (
        returnedExpression &&
        (['Tuple', 'List', 'ListComp'].includes(returnedExpression.type) ||
          (returnedExpression.type === 'Call' &&
            returnedExpression.func?.type === 'Name' &&
            ['tuple', 'list'].includes(returnedExpression.func.id ?? ''))) &&
        freshValue(returned)
      ) {
        returnedType = 'python.calculated-sequence'
        if (returned?.type === 'Tuple') {
          const types = (returned.elts ?? []).map((part) =>
            part.type === 'Call'
              ? child.libraryCallEffect(part)?.returnType
              : child.arithmeticResultType(part)
          )
          if (types.every((type): type is string => Boolean(type))) returnedShape = types
        }
      } else if (
        returned &&
        ['BinOp', 'UnaryOp'].includes(returned.type) &&
        walkPy(returned).every((item) =>
          ['BinOp', 'UnaryOp', 'Name', 'Constant'].includes(item.type)
        )
      ) {
        // The helper's arithmetic is understood even when a lookup's value type
        // is not. Do not invent a numeric type or discard possible returned aliases.
        returnedType = 'python.calculated-sequence'
        returnedAliases.set(
          0,
          [...supplied.values()].flatMap((value) => this.expressionVisibleRoots(value))
        )
      } else {
        // A helper may return a factory's complete destructured result (figure, axes).
        // Keep the shape only when every binding still comes from that one allocation.
        const tupleAllocation =
          returned?.type === 'Tuple'
            ? [...child.callResultNames].find(
                ([, names]) =>
                  names.length === returned.elts?.length &&
                  names.every(
                    (name, index) =>
                      returned.elts?.[index]?.type === 'Name' &&
                      returned.elts[index]?.id === name &&
                      locals.locals.has(name) &&
                      !child.conditionallyDefined.has(name) &&
                      nodes.filter(
                        (item) =>
                          ['Assign', 'AnnAssign', 'AugAssign', 'NamedExpr'].includes(item.type) &&
                          [...(item.targets ?? []), item.target].some(
                            (target) => target && loopTargetNames(target).includes(name)
                          )
                      ).length === 1
                  )
              )?.[0]
            : undefined
        const allocation =
          tupleAllocation ??
          (returned?.type === 'Call'
            ? returned
            : returned?.type === 'Name' &&
                locals.locals.has(returned.id ?? '') &&
                !child.conditionallyDefined.has(returned.id ?? '')
              ? [...child.callResultNames].find(([, names]) => names.includes(returned.id!))?.[0]
              : undefined)
        if (!allocation) return false
        const allocationRoot = rootName(allocation.func)
        if (
          !child.importedModules.has(allocationRoot ?? '') &&
          !child.importedFunctions.has(allocationRoot ?? '') &&
          !child.procedureReturnTypes.has(allocation)
        )
          return false
        const effect = child.libraryCallEffect(allocation)
        if (
          !(
            effect?.returnType ||
            (effect?.destructuredReturnTypes && (tupleAllocation || returned?.type === 'Call'))
          ) ||
          effect.effect !== 'read' ||
          effect.returnsPossibleAliasOf ||
          effect.returnsAliasOfReceiver ||
          effect.returnsAliasOfKeyword ||
          effect.returnsPossibleAliasWhenKeywordFalse
        )
          return false
        // Output buffers transfer caller-owned identity back into the return value.
        if (
          (effect.mutatesKeyword &&
            allocation.keywords?.some((keyword) => keyword.arg === effect.mutatesKeyword)) ||
          (effect.mutatesPositionalArgument !== undefined &&
            Array.isArray(allocation.args) &&
            allocation.args.length > effect.mutatesPositionalArgument)
        )
          return false
        if (
          effect.returnType === 'matplotlib.path.Path' &&
          child
            .visibleRoots(Array.isArray(allocation.args) ? allocation.args : [])
            .some((name) => !locals.locals.has(name) || child.aliases.has(name))
        )
          return false
        returnedType = effect.returnType ?? 'python.calculated-sequence'
        returnedShape = effect.destructuredReturnTypes
      }
    }
    if (sameCalculatedReturns && !['python.scalar', 'numpy.ndarray'].includes(returnedType ?? ''))
      return false
    const localNames = new Set([...locals.locals, ...supplied.keys()])
    const exported = (names: string[] = []): string[] => [
      ...new Set(
        names.flatMap((name) => {
          const seen = new Set<string>()
          while (locals.locals.has(name) && child.aliases.has(name) && !seen.has(name)) {
            seen.add(name)
            name = child.aliases.get(name)!
          }
          const value = supplied.get(name)
          return value ? this.expressionVisibleRoots(value) : localNames.has(name) ? [] : [name]
        })
      )
    ]
    // Preserve calls on captured objects/parameters so later monkeypatches and mutations
    // still flow through the normal type-aware projection instead of being declared pure.
    for (const record of child.receiverCalls) {
      if (localNames.has(record.receiver) && !supplied.has(record.receiver)) {
        if (!child.builtinContainers.has(record.receiver)) {
          const effect = pythonLibraryMethodEffect(
            child.localLibraryTypes.get(record.receiver) ?? '',
            record.member
          )
          const borrowed = (names: string[] = []): boolean =>
            names.some(
              (name) =>
                !locals.locals.has(name) ||
                supplied.has(name) ||
                child.aliases.has(name) ||
                [...child.possibleAliases].some((alias) => alias.split('\0')[0] === name)
            )
          // Only local receiver effects can disappear at the function boundary. Calls
          // that may write caller-owned arguments still require the exported record.
          if (
            record.receiverChain?.length ||
            !effect ||
            effect.effect === 'unknown' ||
            record.keywordArguments?.some(
              (keyword) =>
                keyword.name === '**' ||
                ((keyword.name === effect.mutatesKeyword ||
                  keyword.name === effect.possiblyMutatesKeyword) &&
                  borrowed([...keyword.argumentNames, ...(keyword.possibleArgumentNames ?? [])]))
            ) ||
            [
              effect.mutatesPositionalArgument,
              effect.possiblyMutatesPositionalArgument,
              ...(effect.possiblyMutatesFirstArgument ? [0] : [])
            ].some(
              (position) =>
                position !== undefined && borrowed(record.positionalArgumentNames?.[position])
            )
          )
            return false
        }
        continue
      }
      const receivers = exported([record.receiver])
      if (receivers.length !== 1) return false
    }
    for (const name of exported([...child.used.keys()])) this.addUsed(name)
    for (const name of child.safeCallNames) this.safeCallNames.add(name)
    for (const record of child.receiverCalls) {
      if (localNames.has(record.receiver) && !supplied.has(record.receiver)) continue
      this.receiverCalls.push({
        ...record,
        // Summarize every possible effect of this checked invocation. A branch
        // inside the helper does not make the caller's invocation conditional.
        conditional: undefined,
        receiver: exported([record.receiver])[0]!,
        ...this.conditionalFact(),
        argumentNames: exported(record.argumentNames),
        receiverValueNames: exported(record.receiverValueNames),
        positionalArgumentNames: record.positionalArgumentNames?.map(exported),
        receiverChainFirstArgumentNames: record.receiverChainFirstArgumentNames?.map(exported),
        receiverChainPositionalArgumentNames: record.receiverChainPositionalArgumentNames?.map(
          (argumentsList) => argumentsList.map(exported)
        ),
        receiverChainKeywordArguments: record.receiverChainKeywordArguments?.map((keywords) =>
          keywords.map((keyword) => ({
            ...keyword,
            argumentNames: exported(keyword.argumentNames)
          }))
        ),
        keywordArguments: record.keywordArguments?.map((keyword) => ({
          ...keyword,
          argumentNames: exported(keyword.argumentNames),
          possibleArgumentNames: exported(keyword.possibleArgumentNames)
        })),
        resultNames: [],
        resultPaths: []
      })
    }
    for (const name of exported([...child.mutated])) this.addMutation(name)
    this.pythonRandomStateReads ||= child.pythonRandomStateReads
    this.pythonPlottingState.reads ||= child.pythonPlottingState.reads
    this.pythonPlottingState.writes ||= child.pythonPlottingState.writes
    for (const name of exported([...child.possiblyMutated])) this.possiblyMutated.add(name)
    if (returnedType) this.procedureReturnTypes.set(call, returnedType)
    if (returnedShape) this.procedureReturnShapes.set(call, returnedShape)
    if (returnedAliases.size) this.procedureReturnAliases.set(call, returnedAliases)
    this.genericVisit(call)
    return true
  }
  visit_Call(node: PyNode): void {
    // A call can expose or mutate a local collection through aliases. Keep only immutable literals.
    for (const [name, value] of this.literalBindings)
      if (!staticScalar(value)) this.literalBindings.delete(name)
    if (this.knownLibraryPredicate(node) !== undefined) {
      this.safeCallNames.add('hasattr')
      this.genericVisit(node)
      return
    }
    if (this.analyzeLocalProcedure(node)) return
    this.trackSerializationCall(node)
    const rawCallName = pythonDottedName(node.func)
    if (rawCallName) {
      const [root, ...members] = rawCallName.split('.')
      const canonicalCallName = [this.importedCanonicalNames.get(root ?? '') ?? root, ...members]
        .filter(Boolean)
        .join('.')
      if (
        !this.acceptedSerializedReads.has(serializationSite(node)) &&
        pythonHasUnsupportedExternalState(canonicalCallName, node)
      ) {
        this.unknown.add('external-state')
        if (
          ['random', 'numpy.random'].some((namespace) =>
            canonicalCallName.startsWith(`${namespace}.`)
          )
        )
          this.unknown.add('scoped-opaque-call')
      }
      if (canonicalCallName === 'os.walk') {
        const callback =
          node.keywords?.find((keyword) => keyword.arg === 'onerror')?.value ??
          (Array.isArray(node.args) ? node.args[2] : undefined)
        if (callback && !(callback.type === 'Constant' && callback.value === null))
          this.unknown.add('scoped-opaque-call')
      }
    }
    const libraryEffect = this.libraryCallEffect(node)
    // Set operations iterate their inputs. A known container receiver alone
    // must not certify an arbitrary user-defined iterator's side effects.
    if (
      node.func?.type === 'Attribute' &&
      ['union', 'intersection', 'difference', 'symmetric_difference'].includes(
        node.func.attr ?? ''
      ) &&
      libraryEffect?.returnType === 'python.container' &&
      (Array.isArray(node.args) ? node.args : []).some(
        (arg) => !this.knownProcedureIterator(arg.type === 'Starred' ? (arg.value as PyNode) : arg)
      )
    )
      this.unknown.add('opaque-call')
    if (libraryEffect?.globalRandomState) {
      if (!this.checkingFunction) this.pythonRandomStateReads = true
      else this.unresolvedFunctionCall = true
    }
    const plottingOwner =
      node.func?.type === 'Attribute' && isPyNode(node.func.value)
        ? this.libraryTypeName(node.func.value)
        : undefined
    const plottingCall =
      libraryEffect?.plottingState ||
      plottingOwner?.startsWith('matplotlib.') ||
      plottingOwner === 'matplotlib' ||
      plottingOwner === 'seaborn'
    if (plottingCall && !this.checkingFunction) {
      this.pythonPlottingState.reads = true
      if (libraryEffect?.plottingState === 'write' || libraryEffect?.plottingState === 'style')
        this.pythonPlottingState.writes = true
    }
    if (libraryEffect?.plottingState === 'style') {
      const style =
        node.keywords?.find((keyword) => keyword.arg === 'style')?.value ??
        (Array.isArray(node.args) ? node.args[0] : undefined)
      // Named bundled styles need no extra file. Custom paths, URLs and package styles
      // require their own captured evidence; do not silently treat them as configuration only.
      if (
        style?.type !== 'Constant' ||
        ![
          'default',
          'classic',
          'ggplot',
          'dark_background',
          'bmh',
          'fast',
          'fivethirtyeight',
          'grayscale',
          'Solarize_Light2',
          'tableau-colorblind10'
        ].includes(String(style.value))
      )
        this.unknown.add('scoped-opaque-call')
    }
    // Unregistered accessor operations may invoke extensions or user code.
    // Do not let the known DataFrame root certify an unknown string method.
    if (
      node.func?.type === 'Attribute' &&
      isPyNode(node.func.value) &&
      node.func.value.type === 'Attribute' &&
      node.func.value.attr === 'str' &&
      !libraryEffect
    )
      this.unknown.add('opaque-call')
    if (
      node.func?.type === 'Attribute' &&
      isPyNode(node.func.value) &&
      (node.func.value.type === 'Call'
        ? ['python.string', 'python.scalar', 'python.container']
        : ['python.string', 'python.scalar']
      ).includes(
        (node.func.value.type === 'Call'
          ? this.libraryCallEffect(node.func.value)?.returnType
          : this.libraryTypeName(node.func.value)) ?? ''
      ) &&
      libraryEffect?.effect === 'read'
    ) {
      this.genericVisit(node)
      return
    }
    if (this.checkingFunction) {
      if (libraryEffect?.plottingState === 'write' || libraryEffect?.plottingState === 'style')
        this.unresolvedFunctionCall = true
      const builtin =
        node.func?.type === 'Name' &&
        SAFE_CALLS.has(node.func.id ?? '') &&
        !this.defined.has(node.func.id ?? '')
      const localContainer =
        node.func?.type === 'Attribute' &&
        this.builtinContainers.has(rootName(node.func.value as PyNode) ?? '') &&
        MUTATING_METHODS.has(node.func.attr ?? '')
      const known =
        libraryEffect &&
        libraryEffect.effect !== 'unknown' &&
        !libraryEffect.unsafeNamespace &&
        !libraryEffect.externalState &&
        !libraryEffect.scopedOpaque &&
        !libraryEffect.callbackKeywords?.length &&
        !libraryEffect.callbackAllKeywords &&
        !libraryEffect.callbackContainerKeywords?.length
      if (!builtin && !localContainer && !known) {
        this.unresolvedFunctionCall = true
      }
      if (
        builtin &&
        (['map', 'filter'].includes(node.func?.id ?? '') ||
          node.keywords?.some(
            (keyword) =>
              keyword.arg === 'key' &&
              !(keyword.value.type === 'Constant' && keyword.value.value === null)
          ))
      )
        this.unresolvedFunctionCall = true
    }
    const fileCallName =
      isPyNode(node.func) && node.func.type === 'Name'
        ? node.func.id
        : isPyNode(node.func) && node.func.type === 'Attribute'
          ? node.func.attr
          : undefined
    if (fileCallName && PYTHON_FILE_CALL_EFFECTS.get(fileCallName)?.kind === 'read') {
      this.unknown.add('external-state')
    }
    if (libraryEffect?.unsafeNamespace) {
      this.unknown.add('opaque-call')
      this.unknown.add('dynamic-namespace')
    }
    if (libraryEffect?.scopedOpaque) this.unknown.add('scoped-opaque-call')
    if (libraryEffect?.externalState) this.unknown.add('external-state')
    const formulaRule = libraryEffect?.formulaArgument
    if (formulaRule) {
      const args = Array.isArray(node.args) ? node.args : []
      const formula =
        (node.keywords ?? []).find((keyword) => keyword.arg === formulaRule.keyword)?.value ??
        (typeof formulaRule.positionalArgument === 'number'
          ? args[formulaRule.positionalArgument]
          : undefined)
      const formulaNames = simpleFormulaNames(formula)
      if (!formulaNames) this.unknown.add('opaque-call')
      else for (const name of formulaNames) this.possiblyUsed.add(name)
    }
    const args = Array.isArray(node.args) ? node.args : []
    const callbackCandidates: PyNode[] = []
    if (isPyNode(node.func) && node.func.type === 'Name') {
      if (node.func.id === 'map' || node.func.id === 'filter') callbackCandidates.push(args[0]!)
      if (node.func.id === 'sorted' || node.func.id === 'min' || node.func.id === 'max') {
        const key = (node.keywords ?? []).find((keyword) => keyword.arg === 'key')?.value
        if (key) callbackCandidates.push(key)
      }
    }
    if (libraryEffect) {
      if (
        isPyNode(node.func) &&
        node.func.type === 'Attribute' &&
        (node.func.attr === 'apply' || node.func.attr === 'map') &&
        args[0]
      ) {
        callbackCandidates.push(args[0])
      }
      for (const keyword of node.keywords ?? []) {
        if (
          libraryEffect.callbackAllKeywords ||
          libraryEffect.callbackKeywords?.includes(keyword.arg ?? '')
        ) {
          callbackCandidates.push(keyword.value)
        }
        if (libraryEffect.callbackContainerKeywords?.includes(keyword.arg ?? '')) {
          callbackCandidates.push(...(keyword.value.elts ?? []), ...(keyword.value.values ?? []))
        }
      }
    }
    for (const callback of callbackCandidates) {
      const eagerSort =
        node.func?.type === 'Attribute' &&
        node.func.attr === 'sort' &&
        ['python.scalar', 'python.string'].includes(
          this.iterationTypes(node.func.value as PyNode)[0] ?? ''
        )
      if (eagerSort && callback.type === 'Name' && this.localFunctions.has(callback.id ?? '')) {
        const probe = py(
          'Call',
          {
            func: callback,
            args: [py('Constant', { value: 0, constKind: 'int' }, [])],
            keywords: []
          },
          ['func', 'args', 'keywords']
        )
        if (this.analyzeLocalProcedure(probe) && this.procedureReturnTypes.has(probe)) {
          this.pureInlineCallbacks.set(callback, { name: '__call__', effect: 'read' })
          continue
        }
      }
      const summary = summarizeInlineCallback(
        callback,
        new Set([...this.builtinContainers, ...this.contextualStaticCollections]),
        node.func?.type === 'Name' &&
          ['sorted', 'min', 'max'].includes(node.func.id ?? '') &&
          !this.defined.has(node.func.id ?? '') &&
          ['python.string', 'python.scalar'].includes(this.iterationTypes(args[0])[0] ?? '')
          ? new Set(((callback.args as PyArguments | undefined)?.args ?? []).map((arg) => arg.arg))
          : new Set(),
        (value) => {
          const receiver = rootName(value)
          const module = receiver ? this.importedModules.get(receiver) : undefined
          return Boolean(
            module &&
            !this.taintedNamespaces.has(module.split('.')[0]!) &&
            !this.memberWrites.some((write) => write.receiver === receiver) &&
            this.libraryPropertyEffect(value)?.returnType === 'python.scalar'
          )
        }
      )
      if (!summary || summary.safeCallNames?.some((name) => this.defined.has(name))) continue
      // map/filter defer invocation. Until iterator lifetimes are modeled, a
      // captured value cannot be attributed to the run creating the iterator.
      const lazy = node.func?.type === 'Name' && ['map', 'filter'].includes(node.func.id ?? '')
      if (lazy && summary.usedNames?.some((name) => !summary.safeCallNames?.includes(name)))
        continue
      this.pureInlineCallbacks.set(callback, summary)
    }
    if (this.constructorNodes.has(node)) {
      if (isPyNode(node.func) && node.func.type === 'Name' && node.func.id) {
        const candidates = [...args, ...(node.keywords ?? []).map((keyword) => keyword.value)]
        this.receiverCalls.push({
          receiver: node.func.id,
          member: '__call__',
          ...this.conditionalFact(),
          kind: 'callable',
          argumentNames: this.visibleRoots(candidates),
          receiverChain: [],
          receiverChainFirstArgumentNames: [],
          receiverChainPositionalArgumentNames: [],
          receiverChainPositionalStaticBooleans: [],
          receiverChainKeywordArguments: [],
          receiverValueNames: [],
          positionalArgumentNames: args.map((argument) => this.expressionVisibleRoots(argument)),
          positionalStaticShapes: args.map(pythonArgumentShape),
          positionalStaticBooleans: args.map((argument) =>
            argument.type === 'Constant' && argument.constKind === 'bool'
              ? Boolean(argument.value)
              : null
          ),
          resultNames: this.callResultNames.get(node) ?? [],
          ...(this.callResultPaths.has(node)
            ? { resultPaths: this.callResultPaths.get(node)! }
            : {}),
          keywordArguments: this.callKeywordArgumentRecords(node)
        })
      }
      this.genericVisit(node)
      return
    }
    if (isPyNode(node.func) && node.func.type === 'Name' && DYNAMIC_CALLS.has(node.func.id ?? '')) {
      this.unknown.add('dynamic-namespace')
    } else if (
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      SAFE_CALLS.has(node.func.id ?? '')
    ) {
      this.safeCallNames.add(node.func.id ?? '')
      const possible = new Set(
        [...args, ...(node.keywords ?? []).map((keyword) => keyword.value)]
          .map((candidate) => this.visibleRootName(candidate))
          .filter((name): name is string => Boolean(name))
      )
      for (const name of possible) this.safeCallArgumentNames.add(name)
    } else if (
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      EXTERNAL_READ_CALLS.has(node.func.id ?? '')
    ) {
      this.safeCallNames.add(node.func.id ?? '')
      const possible = new Set(
        [...args, ...(node.keywords ?? []).map((keyword) => keyword.value)]
          .map((candidate) => this.visibleRootName(candidate))
          .filter((name): name is string => Boolean(name))
      )
      for (const name of possible) this.safeCallArgumentNames.add(name)
      this.unknown.add('external-state')
    } else if (
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      SCOPED_MUTATION_CALLS.has(node.func.id ?? '')
    ) {
      this.safeCallNames.add(node.func.id ?? '')
      const possible = new Set(
        [...args, ...(node.keywords ?? []).map((keyword) => keyword.value)]
          .map((candidate) => this.visibleRootName(candidate))
          .filter((name): name is string => Boolean(name))
      )
      for (const name of possible) this.safeCallArgumentNames.add(name)
      for (const name of possible) this.possiblyMutated.add(name)
      if (possible.size) this.unknown.add('opaque-mutation')
    } else if (
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      SCOPED_OPAQUE_CALLS.has(node.func.id ?? '')
    ) {
      this.safeCallNames.add(node.func.id ?? '')
      const possible = new Set(
        [...args, ...(node.keywords ?? []).map((keyword) => keyword.value)]
          .map((candidate) => this.visibleRootName(candidate))
          .filter((name): name is string => Boolean(name))
      )
      for (const name of possible) {
        this.safeCallArgumentNames.add(name)
        this.possiblyMutated.add(name)
      }
      this.unknown.add('scoped-opaque-call')
      if (possible.size) this.unknown.add('opaque-mutation')
    } else if (
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      node.func.id &&
      this.importedFunctions.has(node.func.id)
    ) {
      this.receiverCalls.push({
        receiver: this.importedFunctions.get(node.func.id) ?? node.func.id,
        member: '__call__',
        ...this.conditionalFact(),
        kind: 'callable',
        argumentNames: this.visibleRoots([
          ...args,
          ...(node.keywords ?? []).map((keyword) => keyword.value)
        ]),
        receiverChain: [],
        receiverChainFirstArgumentNames: [],
        receiverChainPositionalArgumentNames: [],
        receiverChainPositionalStaticBooleans: [],
        receiverChainKeywordArguments: [],
        receiverValueNames: [],
        positionalArgumentNames: args.map((argument) => this.expressionVisibleRoots(argument)),
        positionalStaticShapes: args.map(pythonArgumentShape),
        positionalStaticBooleans: args.map((argument) =>
          argument.type === 'Constant' && argument.constKind === 'bool'
            ? Boolean(argument.value)
            : null
        ),
        resultNames: this.callResultNames.get(node) ?? [],
        ...(this.callResultPaths.has(node) ? { resultPaths: this.callResultPaths.get(node)! } : {}),
        keywordArguments: this.callKeywordArgumentRecords(node)
      })
    } else if (
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      node.func.id &&
      !SAFE_CALLS.has(node.func.id)
    ) {
      this.receiverCalls.push({
        receiver: node.func.id,
        member: '__call__',
        ...this.conditionalFact(),
        kind: 'callable',
        argumentNames: this.visibleRoots([
          ...args,
          ...(node.keywords ?? []).map((keyword) => keyword.value)
        ]),
        receiverChain: [],
        receiverChainFirstArgumentNames: [],
        receiverChainPositionalArgumentNames: [],
        receiverChainPositionalStaticBooleans: [],
        receiverChainKeywordArguments: [],
        receiverValueNames: [],
        positionalArgumentNames: args.map((argument) => this.expressionVisibleRoots(argument)),
        positionalStaticShapes: args.map(pythonArgumentShape),
        positionalStaticBooleans: args.map((argument) =>
          argument.type === 'Constant' && argument.constKind === 'bool'
            ? Boolean(argument.value)
            : null
        ),
        resultNames: this.callResultNames.get(node) ?? [],
        ...(this.callResultPaths.has(node) ? { resultPaths: this.callResultPaths.get(node)! } : {}),
        keywordArguments: this.callKeywordArgumentRecords(node)
      })
    }
    if (isPyNode(node.func) && node.func.type === 'Attribute') {
      const name = this.receiverRootName(node.func.value as PyNode)
      const builtinContainerView = Boolean(
        name &&
        this.builtinContainers.has(name) &&
        BUILTIN_CONTAINER_VIEW_METHODS.has(node.func.attr ?? '') &&
        !args.length &&
        !(node.keywords ?? []).length
      )
      const literalReceiver =
        isPyNode(node.func.value) &&
        node.func.value.type === 'Constant' &&
        SAFE_LITERAL_METHODS.has(node.func.attr ?? '')
      const localReceiver = this.hasLocalRoot(node.func.value as PyNode)
      const inplace = (node.keywords ?? []).some(
        (keyword) =>
          keyword.arg === 'inplace' &&
          keyword.value.type === 'Constant' &&
          keyword.value.value === true
      )
      const possibleInplace = (node.keywords ?? []).some(
        (keyword) =>
          keyword.arg === 'inplace' &&
          !(keyword.value.type === 'Constant' && keyword.value.constKind === 'bool')
      )
      if (name && !builtinContainerView) {
        const argumentsNames = this.visibleRoots([
          ...args,
          ...(node.keywords ?? []).map((keyword) => keyword.value)
        ])
        if (localReceiver && !libraryEffect) {
          this.possiblyMutated.add(name)
          this.unknown.add('opaque-mutation')
        } else {
          const chainArguments = this.receiverChainArguments(node.func.value as PyNode)
          this.receiverCalls.push({
            receiver: name,
            member: node.func.attr ?? '',
            ...this.conditionalFact(),
            ...(MUTATING_METHODS.has(node.func.attr ?? '') || inplace
              ? { kind: 'mutating' as const }
              : {}),
            argumentNames: argumentsNames,
            receiverChain: this.receiverCallChain(node.func.value as PyNode),
            receiverChainFirstArgumentNames: this.receiverChainFirstArguments(
              node.func.value as PyNode
            ),
            receiverChainPositionalArgumentNames: chainArguments.map(
              (step) => step.positionalArgumentNames
            ),
            receiverChainPositionalStaticShapes: chainArguments.map(
              (step) => step.positionalStaticShapes
            ),
            receiverChainPositionalStaticBooleans: chainArguments.map(
              (step) => step.positionalStaticBooleans
            ),
            receiverChainKeywordArguments: chainArguments.map((step) => step.keywordArguments),
            receiverValueNames: this.receiverValueRoots(node.func.value as PyNode),
            positionalArgumentNames: args.map((argument) => this.expressionVisibleRoots(argument)),
            positionalStaticShapes: args.map(pythonArgumentShape),
            positionalStaticBooleans: args.map((argument) =>
              argument.type === 'Constant' && argument.constKind === 'bool'
                ? Boolean(argument.value)
                : null
            ),
            resultNames: this.callResultNames.get(node) ?? [],
            ...(this.callResultPaths.has(node)
              ? { resultPaths: this.callResultPaths.get(node)! }
              : {}),
            keywordArguments: this.callKeywordArgumentRecords(node, true)
          })
          if (libraryEffect?.mutatesKeyword) {
            for (const keyword of node.keywords ?? []) {
              if (keyword.arg !== libraryEffect.mutatesKeyword) continue
              const output = this.visibleRootName(keyword.value)
              if (!output) continue
              if (this.hasLocalRoot(keyword.value)) {
                this.possiblyMutated.add(output)
                this.unknown.add('opaque-mutation')
              } else this.addMutation(output)
            }
          }
        }
        if (possibleInplace) {
          this.possiblyMutated.add(name)
          this.unknown.add('opaque-mutation')
        }
      } else if (
        !literalReceiver &&
        !builtinContainerView &&
        !this.isReadOnlyArithmeticCall(node)
      ) {
        const possible = new Set(
          [...args, ...(node.keywords ?? []).map((keyword) => keyword.value)]
            .map((candidate) => this.visibleRootName(candidate))
            .filter((item): item is string => Boolean(item))
        )
        if (possible.size) {
          for (const item of possible) this.possiblyMutated.add(item)
          this.unknown.add('opaque-mutation')
        }
        this.unknown.add('opaque-call')
      }
      if (name && this.builtinModuleNames.has(name)) this.unknown.add('dynamic-namespace')
    } else if (!isPyNode(node.func) || node.func.type !== 'Name') {
      const possible = new Set(
        [...args, ...(node.keywords ?? []).map((keyword) => keyword.value)]
          .map((candidate) => this.visibleRootName(candidate))
          .filter((item): item is string => Boolean(item))
      )
      if (possible.size) {
        for (const item of possible) this.possiblyMutated.add(item)
        this.unknown.add('opaque-mutation')
      }
      this.unknown.add('opaque-call')
    }
    if (
      isPyNode(node.func) &&
      node.func.type === 'Name' &&
      (node.func.id === 'setattr' || node.func.id === 'delattr') &&
      args.length
    ) {
      const receiver = this.visibleRootName(args[0])
      if (receiver) {
        const member =
          args[1]?.type === 'Constant' && args[1].constKind === 'str'
            ? String(args[1].value)
            : undefined
        const typeWide = args[0]?.type === 'Attribute' && args[0].attr === '__class__'
        this.memberWrites.push({
          receiver,
          ...this.conditionalFact(),
          ...(member ? { member } : {}),
          ...(typeWide ? { scope: 'type' as const } : {})
        })
      }
      if (receiver && this.builtinModuleNames.has(receiver)) this.unknown.add('dynamic-namespace')
    }
    this.genericVisit(node)
  }
}

const factsFromAnalyzer = (
  analyzer: Analyzer
): Omit<Extract<NotebookRunDependencyFacts, { state: 'available' }>, 'state'> => {
  const aliases: NotebookDependencyAlias[] = [
    ...[...analyzer.aliases.entries()].map(([target, source]) => ({
      target,
      source,
      kind: 'reference' as const
    })),
    ...[...analyzer.possibleAliases].sort().map((item) => {
      const [target, source, access, member] = item.split('\0')
      return {
        target: target ?? '',
        source: source ?? '',
        kind: 'possible-reference' as const,
        ...(access ? { access: access as 'attribute' | 'subscript' } : {}),
        ...(member ? { member } : {})
      }
    })
  ]
  return {
    ...(analyzer.serializedValueWrites.size
      ? { serializedValueWrites: [...analyzer.serializedValueWrites.values()] }
      : {}),
    ...(analyzer.serializedValueReads.size
      ? { serializedValueReads: [...analyzer.serializedValueReads] }
      : {}),
    ...(analyzer.pythonRandomStateReads ? { pythonRandomStateReads: true } : {}),
    ...(analyzer.pythonPlottingState.reads || analyzer.pythonPlottingState.writes
      ? { pythonPlottingState: analyzer.pythonPlottingState }
      : {}),
    definedNames: [...analyzer.defined].sort(),
    conditionallyDefinedNames: [...analyzer.conditionallyDefined].sort(),
    usedNames: [...analyzer.used.keys()].sort(),
    priorUsedNames: [...analyzer.priorUsed.keys()].sort(),
    possiblyUsedNames: [...analyzer.possiblyUsed].sort(),
    mutatedNames: [...analyzer.mutated].sort(),
    possiblyMutatedNames: [...analyzer.possiblyMutated].sort(),
    aliases,
    builtinContainerNames: [...analyzer.builtinContainers].sort(),
    safeCallNames: [...analyzer.safeCallNames].sort(),
    safeCallArgumentNames: [...analyzer.safeCallArgumentNames].sort(),
    typeSummaries: analyzer.typeSummaries,
    typeBindings: [
      ...analyzer.typeBindings,
      ...[...analyzer.localLibraryTypes]
        .filter(
          ([name]) =>
            analyzer.defined.has(name) &&
            !analyzer.conditionallyDefined.has(name) &&
            !analyzer.memberWrites.some((write) => write.receiver === name)
        )
        .map(([target, typeName]) => ({ target, typeName, argumentNames: [] }))
    ],
    receiverCalls: analyzer.receiverCalls,
    memberWrites: analyzer.memberWrites
  }
}

const analyzePythonTree = (
  root: Node,
  contextualStaticCollections: readonly { name: string }[] = [],
  pythonBindings: NotebookSourceFileAccessContext['pythonBindings'] = [],
  pythonTaintedNamespaces: readonly string[] = [],
  staticStrings: NotebookSourceFileAccessContext['staticStrings'] = [],
  resolvedKernelNames: readonly string[] = [],
  verifiedSerializedValues: readonly NotebookSerializedValue[] = [],
  acceptedSerializedReads = new Map<string, string>()
): NotebookRunDependencyFacts => {
  const tree = convertModule(root)
  const analyzer = new Analyzer(
    scopedEffectLoops(tree),
    isolatedConditionalLoopNames(tree),
    new Set(contextualStaticCollections.map(({ name }) => name))
  )
  analyzer.serializedValues = new Map(verifiedSerializedValues.map((value) => [value.path, value]))
  analyzer.serializedPathBindings = new Map(staticStrings.map(({ name, value }) => [name, value]))
  analyzer.acceptedSerializedReads = acceptedSerializedReads
  analyzer.taintedNamespaces = new Set(pythonTaintedNamespaces)
  analyzer.contextualKernelNames = new Set(resolvedKernelNames)
  for (const { name } of staticStrings) {
    const binding = pythonBindings.find((item) => item.name === name && item.kind === 'object')
    if (!binding || binding.qualifiedName === 'pathlib.PurePath') {
      analyzer.diagnosticValues.set(name, binding ? 'path' : 'string')
    }
  }
  for (const { name, qualifiedName, kind } of pythonBindings) {
    if (
      analyzer.taintedNamespaces.has('*') ||
      analyzer.taintedNamespaces.has(qualifiedName.split('.')[0]!)
    )
      continue
    if (kind === 'object' && PYTHON_LIBRARY_EFFECTS[qualifiedName]?.kind === 'type') {
      analyzer.addLibrarySummaries()
      analyzer.localLibraryTypes.set(name, qualifiedName)
    } else if (kind === 'import') {
      analyzer.importedCanonicalNames.set(name, qualifiedName)
      if (PYTHON_LIBRARY_EFFECTS[qualifiedName]?.kind === 'module') {
        analyzer.bindLibraryModule(name, qualifiedName)
      } else {
        const member = qualifiedName.split('.').at(-1)!
        const module = qualifiedName.slice(0, -(member.length + 1))
        if (PYTHON_LIBRARY_EFFECTS[module]?.methods[member])
          analyzer.bindLibraryFunction(name, module, member)
      }
    }
  }
  analyzer.consoleRedirected = pythonRedirectsConsole(tree)
  analyzer.namespaceLoads = namespaceLoadLines(tree)
  analyzer.visit(tree)
  const facts = factsFromAnalyzer(analyzer)
  const reasons = new Set(analyzer.unknown)
  const hasRemainingConditionalEffects =
    [...analyzer.conditionallyDefined].some(
      (name) => !analyzer.isolatedConditionallyDefined.has(name)
    ) ||
    analyzer.possiblyMutated.size > 0 ||
    [...analyzer.possibleAliases].some((alias) => {
      const [target, source] = alias.split('\0')
      return [target, source].some(
        (name) =>
          analyzer.conditionallyDefined.has(name) &&
          !analyzer.isolatedConditionallyDefined.has(name)
      )
    }) ||
    analyzer.receiverCalls.some(
      (call) =>
        call.conditional &&
        (!analyzer.builtinContainers.has(call.receiver) ||
          analyzer.conditionallyDefined.has(call.receiver))
    ) ||
    analyzer.memberWrites.some((write) => write.conditional)
  if (!hasRemainingConditionalEffects) reasons.delete('control-flow')
  if (reasons.size) {
    return { state: 'unknown', reasons: [...reasons].sort(), ...facts }
  }
  return { state: 'available', ...facts }
}

const pythonHasUnsupportedExternalState = (canonicalName: string, node?: PyNode): boolean => {
  const member = canonicalName.split('.').at(-1) ?? ''
  const effect = pythonLibraryMethodEffect(canonicalName.slice(0, -(member.length + 1)), member)
  // Entropy-seeding and independent Generator/Random instances remain external.
  // Only global draws are covered by the bounded per-run kernel snapshot.
  if (effect?.globalRandomState) {
    if (member !== 'seed') return false
    const seed =
      node?.keywords?.find((keyword) => ['seed', 'a'].includes(keyword.arg ?? ''))?.value ??
      (Array.isArray(node?.args) ? node.args[0] : undefined)
    if (
      seed?.type === 'Constant' &&
      (typeof seed.value === 'number' ||
        typeof seed.value === 'string' ||
        typeof seed.value === 'boolean')
    )
      return false
  }
  return (
    PYTHON_UNSUPPORTED_EXTERNAL_STATE_NAMESPACES.some(
      (namespace) => canonicalName === namespace || canonicalName.startsWith(`${namespace}.`)
    ) || PYTHON_UNSUPPORTED_EXTERNAL_STATE_CALLS.has(canonicalName)
  )
}

const pythonDottedName = (node: PyNode | null | undefined): string | undefined => {
  if (node?.type === 'Name') return node.id
  if (node?.type !== 'Attribute') return undefined
  const prefix = pythonDottedName(node.value as PyNode)
  return prefix && node.attr ? `${prefix}.${node.attr}` : node.attr
}

const pythonInMemoryStream = (
  node: PyNode | null | undefined,
  importedNames: ReadonlyMap<string, string>
): boolean => {
  if (node?.type !== 'Call') return false
  const name = pythonDottedName(node.func)
  if (!name) return false
  const [root, ...members] = name.split('.')
  const canonicalName = [importedNames.get(root ?? '') ?? root, ...members]
    .filter(Boolean)
    .join('.')
  return canonicalName === 'io.BytesIO' || canonicalName === 'io.StringIO'
}

const pythonInMemoryInput = (
  node: PyNode | null | undefined,
  importedNames: ReadonlyMap<string, string>,
  bindings: ReadonlySet<string>
): boolean =>
  (node?.type === 'Name' && Boolean(node.id) && bindings.has(node.id!)) ||
  pythonInMemoryStream(node, importedNames)

// Keep '..' lexical: normalizing it before file observation would change symlink semantics.
const pythonJoinPathParts = (
  parts: readonly string[],
  windows = process.platform === 'win32'
): string => {
  if (!windows)
    return parts.reduce(
      (path, part) =>
        part.startsWith('/') || !path ? part : path.endsWith('/') ? path + part : `${path}/${part}`,
      ''
    )
  let drive = ''
  let path = ''
  for (const value of parts) {
    const part = value.replace(/\//gu, '\\')
    const match = /^([a-z]:|\\\\[^\\]+\\[^\\]+)?(.*)$/isu.exec(part)!
    const nextDrive = match[1] ?? ''
    const nextPath = match[2]!
    if (nextPath.startsWith('\\')) {
      drive = nextDrive || drive
      path = nextPath
    } else if (nextDrive && nextDrive.toLowerCase() !== drive.toLowerCase()) {
      drive = nextDrive
      path = nextPath
    } else {
      drive = nextDrive || drive
      path = path && !path.endsWith('\\') ? `${path}\\${nextPath}` : path + nextPath
    }
  }
  return drive + (drive.startsWith('\\\\') && path && !path.startsWith('\\') ? '\\' : '') + path
}

type PythonStaticPathContext = {
  collections: ReadonlyMap<string, PythonStaticFileCollection>
  importedNames: ReadonlyMap<string, string>
  shadowedNames: ReadonlySet<string>
}

const pythonStaticString = (
  node: PyNode | null | undefined,
  bindings: ReadonlyMap<string, string>,
  context?: PythonStaticPathContext
): string | undefined => {
  const evaluate = (value: PyNode | null | undefined): string | undefined =>
    pythonStaticString(value, bindings, context)
  if (!node) return undefined
  if (node.type === 'Constant' && node.constKind === 'str' && typeof node.value === 'string') {
    return node.value
  }
  if (node.type === 'Name' && node.id) return bindings.get(node.id)
  if (node.type === 'Subscript' && isPyNode(node.value)) {
    const collection = pythonStaticStringCollection(
      node.value,
      bindings,
      context?.collections ?? new Map(),
      context
    )
    const key = evaluate(node.slice)
    if (collection?.kind === 'mapping' && key !== undefined)
      return collection.entries.find(([name]) => name === key)?.[1]
    const index = staticInteger(node.slice)
    if (collection?.kind === 'sequence' && index !== undefined && Number.isSafeInteger(index))
      return collection.values.at(index)
    return undefined
  }
  if (node.type === 'JoinedStr') {
    if (node.formatSafe === false) return undefined
    const parts = (node.children ?? []).map((child) =>
      child.type === 'FormattedValue' && child.formatSafe && isPyNode(child.value)
        ? evaluate(child.value)
        : child.type === 'FormattedValue'
          ? undefined
          : evaluate(child)
    )
    return parts.some((part) => part === undefined) ? undefined : (parts as string[]).join('')
  }
  if (node.type === 'BinOp' && (node.op === 'Add' || node.op === 'Div')) {
    const left = evaluate(node.left)
    const right = evaluate(node.right)
    if (left === undefined || right === undefined) return undefined
    return node.op === 'Div' ? pythonJoinPathParts([left, right]) : `${left}${right}`
  }
  if (node.type !== 'Call') return undefined
  const rawName = pythonDottedName(node.func)
  const [root, ...members] = rawName?.split('.') ?? []
  const imported = context?.importedNames.get(root ?? '')
  const name =
    root && !(context?.shadowedNames.has(root) && !imported)
      ? [imported ?? root, ...members].join('.')
      : undefined
  const args = Array.isArray(node.args) ? node.args : []
  if (name && ['Path', 'PurePath', 'pathlib.Path', 'pathlib.PurePath'].includes(name)) {
    if ((node.keywords ?? []).length) return undefined
    const parts = args.map(evaluate)
    return parts.some((part) => part === undefined)
      ? undefined
      : pythonJoinPathParts(parts as string[]) || '.'
  }
  if (name && ['join', 'os.path.join', 'posixpath.join', 'ntpath.join'].includes(name)) {
    const parts = args.map(evaluate)
    if (parts.some((part) => part === undefined)) return undefined
    return pythonJoinPathParts(
      parts as string[],
      name === 'ntpath.join' ? true : name === 'posixpath.join' ? false : undefined
    )
  }
  if (
    name &&
    ['os.fspath', 'str', 'builtins.str'].includes(name) &&
    args.length === 1 &&
    !(node.keywords ?? []).length
  )
    return evaluate(args[0])
  if (isPyNode(node.func) && node.func.type === 'Attribute' && !(node.keywords ?? []).length) {
    const receiver = evaluate(node.func.value as PyNode)
    const parts = args.map(evaluate)
    if (receiver === undefined || parts.some((part) => part === undefined)) return undefined
    if (node.func.attr === 'joinpath' && parts.length) {
      return pythonJoinPathParts([receiver, ...(parts as string[])])
    }
    const [part] = parts as string[]
    if (parts.length !== 1) return undefined
    const separator = Math.max(receiver.lastIndexOf('/'), receiver.lastIndexOf('\\'))
    if (node.func.attr === 'with_name' && part && !/[\\/]/u.test(part)) {
      return `${receiver.slice(0, separator + 1)}${part}`
    }
    if (node.func.attr === 'with_suffix' && (part === '' || part.startsWith('.'))) {
      const dot = receiver.lastIndexOf('.')
      return `${receiver.slice(0, dot > separator + 1 ? dot : receiver.length)}${part}`
    }
  }
  return undefined
}

const MAX_STATIC_FILE_LOOP_ITERATIONS = 128

type PythonStaticFileCollection =
  | { kind: 'sequence'; values: readonly string[] }
  | { kind: 'rows'; rows: ReadonlyArray<readonly string[]> }
  | { kind: 'mapping'; entries: ReadonlyArray<readonly [string, string]> }

const pythonContextCollection = (
  collection: NotebookSourceFileAccessContext['staticCollections'][number]
): PythonStaticFileCollection =>
  collection.entries
    ? { kind: 'mapping', entries: collection.entries.map(({ key, value }) => [key, value]) }
    : { kind: 'sequence', values: collection.values }

const pythonPersistedCollection = (
  name: string,
  collection: PythonStaticFileCollection
): NotebookSourceFileAccessContext['staticCollections'][number] | undefined => {
  if (collection.kind === 'rows') return undefined
  if (collection.kind === 'sequence') return { name, values: [...collection.values] }
  return {
    name,
    values: collection.entries.map(([, value]) => value),
    entries: collection.entries.map(([key, value]) => ({ key, value }))
  }
}

const pythonStaticCollectionRows = (
  collection: PythonStaticFileCollection,
  method?: string
): string[][] | undefined => {
  if (collection.kind === 'sequence') {
    return method === undefined ? collection.values.map((value) => [value]) : undefined
  }
  if (collection.kind === 'rows') {
    return method === undefined ? collection.rows.map((row) => [...row]) : undefined
  }
  if (method === 'items') return collection.entries.map(([key, value]) => [key, value])
  if (method === 'values') return collection.entries.map(([, value]) => [value])
  if (method === undefined || method === 'keys') {
    return collection.entries.map(([key]) => [key])
  }
  return undefined
}

const pythonStaticStringCollection = (
  node: PyNode | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, PythonStaticFileCollection>,
  context?: PythonStaticPathContext
): PythonStaticFileCollection | undefined => {
  if (!node) return undefined
  if (node.type === 'Name' && node.id) return collections.get(node.id)
  if (node.type === 'Subscript' && isPyNode(node.value) && node.slice?.type === 'Slice') {
    const receiver = pythonStaticStringCollection(node.value, bindings, collections, context)
    if (receiver?.kind !== 'sequence') return undefined
    const { lower, upper, step } = node.slice
    const bounds = [lower, upper, step].map((bound) => (bound ? staticInteger(bound) : undefined))
    if ([lower, upper, step].some((bound, index) => bound && !Number.isSafeInteger(bounds[index])))
      return undefined
    const stride = bounds[2] ?? 1
    if (stride === 0) return undefined
    const length = receiver.values.length
    const minimum = stride > 0 ? 0 : -1
    const maximum = stride > 0 ? length : length - 1
    const normalize = (value: number): number =>
      Math.max(minimum, Math.min(maximum, value < 0 ? value + length : value))
    const start = bounds[0] === undefined ? (stride > 0 ? 0 : length - 1) : normalize(bounds[0])
    const stop = bounds[1] === undefined ? (stride > 0 ? length : -1) : normalize(bounds[1])
    const values: string[] = []
    for (let index = start; stride > 0 ? index < stop : index > stop; index += stride) {
      values.push(receiver.values[index]!)
    }
    return { kind: 'sequence', values }
  }
  if (node.type === 'ListComp') {
    const generators = node.generators ?? []
    const generator = generators.length === 1 ? generators[0] : undefined
    if (!generator || generator.ifs.length || !node.elt) return undefined
    const rows = pythonStaticStringCollection(generator.iter, bindings, collections, context)
    const values = rows ? pythonStaticCollectionRows(rows) : undefined
    const targetNames = loopTargetNames(generator.target)
    if (!values || !targetNames.length || values.some((row) => row.length !== targetNames.length)) {
      return undefined
    }
    const expanded = values.map((row) => {
      const localBindings = new Map(bindings)
      targetNames.forEach((name, index) => localBindings.set(name, row[index]!))
      return pythonStaticString(node.elt, localBindings, context)
    })
    if (expanded.some((value) => value === undefined)) return undefined
    return { kind: 'sequence', values: expanded as string[] }
  }
  if (node.type === 'Dict') {
    const keys = node.keys ?? []
    const values = node.values ?? []
    if (keys.length !== values.length || keys.length > MAX_STATIC_FILE_LOOP_ITERATIONS) {
      return undefined
    }
    const entries = keys.map((key, index) => {
      const keyValue = pythonStaticString(key, bindings, context)
      const value = pythonStaticString(values[index], bindings, context)
      return keyValue === undefined || value === undefined
        ? undefined
        : ([keyValue, value] as const)
    })
    if (entries.some((entry) => entry === undefined)) return undefined
    return { kind: 'mapping', entries: [...new Map(entries as Array<readonly [string, string]>)] }
  }
  if (node.type !== 'List' && node.type !== 'Tuple') return undefined
  if (
    (node.elts ?? []).length > 0 &&
    (node.elts ?? []).every((element) => element.type === 'List' || element.type === 'Tuple')
  ) {
    const rows = (node.elts ?? []).map((element) =>
      (element.elts ?? []).map((item) => pythonStaticString(item, bindings, context))
    )
    if (
      rows.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
      rows.some((row) => !row.length || row.some((value) => value === undefined))
    ) {
      return undefined
    }
    return { kind: 'rows', rows: rows as string[][] }
  }
  const values = (node.elts ?? []).map((element) => pythonStaticString(element, bindings, context))
  if (
    values.length > MAX_STATIC_FILE_LOOP_ITERATIONS ||
    values.some((value) => value === undefined)
  ) {
    return undefined
  }
  return { kind: 'sequence', values: values as string[] }
}

const pythonLiteralMappingKeys = (
  node: PyNode | null | undefined,
  bindings: ReadonlyMap<string, string>
): string[] | undefined => {
  if (node?.type !== 'Dict') return undefined
  const keys = (node.keys ?? []).map((key) => pythonStaticString(key, bindings))
  return keys.length > 0 && keys.length <= MAX_STATIC_FILE_LOOP_ITERATIONS && keys.every(Boolean)
    ? [...new Set(keys as string[])]
    : undefined
}

const pythonStaticLoopRows = (
  node: PyNode | null | undefined,
  bindings: ReadonlyMap<string, string>,
  collections: ReadonlyMap<string, PythonStaticFileCollection>,
  shadowedCalls: ReadonlySet<string>,
  partialCollections: ReadonlyMap<string, Array<Array<string | undefined>>> = new Map()
): Array<Array<string | undefined>> | undefined => {
  if (!node) return undefined
  if ((node.type === 'List' || node.type === 'Tuple') && (node.elts ?? []).length > 0) {
    const elements = node.elts ?? []
    if (elements.length > MAX_STATIC_FILE_LOOP_ITERATIONS) return undefined
    if (elements.every((element) => element.type === 'List' || element.type === 'Tuple')) {
      return elements.map((element) =>
        (element.elts ?? []).map((item) => pythonStaticString(item, bindings))
      )
    }
    return elements.map((element) => [pythonStaticString(element, bindings)])
  }
  let collection = pythonStaticStringCollection(node, bindings, collections)
  if (!collection && node.type === 'Name' && node.id) {
    const rows = partialCollections.get(node.id)
    if (rows) return rows.map((row) => [...row])
  }
  let method: string | undefined
  if (
    node.type === 'Call' &&
    isPyNode(node.func) &&
    node.func.type === 'Attribute' &&
    !(Array.isArray(node.args) && node.args.length) &&
    !(node.keywords ?? []).length
  ) {
    method = node.func.attr
    collection = pythonStaticStringCollection(node.func.value as PyNode, bindings, collections)
  }
  if (
    node.type === 'Call' &&
    isPyNode(node.func) &&
    node.func.type === 'Name' &&
    node.func.id === 'zip' &&
    !shadowedCalls.has('zip') &&
    Array.isArray(node.args) &&
    node.args.length &&
    !(node.keywords ?? []).length
  ) {
    const columns = node.args.map((argument) =>
      pythonStaticLoopRows(argument, bindings, collections, shadowedCalls, partialCollections)
    )
    if (columns.some((column) => !column || column.some((row) => row.length !== 1))) {
      return undefined
    }
    const staticColumns = columns as Array<Array<Array<string | undefined>>>
    const length = Math.min(...staticColumns.map((column) => column.length))
    return Array.from({ length }, (_unused, index) =>
      staticColumns.map((column) => column[index]![0]!)
    )
  }
  if (
    node.type === 'Call' &&
    isPyNode(node.func) &&
    node.func.type === 'Name' &&
    node.func.id === 'enumerate' &&
    !shadowedCalls.has('enumerate') &&
    Array.isArray(node.args) &&
    node.args.length >= 1 &&
    node.args.length <= 2
  ) {
    const startKeyword = (node.keywords ?? []).find((keyword) => keyword.arg === 'start')
    if (
      (node.keywords ?? []).some((keyword) => keyword.arg !== 'start') ||
      ((node.keywords ?? []).length > 0 && !startKeyword) ||
      (node.args.length === 2 && startKeyword)
    ) {
      return undefined
    }
    const startNode = startKeyword?.value ?? node.args[1]
    const start = startNode ? staticInteger(startNode) : 0
    const rows = pythonStaticLoopRows(
      node.args[0],
      bindings,
      collections,
      shadowedCalls,
      partialCollections
    )
    if (start === undefined || !rows) return undefined
    return rows.map((row, index) => [String(start + index), ...row])
  }
  if (
    node.type === 'Call' &&
    isPyNode(node.func) &&
    node.func.type === 'Name' &&
    node.func.id &&
    ['list', 'reversed', 'sorted', 'tuple'].includes(node.func.id) &&
    !shadowedCalls.has(node.func.id) &&
    Array.isArray(node.args) &&
    node.args.length === 1
  ) {
    const keywords = node.keywords ?? []
    const reverseKeyword = keywords.find((keyword) => keyword.arg === 'reverse')
    if (
      (node.func.id !== 'sorted' && keywords.length) ||
      keywords.some((keyword) => keyword.arg !== 'reverse') ||
      (reverseKeyword &&
        !(reverseKeyword.value.type === 'Constant' && reverseKeyword.value.constKind === 'bool'))
    ) {
      return undefined
    }
    const rows = pythonStaticLoopRows(
      node.args[0],
      bindings,
      collections,
      shadowedCalls,
      partialCollections
    )
    if (!rows) return undefined
    if (node.func.id === 'list' || node.func.id === 'tuple') return rows
    if (node.func.id === 'reversed') return [...rows].reverse()
    if (rows.some((row) => row.length !== 1)) return undefined
    const sorted = [...rows].sort(([left = ''], [right = '']) => {
      const leftPoints = [...left].map((value) => value.codePointAt(0)!)
      const rightPoints = [...right].map((value) => value.codePointAt(0)!)
      const length = Math.min(leftPoints.length, rightPoints.length)
      for (let index = 0; index < length; index += 1) {
        if (leftPoints[index] !== rightPoints[index]) {
          return leftPoints[index]! - rightPoints[index]!
        }
      }
      return leftPoints.length - rightPoints.length
    })
    return reverseKeyword?.value.value === true ? sorted.reverse() : sorted
  }
  if (!collection) return undefined
  return pythonStaticCollectionRows(collection, method)
}

const pythonLoopTargetNames = (node: PyNode | null | undefined): string[] => {
  if (!node) return []
  if (node.type === 'Name' && node.id) return [node.id]
  if (node.type === 'Tuple' || node.type === 'List') {
    return (node.elts ?? []).flatMap(pythonLoopTargetNames)
  }
  return []
}

const pythonBindLoopTarget = (
  target: PyNode | null | undefined,
  row: ReadonlyArray<string | undefined>,
  bindings: Map<string, string>,
  collections: Map<string, PythonStaticFileCollection>
): boolean => {
  const names = pythonLoopTargetNames(target)
  if (!names.length || names.length !== row.length) return false
  names.forEach((name, index) => {
    const value = row[index]
    if (value === undefined) bindings.delete(name)
    else bindings.set(name, value)
    collections.delete(name)
  })
  return true
}

const pythonFileCallArgument = (node: PyNode, call: NotebookFileCallEffect): PyNode | undefined => {
  const keyword = (node.keywords ?? []).find(
    (candidate) => candidate.arg && call.keywords.includes(candidate.arg)
  )
  const args = Array.isArray(node.args) ? node.args : []
  return keyword?.value ?? args[call.position]
}

const pythonCallHasStaticFileLikeArgument = (
  node: PyNode,
  bindings: ReadonlyMap<string, string>
): boolean => {
  const candidates = [
    ...(Array.isArray(node.args) ? node.args : []),
    ...(node.keywords ?? []).flatMap((keyword) => (keyword.value ? [keyword.value] : []))
  ]
  return candidates.some((candidate) => {
    const value = pythonStaticString(candidate, bindings)
    return value !== undefined && pythonPathLooksLikeFile(value)
  })
}

const pythonPathLooksLikeFile = (value: string): boolean =>
  /(?:^|[\\/])?[^\\/]+\.[A-Za-z][A-Za-z0-9_-]{0,15}$/u.test(value)

const isPotentialPythonFileReadCall = (name: string): boolean =>
  /^(?:import|load|open|parse|read)(?:$|_)/u.test(name)

const pythonPathHasCollectionPattern = (value: string): boolean =>
  value.includes('*') || value.includes('?') || value.includes('[')

const pythonLoopHasEarlyExit = (node: PyNode): boolean =>
  walkPy(node).some((candidate) => candidate.type === 'Break' || candidate.type === 'Continue')

const pythonWriterDisposition = (
  node: PyNode,
  name: string,
  resolveString: (node: PyNode) => string | undefined
): 'replace' | 'update' | 'unknown' => {
  const option = notebookWriteOption('python', name)
  if (!option) return 'replace'
  if ((node.keywords ?? []).some((keyword) => keyword.arg === null)) return 'unknown'
  if (name === 'to_zarr' || name === 'to_netcdf') {
    const compute = (node.keywords ?? []).find((keyword) => keyword.arg === 'compute')?.value
    if (compute && !(compute.type === 'Constant' && compute.value === true)) return 'unknown'
  }

  const argument =
    (node.keywords ?? []).find((keyword) => keyword.arg === option.keyword)?.value ??
    (option.position === undefined
      ? undefined
      : Array.isArray(node.args)
        ? node.args[option.position]
        : undefined)
  const defaultValue =
    name === 'to_zarr' &&
    (node.keywords ?? []).some(
      (keyword) =>
        ['append_dim', 'region'].includes(keyword.arg ?? '') &&
        !(keyword.value?.type === 'Constant' && keyword.value.value === null)
    )
      ? 'a'
      : option.defaultValue
  const value =
    !argument || (name === 'to_zarr' && argument.type === 'Constant' && argument.value === null)
      ? defaultValue
      : option.keyword !== 'append'
        ? resolveString(argument)
        : argument.type === 'Constant'
          ? argument.value
          : undefined
  return notebookWriteDisposition(option, value)
}

const pythonLocalFileWrappers = (
  tree: PyNode
): {
  effects: Map<string, NotebookFileCallEffectSummary>
  names: Set<string>
  complete: boolean
} => {
  const effects = new Map<string, NotebookFileCallEffectSummary>()
  const names = new Set<string>()
  const functions = (Array.isArray(tree.body) ? tree.body : []).filter(
    (node) => node.type === 'FunctionDef' || node.type === 'AsyncFunctionDef'
  )
  let complete = true
  for (const fn of functions) {
    if (fn.name) names.add(fn.name)
    const body = Array.isArray(fn.body) ? fn.body : []
    const statement = body.length === 1 ? body[0] : undefined
    const call =
      statement?.type === 'Call'
        ? statement
        : statement?.type === 'Return' &&
            isPyNode(statement.value) &&
            statement.value.type === 'Call'
          ? statement.value
          : undefined
    const calledName = call ? pythonDottedName(call.func) : undefined
    const member = calledName?.split('.').at(-1)
    const effect = member && member !== 'save' ? PYTHON_FILE_CALL_EFFECTS.get(member) : undefined
    const fnArgs = fn.args as PyArguments | undefined
    const parameters = [...(fnArgs?.posonlyargs ?? []), ...(fnArgs?.args ?? [])]
    const pathArgument = call && effect ? pythonFileCallArgument(call, effect) : undefined
    const parameterIndex =
      pathArgument?.type === 'Name'
        ? parameters.findIndex((parameter) => parameter.arg === pathArgument.id)
        : -1
    if (
      !fn.name ||
      !effect ||
      (member === 'read_h5ad' &&
        call &&
        ((call.keywords ?? []).some((keyword) => keyword.arg === 'backed' || !keyword.arg) ||
          (Array.isArray(call.args) && call.args.length > 1))) ||
      parameterIndex < 0 ||
      (effect.kind === 'write' &&
        call &&
        pythonWriterDisposition(call, member!, (node) => pythonStaticString(node, new Map())) !==
          'replace')
    ) {
      complete = false
      continue
    }
    effects.set(fn.name, {
      name: fn.name,
      kind: effect.kind,
      position: parameterIndex,
      keywords: [parameters[parameterIndex]!.arg],
      ...(effect.inputForm ? { inputForm: effect.inputForm } : {}),
      dependencyNames: calledName ? [calledName.split('.')[0]!].filter(Boolean) : []
    })
  }
  return { effects, names, complete }
}

const analyzePythonFileAccessTree = (
  root: Node,
  context?: NotebookSourceFileAccessContext,
  acceptedSerializedReads = new Map<string, string>()
): NotebookSourceFileAccessExtraction => {
  const tree = convertModule(root)
  const diagnosticNamespaceLoads = namespaceLoadLines(tree)
  const consoleRedirected = pythonRedirectsConsole(tree)
  const localWrappers = pythonLocalFileWrappers(tree)
  const bindings = new Map(context?.staticStrings.map(({ name, value }) => [name, value]) ?? [])
  const collections = new Map(
    context?.staticCollections.map((collection) => [
      collection.name,
      pythonContextCollection(collection)
    ]) ?? []
  )
  const partialMappingKeys = new Map<string, readonly string[]>()
  const partialCollectionRows = new Map<string, Array<Array<string | undefined>>>()
  const possibleAliases = [...(context?.staticCollectionAliases ?? [])]
  const activeStaticLoops: Array<{ names: Set<string>; invalidated: boolean }> = []
  const invalidateStaticValue = (name: string | undefined, taintIdentity = true): void => {
    if (!name) return
    const affectedNames = new Set([name])
    for (const affected of affectedNames) {
      for (const { target, source } of possibleAliases) {
        if (target === affected) affectedNames.add(source)
        if (source === affected) affectedNames.add(target)
      }
      for (const values of [collections, partialMappingKeys, partialCollectionRows]) {
        const value = values.get(affected)
        if (!value) continue
        for (const [alias, candidate] of values) {
          if (candidate === value) affectedNames.add(alias)
        }
      }
    }
    for (const affected of affectedNames) {
      for (const loop of activeStaticLoops) {
        if (loop.names.has(affected)) loop.invalidated = true
      }
      const identity = importedNames.get(affected) ?? scientificObjectTypes.get(affected)
      if (identity && identity !== 'python.container' && taintIdentity) {
        pythonTaintedNamespaces.add(identity.split('.')[0]!)
        unsupportedExternalState = true
      }
      bindings.delete(affected)
      collections.delete(affected)
      partialMappingKeys.delete(affected)
      partialCollectionRows.delete(affected)
    }
  }
  const shadowedStaticCalls = new Set(localWrappers.names)
  const contextualWrappers = new Map(
    context?.localFileWrappers.map((wrapper) => [wrapper.name, wrapper]) ?? []
  )
  const importedNames = new Map<string, string>(
    (context?.pythonBindings ?? [])
      .filter((binding) => binding.kind === 'import')
      .map((binding) => [binding.name, binding.qualifiedName])
  )
  const resolveStaticString = (
    node: PyNode | null | undefined,
    values: ReadonlyMap<string, string>
  ): string | undefined =>
    pythonStaticString(node, values, {
      collections,
      importedNames,
      shadowedNames: shadowedStaticCalls
    })
  const inMemoryInputs = new Set<string>()
  const fileConnections = new Map<string, string>(
    (context?.pythonBindings ?? []).flatMap((binding) =>
      binding.kind === 'object' && binding.qualifiedName === 'pandas.ExcelFile' && binding.filePath
        ? [[binding.name, binding.filePath] as const]
        : []
    )
  )
  const archiveNames = new Set<string>()
  const scientificObjectTypes = new Map<string, string>(
    (context?.pythonBindings ?? [])
      .filter((binding) => binding.kind === 'object')
      .map((binding) => [binding.name, binding.qualifiedName])
  )
  const reads = new Set<string>()
  const pythonTaintedNamespaces = new Set(context?.pythonTaintedNamespaces ?? [])
  const knownDiagnosticValue = (name: string): PythonDiagnosticKind | undefined =>
    bindings.has(name)
      ? scientificObjectTypes.get(name) === 'pathlib.PurePath'
        ? 'path'
        : 'string'
      : undefined
  const writes = new Set<string>()
  const definitelyWritten = new Set<string>()
  const writeScopes = new Map<string, NotebookSourceFileWriteScope>()
  let unresolvedReads = false
  let unresolvedWrites = false
  let unsupportedExternalState = false
  let staticLoopIterations = 0
  let conditionalDepth = 0
  const modeAwareFileConstructors = new Map<
    string,
    { defaultMode: string; modePosition?: number; pathKeyword: string }
  >([
    ['h5py.File', { defaultMode: 'r', modePosition: 1, pathKeyword: 'name' }],
    ['netCDF4.Dataset', { defaultMode: 'r', modePosition: 1, pathKeyword: 'filename' }],
    ['numpy.memmap', { defaultMode: 'r+', modePosition: 2, pathKeyword: 'filename' }],
    ['pandas.ExcelWriter', { defaultMode: 'w', pathKeyword: 'path' }],
    ['pandas.HDFStore', { defaultMode: 'a', modePosition: 1, pathKeyword: 'path' }],
    ['rasterio.open', { defaultMode: 'r', modePosition: 1, pathKeyword: 'fp' }]
  ])

  const canonicalCallName = (node: PyNode): string | undefined => {
    if (node.func?.type === 'Attribute' && isPyNode(node.func.value)) {
      const owner = scientificObjectType(node.func.value)
      if (owner && node.func.attr) return `${owner}.${node.func.attr}`
    }
    const rawName = pythonDottedName(node.func)
    if (!rawName) return undefined
    const [rootName, ...members] = rawName.split('.')
    const objectType = scientificObjectTypes.get(rootName ?? '')
    const canonicalRoot =
      importedNames.get(rootName ?? '') ??
      (objectType && PYTHON_LIBRARY_EFFECTS[objectType] ? objectType : rootName)
    if (objectType && canonicalRoot === objectType && members.length === 0) {
      return `${objectType}.__call__`
    }
    return [canonicalRoot, ...members].filter(Boolean).join('.')
  }

  const fileConnectionPath = (node: PyNode | null | undefined): string | undefined => {
    if (node?.type === 'Name' && node.id) return fileConnections.get(node.id)
    if (node?.type !== 'Call') return undefined
    const name = canonicalCallName(node)
    const rawName = pythonDottedName(node.func)
    const args = Array.isArray(node.args) ? node.args : []
    if (
      rawName === 'open' ||
      name === 'builtins.open' ||
      ['gzip.open', 'bz2.open', 'lzma.open'].includes(name ?? '')
    ) {
      return resolveStaticString(
        (node.keywords ?? []).find((keyword) => ['file', 'filename'].includes(keyword.arg ?? ''))
          ?.value ?? args[0],
        bindings
      )
    }
    if (name === 'pandas.ExcelFile')
      return resolveStaticString(
        pythonFileCallArgument(node, { kind: 'read', position: 0, keywords: ['path_or_buffer'] }),
        bindings
      )
    if (name === 'zipfile.ZipFile')
      return resolveStaticString(
        pythonFileCallArgument(node, { kind: 'read', position: 0, keywords: ['file'] }),
        bindings
      )
    if (
      node.func?.type === 'Attribute' &&
      node.func.attr === 'open' &&
      isPyNode(node.func.value) &&
      node.func.value.type === 'Name' &&
      node.func.value.id &&
      archiveNames.has(node.func.value.id)
    )
      return fileConnections.get(node.func.value.id)
    if (name !== 'pandas.ExcelWriter') return undefined
    return resolveStaticString(
      pythonFileCallArgument(node, { kind: 'write', position: 0, keywords: ['path'] }),
      bindings
    )
  }

  const scientificObjectType = (node: PyNode | null | undefined): string | undefined => {
    if (node?.type === 'Name' && node.id) return scientificObjectTypes.get(node.id)
    if (node && ['List', 'Tuple', 'ListComp'].includes(node.type)) return 'python.container'
    if (
      node?.type === 'Subscript' &&
      isPyNode(node.value) &&
      node.value.type === 'Attribute' &&
      ['loc', 'iloc'].includes(node.value.attr ?? '') &&
      scientificObjectType(node.value.value as PyNode) === 'pandas.DataFrame'
    ) {
      const selectors =
        node.slice?.type === 'Tuple' ? (node.slice.elts ?? []) : node.slice ? [node.slice] : []
      const multiple = (selector: PyNode): boolean =>
        ['List', 'Tuple', 'Slice'].includes(selector.type) ||
        (selector.type === 'Name' && collections.has(selector.id ?? '')) ||
        scientificObjectType(selector) === 'python.container'
      // Only two-dimensional selections retain a DataFrame. A scalar or an
      // unknown selector might produce a string path instead.
      if (selectors.length > 0 && selectors.length <= 2 && selectors.every(multiple))
        return 'pandas.DataFrame'
      return undefined
    }
    if (node?.type !== 'Call') return undefined
    const name = canonicalCallName(node)
    if (name === 'astropy.table.Table' || name === 'astropy.table.Table.read') {
      return 'astropy-table'
    }
    if (name === 'lxml.etree.ElementTree' || name === 'lxml.etree.parse') return 'xml-tree'
    const member = name?.split('.').at(-1)
    const returnType =
      name && member
        ? PYTHON_LIBRARY_EFFECTS[name.slice(0, -(member.length + 1))]?.methods[member]?.returnType
        : undefined
    // Resource handles also need their identity retained when an unmodeled method
    // could access external state. Share lifetime/invalidation with file readers.
    return returnType &&
      (PYTHON_LIBRARY_EFFECTS[returnType]?.unknownMethodsHaveExternalState ||
        Object.values(PYTHON_LIBRARY_EFFECTS[returnType]?.methods ?? {}).some(
          (effect) => effect.file
        ))
      ? returnType
      : undefined
  }

  const recordFileAccess = (
    kind: NotebookFileCallEffect['kind'],
    pathNode: PyNode | null | undefined
  ): void => {
    if (pythonInMemoryInput(pathNode, importedNames, inMemoryInputs)) return
    const path =
      resolveStaticString(pathNode, bindings) ??
      (pathNode?.type === 'Name' && pathNode.id ? fileConnections.get(pathNode.id) : undefined)
    if (!path) {
      if (kind === 'read') unresolvedReads = true
      else unresolvedWrites = true
      return
    }
    if (pythonPathHasCollectionPattern(path)) {
      if (kind === 'read') unresolvedReads = true
      else unresolvedWrites = true
      return
    }
    if (kind === 'read') {
      if (!definitelyWritten.has(path)) reads.add(path)
    } else {
      writes.add(path)
      if (conditionalDepth === 0) definitelyWritten.add(path)
    }
  }

  const recordModeFileAccess = (
    pathNode: PyNode | null | undefined,
    modeNode: PyNode | null | undefined,
    defaultMode: string
  ): void => {
    if (pythonInMemoryInput(pathNode, importedNames, inMemoryInputs)) return
    const path = resolveStaticString(pathNode, bindings)
    const mode = modeNode ? resolveStaticString(modeNode, bindings) : defaultMode
    if (mode === undefined) {
      unresolvedReads = true
      unresolvedWrites = true
      return
    }
    const writable = /[wax+]/u.test(mode)
    const replacesExisting = mode.includes('w') || mode.includes('x')
    const readable =
      !replacesExisting && (mode.includes('r') || mode.includes('+') || mode.includes('a'))
    if (!path) {
      if (readable) unresolvedReads = true
      if (writable) unresolvedWrites = true
      return
    }
    if (readable && !definitelyWritten.has(path)) reads.add(path)
    if (writable) {
      writes.add(path)
      if (conditionalDepth === 0) definitelyWritten.add(path)
    }
  }

  const recordHtsFileAccess = (
    kind: NotebookFileCallEffect['kind'],
    node: PyNode | undefined
  ): void => {
    const value = resolveStaticString(node, bindings)
    if (
      value === '-' ||
      value?.startsWith('/dev/') ||
      value?.includes('##idx##') ||
      (value && /^[a-z][a-z\d+.-]*:\/\//iu.test(value))
    ) {
      if (kind === 'read') unresolvedReads = true
      else unresolvedWrites = true
      unsupportedExternalState = true
      return
    }
    recordFileAccess(kind, node)
  }

  const analyzeCall = (node: PyNode): void => {
    const rawName = pythonDottedName(node.func)
    if (!rawName) return
    const canonicalName = canonicalCallName(node) ?? rawName
    if (
      pythonTaintedNamespaces.has('*') ||
      pythonTaintedNamespaces.has(canonicalName.split('.')[0]!)
    ) {
      unsupportedExternalState = true
      return
    }
    const member = canonicalName.split('.').at(-1) ?? canonicalName
    const libraryMethodEffect = pythonLibraryMethodEffect(
      canonicalName.slice(0, -(member.length + 1)),
      member
    )
    const libraryFileEffect = libraryMethodEffect?.file
    // Callback containers can introduce I/O beyond the reader's explicit source.
    // Only a closed, read-only inline callback proves that no extra files are involved.
    for (const keyword of node.keywords ?? []) {
      if (!libraryMethodEffect?.callbackContainerKeywords?.includes(keyword.arg ?? '')) continue
      if (keyword.value.type === 'Constant' && keyword.value.value === null) continue
      const knownStrings = libraryMethodEffect.callbackStringValues?.[keyword.arg ?? '']
      if (knownStrings?.includes(resolveStaticString(keyword.value, bindings) ?? '')) continue
      const callbacks =
        keyword.value.type === 'Dict'
          ? keyword.value.values
          : ['List', 'Tuple'].includes(keyword.value.type)
            ? keyword.value.elts
            : undefined
      if (
        !callbacks ||
        callbacks.some((callback) => {
          if (knownStrings?.includes(resolveStaticString(callback, bindings) ?? '')) return false
          const summary = summarizeInlineCallback(callback)
          return !summary || summary.effect !== 'read' || Boolean(summary.usedNames?.length)
        })
      ) {
        unresolvedReads = true
        unresolvedWrites = true
        unsupportedExternalState = true
      }
    }
    if (libraryMethodEffect?.externalState) unsupportedExternalState = true
    if (
      !acceptedSerializedReads.has(serializationSite(node)) &&
      pythonHasUnsupportedExternalState(canonicalName, node)
    )
      unsupportedExternalState = true
    if (
      ['cyvcf2.VCF', 'cyvcf2.Writer', 'cyvcf2.Writer.from_string', 'cyvcf2.VCF.set_index'].includes(
        canonicalName
      ) &&
      (importedNames.has(rawName.split('.')[0]!) ||
        scientificObjectTypes.has(rawName.split('.')[0]!))
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      const keyword = (name: string): PyNode | undefined =>
        (node.keywords ?? []).find((entry) => entry.arg === name)?.value
      if (canonicalName === 'cyvcf2.VCF.set_index') {
        // An empty index path asks HTSlib to discover a companion; don't invent it.
        recordHtsFileAccess('read', keyword('index_path') ?? args[0])
        return
      }
      const reader = canonicalName === 'cyvcf2.VCF'
      const modeNode = keyword('mode') ?? args[reader ? 1 : 2]
      const mode =
        !modeNode ||
        (canonicalName === 'cyvcf2.Writer' &&
          modeNode.type === 'Constant' &&
          modeNode.value === null)
          ? reader
            ? 'r'
            : 'w'
          : resolveStaticString(modeNode, bindings)
      const path = keyword('fname') ?? args[0]
      if (mode && /^r[bz]?$/.test(mode)) recordHtsFileAccess('read', path)
      else if (mode && /^w(?:bu|[bz][0-9]?)?$/.test(mode)) recordHtsFileAccess('write', path)
      else {
        unresolvedReads = true
        unresolvedWrites = true
      }
      return
    }
    if (
      importedNames.has(rawName.split('.')[0]!) &&
      [
        'pyteomics.mgf.IndexedMGF.prebuild_byte_offset_file',
        'pyteomics.mzml.MzML.prebuild_byte_offset_file'
      ].includes(canonicalName)
    ) {
      const pathNode =
        (node.keywords ?? []).find((entry) => entry.arg === 'path')?.value ??
        (Array.isArray(node.args) ? node.args[0] : undefined)
      recordFileAccess('read', pathNode)
      const path = resolveStaticString(pathNode, bindings)
      if (
        !path ||
        path.includes('\\') ||
        pythonPathHasCollectionPattern(path) ||
        /^[a-z][a-z\d+.-]*:\/\//iu.test(path)
      ) {
        unresolvedWrites = true
      } else {
        // IndexSavingMixin explicitly writes this splitext-derived filename.
        // Construction can still consume a pre-existing index (and mzML CV),
        // so naming the output does not establish complete input coverage.
        const separator = path.lastIndexOf('/')
        const dot = path.lastIndexOf('.')
        const hasExtension = dot > separator + 1 && /[^.]/u.test(path.slice(separator + 1, dot))
        const stem = hasExtension ? path.slice(0, dot) : path
        const extension = hasExtension ? path.slice(dot + 1) : ''
        writes.add(`${stem}-${extension}-byte-offsets.json`)
      }
      unsupportedExternalState = true
      return
    }
    if (canonicalName === 'pysam.AlignmentFile' && importedNames.has(rawName.split('.')[0]!)) {
      // Only the file and mode positions are stable across documented versions.
      // Preserve explicitly named companions without guessing which implicit
      // index, reference cache or format-option resource exists at execution time.
      const args = Array.isArray(node.args) ? node.args : []
      const keyword = (name: string): PyNode | undefined =>
        (node.keywords ?? []).find((entry) => entry.arg === name)?.value
      const pathNode = keyword('filepath_or_object') ?? keyword('filename') ?? args[0]
      const modeNode = keyword('mode') ?? args[1]
      const mode =
        !modeNode || (modeNode.type === 'Constant' && modeNode.value === null)
          ? 'r'
          : resolveStaticString(modeNode, bindings)
      const reading = mode !== undefined && ['r', 'rb', 'rc', 'rU'].includes(mode)
      const writing = mode !== undefined && ['w', 'wh', 'wb', 'wbu', 'wb0', 'wc'].includes(mode)
      if (reading) recordHtsFileAccess('read', pathNode)
      else if (writing) recordHtsFileAccess('write', pathNode)
      else {
        unresolvedReads = true
        unresolvedWrites = true
      }
      if (reading) {
        const explicitIndex = keyword('index_filename')
        const index =
          !explicitIndex ||
          (explicitIndex.type === 'Constant' && !explicitIndex.value) ||
          resolveStaticString(explicitIndex, bindings) === ''
            ? keyword('filepath_index')
            : explicitIndex
        if (index && !(index.type === 'Constant' && !index.value))
          recordHtsFileAccess('read', index)
      }
      const reference = keyword('reference_filename')
      if (
        (reading || mode === 'wc') &&
        reference &&
        !(reference.type === 'Constant' && !reference.value)
      ) {
        recordHtsFileAccess('read', reference)
      }
      unsupportedExternalState = true
      return
    }
    if (
      canonicalName === 'pyteomics.mgf.write' &&
      ((Array.isArray(node.args) && node.args.length > 2) ||
        (node.keywords ?? []).some((keyword) => keyword.arg === 'param_formatters'))
    ) {
      // Custom formatters execute user callbacks. Recording the destination alone
      // cannot account for their file reads; optional positional arguments may
      // also supply these callbacks, depending on the installed Pyteomics version.
      unsupportedExternalState = true
    }
    if (['scanpy.read_h5ad', 'anndata.read_h5ad', 'anndata.io.read_h5ad'].includes(canonicalName)) {
      const args = Array.isArray(node.args) ? node.args : []
      const pathNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'filename')?.value ?? args[0]
      const backedNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'backed')?.value ?? args[1]
      recordFileAccess('read', pathNode)
      const backed = backedNode ? pythonStaticString(backedNode, bindings) : undefined
      const inMemory =
        !backedNode ||
        (backedNode.type === 'Constant' &&
          (backedNode.value === false || backedNode.constKind === 'none'))
      if (
        backed === 'r+' ||
        (!inMemory && backed !== 'r') ||
        (node.keywords ?? []).some((keyword) => !keyword.arg)
      ) {
        // A writable backing file remains an input. Opening it does not prove
        // a replacement write, nor which later object operations reach disk.
        unresolvedWrites = true
        unsupportedExternalState = true
      }
      return
    }

    if (
      [
        'scanpy.read_10x_mtx',
        'scanpy.read_visium',
        'pyarrow.dataset.dataset',
        'fsspec.open',
        'fsspec.open_files',
        'fsspec.get_mapper'
      ].includes(canonicalName)
    ) {
      unresolvedReads = true
      unsupportedExternalState = true
      return
    }
    if (
      node.func?.type === 'Attribute' &&
      node.func.attr === 'open' &&
      isPyNode(node.func.value) &&
      node.func.value.type === 'Name' &&
      node.func.value.id &&
      archiveNames.has(node.func.value.id)
    ) {
      const path = fileConnectionPath(node)
      if (!path) unresolvedReads = true
      else
        recordModeFileAccess(
          { type: 'Constant', constKind: 'str', value: path, _fields: [] },
          (node.keywords ?? []).find((keyword) => keyword.arg === 'mode')?.value ??
            (Array.isArray(node.args) ? node.args[1] : undefined),
          'r'
        )
      return
    }

    if (rawName === 'open' || canonicalName === 'builtins.open') {
      const args = Array.isArray(node.args) ? node.args : []
      const modeNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'mode')?.value ?? args[1]
      const pathNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'file')?.value ?? args[0]
      recordModeFileAccess(pathNode, modeNode, 'r')
      return
    }

    if (['gzip.open', 'bz2.open', 'lzma.open'].includes(canonicalName)) {
      const args = Array.isArray(node.args) ? node.args : []
      const pathNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'filename')?.value ?? args[0]
      const modeNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'mode')?.value ?? args[1]
      recordModeFileAccess(pathNode, modeNode, 'rb')
      return
    }

    if (canonicalName === 'zipfile.ZipFile') {
      const args = Array.isArray(node.args) ? node.args : []
      const pathNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'file')?.value ?? args[0]
      const modeNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'mode')?.value ?? args[1]
      recordModeFileAccess(pathNode, modeNode, 'r')
      return
    }

    if (canonicalName === 'csv.writer' || canonicalName === 'csv.DictWriter') return

    if (canonicalName === 'shutil.copyfile') {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'read',
        (node.keywords ?? []).find((keyword) => keyword.arg === 'src')?.value ?? args[0]
      )
      recordFileAccess(
        'write',
        (node.keywords ?? []).find((keyword) => keyword.arg === 'dst')?.value ?? args[1]
      )
      return
    }

    if (canonicalName === 'onnx.save') {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'write',
        (node.keywords ?? []).find((keyword) => ['f', 'file'].includes(keyword.arg ?? ''))?.value ??
          args[1]
      )
      return
    }

    if (member === 'load_model' || member === 'save_model') {
      const args = Array.isArray(node.args) ? node.args : []
      const moduleSave =
        member === 'save_model' && /^(?:keras|onnx|tensorflow\.keras)(?:\.|$)/u.test(canonicalName)
      const pathNode =
        (node.keywords ?? []).find((keyword) =>
          ['f', 'file', 'filepath', 'fname', 'model_file'].includes(keyword.arg ?? '')
        )?.value ?? args[moduleSave ? 1 : 0]
      const path = resolveStaticString(pathNode, bindings)
      if (!path || !pythonPathLooksLikeFile(path)) {
        if (member === 'load_model') unresolvedReads = true
        else unresolvedWrites = true
        return
      }
      recordFileAccess(member === 'load_model' ? 'read' : 'write', pathNode)
      return
    }

    if (canonicalName === 'PIL.Image.open') {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'read',
        (node.keywords ?? []).find((keyword) => keyword.arg === 'fp')?.value ?? args[0]
      )
      return
    }

    if (
      ['scipy.io.wavfile.read', 'soundfile.read', 'astropy.table.Table.read'].includes(
        canonicalName
      )
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'read',
        (node.keywords ?? []).find((keyword) =>
          ['file', 'filename', 'source'].includes(keyword.arg ?? '')
        )?.value ?? args[0]
      )
      return
    }

    if (canonicalName === 'lxml.etree.parse') {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'read',
        (node.keywords ?? []).find((keyword) => keyword.arg === 'source')?.value ?? args[0]
      )
      return
    }

    if (canonicalName === 'Bio.SeqIO.parse') {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'read',
        (node.keywords ?? []).find((keyword) => keyword.arg === 'handle')?.value ?? args[0]
      )
      return
    }

    if (canonicalName === 'Bio.SeqIO.write') {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'write',
        (node.keywords ?? []).find((keyword) => keyword.arg === 'handle')?.value ?? args[1]
      )
      return
    }

    if (
      member === 'write' &&
      isPyNode(node.func) &&
      node.func.type === 'Attribute' &&
      isPyNode(node.func.value) &&
      node.func.value.type === 'Name' &&
      node.func.value.id &&
      scientificObjectTypes.get(node.func.value.id) === 'astropy-table'
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'write',
        (node.keywords ?? []).find((keyword) => keyword.arg === 'output')?.value ?? args[0]
      )
      return
    }

    if (
      member === 'write' &&
      isPyNode(node.func) &&
      node.func.type === 'Attribute' &&
      isPyNode(node.func.value) &&
      node.func.value.type === 'Name' &&
      node.func.value.id &&
      scientificObjectTypes.get(node.func.value.id) === 'xml-tree'
    ) {
      const args = Array.isArray(node.args) ? node.args : []
      recordFileAccess(
        'write',
        (node.keywords ?? []).find((keyword) => ['file', 'filename'].includes(keyword.arg ?? ''))
          ?.value ?? args[0]
      )
      return
    }

    const modeAwareConstructor = modeAwareFileConstructors.get(canonicalName)
    if (modeAwareConstructor) {
      const args = Array.isArray(node.args) ? node.args : []
      if (canonicalName === 'h5py.File') {
        const driver =
          (node.keywords ?? []).find((keyword) => keyword.arg === 'driver')?.value ?? args[2]
        if (
          driver &&
          !(driver.type === 'Constant' && driver.value === null) &&
          !['sec2', 'stdio'].includes(resolveStaticString(driver, bindings) ?? '')
        ) {
          // A logical HDF5 filename may be memory-only or span physical files. Until
          // driver-specific members are captured, do not claim single-file coverage.
          unresolvedReads = true
          unresolvedWrites = true
          return
        }
      }

      recordModeFileAccess(
        (node.keywords ?? []).find((keyword) => keyword.arg === modeAwareConstructor.pathKeyword)
          ?.value ?? args[0],
        (node.keywords ?? []).find((keyword) => keyword.arg === 'mode')?.value ??
          (modeAwareConstructor.modePosition === undefined
            ? undefined
            : args[modeAwareConstructor.modePosition]),
        modeAwareConstructor.defaultMode
      )
      return
    }

    if (canonicalName === 'zarr.open') {
      const args = Array.isArray(node.args) ? node.args : []
      const pathNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'store')?.value ?? args[0]
      const modeNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'mode')?.value ?? args[1]
      const path = resolveStaticString(pathNode, bindings)
      const mode = modeNode ? resolveStaticString(modeNode, bindings) : 'a'
      if (!path || !mode || !path.toLocaleLowerCase('en-US').endsWith('.zarr')) {
        unresolvedReads = true
        unresolvedWrites = true
        return
      }
      const replacesExisting = mode.includes('w') || mode.includes('x')
      const readsExisting = !replacesExisting && /[ra+]/u.test(mode)
      const writesStore = /[wax+]/u.test(mode)
      if (readsExisting) unresolvedReads = true
      if (writesStore) {
        writes.add(path)
        if (conditionalDepth === 0) definitelyWritten.add(path)
        writeScopes.set(`directory\0${path}`, { kind: 'directory', path })
      }
      return
    }

    if (
      isPyNode(node.func) &&
      node.func.type === 'Attribute' &&
      !libraryFileEffect &&
      ['read_bytes', 'read_text', 'write_bytes', 'write_text'].includes(member)
    ) {
      recordFileAccess(member.startsWith('read') ? 'read' : 'write', node.func.value as PyNode)
      return
    }

    if (['yaml.dump', 'yaml.safe_dump', 'yaml.load', 'yaml.safe_load'].includes(canonicalName)) {
      const args = Array.isArray(node.args) ? node.args : []
      const write = canonicalName.endsWith('dump')
      const argument = write
        ? ((node.keywords ?? []).find((keyword) => keyword.arg === 'stream')?.value ?? args[1])
        : args[0]
      if (argument?.type === 'Name' && argument.id && fileConnections.has(argument.id)) {
        recordFileAccess(write ? 'write' : 'read', argument)
      }
      return
    }

    if (canonicalName === 'tarfile.open') {
      const args = Array.isArray(node.args) ? node.args : []
      const fileObject = (node.keywords ?? []).find((keyword) => keyword.arg === 'fileobj')?.value
      const pathNode =
        fileObject ??
        (node.keywords ?? []).find((keyword) => keyword.arg === 'name')?.value ??
        args[0]
      const modeNode =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'mode')?.value ?? args[1]
      recordModeFileAccess(pathNode, modeNode, 'r')
      return
    }

    if (canonicalName === 'pandas.ExcelFile.parse' && node.func?.type === 'Attribute') {
      // Parsing reads from the workbook, not from the sheet name argument.
      // A handle without a captured source path cannot prove its input file.
      const path = fileConnectionPath(node.func.value as PyNode)
      if (path) {
        if (!definitelyWritten.has(path)) reads.add(path)
      } else unresolvedReads = true
      return
    }
    let call: NotebookFileCallEffect | undefined = localWrappers.effects.get(rawName)
    let writeScopeKind: NotebookSourceFileWriteScope['kind'] | undefined
    if (!call && !localWrappers.names.has(rawName)) {
      call =
        contextualWrappers.get(rawName) ??
        PYTHON_FILE_CALL_EFFECTS.get(canonicalName) ??
        libraryFileEffect ??
        PYTHON_FILE_CALL_EFFECTS.get(member)
      if (!call && member === 'to_zarr' && rawName.includes('.')) {
        call = { kind: 'write', position: 0, keywords: ['store'] }
        writeScopeKind = 'directory'
      } else if (!call && canonicalName === 'pyarrow.dataset.write_dataset') {
        call = { kind: 'write', position: 1, keywords: ['base_dir'] }
        writeScopeKind = 'directory'
      }
    }
    if (member === 'save' && /^(?:nibabel|torch)(?:\.|$)/u.test(canonicalName)) {
      call = { kind: 'write', position: 1, keywords: ['file', 'filename', 'f'] }
    } else if (canonicalName === 'scipy.io.wavfile.write') {
      call = { kind: 'write', position: 0, keywords: ['filename'] }
    } else if (canonicalName === 'soundfile.write') {
      call = { kind: 'write', position: 0, keywords: ['file'] }
    } else if (canonicalName === 'scipy.io.mmwrite') {
      call = { kind: 'write', position: 0, keywords: ['target'] }
    } else if (canonicalName === 'pyarrow.parquet.write_table') {
      call = { kind: 'write', position: 1, keywords: ['where'] }
    } else if (
      (member === 'write_html' || member === 'write_image') &&
      !canonicalName.startsWith('plotly.io.')
    ) {
      call = { kind: 'write', position: 0, keywords: ['file'] }
    }
    if (!call) {
      if (
        !libraryMethodEffect &&
        (!SAFE_CALLS.has(rawName) ||
          shadowedStaticCalls.has(rawName) ||
          context?.resolvedKernelNames?.includes(rawName))
      ) {
        // An opaque callback can monkeypatch a module passed by reference.
        // Preserve that uncertainty across re-imports, including failed cells.
        const argumentsToCheck = [
          ...(Array.isArray(node.args) ? node.args : []),
          ...(node.keywords ?? []).map((keyword) => keyword.value)
        ]
        for (const argument of argumentsToCheck) {
          const identity =
            argument?.type === 'Name' && argument.id ? importedNames.get(argument.id) : undefined
          if (identity && PYTHON_LIBRARY_EFFECTS[identity]?.kind === 'module') {
            pythonTaintedNamespaces.add(identity.split('.')[0]!)
            unsupportedExternalState = true
          }
        }
      }
      if (
        isPotentialPythonFileReadCall(member) &&
        pythonCallHasStaticFileLikeArgument(node, bindings)
      ) {
        unresolvedReads = true
      }
      if (isPotentialPythonFileWriteCall(member)) unresolvedWrites = true
      return
    }
    const effect = call
    const recordPath = (path: string): void => {
      if (
        effect.singleFileSuffixes &&
        !effect.singleFileSuffixes.some((suffix) => path.toLowerCase().endsWith(suffix))
      ) {
        if (effect.kind === 'read') unresolvedReads = true
        else unresolvedWrites = true
      }
      if (pythonPathHasCollectionPattern(path)) {
        if (effect.kind === 'read') unresolvedReads = true
        else unresolvedWrites = true
      } else if (
        writeScopeKind === 'directory' &&
        member === 'to_zarr' &&
        !path.toLocaleLowerCase('en-US').endsWith('.zarr')
      ) {
        unresolvedWrites = true
      } else {
        if (effect.kind === 'read') {
          if (!definitelyWritten.has(path)) reads.add(path)
        } else {
          const disposition = pythonWriterDisposition(
            node,
            notebookWriteOption('python', canonicalName) ? canonicalName : member,
            (argument) => resolveStaticString(argument, bindings)
          )
          if (disposition === 'update' && !definitelyWritten.has(path)) {
            if (writeScopeKind === 'directory') unresolvedReads = true
            else reads.add(path)
          }
          if (disposition === 'unknown') {
            unresolvedReads = true
            unresolvedWrites = true
          }
          writes.add(path)
          if (conditionalDepth === 0 && disposition !== 'unknown') definitelyWritten.add(path)
        }
        if (writeScopeKind) {
          writeScopes.set(`${writeScopeKind}\0${path}`, { kind: writeScopeKind, path })
        } else if (member === 'to_file' && path.toLocaleLowerCase('en-US').endsWith('.shp')) {
          writeScopes.set(`shapefile\0${path}`, { kind: 'shapefile', path })
        }
      }
    }
    if (canonicalName === 'SimpleITK.ReadImage' || canonicalName === 'SimpleITK.WriteImage') {
      const reading = canonicalName.endsWith('ReadImage')
      const allowedKeywords = reading
        ? ['fileName', 'outputPixelType', 'imageIO']
        : ['image', 'fileName', 'useCompression', 'compressionLevel', 'imageIO', 'compressor']
      const args = Array.isArray(node.args) ? node.args : []
      const imageIO =
        (node.keywords ?? []).find((keyword) => keyword.arg === 'imageIO')?.value ??
        (reading ? args[2] : undefined)
      if (
        (imageIO && resolveStaticString(imageIO, bindings) !== '') ||
        (node.keywords ?? []).some(
          (keyword) => !keyword.arg || !allowedKeywords.includes(keyword.arg)
        )
      ) {
        // ReadImage forwards extra kwargs to reader setters, including FileNames.
        // A selected imageIO can also change a path's single-file semantics.
        if (reading) unresolvedReads = true
        else unresolvedWrites = true
        unsupportedExternalState = true
      }
    }
    for (const additional of effect.additionalPaths ?? []) {
      recordFileAccess('read', pythonFileCallArgument(node, { kind: 'read', ...additional }))
    }
    const argument = pythonFileCallArgument(node, effect)
    if (!argument && effect.pathOptional) return
    if (effect.inMemoryTypes?.includes(scientificObjectType(argument) ?? '')) return
    if (pythonInMemoryInput(argument, importedNames, inMemoryInputs)) return
    if (effect.inputForm) {
      const collection = pythonStaticStringCollection(argument, bindings, collections, {
        collections,
        importedNames,
        shadowedNames: shadowedStaticCalls
      })
      if (collection?.kind === 'sequence' || collection?.kind === 'rows') {
        if (effect.inputForm === 'lines' && collection.kind === 'sequence') return
        if (effect.inputForm === 'paths') {
          const paths = collection.kind === 'rows' ? collection.rows.flat() : collection.values
          for (const path of paths) recordPath(path)
          return
        }
      }
    }
    const path =
      resolveStaticString(argument, bindings) ??
      (argument?.type === 'Name' && argument.id ? fileConnections.get(argument.id) : undefined)
    if (!path) {
      if (effect.kind === 'read') unresolvedReads = true
      else unresolvedWrites = true
    } else {
      const connection = argument?.type === 'Name' && fileConnections.has(argument.id ?? '')
      recordPath(
        effect.appendedSuffix && !connection && !path.endsWith(effect.appendedSuffix)
          ? path + effect.appendedSuffix
          : path
      )
    }
  }

  const visit = (node: PyNode): void => {
    const consoleControl =
      !consoleRedirected &&
      pythonConsoleControlDiagnostic(
        node,
        importedNames,
        shadowedStaticCalls,
        pythonTaintedNamespaces,
        knownDiagnosticValue
      )
    if (
      consoleControl &&
      consoleControl.locals.every(
        (name) =>
          !(diagnosticNamespaceLoads.get(name) ?? []).some((line) => line > (node.end_lineno ?? 0))
      )
    ) {
      // Later uses must not reuse a pre-loop static binding for a diagnostic temporary.
      for (const name of consoleControl.locals) {
        invalidateStaticValue(name, false)
        inMemoryInputs.delete(name)
        fileConnections.delete(name)
        scientificObjectTypes.delete(name)
        importedNames.delete(name)
      }
      return
    }

    if (node.type === 'IfExp') {
      const selected = staticBoolean(node.test)
      if (selected !== undefined) {
        if (node.test) visit(node.test)
        const branch = selected ? node.body : node.alternate
        if (isPyNode(branch)) visit(branch)
        return
      }
    }
    if (
      !consoleRedirected &&
      pythonConsoleDiagnostic(
        node,
        importedNames,
        shadowedStaticCalls,
        pythonTaintedNamespaces,
        knownDiagnosticValue
      )
    )
      return
    if (
      node.type === 'FunctionDef' ||
      node.type === 'AsyncFunctionDef' ||
      node.type === 'ClassDef'
    ) {
      if (node.name) {
        importedNames.delete(node.name)
        scientificObjectTypes.delete(node.name)
      }
      return
    }
    if (
      node.type === 'AugAssign' ||
      ((node.type === 'Subscript' || node.type === 'Attribute' || node.type === 'Name') &&
        (node.ctx === 'Del' || (node.type !== 'Name' && node.ctx === 'Store')))
    ) {
      if (node.type === 'Name' && node.ctx === 'Del' && node.id) {
        importedNames.delete(node.id)
        scientificObjectTypes.delete(node.id)
      }
      const target = node.type === 'AugAssign' ? node.target : node
      const mapping =
        target?.type === 'Subscript' && isPyNode(target.value)
          ? canonicalCallName({ type: 'Call', _fields: ['func'], func: target.value })
          : undefined
      const configurationMapping =
        mapping && pythonLibraryMethodEffect(mapping, 'update')?.plottingState === 'write'
      invalidateStaticValue(rootName(target), !configurationMapping)
    }
    if (node.type === 'Call' && MUTATING_METHODS.has(memberName(node.func) ?? '')) {
      const canonical = canonicalCallName(node)
      const member = memberName(node.func) ?? ''
      const owner = canonical?.slice(0, -(member.length + 1)) ?? ''
      const effect = pythonLibraryMethodEffect(owner, member)
      const instanceMutation =
        PYTHON_LIBRARY_EFFECTS[owner]?.kind === 'type' &&
        effect?.effect === 'mutate' &&
        !effect.unsafeNamespace
      invalidateStaticValue(
        rootName(node.func),
        !instanceMutation && effect?.plottingState !== 'write'
      )
    }
    if (node.type === 'For') {
      if (node.iter) visit(node.iter)
      const targetNames = pythonLoopTargetNames(node.target)
      const partialMappingRows = (() => {
        if (
          node.iter?.type !== 'Call' ||
          !isPyNode(node.iter.func) ||
          node.iter.func.type !== 'Attribute' ||
          !isPyNode(node.iter.func.value) ||
          node.iter.func.value.type !== 'Name' ||
          !node.iter.func.value.id ||
          (Array.isArray(node.iter.args) && node.iter.args.length) ||
          (node.iter.keywords ?? []).length
        ) {
          return undefined
        }
        const keys = partialMappingKeys.get(node.iter.func.value.id)
        if (!keys) return undefined
        if (node.iter.func.attr === 'items') return keys.map((key) => [key, undefined])
        if (node.iter.func.attr === 'keys') return keys.map((key) => [key])
        if (node.iter.func.attr === 'values') return keys.map(() => [undefined])
        return undefined
      })()
      const rows =
        pythonStaticLoopRows(
          node.iter,
          bindings,
          collections,
          shadowedStaticCalls,
          partialCollectionRows
        ) ?? partialMappingRows
      const independentSnapshot = (() => {
        const iterable = node.iter
        if (iterable?.type === 'Subscript' && iterable.slice?.type === 'Slice') {
          return pythonStaticStringCollection(iterable, bindings, collections)?.kind === 'sequence'
        }
        if (
          iterable?.type !== 'Call' ||
          !isPyNode(iterable.func) ||
          iterable.func.type !== 'Name' ||
          !['list', 'tuple', 'sorted'].includes(iterable.func.id ?? '') ||
          shadowedStaticCalls.has(iterable.func.id!) ||
          !Array.isArray(iterable.args) ||
          iterable.args.length !== 1
        )
          return false
        const source = pythonStaticStringCollection(iterable.args[0], bindings, collections)
        // Only flat immutable string values: a shallow copy of nested mutable rows can
        // still change underneath the loop. Argument validity is checked by loopRows.
        return source?.kind === 'sequence' || source?.kind === 'mapping'
      })()
      const body = Array.isArray(node.body) ? node.body : node.body ? [node.body] : []
      for (const targetName of targetNames) shadowedStaticCalls.add(targetName)
      for (const targetName of targetNames) inMemoryInputs.delete(targetName)
      for (const targetName of targetNames) fileConnections.delete(targetName)
      for (const targetName of targetNames) {
        scientificObjectTypes.delete(targetName)
        importedNames.delete(targetName)
      }
      for (const targetName of targetNames) partialMappingKeys.delete(targetName)
      for (const targetName of targetNames) partialCollectionRows.delete(targetName)
      if (
        targetNames.length &&
        rows &&
        rows.every((row) => row.length === targetNames.length) &&
        !pythonLoopHasEarlyExit(node) &&
        staticLoopIterations + rows.length <= MAX_STATIC_FILE_LOOP_ITERATIONS
      ) {
        const readsBefore = new Set(reads)
        const writesBefore = new Set(writes)
        const definitelyWrittenBefore = new Set(definitelyWritten)
        const writeScopeKeysBefore = new Set(writeScopes.keys())
        const unresolvedReadsBefore = unresolvedReads
        const unresolvedWritesBefore = unresolvedWrites
        unresolvedReads = false
        unresolvedWrites = false
        const loop = {
          names: new Set(
            !independentSnapshot && node.iter
              ? walkPy(node.iter).flatMap((node) =>
                  node.type === 'Name' && node.id ? [node.id] : []
                )
              : []
          ),
          invalidated: false
        }
        activeStaticLoops.push(loop)
        for (const row of rows) {
          staticLoopIterations += 1
          pythonBindLoopTarget(node.target, row, bindings, collections)
          body.forEach(visit)
        }
        activeStaticLoops.pop()
        if (loop.invalidated) {
          // Python iterates the live container. Cached rows and values derived inside the
          // loop no longer describe its final state after mutation through a known reference.
          unresolvedReads = true
          unresolvedWrites = true
          const assignedNames = new Set([
            ...targetNames,
            ...body.flatMap((statement) =>
              walkPy(statement).flatMap((node) =>
                node.type === 'Name' && node.ctx === 'Store' && node.id ? [node.id] : []
              )
            )
          ])
          for (const name of assignedNames) {
            bindings.delete(name)
            collections.delete(name)
            partialMappingKeys.delete(name)
            partialCollectionRows.delete(name)
            inMemoryInputs.delete(name)
            fileConnections.delete(name)
            scientificObjectTypes.delete(name)
            importedNames.delete(name)
          }
        }
        const loopUnresolvedReads = unresolvedReads
        const loopUnresolvedWrites = unresolvedWrites
        unresolvedReads = unresolvedReadsBefore || loopUnresolvedReads
        unresolvedWrites = unresolvedWritesBefore || loopUnresolvedWrites
        if (loopUnresolvedReads) {
          for (const path of reads) if (!readsBefore.has(path)) reads.delete(path)
        }
        if (loopUnresolvedWrites) {
          for (const path of writes) if (!writesBefore.has(path)) writes.delete(path)
          for (const path of definitelyWritten) {
            if (!definitelyWrittenBefore.has(path)) definitelyWritten.delete(path)
          }
          for (const key of writeScopes.keys()) {
            if (!writeScopeKeysBefore.has(key)) writeScopes.delete(key)
          }
        }
      } else {
        for (const targetName of targetNames) {
          bindings.delete(targetName)
          collections.delete(targetName)
          fileConnections.delete(targetName)
          scientificObjectTypes.delete(targetName)
          importedNames.delete(targetName)
        }
        conditionalDepth += 1
        body.forEach(visit)
        conditionalDepth -= 1
      }
      for (const child of node.orelse ?? []) visit(child)
      return
    }
    if (
      node.type === 'If' ||
      node.type === 'While' ||
      node.type === 'Try' ||
      node.type === 'Match'
    ) {
      conditionalDepth += 1
      pyChildren(node).forEach(visit)
      conditionalDepth -= 1
      return
    }
    if (node.type === 'With') {
      for (const item of node.items ?? []) {
        if (item.context_expr) visit(item.context_expr)
        if (item.optional_vars?.type !== 'Name' || !item.optional_vars.id) continue
        const target = item.optional_vars.id
        if (
          item.context_expr?.type === 'Call' &&
          canonicalCallName(item.context_expr) === 'zipfile.ZipFile' &&
          conditionalDepth === 0
        )
          archiveNames.add(target)
        else archiveNames.delete(target)
        const path = fileConnectionPath(item.context_expr)
        bindings.delete(target)
        collections.delete(target)
        inMemoryInputs.delete(target)
        scientificObjectTypes.delete(target)
        importedNames.delete(target)
        if (path && conditionalDepth === 0) fileConnections.set(target, path)
        else fileConnections.delete(target)
      }
      const body = Array.isArray(node.body) ? node.body : node.body ? [node.body] : []
      body.forEach(visit)
      return
    }
    if (node.type === 'Import') {
      for (const alias of (node.names as PyAlias[] | undefined) ?? []) {
        const localName = alias.asname || alias.name.split('.')[0] || alias.name
        importedNames.set(localName, alias.asname ? alias.name : localName)
        archiveNames.delete(localName)
        inMemoryInputs.delete(localName)
        fileConnections.delete(localName)
        scientificObjectTypes.delete(localName)
        shadowedStaticCalls.add(localName)
      }
    } else if (node.type === 'ImportFrom') {
      for (const alias of (node.names as PyAlias[] | undefined) ?? []) {
        if (alias.name !== '*') {
          const localName = alias.asname || alias.name
          importedNames.set(localName, `${node.module ?? ''}.${alias.name}`)
          archiveNames.delete(localName)
          inMemoryInputs.delete(localName)
          fileConnections.delete(localName)
          scientificObjectTypes.delete(localName)
          shadowedStaticCalls.add(localName)
        }
      }
    } else if (node.type === 'Assign' || node.type === 'AnnAssign' || node.type === 'NamedExpr') {
      const targets =
        node.type === 'Assign' ? (node.targets ?? []) : node.target ? [node.target] : []
      const valueNode = isPyNode(node.value) ? node.value : undefined
      const value = resolveStaticString(valueNode, bindings)
      const collection = pythonStaticStringCollection(valueNode, bindings, collections, {
        collections,
        importedNames,
        shadowedNames: shadowedStaticCalls
      })
      const collectionRows = pythonStaticLoopRows(
        valueNode,
        bindings,
        collections,
        shadowedStaticCalls,
        partialCollectionRows
      )
      const mappingKeys =
        pythonLiteralMappingKeys(valueNode, bindings) ??
        (valueNode?.type === 'Name' && valueNode.id
          ? partialMappingKeys.get(valueNode.id)
          : undefined)
      const inMemoryInput = pythonInMemoryInput(valueNode, importedNames, inMemoryInputs)
      const connectionPath = fileConnectionPath(valueNode)
      const diagnosticValue =
        valueNode &&
        pythonDiagnosticValue(
          valueNode,
          importedNames,
          shadowedStaticCalls,
          pythonTaintedNamespaces,
          knownDiagnosticValue
        )
      const objectType =
        diagnosticValue?.kind === 'path' && !diagnosticValue.observed
          ? 'pathlib.PurePath'
          : scientificObjectType(valueNode)
      const importedAlias =
        valueNode?.type === 'Name' && valueNode.id ? importedNames.get(valueNode.id) : undefined
      pyChildren(node).forEach(visit)
      for (const target of targets) {
        if (target.type !== 'Name' || !target.id) continue
        if (conditionalDepth > 0) {
          // A skipped rebind leaves the old object alive through this name.
          for (const values of [collections, partialMappingKeys, partialCollectionRows]) {
            const previous = values.get(target.id)
            if (!previous) continue
            for (const [source, value] of values) {
              if (source !== target.id && value === previous) {
                possibleAliases.push({ target: target.id, source })
              }
            }
          }
        }
        if (conditionalDepth > 0 && valueNode?.type === 'Name' && valueNode.id) {
          possibleAliases.push({ target: target.id, source: valueNode.id })
        }
        shadowedStaticCalls.add(target.id)
        if (
          conditionalDepth === 0 &&
          ((valueNode?.type === 'Call' && canonicalCallName(valueNode) === 'zipfile.ZipFile') ||
            (valueNode?.type === 'Name' && valueNode.id && archiveNames.has(valueNode.id)))
        )
          archiveNames.add(target.id)
        else archiveNames.delete(target.id)
        importedNames.delete(target.id)
        if (importedAlias && conditionalDepth === 0) importedNames.set(target.id, importedAlias)
        if (conditionalDepth > 0 || !mappingKeys) partialMappingKeys.delete(target.id)
        else partialMappingKeys.set(target.id, mappingKeys)
        if (
          conditionalDepth > 0 ||
          !collectionRows?.some((row) => row.some((item) => item === undefined))
        ) {
          partialCollectionRows.delete(target.id)
        } else {
          partialCollectionRows.set(target.id, collectionRows)
        }
        if (conditionalDepth > 0) {
          bindings.delete(target.id)
          collections.delete(target.id)
          inMemoryInputs.delete(target.id)
          fileConnections.delete(target.id)
          scientificObjectTypes.delete(target.id)
        } else if (value !== undefined) {
          bindings.set(target.id, value)
          collections.delete(target.id)
          inMemoryInputs.delete(target.id)
          fileConnections.delete(target.id)
          if (objectType === 'pathlib.PurePath') scientificObjectTypes.set(target.id, objectType)
          else scientificObjectTypes.delete(target.id)
        } else if (collection) {
          bindings.delete(target.id)
          collections.set(target.id, collection)
          inMemoryInputs.delete(target.id)
          fileConnections.delete(target.id)
          scientificObjectTypes.delete(target.id)
        } else if (inMemoryInput) {
          bindings.delete(target.id)
          collections.delete(target.id)
          inMemoryInputs.add(target.id)
          fileConnections.delete(target.id)
          scientificObjectTypes.delete(target.id)
        } else if (connectionPath) {
          bindings.delete(target.id)
          collections.delete(target.id)
          inMemoryInputs.delete(target.id)
          fileConnections.set(target.id, connectionPath)
          scientificObjectTypes.delete(target.id)
          if (objectType === 'pandas.ExcelFile') scientificObjectTypes.set(target.id, objectType)
        } else if (objectType) {
          bindings.delete(target.id)
          collections.delete(target.id)
          inMemoryInputs.delete(target.id)
          fileConnections.delete(target.id)
          scientificObjectTypes.set(target.id, objectType)
        } else {
          bindings.delete(target.id)
          collections.delete(target.id)
          inMemoryInputs.delete(target.id)
          fileConnections.delete(target.id)
          scientificObjectTypes.delete(target.id)
        }
      }
      return
    } else if (node.type === 'Call') {
      analyzeCall(node)
    }
    pyChildren(node).forEach(visit)
  }
  visit(tree)

  return {
    reads: [...reads].sort(),
    writes: [...writes].sort(),
    ...(writeScopes.size ? { writeScopes: [...writeScopes.values()] } : {}),
    unresolvedReads,
    unresolvedWrites,
    unsupportedExternalState,
    directoryStateRead: false,
    localFileWrappersComplete: localWrappers.complete,
    context: {
      ...(pythonTaintedNamespaces.size
        ? { pythonTaintedNamespaces: [...pythonTaintedNamespaces].sort() }
        : {}),
      pythonBindings: [
        ...[...importedNames].map(([name, qualifiedName]) => ({
          name,
          qualifiedName,
          kind: 'import' as const
        })),
        ...[...scientificObjectTypes]
          .filter(([, type]) => Boolean(PYTHON_LIBRARY_EFFECTS[type]))
          .map(([name, qualifiedName]) => ({
            name,
            qualifiedName,
            kind: 'object' as const,
            ...(qualifiedName === 'pandas.ExcelFile' && fileConnections.has(name)
              ? { filePath: fileConnections.get(name)! }
              : {})
          }))
      ].sort((a, b) => a.name.localeCompare(b.name)),
      staticStrings: [...bindings]
        .map(([name, value]) => ({ name, value }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      staticCollections: [...collections]
        .flatMap(([name, collection]) => {
          const persisted = pythonPersistedCollection(name, collection)
          return persisted ? [persisted] : []
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
      localFileWrappers: [...localWrappers.effects.values()].sort((left, right) =>
        left.name.localeCompare(right.name)
      )
    }
  }
}

const analyzePythonSources = async (
  sources: readonly string[],
  context?: NotebookSourceFileAccessContext
): Promise<NotebookRunDependencyFacts[]> => {
  const results: NotebookRunDependencyFacts[] = []
  for (const source of sources) {
    const parsed = await withParsedNotebookSource('python', source, (root) =>
      analyzePythonTree(
        root,
        context?.staticCollections,
        context?.pythonBindings,
        context?.pythonTaintedNamespaces,
        context?.staticStrings,
        context?.resolvedKernelNames,
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
const analyzePythonNotebookSource = async (
  source: string,
  context?: NotebookSourceFileAccessContext,
  fileContextForFacts?: (
    facts: NotebookRunDependencyFacts
  ) => NotebookSourceFileAccessContext | undefined
): Promise<{
  facts: NotebookRunDependencyFacts
  fileAccess?: NotebookSourceFileAccessExtraction
}> => {
  const parsed = await withParsedNotebookSource('python', source, (root) => {
    const acceptedSerializedReads = new Map<string, string>()
    const facts = analyzePythonTree(
      root,
      context?.staticCollections,
      context?.pythonBindings,
      context?.pythonTaintedNamespaces,
      context?.staticStrings,
      context?.resolvedKernelNames,
      context?.verifiedSerializedValues,
      acceptedSerializedReads
    )
    const fileAccess = analyzePythonFileAccessTree(
      root,
      fileContextForFacts ? fileContextForFacts(facts) : context,
      acceptedSerializedReads
    )
    // Static subscripting only produces a collection here for a slice of flat
    // strings. It owns its sequence; keep the read dependency without linking
    // the source and copy as shared mutable references in either projection.
    const capturedCollections = new Set(
      fileAccess.context?.staticCollections.map(({ name }) => name)
    )
    const aliases = facts.aliases?.filter(
      (alias) =>
        !(
          alias.access === 'subscript' &&
          alias.member === undefined &&
          capturedCollections.has(alias.target)
        )
    )
    return { facts: aliases ? { ...facts, aliases } : facts, fileAccess }
  })
  return parsed.state === 'ok'
    ? parsed.value
    : { facts: { state: 'unknown', reasons: [parsed.reason] } }
}

const analyzePythonFileAccesses = async (
  sources: readonly string[],
  context?: NotebookSourceFileAccessContext
): Promise<Array<NotebookSourceFileAccessExtraction | undefined>> => {
  const results: Array<NotebookSourceFileAccessExtraction | undefined> = []
  for (const source of sources) {
    results.push((await analyzePythonNotebookSource(source, context)).fileAccess)
  }
  return results
}

export { analyzePythonFileAccesses, analyzePythonSources, analyzePythonNotebookSource }
