import { posix, win32 } from 'node:path'
import { fieldChild, withParsedNotebookSource, type Node } from './dependency-analysis-parser'
import type {
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessContext,
  NotebookSourceFileAccessExtraction
} from './dependency-analysis-types'

type Value = { roots: string[]; text?: string; module?: string; plain?: boolean; shared?: boolean }
const empty = (): Value => ({ roots: [] })
const builtins = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'JSON',
  'Math',
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Set',
  'Error',
  'TypeError',
  'ReferenceError',
  'console',
  'host',
  'process',
  'require',
  'globalThis'
])
const pureMethods = new Set([
  'map',
  'filter',
  'slice',
  'find',
  'findIndex',
  'includes',
  'indexOf',
  'join',
  'concat',
  'some',
  'every',
  'reduce',
  'flat',
  'flatMap',
  'at',
  'test'
])
const mutatingMethods = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'sort',
  'reverse',
  'splice',
  'add'
])
const pureCalls = new Set([
  'JSON.stringify',
  'JSON.parse',
  'Object.entries',
  'Object.keys',
  'Object.values',
  'Array.isArray',
  'Array.from',
  'Number',
  'String',
  'Boolean',
  'Error',
  'TypeError',
  'ReferenceError',
  'Number.isFinite',
  'Number.isNaN',
  'console.log',
  'console.error'
])
const readMethods = new Set(['readFileSync'])
const writeMethods = new Set(['writeFileSync', 'appendFileSync'])

// Decode a restricted literal without evaluating Notebook code or accepting escape sequences
// whose path meaning differs across JavaScript and JSON.
const literal = (node: Node | null): string | undefined => {
  if (!node || !['string', 'template_string'].includes(node.type)) return undefined
  if (node.namedChildren.some((child) => child.type === 'template_substitution')) return undefined
  const text = node.text.slice(1, -1)
  if (!text.includes('\\')) return text
  if (node.text.startsWith('"')) {
    try {
      return JSON.parse(node.text) as string
    } catch {
      return undefined
    }
  }
  return undefined
}

const analyzeReplTree = (
  root: Node,
  context?: NotebookSourceFileAccessContext
): {
  facts: NotebookRunDependencyFacts
  fileAccess: NotebookSourceFileAccessExtraction
} => {
  const defined = new Set<string>()
  const conditional = new Set<string>()
  const used = new Set<string>()
  const prior = new Set<string>()
  const mutated = new Set<string>()
  const possiblyMutated = new Set<string>()
  const reasons = new Set<string>()
  const safeCalls = new Set<string>()
  const containers = new Set(context?.replContainerNames ?? [])
  const globalStrings = new Map(context?.staticStrings.map(({ name, value }) => [name, value]))
  const aliases: NonNullable<NotebookRunDependencyFacts['aliases']> = []
  const reads = new Set<string>()
  const writes = new Set<string>()
  let unresolvedReads = false
  let unresolvedWrites = false
  let external = false
  let conditionalDepth = 0
  const scopes: Array<Map<string, Value>> = [new Map()]
  const local = (name: string): Map<string, Value> | undefined =>
    scopes.findLast((scope) => scope.has(name))
  const unsupported = (reason = 'opaque-call'): void => {
    reasons.add(reason)
    unresolvedReads = true
    unresolvedWrites = true
  }
  const global = (name: string): Value => {
    used.add(name)
    if (!defined.has(name)) prior.add(name)
    return {
      roots: [name],
      text: globalStrings.get(name),
      plain: containers.has(name),
      shared: true
    }
  }
  const property = (node: Node): string | undefined =>
    node.type === 'member_expression'
      ? fieldChild(node, 'property')?.text
      : literal(fieldChild(node, 'index'))
  const dotted = (node: Node | null): string | undefined => {
    if (!node) return undefined
    if (node.type === 'identifier') {
      const binding = local(node.text)
      return binding
        ? binding.get(node.text)?.module
        : builtins.has(node.text)
          ? node.text
          : undefined
    }
    if (!['member_expression', 'subscript_expression'].includes(node.type)) return undefined
    const prefix = dotted(fieldChild(node, 'object'))
    const member = property(node)
    return prefix && member ? `${prefix}.${member}` : undefined
  }
  const globalTarget = (node: Node | null): string | undefined => {
    if (!node) return undefined
    if (node.type === 'identifier' && !local(node.text)) return node.text
    if (
      ['member_expression', 'subscript_expression'].includes(node.type) &&
      dotted(fieldChild(node, 'object')) === 'globalThis'
    )
      return property(node)
    return undefined
  }
  const merge = (values: Value[]): Value => ({
    roots: [...new Set(values.flatMap((v) => v.roots))]
  })
  const alternatives = (values: Value[]): Value => ({
    ...merge(values),
    plain: values.every((value) => value.plain),
    shared: values.some((value) => value.shared),
    ...(values.every((value) => value.text === values[0]?.text) ? { text: values[0]?.text } : {})
  })
  const bindPattern = (node: Node | null, value: Value): void => {
    if (!node) return
    if (
      ['assignment_pattern', 'object_assignment_pattern', 'computed_property_name'].includes(
        node.type
      )
    )
      unsupported('dynamic-assignment')
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
      scopes.at(-1)!.set(node.text, { ...value, text: undefined, module: undefined })
    } else for (const child of node.namedChildren) bindPattern(child, value)
  }
  const callback = (node: Node, receiverRoots: string[]): Value => {
    scopes.push(new Map())
    bindPattern(fieldChild(node, 'parameters') ?? fieldChild(node, 'parameter'), {
      roots: receiverRoots,
      plain: true,
      shared: receiverRoots.length > 0
    })
    conditionalDepth++
    const result = visit(fieldChild(node, 'body'))
    conditionalDepth--
    scopes.pop()
    return result
  }
  const assign = (target: Node | null, value: Value, update = false): void => {
    if (!target) return
    const name = globalTarget(target)
    if (name) {
      if (builtins.has(name)) unsupported('dynamic-namespace')
      if (update) {
        global(name)
        ;(conditionalDepth ? possiblyMutated : mutated).add(name)
      } else if (conditionalDepth) conditional.add(name)
      else defined.add(name)
      globalStrings.delete(name)
      containers.delete(name)
      if (!conditionalDepth && !update) {
        if (value.text !== undefined) globalStrings.set(name, value.text)
        if (value.plain) containers.add(name)
        for (const source of value.shared ? value.roots : [])
          if (source !== name) aliases.push({ target: name, source, kind: 'possible-reference' })
      }
      return
    }
    if (target.type === 'identifier') {
      const scope = local(target.text)
      scope?.set(
        target.text,
        conditionalDepth || update ? merge([scope.get(target.text)!, value]) : value
      )
      return
    }
    if (['member_expression', 'subscript_expression'].includes(target.type)) {
      const receiver = visit(fieldChild(target, 'object'))
      for (const name of receiver.roots) (conditionalDepth ? possiblyMutated : mutated).add(name)
      if (!receiver.plain || (!update && !value.plain)) unsupported('dynamic-assignment')
      if (target.type === 'subscript_expression') visit(fieldChild(target, 'index'))
      return
    }
    unsupported('dynamic-assignment')
  }
  const call = (node: Node): Value => {
    const fn = fieldChild(node, 'function')
    const args = fieldChild(node, 'arguments')?.namedChildren ?? []
    const name = dotted(fn)
    if (name === 'require' && args.length === 1) {
      const module = literal(args[0]!)?.replace(/^node:/u, '')
      safeCalls.add('require')
      if (module === 'fs' || module === 'path') return { roots: [], module }
      unsupported()
      return empty()
    }
    const receiverValue =
      fn && ['member_expression', 'subscript_expression'].includes(fn.type) && !name
        ? visit(fieldChild(fn, 'object'))
        : undefined
    const values = args.map((arg) => {
      if (arg.type === 'arrow_function') return callback(arg, receiverValue?.roots ?? [])
      const argumentName = dotted(arg)
      if (argumentName && ['Boolean', 'Number', 'String'].includes(argumentName)) {
        safeCalls.add(argumentName)
        return { roots: [], plain: true }
      }
      return visit(arg)
    })
    const combined = merge(values)
    if (name === 'host.mcp') {
      safeCalls.add('host')
      external = true
      return { ...combined, plain: true }
    }
    if (
      name &&
      (pureCalls.has(name) || /^Math\.(abs|min|max|floor|ceil|round|sqrt|pow|log|exp)$/u.test(name))
    ) {
      safeCalls.add(name.split('.')[0]!)
      if (!values.every((value) => value.plain)) unsupported()
      return {
        ...combined,
        plain: values.every((value) => value.plain),
        shared:
          ['Object.entries', 'Object.values', 'Array.from'].includes(name) &&
          values.some((value) => value.shared)
      }
    }
    if (name === 'path.join' || name === 'path.posix.join' || name === 'path.win32.join') {
      if (!values.every((value) => value.plain)) unsupported()
      const parts = values.map((value) => value.text)
      const path =
        name === 'path.win32.join' || (name === 'path.join' && process.platform === 'win32')
          ? win32
          : posix
      return {
        ...combined,
        plain: true,
        ...(parts.length && parts.every((part) => part !== undefined)
          ? { text: path.join(...(parts as string[])) }
          : {})
      }
    }
    if (name?.startsWith('fs.')) {
      const method = name.slice(3)
      const path = values[0]?.text
      if (readMethods.has(method) || writeMethods.has(method)) {
        const reading = readMethods.has(method) || method === 'appendFileSync'
        const writing = writeMethods.has(method)
        // Explicit options can change write mode or invoke arbitrary getters.
        const supportedOptions =
          args.length <= (reading && !writing ? 2 : 3) &&
          (args.length < (writing ? 3 : 2) || literal(args.at(-1)!) !== undefined)
        if (!supportedOptions) unsupported()
        if (reading) {
          if (path !== undefined) reads.add(path)
          else unresolvedReads = true
          if (conditionalDepth) unresolvedReads = true
        }
        if (writing) {
          if (path !== undefined) writes.add(path)
          else unresolvedWrites = true
          if (conditionalDepth) unresolvedWrites = true
        }
        return { ...combined, plain: true }
      }
    }
    if (fn && ['member_expression', 'subscript_expression'].includes(fn.type)) {
      const receiver = receiverValue ?? visit(fieldChild(fn, 'object'))
      const method = property(fn)
      if (receiver.plain && method && (pureMethods.has(method) || mutatingMethods.has(method))) {
        if (!values.every((value) => value.plain)) unsupported()
        if (mutatingMethods.has(method))
          for (const root of receiver.roots)
            (conditionalDepth ? possiblyMutated : mutated).add(root)
        return {
          ...merge([receiver, ...values]),
          plain: values.every((value) => value.plain),
          shared: receiver.shared || values.some((value) => value.shared)
        }
      }
    } else visit(fn)
    unsupported()
    return combined
  }
  const visit = (node: Node | null): Value => {
    if (!node) return empty()
    switch (node.type) {
      case 'identifier': {
        const binding = local(node.text)
        if (binding) return binding.get(node.text)!
        if (builtins.has(node.text)) return empty()
        return global(node.text)
      }
      case 'shorthand_property_identifier':
        return local(node.text)?.get(node.text) ?? global(node.text)
      case 'string':
      case 'template_string': {
        const text = literal(node)
        return {
          ...merge(node.namedChildren.filter((c) => c.type === 'template_substitution').map(visit)),
          plain: true,
          ...(text !== undefined ? { text } : {})
        }
      }
      case 'number':
      case 'regex':
      case 'true':
      case 'false':
      case 'null':
      case 'property_identifier':
      case 'comment':
        return { roots: [], plain: true }
      case 'member_expression':
      case 'subscript_expression': {
        const owner = fieldChild(node, 'object')
        if (dotted(owner) === 'globalThis') {
          const name = property(node)
          if (name) return global(name)
          unsupported('dynamic-namespace')
        }
        const name = dotted(node)
        if (name?.startsWith('process.env.')) {
          const value = context?.managedEnvironment?.[name.slice('process.env.'.length)]
          const text = typeof value === 'string' ? value : undefined
          if (text === undefined) external = true
          return { roots: [], plain: true, ...(text !== undefined ? { text } : {}) }
        }
        const value = visit(owner)
        if (node.type === 'subscript_expression') visit(fieldChild(node, 'index'))
        return { roots: value.roots, plain: value.plain, shared: value.shared }
      }
      case 'variable_declarator': {
        const name = fieldChild(node, 'name')
        const value = visit(fieldChild(node, 'value'))
        if (name?.type === 'identifier') scopes.at(-1)!.set(name.text, value)
        else bindPattern(name, value)
        return value
      }
      case 'assignment_expression':
      case 'augmented_assignment_expression': {
        const value = visit(fieldChild(node, 'right'))
        assign(fieldChild(node, 'left'), value, node.type !== 'assignment_expression')
        return value
      }
      case 'update_expression':
        assign(fieldChild(node, 'argument'), empty(), true)
        return empty()
      case 'call_expression':
        return call(node)
      case 'await_expression':
      case 'parenthesized_expression':
        return visit(node.namedChildren[0] ?? null)
      case 'new_expression': {
        if (dotted(fieldChild(node, 'constructor')) !== 'Set') {
          unsupported('function-scope')
          node.namedChildren.forEach(visit)
          return empty()
        }
        safeCalls.add('Set')
        const values = (fieldChild(node, 'arguments')?.namedChildren ?? []).map(visit)
        if (!values.every((value) => value.plain)) unsupported()
        return {
          ...merge(values),
          plain: values.every((value) => value.plain),
          shared: values.some((value) => value.shared)
        }
      }
      case 'unary_expression': {
        const value = visit(fieldChild(node, 'argument'))
        if (fieldChild(node, 'operator')?.text === 'delete') {
          assign(fieldChild(node, 'argument'), empty(), true)
          unsupported('dynamic-assignment')
        }
        return { ...merge([value]), plain: true }
      }
      case 'array':
      case 'object': {
        const values = node.namedChildren.map(visit)
        return {
          ...merge(values),
          plain: values.every((value) => value.plain),
          shared: values.some((value) => value.shared)
        }
      }
      case 'spread_element': {
        const value = visit(node.namedChildren[0] ?? null)
        if (!value.plain) unsupported('function-scope')
        return value
      }
      case 'computed_property_name':
        return visit(node.namedChildren[0] ?? null)
      case 'pair': {
        visit(fieldChild(node, 'key'))
        return visit(fieldChild(node, 'value'))
      }
      case 'binary_expression': {
        const left = visit(fieldChild(node, 'left'))
        const operator = fieldChild(node, 'operator')?.text
        const shortCircuit = ['||', '&&', '??'].includes(operator ?? '')
        if (shortCircuit) conditionalDepth++
        const right = visit(fieldChild(node, 'right'))
        if (shortCircuit) conditionalDepth--
        if (shortCircuit) return alternatives([left, right])
        return {
          ...merge([left, right]),
          plain: true,
          ...(operator === '+' && left.text !== undefined && right.text !== undefined
            ? { text: left.text + right.text }
            : {})
        }
      }
      case 'ternary_expression': {
        const condition = visit(fieldChild(node, 'condition'))
        conditionalDepth++
        const consequence = visit(fieldChild(node, 'consequence'))
        const alternative = visit(fieldChild(node, 'alternative'))
        conditionalDepth--
        return {
          ...alternatives([consequence, alternative]),
          roots: merge([condition, consequence, alternative]).roots
        }
      }
      case 'for_in_statement': {
        const value = visit(fieldChild(node, 'right'))
        scopes.push(new Map())
        conditionalDepth++
        if (fieldChild(node, 'kind'))
          bindPattern(fieldChild(node, 'left'), { ...value, text: undefined })
        else assign(fieldChild(node, 'left'), { ...value, text: undefined })
        visit(fieldChild(node, 'body'))
        conditionalDepth--
        scopes.pop()
        return empty()
      }
      case 'if_statement':
      case 'for_statement':
      case 'while_statement':
      case 'do_statement':
      case 'try_statement':
        conditionalDepth++
        node.namedChildren.forEach(visit)
        conditionalDepth--
        return empty()
      case 'return_statement':
        return visit(node.namedChildren[0] ?? null)
      case 'statement_block': {
        scopes.push(new Map())
        const values = node.namedChildren.map(visit)
        scopes.pop()
        return alternatives(values)
      }
      case 'catch_clause':
        scopes.push(new Map())
        bindPattern(fieldChild(node, 'parameter'), { roots: [], plain: true })
        visit(fieldChild(node, 'body'))
        scopes.pop()
        return empty()
      case 'method_definition':
      case 'arrow_function':
      case 'function_expression':
      case 'function_declaration':
      case 'class_declaration':
        unsupported('function-scope')
        return empty()
      default:
        return merge(node.namedChildren.map(visit))
    }
  }
  if (context?.replNamespaceUncertain) unsupported('dynamic-namespace')
  visit(root)
  if (conditional.size || possiblyMutated.size) reasons.add('control-flow')
  const facts = {
    definedNames: [...defined].sort(),
    conditionallyDefinedNames: [...conditional].sort(),
    usedNames: [...used].sort(),
    priorUsedNames: [...prior].sort(),
    mutatedNames: [...mutated].sort(),
    possiblyMutatedNames: [...possiblyMutated].sort(),
    aliases,
    builtinContainerNames: [...containers].filter((name) => defined.has(name)),
    safeCallNames: [...safeCalls].sort()
  }
  return {
    facts: reasons.size
      ? { state: 'unknown', reasons: [...reasons].sort(), ...facts }
      : { state: 'available', ...facts },
    fileAccess: {
      reads: [...reads].sort(),
      writes: [...writes].sort(),
      unresolvedReads,
      unresolvedWrites,
      unsupportedExternalState: external,
      directoryStateRead: false,
      localFileWrappersComplete: true,
      context: {
        staticStrings: [...globalStrings]
          .filter(([name]) => defined.has(name))
          .map(([name, value]) => ({ name, value })),
        staticCollections: [],
        localFileWrappers: []
      }
    }
  }
}

const analyzeReplNotebookSource = async (
  source: string,
  context?: NotebookSourceFileAccessContext
): Promise<{
  facts: NotebookRunDependencyFacts
  fileAccess?: NotebookSourceFileAccessExtraction
}> => {
  const parsed = await withParsedNotebookSource('javascript', source, (root) =>
    analyzeReplTree(root, context)
  )
  return parsed.state === 'ok'
    ? parsed.value
    : { facts: { state: 'unknown', reasons: [parsed.reason] } }
}

export { analyzeReplNotebookSource }
