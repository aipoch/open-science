import {
  fieldChild,
  fieldChildren,
  withParsedNotebookSource,
  type Node
} from '@aipoch/notebook-syntax'
import type { z } from 'zod'
import { rPackageBindingsSchema } from './r-package-bindings'

export type RPackageBindings = NonNullable<z.infer<typeof rPackageBindingsSchema>>

type Shape =
  'numeric' | 'logical' | 'character' | 'column' | 'data-frame' | 'matrix' | 'null' | 'effect'

const callPackages = new Map<string, string>([
  ...[
    'c',
    'pmax',
    'pmin',
    'log',
    'log10',
    'abs',
    'sqrt',
    'is.finite',
    'is.na',
    'as.numeric',
    'as.double',
    'as.integer',
    'ifelse',
    'which',
    'length',
    'seq_len',
    'seq_along',
    'round',
    'floor',
    'ceiling',
    'as.matrix',
    'colnames',
    'rownames',
    'identical',
    'stopifnot'
  ].map((name): [string, string] => [name, 'base']),
  ['.subset2', 'base'],
  ['read.csv', 'utils'],
  ['write.csv', 'utils'],
  ['plot.default', 'graphics'],
  ['abline', 'graphics'],
  ['png', 'grDevices'],
  ['dev.off', 'grDevices']
])
const numeric = (shape: Shape | undefined): boolean =>
  shape === 'numeric' || shape === 'logical' || shape === 'column'
const atomic = (shape: Shape | undefined): boolean => numeric(shape) || shape === 'character'
const arithmetic = new Set(['+', '-', '*', '/', '^', '%%', '%/%', ':'])
const comparisons = new Set(['<', '<=', '>', '>=', '==', '!='])
const logical = new Set(['&', '|', '&&', '||', '!'])
const plotArguments = new Set([
  'x',
  'y',
  'pch',
  'xlab',
  'ylab',
  'main',
  'col',
  'cex',
  'xlim',
  'ylim',
  'log',
  'type',
  'axes',
  'frame.plot',
  'asp',
  'bg',
  'lwd',
  'cex.main',
  'cex.lab'
])
const csvArguments = new Set([
  'file',
  'header',
  'sep',
  'quote',
  'dec',
  'fill',
  'comment.char',
  'row.names',
  'check.names',
  'stringsAsFactors',
  'na.strings',
  'col.names',
  'encoding',
  'fileEncoding',
  'strip.white',
  'blank.lines.skip',
  'nrows',
  'skip'
])
// This proves bounded CSV preparation and ordinary file-to-base-graphics code, not arbitrary R
// package usage. An unknown value/call/dispatch prevents proving fresh-session file isolation.
const checkBaseRSource = async (
  source: string,
  bindings: RPackageBindings | undefined,
  priorBindingNames: readonly string[] = []
): Promise<'isolated' | 'method-conflict' | 'unavailable'> => {
  const checked = rPackageBindingsSchema.safeParse(bindings)
  if (!checked.success || !checked.data?.complete || source.length > 256 * 1024)
    return 'unavailable'
  const observed = new Map<string, Set<string>>()
  for (const { name, package: owner } of checked.data.reads) {
    const owners = observed.get(name) ?? new Set<string>()
    owners.add(owner)
    observed.set(name, owners)
  }
  const boundTo = (name: string, owner: string): boolean => {
    const owners = observed.get(name)
    return owners?.size === 1 && owners.has(owner)
  }
  const parsed = await withParsedNotebookSource('r', source, (root) => {
    const values = new Map<string, Shape>()
    const priorBindings = new Set(priorBindingNames)
    let methodConflict = false
    const usesMethods = (...names: string[]): void => {
      methodConflict ||= names.some((name) => priorBindings.has(name))
    }
    let deviceOpen = false
    let openedDevice = false
    let visited = 0
    const evaluate = (node: Node | null, depth = 0): Shape | undefined => {
      if (!node || ++visited > 4096 || depth > 64) return undefined
      const child = (field: string): Shape | undefined =>
        evaluate(fieldChild(node, field), depth + 1)
      switch (node.type) {
        case 'program':
        case 'braced_expression':
        case 'parenthesized_expression': {
          const body = node.type === 'program' ? node.namedChildren : fieldChildren(node, 'body')
          let result: Shape | undefined
          for (const statement of body) {
            if (statement.type === 'comment') continue
            result = evaluate(statement, depth + 1)
            if (!result) return undefined
          }
          return result
        }
        case 'integer':
        case 'float':
        case 'inf':
        case 'nan':
        case 'na':
          return 'numeric'
        case 'true':
        case 'false':
          return 'logical'
        case 'string':
          return 'character'
        case 'null':
          return 'null'
        case 'identifier':
          return values.get(node.text)
        case 'binary_operator': {
          const operator = fieldChild(node, 'operator')?.text ?? ''
          if (!boundTo(operator, 'base')) return undefined
          if (operator === '<-' || operator === '=') {
            const target = fieldChild(node, 'lhs')
            if (target?.type !== 'identifier' || callPackages.has(target.text)) return undefined
            const result = child('rhs')
            if (!result || result === 'effect') return undefined
            values.set(target.text, result)
            return result
          }
          const left = child('lhs')
          const right = child('rhs')
          if (arithmetic.has(operator) && numeric(left) && numeric(right)) return 'numeric'
          if (comparisons.has(operator) && atomic(left) && atomic(right)) return 'logical'
          if (logical.has(operator) && numeric(left) && numeric(right)) return 'logical'
          return undefined
        }
        case 'unary_operator': {
          const operator = fieldChild(node, 'operator')?.text ?? ''
          if (!boundTo(operator, 'base') || !numeric(child('rhs'))) return undefined
          if (operator === '+' || operator === '-') return 'numeric'
          if (operator === '!') return 'logical'
          return undefined
        }
        case 'extract_operator': {
          const frame = child('lhs') === 'data-frame'
          if (frame) usesMethods('$.data.frame')
          return fieldChild(node, 'operator')?.text === '$' &&
            boundTo('$', 'base') &&
            frame &&
            fieldChild(node, 'rhs')?.type === 'identifier'
            ? 'column'
            : undefined
        }
        case 'subset':
        case 'subset2': {
          if (!boundTo(node.type === 'subset' ? '[' : '[[', 'base')) return undefined
          const value = child('function')
          const args =
            fieldChild(node, 'arguments')?.namedChildren.filter(
              (argument) => argument.type === 'argument'
            ) ?? []
          if (value === 'data-frame') {
            usesMethods(node.type === 'subset' ? '[.data.frame' : '[[.data.frame')
            return node.type === 'subset2' &&
              args.length === 1 &&
              !fieldChild(args[0], 'name') &&
              fieldChild(args[0], 'value')?.type === 'string'
              ? 'column'
              : undefined
          }
          if (!atomic(value)) return undefined
          if (
            args.some((argument) => {
              if (fieldChild(argument, 'name')) return true
              const index = fieldChild(argument, 'value')
              return index !== null && !atomic(evaluate(index, depth + 1))
            })
          )
            return undefined
          return value
        }
        case 'call': {
          const callee = fieldChild(node, 'function')
          let name: string | undefined
          let qualified = false
          if (callee?.type === 'identifier') {
            name = callee.text
            const owner = callPackages.get(name)
            if (!owner || values.has(name) || !boundTo(name, owner)) return undefined
          } else if (callee?.type === 'namespace_operator') {
            if (fieldChild(callee, 'operator')?.text !== '::' || !boundTo('::', 'base'))
              return undefined
            const owner = fieldChild(callee, 'lhs')
            const member = fieldChild(callee, 'rhs')
            if (owner?.type !== 'identifier' || member?.type !== 'identifier') return undefined
            name = member.text
            if (callPackages.get(name) !== owner.text) return undefined
            qualified = true
          } else return undefined
          if ((name === 'plot.default' || name === '.subset2') && !qualified) return undefined
          const argumentsNode = fieldChild(node, 'arguments')
          const args =
            argumentsNode?.namedChildren.filter((argument) => argument.type === 'argument') ?? []
          const evaluated = args.map((argument) => ({
            name: fieldChild(argument, 'name')?.text,
            shape: evaluate(fieldChild(argument, 'value'), depth + 1)
          }))
          if (evaluated.some(({ shape }) => !shape || shape === 'effect')) return undefined
          if (
            evaluated.some(({ shape }) => shape === 'data-frame' || shape === 'matrix') &&
            !['.subset2', 'as.matrix', 'colnames', 'rownames', 'write.csv'].includes(name)
          )
            return undefined
          const positional = evaluated.filter((argument) => !argument.name)
          const argument = (key: string, position: number): Shape | undefined =>
            evaluated.find((item) => item.name === key)?.shape ?? positional[position]?.shape
          const allowedNames = (names: ReadonlySet<string>): boolean =>
            evaluated.every((item) => !item.name || names.has(item.name))
          if (name === 'as.matrix' || name === 'colnames' || name === 'rownames') {
            if (evaluated.length !== 1 || !allowedNames(new Set(['x']))) return undefined
            const input = argument('x', 0)
            if (input === 'data-frame')
              usesMethods(
                ...(name === 'as.matrix'
                  ? ['as.matrix.data.frame', 'names.data.frame', 'row.names.data.frame']
                  : [
                      'names.data.frame',
                      'dimnames.data.frame',
                      'dim.data.frame',
                      'row.names.data.frame'
                    ])
              )
            if (name === 'as.matrix') return input === 'data-frame' ? 'matrix' : undefined
            return input === 'data-frame' || input === 'matrix' ? 'character' : undefined
          }
          if (name === 'identical')
            return evaluated.length === 2 &&
              allowedNames(new Set(['x', 'y'])) &&
              evaluated.every(({ shape }) => atomic(shape) || shape === 'null')
              ? 'logical'
              : undefined
          if (name === 'stopifnot')
            return evaluated.length > 0 && evaluated.every(({ shape }) => shape === 'logical')
              ? 'effect'
              : undefined
          if (name === 'write.csv') {
            const input = argument('x', 0)
            if (input === 'data-frame') usesMethods('names.data.frame', 'row.names.data.frame')
            const fileArgument =
              args.find((item) => fieldChild(item, 'name')?.text === 'file') ??
              args.filter((item) => !fieldChild(item, 'name'))[1]
            return allowedNames(new Set(['x', 'file', 'row.names', 'na'])) &&
              positional.length <= 2 &&
              (input === 'data-frame' || input === 'matrix') &&
              fieldChild(fileArgument, 'value')?.type === 'string' &&
              args.every((item) => {
                const key = fieldChild(item, 'name')?.text
                const value = fieldChild(item, 'value')
                if (key === 'row.names') return value?.type === 'true' || value?.type === 'false'
                if (key === 'na') return value?.type === 'string'
                return true
              })
              ? 'effect'
              : undefined
          }
          if (name === 'read.csv') {
            const factors = args.find(
              (item) => fieldChild(item, 'name')?.text === 'stringsAsFactors'
            )
            return allowedNames(csvArguments) &&
              positional.length <= 1 &&
              argument('file', 0) === 'character' &&
              fieldChild(factors, 'value')?.type === 'false'
              ? 'data-frame'
              : undefined
          }
          if (name === '.subset2')
            return evaluated.length === 2 &&
              positional.length === 2 &&
              evaluated[0]?.shape === 'data-frame' &&
              fieldChild(args[1], 'value')?.type === 'string'
              ? 'column'
              : undefined
          if (name === 'png') {
            const supported =
              allowedNames(
                new Set([
                  'filename',
                  'width',
                  'height',
                  'units',
                  'pointsize',
                  'bg',
                  'res',
                  'family',
                  'type',
                  'antialias'
                ])
              ) && argument('filename', 0) === 'character'
            if (!supported || deviceOpen || openedDevice) return undefined
            deviceOpen = true
            openedDevice = true
            return 'effect'
          }
          if (name === 'dev.off') {
            if (evaluated.length !== 0 || !deviceOpen) return undefined
            deviceOpen = false
            return 'effect'
          }
          if (name === 'plot.default')
            return deviceOpen &&
              allowedNames(plotArguments) &&
              numeric(argument('x', 0)) &&
              numeric(argument('y', 1))
              ? 'effect'
              : undefined
          if (name === 'abline')
            return deviceOpen &&
              allowedNames(new Set(['a', 'b', 'h', 'v', 'col', 'lty', 'lwd'])) &&
              evaluated.every(({ name: key, shape }) => key === 'col' || numeric(shape))
              ? 'effect'
              : undefined
          if (name === 'c')
            return evaluated.every(({ shape }) => atomic(shape))
              ? evaluated.some(({ shape }) => shape === 'character')
                ? 'character'
                : 'numeric'
              : undefined
          if (name === 'ifelse')
            return evaluated.length === 3 &&
              numeric(evaluated[0]?.shape) &&
              evaluated.slice(1).every(({ shape }) => numeric(shape))
              ? 'numeric'
              : undefined
          if (name === 'length' || name === 'seq_along')
            return evaluated.length === 1 && atomic(evaluated[0]?.shape) ? 'numeric' : undefined
          return evaluated.length > 0 && evaluated.every(({ shape }) => numeric(shape))
            ? name === 'is.finite' || name === 'is.na'
              ? 'logical'
              : 'numeric'
            : undefined
        }
        default:
          return undefined
      }
    }
    const supported = evaluate(root) !== undefined && !deviceOpen
    if (methodConflict) return 'method-conflict' as const
    return supported ? ('isolated' as const) : ('unavailable' as const)
  })
  return parsed.state === 'ok' ? parsed.value : 'unavailable'
}

// A warm session may use its exact captured packages while still proving that
// this bounded file consumer creates all values and devices needed by its code.
export const canReplayRFileCodeInFreshSession = (
  source: string,
  bindings?: RPackageBindings,
  priorBindingNames: readonly string[] = []
): Promise<'isolated' | 'method-conflict' | 'unavailable'> =>
  checkBaseRSource(source, bindings, priorBindingNames)
