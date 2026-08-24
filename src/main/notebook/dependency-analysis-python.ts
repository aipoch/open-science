import { PYTHON_LIBRARY_EFFECTS, type PythonLibraryMethodEffect } from './python-library-effects'
import {
  fieldChild,
  fieldChildren,
  withParsedNotebookSource,
  type Node
} from './dependency-analysis-parser'
import type {
  NotebookDependencyAlias,
  NotebookDependencyMemberWrite,
  NotebookDependencyReceiverCall,
  NotebookDependencyTypeBinding,
  NotebookDependencyTypeSummary,
  NotebookRunDependencyFacts
} from './dependency-analysis-types'

const MUTATING_METHODS = new Set([
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
const SIMPLE_FORMULA_PATTERN = /^[A-Za-z0-9_~+*:/.-]+(?:\s+[A-Za-z0-9_~+*:/.-]+)*$/u

type PyCtx = 'Load' | 'Store' | 'Del'
type ConstKind = 'int' | 'float' | 'bool' | 'str' | 'bytes' | 'none' | 'complex'

type PyArg = { type: 'arg'; arg: string }
type PyKeyword = { type: 'keyword'; arg: string | null; value: PyNode; _fields: string[] }
type PyAlias = { type: 'alias'; name: string; asname: string | null }
type PyComprehension = { target: PyNode; iter: PyNode; ifs: PyNode[] }
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
  children?: PyNode[]
  left?: PyNode
  right?: PyNode
  alternate?: PyNode
  context_expr?: PyNode
  optional_vars?: PyNode
  items?: PyNode[]
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
    value: inner
      .replaceAll(String.raw`\\`, '\u0000')
      .replaceAll(String.raw`\n`, '\n')
      .replaceAll(String.raw`\t`, '\t')
      .replaceAll(String.raw`\'`, "'")
      .replaceAll(String.raw`\"`, '"')
      .replaceAll('\u0000', '\\')
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
      py('Tuple', { elts: node.namedChildren.map((child) => convertPattern(child, ctx)), ctx }, [
        'elts'
      ])
    )
  }
  if (node.type === 'list_pattern' || node.type === 'list') {
    return locate(
      node,
      py('List', { elts: node.namedChildren.map((child) => convertPattern(child, ctx)), ctx }, [
        'elts'
      ])
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
  for (const child of node.namedChildren) {
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

const convertCallArgs = (node: Node | null): { args: PyNode[]; keywords: PyKeyword[] } => {
  const args: PyNode[] = []
  const keywords: PyKeyword[] = []
  if (!node) return { args, keywords }
  if (node.type === 'generator_expression') {
    args.push(convertExpr(node, 'Load'))
    return { args, keywords }
  }
  for (const child of node.namedChildren) {
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
  for (const child of node.namedChildren) {
    if (child.type === 'for_in_clause') {
      const left = fieldChild(child, 'left')
      const rights = fieldChildren(child, 'right')
      generators.push({
        target: left ? convertPattern(left, 'Store') : py('Name', { id: '', ctx: 'Store' }, []),
        iter: rights[0]
          ? convertExpr(rights[0], 'Load')
          : py('Constant', { value: null, constKind: 'none' }, []),
        ifs: []
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
    ? node.namedChildren
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
      if (node.namedChildren.some((child) => child.type === 'interpolation')) {
        return locate(
          node,
          py(
            'JoinedStr',
            {
              children: node.namedChildren
                .filter((child) => child.type === 'interpolation')
                .map((child) => convertExpr(fieldChild(child, 'expression') ?? child, 'Load'))
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
        py('JoinedStr', { children: node.namedChildren.map((child) => convertExpr(child, ctx)) }, [
          'children'
        ])
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
    case 'subscript':
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
            slice: fieldChild(node, 'subscript')
              ? convertExpr(fieldChild(node, 'subscript')!, 'Load')
              : py('Constant', { value: null, constKind: 'none' }, []),
            ctx
          },
          ['value', 'slice']
        )
      )
    case 'slice':
      return locate(
        node,
        py('Slice', { children: node.namedChildren.map((child) => convertExpr(child, 'Load')) }, [
          'children'
        ])
      )
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
        py('List', { elts: node.namedChildren.map((child) => convertExpr(child, ctx)), ctx }, [
          'elts'
        ])
      )
    case 'tuple':
      return locate(
        node,
        py('Tuple', { elts: node.namedChildren.map((child) => convertExpr(child, ctx)), ctx }, [
          'elts'
        ])
      )
    case 'set':
      return locate(
        node,
        py('Set', { elts: node.namedChildren.map((child) => convertExpr(child, 'Load')) }, ['elts'])
      )
    case 'dictionary':
      return locate(
        node,
        py(
          'Dict',
          {
            keys: node.namedChildren.map((child) =>
              child.type === 'pair' ? convertExpr(fieldChild(child, 'key') ?? child, 'Load') : null
            ),
            values: node.namedChildren.map((child) =>
              child.type === 'pair'
                ? convertExpr(fieldChild(child, 'value') ?? child, 'Load')
                : convertExpr(child.namedChildren[0] ?? child, 'Load')
            )
          },
          ['keys', 'values']
        )
      )
    case 'parenthesized_expression':
      return convertExpr(node.namedChildren[0] ?? node, ctx)
    case 'conditional_expression': {
      const [body, test, orelse] = node.namedChildren
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
            op: operator === '+' ? 'UAdd' : operator === '-' ? 'USub' : operator,
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
    case 'binary_operator':
    case 'comparison_operator':
      return locate(
        node,
        py(
          'BinOp',
          {
            left: fieldChild(node, 'left')
              ? convertExpr(fieldChild(node, 'left')!, 'Load')
              : undefined,
            right: fieldChild(node, 'right')
              ? convertExpr(fieldChild(node, 'right')!, 'Load')
              : undefined,
            children: node.namedChildren.map((child) => convertExpr(child, 'Load'))
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
            children: node.namedChildren.map((child) => convertExpr(child, 'Load'))
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
        py('Generic', { children: node.namedChildren.map((child) => convertExpr(child, ctx)) }, [
          'children'
        ])
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
    case 'expression_statement':
      return node.namedChildren[0] ? convertExpr(node.namedChildren[0], 'Load') : undefined
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
            children: node.namedChildren.map(
              (child) => convertStmt(child) ?? convertExpr(child, 'Load')
            )
          },
          ['children']
        )
      )
    case 'delete_statement':
      return locate(
        node,
        py('Delete', { targets: node.namedChildren.map((child) => convertPattern(child, 'Del')) }, [
          'targets'
        ])
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
            names: node.namedChildren.some((child) => child.type === 'wildcard_import')
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
        py('Global', { names: node.namedChildren.map((child) => child.text) }, [])
      )
    case 'nonlocal_statement':
      return locate(
        node,
        py('Nonlocal', { names: node.namedChildren.map((child) => child.text) }, [])
      )
    case 'return_statement':
      return locate(
        node,
        py(
          'Return',
          { value: node.namedChildren[0] ? convertExpr(node.namedChildren[0], 'Load') : null },
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

const staticNonemptyIterable = (node: PyNode | null | undefined): boolean => {
  if (!node) return false
  if (node.type === 'List' || node.type === 'Tuple' || node.type === 'Set') {
    return Boolean(node.elts?.length) && (node.elts ?? []).every(staticScalar)
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
    return staticNonemptyIterable(args[0])
  }
  if (node.func.id === 'zip' && args.length) return args.every(staticNonemptyIterable)
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

const effectOnlyLoopBody = (statements: PyNode[]): boolean => {
  const visitor = new EffectOnlyLoopBody()
  for (const statement of statements) {
    visitor.visit(statement)
    if (!visitor.safe) return false
  }
  return true
}

const scopedEffectLoops = (tree: PyNode): Set<PyNode> => {
  const loadedAfter = new Map<string, number[]>()
  for (const candidate of walkPy(tree)) {
    if (candidate.type === 'Name' && candidate.ctx === 'Load' && candidate.id) {
      const lines = loadedAfter.get(candidate.id) ?? []
      lines.push(candidate.lineno ?? 0)
      loadedAfter.set(candidate.id, lines)
    }
  }
  const result = new Set<PyNode>()
  for (const candidate of walkPy(tree)) {
    if (candidate.type !== 'For') continue
    const body = Array.isArray(candidate.body) ? candidate.body : []
    if (!simpleLoopTarget(candidate.target) || !effectOnlyLoopBody(body)) continue
    const targetNames = loopTargetNames(candidate.target)
    const bodyLoads = new Set(
      body
        .flatMap(walkPy)
        .filter((child) => child.type === 'Name' && child.ctx === 'Load' && child.id)
        .map((child) => child.id as string)
    )
    if (!targetNames.some((name) => bodyLoads.has(name))) continue
    const endLine = candidate.end_lineno ?? candidate.lineno ?? 0
    if (
      targetNames.every((name) => !(loadedAfter.get(name) ?? []).some((line) => line > endLine))
    ) {
      result.add(candidate)
    }
  }
  return result
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
    if (value && value.type !== 'Constant') this.unknown(true)
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

class Analyzer extends NodeVisitor {
  defined = new Set<string>()
  conditionallyDefined = new Set<string>()
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
  unknown = new Set<string>()
  controlDepth = 0
  localScopes: Array<Record<string, string | undefined>> = []
  builtinModuleNames = new Set(['builtins', '__builtins__'])
  importedModules = new Map<string, string>()
  importedFunctions = new Map<string, string>()

  constructor(private readonly scopedLoops: Set<PyNode>) {
    super()
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
    if (this.controlDepth > 0) this.possiblyMutated.add(name)
    else this.mutated.add(name)
  }

  conditionalFact(): { conditional?: true } {
    return this.controlDepth > 0 ? { conditional: true } : {}
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
    if (node?.type === 'Subscript') return this.receiverCallChain(node.value as PyNode)
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Attribute') {
      return [...this.receiverCallChain(node.func.value as PyNode), node.func.attr ?? '']
    }
    if (node?.type === 'Call' && isPyNode(node.func) && node.func.type === 'Name')
      return ['__call__']
    return []
  }

  receiverChainFirstArguments(node: PyNode | null | undefined): string[][] {
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
    positionalStaticBooleans: Array<boolean | null>
    keywordArguments: ReturnType<Analyzer['keywordArgumentRecord']>[]
  }> {
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
          positionalStaticBooleans: args.map((argument) =>
            argument.type === 'Constant' && argument.constKind === 'bool'
              ? Boolean(argument.value)
              : null
          ),
          keywordArguments: (node.keywords ?? []).map((keyword) =>
            this.keywordArgumentRecord(keyword)
          )
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
    const summary = PYTHON_LIBRARY_EFFECTS[module]
    if (!summary || summary.kind !== 'module') return
    this.addLibrarySummaries()
    this.importedModules.set(target, module)
    if (target !== module) this.aliases.set(target, module)
    this.typeBindings.push({ target, typeName: module, argumentNames: [] })
  }

  bindLibraryFunction(target: string, module: string, member: string): void {
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

  libraryCallEffect(node: PyNode): PythonLibraryMethodEffect | undefined {
    if (isPyNode(node.func) && node.func.type === 'Name' && node.func.id) {
      const callableType = this.importedFunctions.get(node.func.id) ?? ''
      const prefix = 'python-callable:'
      if (!callableType.startsWith(prefix)) return undefined
      const canonical = callableType.slice(prefix.length)
      const modules = Object.entries(PYTHON_LIBRARY_EFFECTS)
        .filter(([name, summary]) => summary.kind === 'module' && canonical.startsWith(`${name}.`))
        .sort((left, right) => right[0].length - left[0].length)
      const module = modules[0]?.[0]
      if (!module) return undefined
      return PYTHON_LIBRARY_EFFECTS[module]?.methods[canonical.slice(module.length + 1)]
    }
    if (!isPyNode(node.func) || node.func.type !== 'Attribute') return undefined
    const receiver = this.visibleRootName(node.func.value as PyNode)
    const module = receiver ? this.importedModules.get(receiver) : undefined
    if (!module) return undefined
    return PYTHON_LIBRARY_EFFECTS[module]?.methods[node.func.attr ?? '']
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

  prepareAssignment(targetNames: string[]): void {
    const conditional = this.controlDepth > 0
    if (conditional) {
      this.unknown.add('control-flow')
      for (const name of targetNames) this.conditionallyDefined.add(name)
    } else {
      for (const name of targetNames) this.conditionallyDefined.delete(name)
    }
    for (const name of targetNames) {
      if (!conditional) this.clearPossibleAliases(name)
      this.importedModules.delete(name)
      this.importedFunctions.delete(name)
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
  }

  visit_Name(node: PyNode): void {
    if (!node.id || this.localScopes.some((scope) => node.id! in scope)) return
    if (node.ctx === 'Load') this.addUsed(node.id)
    else if (node.ctx === 'Store') {
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
    if (value?.type === 'Call') this.callResultNames.set(value, targetNames)
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
    if (value) this.visit(value)
    if (node.type === 'AnnAssign' && node.annotation) this.visit(node.annotation)
    this.prepareAssignment(targetNames)
    if (target?.type === 'Name' && target.id && conditionalSources.size) {
      this.unknown.add('conditional-expression')
      for (const source of conditionalSources) this.addPossibleAlias(target.id, source)
    } else if (target?.type === 'Name' && target.id && value?.type === 'Name' && aliasSource) {
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
        this.bindUnknownImport(target.id, importedMemberModule, member)
      }
    } else if (
      constructor &&
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
      (value.type === 'Dict' || value.type === 'List' || value.type === 'Tuple')
    ) {
      this.builtinContainers.add(target.id)
    }
  }

  visit_Assign(node: PyNode): void {
    const targetNames = (node.targets ?? []).flatMap((target) => this.assignedNames(target))
    const target = (node.targets ?? []).length === 1 ? node.targets![0] : undefined
    this.bindAssignmentValue(
      node,
      target,
      isPyNode(node.value) ? node.value : undefined,
      targetNames
    )
    for (const assigned of node.targets ?? []) this.visit(assigned)
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
    if (this.localScopes.length) this.unknown.add('comprehension-scope')
    this.bindAssignmentValue(
      node,
      node.target,
      isPyNode(node.value) ? node.value : undefined,
      this.assignedNames(node.target)
    )
    if (node.target) this.visit(node.target)
  }

  visit_If = this.visit_control

  visit_For(node: PyNode): void {
    const deterministic = staticNonemptyIterable(node.iter)
    const scoped = this.scopedLoops.has(node)
    const body = Array.isArray(node.body) ? node.body : []
    if (!simpleLoopTarget(node.target) || !effectOnlyLoopBody(body) || !(deterministic || scoped)) {
      this.visit_control(node)
      return
    }
    if (node.iter) this.visit(node.iter)
    const targetNames = this.assignedNames(node.target)
    if (deterministic) {
      this.prepareAssignment(targetNames)
      for (const name of targetNames) this.defined.add(name)
    }
    const sources = this.expressionVisibleRoots(node.iter)
    this.localScopes.push(
      Object.fromEntries(targetNames.map((name, index) => [name, sources[index] ?? sources[0]]))
    )
    for (const statement of body) this.visit(statement)
    this.localScopes.pop()
    for (const statement of node.orelse ?? []) this.visit(statement)
  }

  visit_AsyncFor = this.visit_control
  visit_While = this.visit_control
  visit_Try = this.visit_control
  visit_Match = this.visit_control

  visit_IfExp(node: PyNode): void {
    this.controlDepth += 1
    this.genericVisit(node)
    this.controlDepth -= 1
  }

  visit_FunctionDef(node: PyNode): void {
    if (node.name) {
      this.prepareAssignment([node.name])
      this.defined.add(node.name)
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

  visit_Lambda(): void {
    this.unknown.add('lambda-scope')
  }

  visitComprehension(node: PyNode, values: Array<PyNode | undefined>): void {
    const scope: Record<string, string | undefined> = {}
    this.localScopes.push(scope)
    for (const generator of node.generators ?? []) {
      this.visit(generator.iter)
      const sources = this.expressionVisibleRoots(generator.iter)
      for (const [index, name] of this.assignedNames(generator.target).entries()) {
        scope[name] = sources[index] ?? sources[0]
      }
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

  visit_AugAssign(node: PyNode): void {
    const name = this.visibleRootName(node.target)
    if (name) {
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
    } else {
      this.unknown.add('dynamic-assignment')
      if (node.target) this.visit(node.target)
    }
    if (isPyNode(node.value)) this.visit(node.value)
  }

  visit_Subscript(node: PyNode): void {
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

  visit_Call(node: PyNode): void {
    const libraryEffect = this.libraryCallEffect(node)
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
          positionalStaticBooleans: args.map((argument) =>
            argument.type === 'Constant' && argument.constKind === 'bool'
              ? Boolean(argument.value)
              : null
          ),
          resultNames: this.callResultNames.get(node) ?? [],
          keywordArguments: (node.keywords ?? []).map((keyword) =>
            this.keywordArgumentRecord(keyword)
          )
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
        positionalStaticBooleans: args.map((argument) =>
          argument.type === 'Constant' && argument.constKind === 'bool'
            ? Boolean(argument.value)
            : null
        ),
        resultNames: this.callResultNames.get(node) ?? [],
        keywordArguments: (node.keywords ?? []).map((keyword) =>
          this.keywordArgumentRecord(keyword)
        )
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
        positionalStaticBooleans: args.map((argument) =>
          argument.type === 'Constant' && argument.constKind === 'bool'
            ? Boolean(argument.value)
            : null
        ),
        resultNames: this.callResultNames.get(node) ?? [],
        keywordArguments: (node.keywords ?? []).map((keyword) =>
          this.keywordArgumentRecord(keyword)
        )
      })
    }
    if (isPyNode(node.func) && node.func.type === 'Attribute') {
      const name = this.receiverRootName(node.func.value as PyNode)
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
      if (name) {
        const argumentsNames = this.visibleRoots([
          ...args,
          ...(node.keywords ?? []).map((keyword) => keyword.value)
        ])
        if (localReceiver) {
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
            receiverChainPositionalStaticBooleans: chainArguments.map(
              (step) => step.positionalStaticBooleans
            ),
            receiverChainKeywordArguments: chainArguments.map((step) => step.keywordArguments),
            receiverValueNames: this.receiverValueRoots(node.func.value as PyNode),
            positionalArgumentNames: args.map((argument) => this.expressionVisibleRoots(argument)),
            positionalStaticBooleans: args.map((argument) =>
              argument.type === 'Constant' && argument.constKind === 'bool'
                ? Boolean(argument.value)
                : null
            ),
            resultNames: this.callResultNames.get(node) ?? [],
            keywordArguments: (node.keywords ?? []).map((keyword) =>
              this.keywordArgumentRecord(keyword, true)
            )
          })
          const effect = this.libraryCallEffect(node)
          if (effect?.mutatesKeyword) {
            for (const keyword of node.keywords ?? []) {
              if (keyword.arg !== effect.mutatesKeyword) continue
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
      } else if (!literalReceiver) {
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
    typeBindings: analyzer.typeBindings,
    receiverCalls: analyzer.receiverCalls,
    memberWrites: analyzer.memberWrites
  }
}

const analyzePythonTree = (root: Node): NotebookRunDependencyFacts => {
  const tree = convertModule(root)
  const analyzer = new Analyzer(scopedEffectLoops(tree))
  analyzer.visit(tree)
  const facts = factsFromAnalyzer(analyzer)
  const reasons = new Set(analyzer.unknown)
  const hasRemainingConditionalEffects =
    analyzer.conditionallyDefined.size > 0 ||
    analyzer.possiblyMutated.size > 0 ||
    analyzer.possibleAliases.size > 0 ||
    analyzer.receiverCalls.some((call) => call.conditional) ||
    analyzer.memberWrites.some((write) => write.conditional)
  if (!hasRemainingConditionalEffects) reasons.delete('control-flow')
  if (reasons.size) {
    return { state: 'unknown', reasons: [...reasons].sort(), ...facts }
  }
  return { state: 'available', ...facts }
}

const analyzePythonSources = async (
  sources: readonly string[]
): Promise<NotebookRunDependencyFacts[]> => {
  const results: NotebookRunDependencyFacts[] = []
  for (const source of sources) {
    const parsed = await withParsedNotebookSource('python', source, analyzePythonTree)
    results.push(
      parsed.state === 'ok' ? parsed.value : { state: 'unknown', reasons: [parsed.reason] }
    )
  }
  return results
}

export { analyzePythonSources }
