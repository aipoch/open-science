import { setImmediate as yieldAnalysis } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, resolve, win32 } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import {
  fieldChild,
  fieldChildren,
  withParsedNotebookSource,
  type Node
} from './dependency-analysis-parser'
import type { NotebookSourceFileAccessContext } from './dependency-analysis-types'
import { parsePowerShellSearchCommands } from './powershell-search-parser'

/** Source evidence for a one-call decision, never a reusable permission or a safety certificate. */
export type NotebookCodeRisk = Readonly<{
  operation: string
  source: string
  line: number
}>

type Language = 'python' | 'r' | 'repl' | 'bash'
type Bindings = Map<string, string>

// Deferred paths are analysis-only: filesystem verdicts must never enter replay snapshots.
type RiskEvidence = NotebookCodeRisk & {
  overwritePath?: string
  overwriteCwd?: string
  copyBasename?: string | null
  freshHandle?: boolean
}
type FunctionEvidence = { name: string; effects: RiskEvidence[]; members: Bindings }
type ReplaySnapshot = {
  bindings: [string, string][]
  functions: [string, { name: string; effects: RiskEvidence[]; members: [string, string][] }][]
  objectRevision: number
}

// Content-addressed source evidence only. No parser nodes, execution receipts or permissions survive.
const replaySnapshots = new Map<string, string>()
let replaySnapshotCharacters = 0
const MAX_REPLAY_STATE_CHARACTERS = 1024 * 1024
const replayKey = (parent: string, script: string, incomplete: boolean): string =>
  createHash('sha256')
    .update(parent)
    .update(incomplete ? '1' : '0')
    .update(script, 'utf16le')
    .digest('hex')
const rememberReplaySnapshot = (key: string, snapshot: string): void => {
  replaySnapshotCharacters -= replaySnapshots.get(key)?.length ?? 0
  replaySnapshots.delete(key)
  replaySnapshots.set(key, snapshot)
  replaySnapshotCharacters += snapshot.length
  while (replaySnapshots.size > 8 || replaySnapshotCharacters > 4 * MAX_REPLAY_STATE_CHARACTERS) {
    const oldest = replaySnapshots.keys().next().value!
    replaySnapshotCharacters -= replaySnapshots.get(oldest)!.length
    replaySnapshots.delete(oldest)
  }
}

// Branch evidence contains only target strings, never parser nodes or reusable permissions.
const possibleTargets = (target: string | undefined): (string | undefined)[] =>
  target?.startsWith('@choices:') ? JSON.parse(target.slice('@choices:'.length)) : [target]
const mergeTargets = (targets: (string | undefined)[]): string => {
  const values = [...new Set(targets.flatMap(possibleTargets).map((value) => value ?? '<dynamic>'))]
  // ponytail: bound branch provenance rather than build a general symbolic evaluator.
  if (values.includes('@choices-overflow') || values.length > 16) return '@choices-overflow'
  return values.length === 1 ? values[0] : `@choices:${JSON.stringify(values.sort())}`
}
const joinedBindings = (...states: Bindings[]): Bindings => {
  const names = new Set(states.flatMap((state) => [...state.keys()]))
  return new Map(
    [...names].map((name) => [name, mergeTargets(states.map((state) => state.get(name) ?? name))])
  )
}
const uniqueRisks = (risks: RiskEvidence[]): RiskEvidence[] => [
  ...new Map(risks.map((risk) => [JSON.stringify(risk), risk])).values()
]

// Cwd expressions contain source path steps relative to the invocation, never host cwd or stat
// results. Keeping them in Bindings gives branches and incomplete cells the same bounded joins.
const CWD_BINDING = '@execution-cwd'
const FILE_SCOPE_BINDING = '@file-scope'
const INITIAL_CWD = '@cwd:[]'
const cwdSteps = (target: string | undefined): string[] | undefined =>
  target?.startsWith('@cwd:') ? JSON.parse(target.slice(5)) : undefined
const appendCwd = (base: string | undefined, steps: readonly string[] | undefined): string => {
  if (!steps) return '<dynamic>'
  const absolute = steps.findLastIndex((step) => isAbsolute(step))
  if (absolute >= 0) return `@cwd:${JSON.stringify(steps.slice(absolute))}`
  const before = cwdSteps(base)
  return before && before.length + steps.length <= 64
    ? `@cwd:${JSON.stringify([...before, ...steps])}`
    : '<dynamic>'
}
const composeCwd = (base: string | undefined, change: string | undefined): string =>
  mergeTargets(
    possibleTargets(base ?? INITIAL_CWD).flatMap((origin) =>
      possibleTargets(change ?? INITIAL_CWD).map((target) => appendCwd(origin, cwdSteps(target)))
    )
  )

async function resolveOverwriteRisks(
  evidence: RiskEvidence[],
  cwd?: string,
  signal?: AbortSignal
): Promise<NotebookCodeRisk[]> {
  const results: NotebookCodeRisk[] = []
  const existing = new Map<string, { exists: boolean; directory: boolean }>()
  const directories = new Map<string, string | undefined>()
  const physicalDirectory = async (path: string): Promise<string | undefined> => {
    signal?.throwIfAborted()
    if (directories.has(path)) return directories.get(path)
    if (directories.size >= 256) throw new Error('Notebook cwd analysis exceeds path limit')
    let physical: string | undefined
    try {
      physical = await realpath(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // A directory created earlier in this cell is absent during preflight. Existing symlinks
      // have already been resolved step by step; retain only a lexical candidate for new paths.
      if (code === 'ENOENT' || code === 'ENOTDIR') physical = resolve(path)
    }
    directories.set(path, physical)
    return physical
  }
  const inspect = async (path: string): Promise<{ exists: boolean; directory: boolean }> => {
    signal?.throwIfAborted()
    const cached = existing.get(path)
    if (cached) return cached
    if (existing.size >= 256) throw new Error('Notebook write analysis exceeds path limit')
    let value: { exists: boolean; directory: boolean }
    try {
      const info = await stat(path)
      value = { exists: true, directory: info.isDirectory() }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      value = { exists: code !== 'ENOENT' && code !== 'ENOTDIR', directory: false }
    }
    existing.set(path, value)
    return value
  }
  for (const { overwritePath, overwriteCwd, copyBasename, freshHandle, ...risk } of evidence) {
    signal?.throwIfAborted()
    if (freshHandle) continue
    if (overwritePath !== undefined) {
      let overwrites = false
      for (const origin of possibleTargets(overwriteCwd ?? INITIAL_CWD)) {
        const steps = isAbsolute(overwritePath) ? [] : cwdSteps(origin)
        // A visible cwd-changing call with unresolved input invalidates relative-path exemptions.
        if (!steps) {
          overwrites = true
          break
        }
        if (!cwd && ![...steps, overwritePath].some(isAbsolute)) continue
        let directory = cwd
        for (const step of steps) {
          if (isAbsolute(step)) directory = await physicalDirectory(step)
          else if (directory !== undefined)
            directory = await physicalDirectory(`${directory}/${step}`)
        }
        if (!isAbsolute(overwritePath) && directory === undefined) {
          overwrites = true
          break
        }
        // Do not normalize '..' before the filesystem follows intermediate symlinks.
        let path = isAbsolute(overwritePath) ? overwritePath : `${directory}/${overwritePath}`
        let info = await inspect(path)
        if (info.directory && copyBasename !== undefined) {
          if (copyBasename === null) {
            overwrites = true
            break
          }
          path = `${path}/${copyBasename}`
          info = await inspect(path)
        }
        if (info.exists) {
          overwrites = true
          break
        }
      }
      if (!overwrites) continue
    }
    results.push(risk)
  }
  signal?.throwIfAborted()
  return uniqueRisks(results)
}
type PythonFileHandle = { mode: string; prior?: boolean; scope: string }
const pythonFileHandle = (
  target: string
): { handle: PythonFileHandle; member: string } | undefined => {
  const match = /^@python-file:(.+);(\.[a-zA-Z_]+)?$/.exec(target)
  return match ? { handle: JSON.parse(match[1]), member: match[2] ?? '' } : undefined
}
const pythonPartialTarget = (target: string): string | undefined =>
  target.startsWith('@python-partial:') && target.endsWith(';')
    ? target.slice('@python-partial:'.length, -1)
    : undefined
const pythonAttrgetterNames = (target: string): string[] | undefined =>
  target.startsWith('@python-attrgetter:') && target.endsWith(';')
    ? JSON.parse(target.slice('@python-attrgetter:'.length, -1))
    : undefined
const pythonItemgetterKeys = (target: string): (string | number)[] | undefined =>
  target.startsWith('@python-itemgetter:') && target.endsWith(';')
    ? JSON.parse(target.slice('@python-itemgetter:'.length, -1))
    : undefined
const memberTarget = (target: string, property: string): string =>
  target === '@choices-overflow'
    ? target
    : mergeTargets(
        possibleTargets(target).map((value) =>
          property === 'func' && value && pythonPartialTarget(value)
            ? pythonPartialTarget(value)
            : `${value}.${property}`
        )
      )
const resolvedMemberTarget = (target: string, property: string, bindings: Bindings): string =>
  target === '@choices-overflow'
    ? target
    : mergeTargets(
        possibleTargets(target).map((value) => {
          const member = `${value}.${property}`
          return bindings.get(member) ?? memberTarget(value ?? '<dynamic>', property)
        })
      )
const jsApplyBoundTarget = (target: string): string | undefined =>
  target.startsWith('@apply-bound:') && target.endsWith(';')
    ? target.slice('@apply-bound:'.length, -1)
    : undefined
const booleanCondition = (node: Node | null): boolean | undefined => {
  while (node?.type === 'parenthesized_expression')
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null
  if (node?.type === 'true') return true
  if (node?.type === 'false') return false
  return undefined
}

// Python's selection expressions return operands, not a synthesized boolean value.
const pythonSelection = (node: Node): [Node, Node, Node] | undefined => {
  if (node.type === 'conditional_expression') {
    const values = node.namedChildren.filter((child) => child.type !== 'comment')
    if (values.length === 3) return [values[1], values[0], values[2]]
  }
  if (node.type === 'boolean_operator') {
    const left = fieldChild(node, 'left')
    const right = fieldChild(node, 'right')
    const operator = fieldChild(node, 'operator')?.text
    if (left && right && ['and', 'or'].includes(operator ?? ''))
      return operator === 'and' ? [left, right, left] : [left, left, right]
  }
  return undefined
}

// Only syntactically guaranteed control transfer stops sequential source inspection.
const blockControl = (node: Node | null): string | undefined => {
  if (!node) return undefined
  if (
    [
      'break_statement',
      'continue_statement',
      'return_statement',
      'raise_statement',
      'throw_statement',
      'break',
      'next'
    ].includes(node.type)
  )
    return node.type
  if (['block', 'statement_block', 'braced_expression'].includes(node.type)) {
    for (const child of node.namedChildren) {
      const control = blockControl(child)
      if (control) return control
    }
  }
  if (node.type === 'if_statement') {
    const truth = booleanCondition(fieldChild(node, 'condition'))
    if (truth === true) return blockControl(fieldChild(node, 'consequence'))
    if (truth === false) return blockControl(fieldChild(node, 'alternative'))
  }
  if (node.type === 'else_clause')
    return blockControl(fieldChild(node, 'body') ?? node.namedChild(0))
  return undefined
}
const containsLoopBreak = (node: Node | null, root = true): boolean => {
  if (!node) return false
  if (['break_statement', 'break'].includes(node.type)) return true
  if (
    !root &&
    [
      'for_statement',
      'for_in_statement',
      'while_statement',
      'do_statement',
      'repeat_statement',
      'function_definition',
      'function_declaration',
      'function_expression',
      'method_definition',
      'arrow_function',
      'lambda'
    ].includes(node.type)
  )
    return false
  return node.namedChildren.some((child) => containsLoopBreak(child, false))
}

export async function analyzePowerShellCodeRisk(
  source: string,
  signal?: AbortSignal,
  version: '5.1' | '7.6' = '5.1',
  cwd?: string
): Promise<NotebookCodeRisk[]> {
  try {
    const commands = await parsePowerShellSearchCommands(source, signal, version, true)
    const evidence: RiskEvidence[] = commands.flatMap(
      ({ name, arguments: args, source: commandSource, line }) => {
        const command = name?.split('\\').at(-1)?.toLowerCase()
        const overwritePath = powerShellOverwriteTarget(command ?? '', args)
        const risky =
          !command ||
          [
            'remove-item',
            'ri',
            'rm',
            'rmdir',
            'del',
            'erase',
            'copy-item',
            'copy',
            'cpi',
            'cp',
            'move-item',
            'move',
            'mi',
            'mv',
            'rename-item',
            'ren',
            'rni',
            'clear-content',
            'format-volume',
            'invoke-expression',
            'iex',
            'start-process',
            'powershell',
            'pwsh',
            'cmd',
            '@overwrite',
            '@dynamic-member'
          ].includes(command) ||
          /^@member:(?:delete|deletefile|deletedirectory|invoke|start)$/i.test(command) ||
          /^@file:(?:delete|move|replace)$/.test(command) ||
          (!command.startsWith('@') &&
            commandRisk(
              command,
              args.map((arg) => arg ?? undefined)
            ))
        return risky || overwritePath !== undefined
          ? [
              {
                operation:
                  overwritePath !== undefined
                    ? `${name} existing-file overwrite`
                    : (name ?? 'dynamic PowerShell command'),
                source: commandSource ?? args.filter((arg) => arg !== null).join(' '),
                line: line ?? 1,
                ...(!risky && overwritePath !== undefined ? { overwritePath } : {})
              }
            ]
          : []
      }
    )
    return await resolveOverwriteRisks(evidence, cwd, signal)
  } catch {
    signal?.throwIfAborted()
    return [{ operation: 'PowerShell analysis unavailable', source, line: 1 }]
  }
}

const powerShellOverwriteTarget = (
  command: string,
  args: (string | null)[]
): string | undefined => {
  if (/^@file:(?:writealltext|writealllines|writeallbytes|create|createtext)$/.test(command))
    return args[0] ?? undefined
  if (command === '@file:copy')
    return args[2]?.toLowerCase() === 'true' ? (args[1] ?? undefined) : undefined
  if (!['set-content', 'sc', 'out-file', 'of', 'tee-object', 'tee'].includes(command))
    return undefined
  const output = !['set-content', 'sc'].includes(command)
  let path: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === null) continue
    const parameter = arg.toLowerCase()
    if (output && ['-append', '-noclobber'].includes(parameter)) {
      const next = args[index + 1]?.toLowerCase()
      if (next !== 'false' && next !== null) return undefined
      index++
    } else if (['-path', '-literalpath', '-filepath'].includes(parameter)) {
      path = args[++index] ?? undefined
    } else if (arg.startsWith('-')) {
      // Known value parameters consume one argument; switches do not. Unsupported binding
      // remains unresolved instead of mistaking an option value for the destination.
      if (
        [
          '-encoding',
          '-value',
          '-inputobject',
          '-width',
          '-filter',
          '-include',
          '-exclude',
          '-credential',
          '-erroraction',
          '-warningaction'
        ].includes(parameter)
      )
        index++
      else if (!['-force', '-nonewline', '-verbose', '-debug'].includes(parameter)) return undefined
    } else if (index === 0) path = arg
  }
  return path
}
const pythonDeletion =
  /^(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|pathlib\.(?:Path|PosixPath|WindowsPath)\.(?:unlink|rmdir))$/
const jsDeletion = /^(?:node:)?fs(?:\.promises)?\.(?:rm|unlink|rmdir)(?:Sync)?$/
const explicitFileMutation = (language: Language, target: string): boolean =>
  language === 'python'
    ? /^(?:os\.(?:truncate|ftruncate|rename|renames|replace)|pathlib\.(?:Path|PosixPath|WindowsPath)\.(?:rename|replace)|shutil\.move)$/.test(
        target
      )
    : language === 'repl'
      ? /^(?:node:)?fs(?:\.promises)?\.(?:truncate|ftruncate|rename)(?:Sync)?$/.test(target)
      : language === 'r' && /^(?:base::)?(?:file\.rename|truncate)$/.test(target)

// Only concrete targets and known write modes become candidates. Unknown scientific calls and
// dynamic output paths are not blanket review triggers. Argument effects are visited separately.
const overwriteTarget = (
  language: Language,
  target: string,
  args: Node[],
  functionNode: Node | null | undefined,
  bindings: Bindings
): string | undefined => {
  if (language === 'python') {
    const positional = pythonPositional(args)
    const argument = (name: string, position: number): Node | null | undefined =>
      pythonKeyword(args, name, bindings) ?? positional[position]
    const pathMethod =
      /^pathlib\.(?:Path|PosixPath|WindowsPath)\.(open|write_text|write_bytes)$/.exec(target)
    const receiver = pathMethod ? fieldChild(functionNode, 'object') : undefined
    if (pathMethod && !receiver) return undefined
    const path = receiver ?? argument('file', 0)
    if (/^(?:(?:builtins|io)\.)?open$/.test(target) || pathMethod?.[1] === 'open') {
      const mode = processString(argument('mode', receiver ? 0 : 1)) ?? 'r'
      return /^w[bt]?\+?$|^w\+[bt]?$/.test(mode)
        ? pythonProcessText(pythonProcessValue(path, bindings), bindings)
        : undefined
    }
    if (pathMethod) return pythonProcessText(pythonProcessValue(path, bindings), bindings)
    if (/^shutil\.(?:copyfile|copy2?)$/.test(target))
      return pythonProcessText(pythonProcessValue(argument('dst', 1), bindings), bindings)
  }
  if (language === 'repl') {
    if (!/^(?:node:)?fs(?:\.promises)?\./.test(target)) return undefined
    const method = target.split('.').at(-1)!.replace(/Sync$/, '')
    if (method === 'copyFile') {
      // COPYFILE_EXCL (1) prevents destination replacement.
      if (
        (args[2]?.type === 'number' && Number(args[2].text) & 1) ||
        /^(?:node:)?fs\.constants\.COPYFILE_EXCL$/.test(identity(args[2] ?? null, bindings) ?? '')
      )
        return undefined
      return processString(args[1])
    }
    if (!['writeFile', 'appendFile', 'open', 'createWriteStream'].includes(method)) return undefined
    let flag: string | undefined = method === 'appendFile' ? 'a' : method === 'open' ? 'r' : 'w'
    if (method === 'open') flag = args[1] ? processString(args[1]) : flag
    else {
      const options = unparenthesized(args[method === 'createWriteStream' ? 1 : 2])
      if (options?.type === 'object') {
        for (const entry of options.namedChildren) {
          if (entry.type === 'comment') continue
          if (entry.type !== 'pair') {
            flag = undefined
            continue
          }
          const key = fieldChild(entry, 'key')
          const name =
            key?.type === 'computed_property_name' ? processString(key.namedChild(0)) : literal(key)
          if (name === (method === 'createWriteStream' ? 'flags' : 'flag'))
            flag = processString(fieldChild(entry, 'value'))
          else if (name === undefined) flag = undefined
        }
      } else if (
        options &&
        !['string', 'null', 'arrow_function', 'function_expression'].includes(options.type)
      )
        flag = undefined
    }
    // Opening r+ alone does not mutate data; writeFile/streams with r+ do.
    return flag &&
      (['w', 'w+'].includes(flag) || (method !== 'open' && ['r+', 'rs+', 'sr+'].includes(flag)))
      ? processString(args[0])
      : undefined
  }
  if (language === 'r') {
    const name = target.replace(/^base::/, '')
    const formals =
      name === 'writeLines'
        ? ['text', 'con', 'sep', 'useBytes']
        : name === 'writeBin'
          ? ['object', 'con', 'size', 'endian', 'useBytes']
          : name === 'cat'
            ? ['...', 'file', 'sep', 'fill', 'labels', 'append']
            : name === 'file'
              ? ['description', 'open']
              : undefined
    if (!formals) return undefined
    // cat's parameters after ... require exact names and never consume positional data.
    const matched =
      name === 'cat'
        ? new Map(
            args.flatMap((arg) => {
              const key = literal(fieldChild(arg, 'name'))
              return key && ['file', 'append'].includes(key) ? [[key, arg] as const] : []
            })
          )
        : rArguments(args, formals)
    const value = (key: string): Node | null => fieldChild(matched.get(key), 'value')
    if (name === 'cat' && value('append') && value('append')?.text !== 'FALSE') return undefined
    if (name === 'file' && !/^w[b+]*$/.test(processString(value('open')) ?? '')) return undefined
    return processString(value(name === 'cat' ? 'file' : name === 'file' ? 'description' : 'con'))
  }
  return undefined
}
const processCall =
  /^(?:os\.(?:system|popen|(?:exec|spawn)[lv]p?e?|posix_spawnp?)|pty\.spawn|runpy\.run_(?:path|module)|subprocess\.(?:run|call|Popen|check_call|check_output|getoutput|getstatusoutput)|(?:node:)?child_process\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)|(?:base::)?system2?)$/
const jsVmExecution =
  /^(?:node:)?vm\.(?:Script\.(?:prototype\.)?)?runIn(?:Context|NewContext|ThisContext)$/
const jsCallbackIndex = (target: string): number | undefined => {
  if (
    /^(?:(?:globalThis|global)\.)?(?:Array\.from(?:Async)?|(?:Object|Map)\.groupBy|(?:(?:Int|Uint)(?:8|16|32)Array|Uint8ClampedArray|Float(?:16|32|64)Array|Big(?:Int|Uint)64Array)\.from)$/.test(
      target
    ) ||
    /\.(?:replace|replaceAll)$/.test(target)
  )
    return 1
  if (
    /\.(?:map|flatMap|forEach|filter|some|every|find|findIndex|findLast|findLastIndex|reduce|reduceRight|sort|then|catch|finally)$/.test(
      target
    ) ||
    /^(?:(?:globalThis|global)\.)?(?:setTimeout|setInterval|setImmediate|queueMicrotask|process\.nextTick)$/.test(
      target
    ) ||
    /^(?:node:)?(?:timers\.(?:setTimeout|setInterval|setImmediate)|process\.nextTick)$/.test(target)
  )
    return 0
  return undefined
}

// Signature-specific callback positions, shared by direct calls and wrapper guards.
const pythonCallbackIndex = (target: string): number | undefined => {
  if (
    /^(?:(?:builtins\.)?(?:map|filter)|functools\.reduce|itertools\.(?:starmap|dropwhile|takewhile|filterfalse))$/.test(
      target
    )
  )
    return 0
  if (/^itertools\.(?:accumulate|groupby)$/.test(target)) return 1
  if (/^heapq\.(?:nlargest|nsmallest)$/.test(target)) return 2
  if (/^(?:(?:builtins\.)?open|io\.open)$/.test(target)) return 7
  return undefined
}
const pythonCallbackKeyword = (target: string): string | undefined => {
  if (
    /^(?:(?:builtins\.)?(?:sorted|min|max)|bisect\.(?:bisect|insort)(?:_left|_right)?|heapq\.(?:nlargest|nsmallest)|itertools\.groupby)$/.test(
      target
    ) ||
    /\.sort$/.test(target)
  )
    return 'key'
  if (target === 'itertools.accumulate') return 'func'
  if (/^(?:(?:builtins\.)?open|io\.open)$/.test(target)) return 'opener'
  return undefined
}

// Bound arguments and partial.keywords can change these signatures. Retain review rather
// than apply the unbound function's argv/callback positions to a partial's later arguments.
const pythonPartialSensitive = (target: string): boolean =>
  target.startsWith('@function:') ||
  (!target.includes('.') &&
    !target.startsWith('@') &&
    !/^(?:abs|all|any|ascii|bin|bool|bytearray|bytes|chr|complex|dict|divmod|enumerate|float|format|frozenset|hash|hex|int|len|list|oct|ord|pow|print|range|repr|reversed|round|set|slice|str|sum|tuple|type|zip)$/.test(
      target
    )) ||
  processCall.test(target) ||
  pythonCallbackIndex(target) !== undefined ||
  pythonCallbackKeyword(target) !== undefined ||
  /^(?:(?:builtins\.)?(?:eval|exec|compile|getattr|__import__)|operator\.(?:call|__call__)|functools\.(?:partial|partialmethod))$/.test(
    target
  ) ||
  target.startsWith('operator.methodcaller:')

const jsPromiseCall = /\.(?:then|catch|finally)$/
const jsPromiseConstructor = /^(?:(?:globalThis|global)\.)?Promise$/

const jsNonCallableLiteral = (node: Node | null): boolean => {
  while (node?.type === 'parenthesized_expression')
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null
  return [
    'null',
    'number',
    'string',
    'true',
    'false',
    'object',
    'array',
    'template_string'
  ].includes(node?.type ?? '')
}

// Builtin data and closed scalar expressions stay noncallable across Python bindings.
// Member values and eager construction effects still need their own source evidence.
const pythonNonCallableData = (node: Node | null): boolean => {
  const scalarExpression = (value: Node | null | undefined, depth = 0): boolean => {
    value = unparenthesized(value) ?? null
    if (!value || depth >= 64) return false
    if (['none', 'true', 'false', 'integer', 'float'].includes(value.type)) return true
    if (['string', 'concatenated_string'].includes(value.type))
      return !uncertainFormatting(value, depth + 1)
    if (
      ['unary_operator', 'not_operator', 'binary_operator', 'comparison_operator'].includes(
        value.type
      )
    ) {
      const operands = value.namedChildren.filter((child) => child.type !== 'comment')
      // Unknown operands may invoke overloaded operators; noncallable containers can also
      // hold objects with comparison/formatting hooks. Require closed scalar syntax here.
      return (
        operands.length > 0 && operands.every((operand) => scalarExpression(operand, depth + 1))
      )
    }
    return false
  }
  const uncertainFormatting = (value: Node, depth = 0): boolean => {
    if (depth >= 64) return true
    if (['interpolation', 'format_expression'].includes(value.type)) {
      const expression = unparenthesized(fieldChild(value, 'expression') ?? value.namedChild(0))
      // Formatting an unknown object can invoke __format__/__repr__ while building the data.
      if (!scalarExpression(expression, depth + 1)) return true
    }
    return value.namedChildren.some((child) => uncertainFormatting(child, depth + 1))
  }
  node = unparenthesized(node) ?? null
  return (
    scalarExpression(node) ||
    (['list', 'tuple', 'dictionary', 'set'].includes(node?.type ?? '') &&
      !!node &&
      !uncertainFormatting(node))
  )
}

// Fixed string addition avoids object conversion and overloaded operators. Keep the
// original static spelling rules and bound recursion instead of evaluating expressions.
const fixedText = (node: Node | null | undefined, depth = 0): string | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  if (
    ['binary_operator', 'binary_expression'].includes(node.type) &&
    fieldChild(node, 'operator')?.text === '+'
  ) {
    const left = fixedText(fieldChild(node, 'left'), depth + 1)
    const right = fixedText(fieldChild(node, 'right'), depth + 1)
    return left !== undefined && right !== undefined ? left + right : undefined
  }
  if (node.type === 'concatenated_string') {
    const parts = node.namedChildren
      .filter((child) => child.type !== 'comment')
      .map((child) => fixedText(child, depth + 1))
    return parts.every((part) => part !== undefined) ? parts.join('') : undefined
  }
  // Bytes may carry different native encoding semantics; they cannot select getattr names.
  return (node.type === 'string' && !/^[rubf]*b/i.test(node.text)) ||
    (node.tree.rootNode.type === 'program' && node.type === 'template_string')
    ? literal(node)
    : undefined
}

const literal = (node: Node | null): string | undefined => {
  if (!node) return undefined
  if (
    (node.tree.rootNode.type === 'module' && node.type === 'binary_operator') ||
    (node.tree.rootNode.type === 'program' && node.type === 'binary_expression')
  )
    return fixedText(node)
  if (['concatenation', 'concatenated_string'].includes(node.type)) {
    const parts = node.namedChildren.filter((child) => child.type !== 'comment').map(literal)
    return parts.every((part) => part !== undefined) ? parts.join('') : undefined
  }
  if (node.type === 'template_string') {
    // Static template content is data; never evaluate substitutions/escapes or call a tag.
    if (
      node.namedChildren.some((child) => child.type !== 'string_fragment') ||
      node.text.includes('\\')
    )
      return undefined
    return node.text.slice(1, -1)
  }
  if (['word', 'number', 'identifier', 'property_identifier'].includes(node.type)) return node.text
  if (['string', 'raw_string'].includes(node.type)) {
    if (
      node.namedChildren.some(
        (child) =>
          ![
            'string_content',
            'string_fragment',
            'string_start',
            'string_end',
            'string_open',
            'string_close'
          ].includes(child.type)
      )
    )
      return undefined
    // Escaped/interpolated strings are deliberately not decoded as executable source.
    if (node.text.includes('\\')) return undefined
    return node.text.replace(/^[rubf]*(['"])(?:\1\1)?/i, '').replace(/(['"])(?:\1\1)?$/, '')
  }
  if (node.type === 'command_name') return literal(node.namedChild(0))
  return undefined
}

const identity = (
  node: Node | null,
  bindings: Bindings,
  callTarget?: string,
  values?: ReadonlyMap<number, string | undefined>
): string | undefined => {
  if (!node) return undefined
  if (
    ['call', 'call_expression', 'new_expression', 'subscript'].includes(node.type) &&
    !values &&
    bindings.has(`@node:${node.id}`)
  ) {
    const result = bindings.get(`@node:${node.id}`)
    return result === '<dynamic>' ? undefined : result
  }
  const valueOf = (value: Node | null): string | undefined =>
    value && values?.has(value.id) ? values.get(value.id) : identity(value, bindings)
  if (node.type === 'parenthesized_expression')
    return identity(node.namedChildren.find((child) => child.type !== 'comment') ?? null, bindings)
  if (node.type === 'list_splat' && pythonEmbeddedSequenceSpread(node))
    return identity(node.namedChild(0), bindings)
  // None/NULL/null cannot become callable by assigning or forwarding the same value.
  if (node.type === 'none' || node.type === 'null') return '@noncallable'
  if (node.tree.rootNode.type === 'module' && pythonNonCallableData(node)) return '@noncallable'
  if (node.tree.rootNode.type === 'module') {
    const selection = pythonSelection(node)
    if (selection) {
      const [condition, consequence, alternative] = selection
      // An unknown object's truth test may itself run __bool__/__len__. Do not discharge
      // that implicit call merely because both result alternatives happen to be readers.
      if (identity(condition, bindings) !== '@noncallable') return undefined
      const truth = pythonLiteralTruth(condition, 0, bindings)
      return truth === undefined
        ? mergeTargets([identity(consequence, bindings), identity(alternative, bindings)])
        : identity(truth ? consequence : alternative, bindings)
    }
  }
  // Inline function syntax is visible source, not an unknown dynamic target. Its body is visited.
  if (
    ['lambda', 'arrow_function', 'function_expression', 'function_definition'].includes(node.type)
  )
    return '@inline'
  if (node.type === 'object') return bindings.get(`@node:${node.id}`)
  if (node.type === 'identifier' || node.type === 'undefined')
    return (
      bindings.get(node.text) ??
      (node.tree.rootNode.type === 'module' ? bindings.get(`builtins.${node.text}`) : undefined) ??
      node.text
    )
  // Chained assignments and assignment expressions yield their assigned value, not a new
  // dynamic callable. The normal traversal still records each binding and inspects RHS effects.
  const assigned = assignment(node)
  if (assigned) {
    const value = identity(assigned.right, bindings)
    // Assigned anonymous bodies are summarized instead of executed by traversal. Their return
    // identity is not yet available here, so keep an immediate invocation reviewable.
    return value === '@inline' ? undefined : value
  }
  if (node.type === 'subscript' && node.tree.rootNode.type === 'module') {
    const indices = fieldChildren(node, 'subscript')
    const key = indices.length === 1 ? pythonItemKey(indices[0]) : undefined
    const item =
      key === undefined
        ? undefined
        : pythonLiteralItemNode(fieldChild(node, 'value'), key, bindings)
    const target = item ? valueOf(item) : undefined
    return target === '@inline' ? undefined : target
  }
  if (node.type === 'subscript_expression') {
    const object = fieldChild(node, 'object')
    const index = fieldChild(node, 'index')
    // JavaScript obj["member"] is the same fixed property as obj.member. A variable index
    // remains unresolved; do not treat an identifier's spelling as its runtime string value.
    const property = processString(index)
    return object && property
      ? resolvedMemberTarget(identity(object, bindings) ?? object.text, property, bindings)
      : undefined
  }
  if (['attribute', 'member_expression', 'extract_operator'].includes(node.type)) {
    const objectNode = fieldChild(node, node.type === 'extract_operator' ? 'lhs' : 'object')
    const object = identity(objectNode, bindings)
    const property = literal(
      fieldChild(
        node,
        node.type === 'attribute'
          ? 'attribute'
          : node.type === 'extract_operator'
            ? 'rhs'
            : 'property'
      )
    )
    // Python's explicit call method invokes the receiver. Preserve its callable identity,
    // including unresolved factories, rather than treating it as an ordinary fixed member.
    // operator.__call__ is the module's forwarding function, not a call on the module itself.
    if (node.type === 'attribute' && property === '__call__' && object !== 'operator')
      return object ?? '<dynamic>'
    // A fixed member on a returned object (open(path).read(), frame.dropna().mean()) is not
    // dynamic dispatch evidence. Keep its name for deletion checks and alias tracking; traversal
    // still inspects the receiver, arguments and callbacks for effects. Computed call targets
    // (handlers[name](), getattr(...)(), factory()()) retain the dynamic-call review below.
    return objectNode && property
      ? resolvedMemberTarget(object ?? objectNode.text, property, bindings)
      : undefined
  }
  if (node.type === 'namespace_operator')
    return `${fieldChild(node, 'lhs')?.text}::${fieldChild(node, 'rhs')?.text}`
  if (['call', 'call_expression', 'new_expression'].includes(node.type)) {
    const functionNode = fieldChild(node, 'function') ?? fieldChild(node, 'constructor')
    let callee = callTarget ?? identity(functionNode, bindings)
    if (possibleTargets(callee).length > 1)
      return mergeTargets(
        possibleTargets(callee).map((target) => identity(node, bindings, target, values))
      )
    // Script construction compiles code without executing it. Keep its instance provenance so
    // later run methods, including saved/bound aliases, cannot hide behind an ordinary member.
    const jsCall =
      node.type === 'new_expression' || node.type === 'call_expression'
        ? jsInvocation(node, bindings, callee, values)
        : undefined
    if (jsCall?.construct)
      return /^(?:node:)?vm\.Script$/.test(jsCall.callee ?? '') ? jsCall.callee : undefined
    // bind creates a callable; it does not execute its target. Resolve the actual receiver
    // node, never the textual fallback used for ordinary members on unknown returned objects.
    if (jsCall?.callee?.endsWith('.bind')) {
      let target = jsCall.thisValue
      // Inline bodies and pre-bound callbacks need their own invocation summary.
      // Until that exists, keep these results unresolved rather than lose their deferred effects.
      const args = jsCall.args
      if (jsCall.uncertainArgs || args.some((arg) => arg?.type === 'spread_element'))
        return undefined
      let boundArgumentCount = args.length
      let boundApply = false
      if (possibleTargets(target).some((value) => /\.(?:call|apply)$/.test(value ?? ''))) {
        if (!possibleTargets(target).every((value) => /\.(?:call|apply)$/.test(value ?? '')))
          return undefined
        boundApply = possibleTargets(target).every((value) => value?.endsWith('.apply'))
        if (possibleTargets(target).some((value) => value?.endsWith('.apply')) && !boundApply)
          return undefined
        // Function.call/apply.bind(actualFunction, thisValue) invokes the bound receiver, which
        // need not be the function whose call property was read. The receiver is not argv.
        target = valueOf(args[0] ?? null)
        boundArgumentCount--
      }
      // apply.bind(fn, thisValue) consumes one argument array when invoked. Other pre-bound
      // payload shapes need their own signature evidence rather than pretending to be fn(...args).
      if (boundApply && boundArgumentCount !== 1) return undefined
      return possibleTargets(target).includes('@inline') ||
        (possibleTargets(target).some(
          (value) =>
            jsCallbackIndex(value ?? '') !== undefined || jsPromiseConstructor.test(value ?? '')
        ) &&
          boundArgumentCount > 1) ||
        (boundArgumentCount > 1 &&
          possibleTargets(target).some(
            (value) => processCall.test(value ?? '') && !value?.endsWith('.fork')
          ))
        ? undefined
        : boundApply
          ? mergeTargets(
              possibleTargets(target).map((value) => (value ? `@apply-bound:${value};` : undefined))
            )
          : target
    }
    let args =
      fieldChild(node, 'arguments')?.namedChildren.filter(
        (child) => !['comment', 'comma'].includes(child.type)
      ) ?? []
    if (node.type === 'call_expression') {
      const reflection = jsCall!
      if (/^(?:(?:globalThis|global)\.)?Reflect\.get$/.test(reflection.callee ?? '')) {
        const args = reflection.args
        if (
          reflection.construct ||
          reflection.uncertainArgs ||
          args.length < 2 ||
          args.length > 3 ||
          args.some((arg) => !arg || arg.type === 'spread_element')
        )
          return undefined
        const property = processString(args[1])
        const object = valueOf(args[0])
        return property !== undefined && object
          ? resolvedMemberTarget(object, property, bindings)
          : undefined
      }
    }
    if (
      node.type === 'call' &&
      node.tree.rootNode.type === 'program' &&
      /^(?:base::)?match\.fun$/.test(callee ?? '')
    ) {
      const matched = rArguments(args, ['FUN', 'descend'])
      const value = unparenthesized(fieldChild(matched.get('FUN'), 'value'))
      const descend = fieldChild(matched.get('descend'), 'value')
      if (
        new Set(matched.values()).size !== args.length ||
        (matched.has('descend') && booleanCondition(descend) === undefined)
      )
        return undefined
      const name = processString(value)
      const target =
        value?.type === 'string' && name
          ? (bindings.get(name) ?? name)
          : identity(value ?? null, bindings)
      if (value?.type === 'string' && (!name || name.startsWith('@') || name.includes('::')))
        return undefined
      // String lookup may skip non-function bindings; unknown values may themselves name
      // another function. Preserve only visible function provenance, never inert data.
      const known = possibleTargets(target).every(
        (candidate) =>
          candidate?.startsWith('@function:') ||
          candidate === '@inline' ||
          processCall.test(candidate ?? '') ||
          /^(?:base::)?(?:sum|mean|abs|length|rbind|cbind|paste|paste0|identity|list|c|do\.call|match\.fun|readLines|readRDS|scan|unlink|file\.remove|lapply|sapply|vapply|apply|mapply|Map|Reduce|Filter|Find|Position)$/.test(
            candidate ?? ''
          )
      )
      return known ? target : undefined
    }
    let partial = false
    if (node.type === 'call')
      ({ callee, args, partial } = pythonInvocation(args, bindings, callee, values, functionNode))
    if (
      node.type === 'call' &&
      node.tree.rootNode.type === 'module' &&
      /^(?:builtins\.)?dict\.(?:get|pop|setdefault)$/.test(callee ?? '')
    ) {
      const positional = pythonPositional(args)
      const key = pythonItemKey(positional[1])
      if (
        partial ||
        positional.length < 2 ||
        positional.length > 3 ||
        key === undefined ||
        args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)) ||
        (!pythonDictionaryEntries(positional[0]) &&
          !pythonClosedKeywords(positional[0], bindings, 0, true)) ||
        positional.some((arg) => !pythonStableLiteralConstruction(arg, bindings))
      )
        return undefined
      const selected = pythonLiteralItemNode(positional[0], key, bindings)
      // A proved absent key selects the default; unknown construction cannot do so.
      if (selected === undefined) return undefined
      const result = selected ?? positional[2]
      const target = result
        ? valueOf(result)
        : callee?.endsWith('.pop')
          ? undefined
          : '@noncallable'
      return target === '@inline' ? undefined : target
    }
    const items = pythonItemgetterKeys(callee ?? '')
    if (
      node.type === 'call' &&
      node.tree.rootNode.type === 'module' &&
      (items || /^operator\.(?:getitem|__getitem__)$/.test(callee ?? ''))
    ) {
      const positional = pythonPositional(args)
      if (
        positional.length !== (items ? 1 : 2) ||
        args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)) ||
        positional.some((arg) => arg.type === 'list_splat')
      )
        return undefined
      const keys = items ?? [pythonItemKey(positional[1])]
      const selected = keys.map((key) =>
        key === undefined ? undefined : pythonLiteralItemNode(positional[0], key, bindings)
      )
      if (selected.some((item) => !item)) return undefined
      if (selected.length > 1) return '@noncallable'
      const target = valueOf(selected[0]!)
      return target === '@inline' ? undefined : target
    }
    const attributes = pythonAttrgetterNames(callee ?? '')
    if (node.type === 'call' && attributes) {
      const positional = pythonPositional(args)
      if (
        positional.length !== 1 ||
        args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)) ||
        positional[0].type === 'list_splat'
      )
        return undefined
      // Multiple names return a tuple, never one of its callable elements directly.
      if (attributes.length > 1) return '@noncallable'
      const properties = attributes[0].split('.')
      if (properties.length > 64) return undefined
      let target = valueOf(positional[0])
      for (const property of properties)
        target =
          property === '__call__'
            ? (target ?? '<dynamic>')
            : resolvedMemberTarget(target ?? positional[0].text, property, bindings)
      return target
    }
    if (node.type === 'call' && callee === 'functools.partial') {
      const positional = pythonPositional(args)
      const target = valueOf(positional[0] ?? null)
      // The function is frozen, not executed. Inline returned-callable summaries and unknown
      // packed function slots still need review when invoked. No bound AST survives a cell.
      return !target || possibleTargets(target).includes('@inline')
        ? '@python-partial:<dynamic>;'
        : mergeTargets(
            possibleTargets(target).map((value) =>
              value ? `@python-partial:${value};` : undefined
            )
          )
    }
    if (node.tree.rootNode.type === 'module' && !partial) {
      const pathOpen = /^pathlib\.(?:Path|PosixPath|WindowsPath)\.open$/.test(callee ?? '')
      if (/^(?:(?:builtins|io)\.)?open$/.test(callee ?? '') || pathOpen) {
        const modeNode =
          pythonKeyword(args, 'mode', bindings) ?? pythonPositional(args)[pathOpen ? 0 : 1]
        const mode = modeNode ? processString(modeNode) : 'r'
        if (mode && /^[rwax][bt]?\+?$|^[rwax]\+[bt]?$/.test(mode))
          return `@python-file:${JSON.stringify({ mode, scope: bindings.get(FILE_SCOPE_BINDING) ?? 'root' })};`
      }
    }
    const attribute = pythonAttributeLookup(node, bindings, callee, args, values)
    if (attribute) {
      if (!attribute.fallback || attribute.present) return attribute.member
      // Keep both known alternatives: a reader or None is not an unknown executable.
      // Destructive defaults and uncertain returned callables still retain their evidence.
      const fallback = valueOf(attribute.fallback)
      return mergeTargets([attribute.member, fallback])
    }
    if (callee === 'require' || callee === 'import' || functionNode?.type === 'import')
      return processString(args[0])?.replace('fs/promises', 'fs.promises')
    if (/^pathlib\.(Path|PosixPath|WindowsPath)$/.test(callee ?? '')) return callee
    // Accessor factories create a known reader callable. Its result, however, may be arbitrary
    // data or another callable; do not keep treating repeated invocations as factory creation.
    if (node.tree.rootNode.type === 'module' && callee === 'operator.itemgetter') {
      const keys = pythonPositional(args).map(pythonItemKey)
      if (
        keys.length &&
        keys.length <= 64 &&
        keys.every((key) => key !== undefined) &&
        !args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type))
      )
        return `@python-itemgetter:${JSON.stringify(keys)};`
    }
    if (node.tree.rootNode.type === 'module' && callee === 'operator.attrgetter') {
      const names = pythonPositional(args).map(processString)
      if (
        names.length &&
        names.every((name) => name !== undefined) &&
        !args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type))
      )
        return `@python-attrgetter:${JSON.stringify(names)};`
    }
    if (/^operator\.(?:itemgetter|attrgetter)$/.test(callee ?? '')) return `${callee}.__call__`
    if (callee === 'operator.methodcaller' && node.tree.rootNode.type === 'module') {
      const positional = pythonPositional(args)
      const name = processString(positional[0])
      const frozenArguments =
        positional.length > 1 ||
        args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type))
      const sortKey = name === 'sort' ? pythonKeyword(args, 'key', bindings) : undefined
      const sortKeyTarget = sortKey ? identity(sortKey, bindings) : undefined
      // A frozen builtin/reader accessor keeps its identity if its source name is later rebound.
      // Do not infer effects for user callbacks or packed/positional method arguments.
      const sortCallbackRisk =
        name === 'sort' &&
        (positional.length > 1 ||
          sortKey === null ||
          (sortKey !== undefined &&
            sortKeyTarget !== '@noncallable' &&
            pythonAttrgetterNames(sortKeyTarget ?? '') === undefined &&
            pythonItemgetterKeys(sortKeyTarget ?? '') === undefined &&
            !/^(?:(?:builtins\.)?(?:len|abs|str|int|float|bool)|operator\.(?:itemgetter|attrgetter)\.__call__)$/.test(
              sortKeyTarget ?? ''
            )))
      // Frozen callback arguments require their own invocation summary. Keep these wrappers
      // unresolved, rather than recognize the method but lose its bound callback on invocation.
      if (
        !name ||
        (name === '__call__' && frozenArguments) ||
        sortCallbackRisk ||
        ['builtins', 'itertools', 'heapq', 'bisect', 'io', 'functools'].some(
          (module) =>
            pythonCallbackIndex(`${module}.${name}`) !== undefined ||
            (name !== 'sort' && pythonCallbackKeyword(`${module}.${name}`) !== undefined)
        ) ||
        [
          'iter',
          'submit',
          'apply',
          'apply_async',
          'map_async',
          'starmap_async',
          'partial'
        ].includes(name)
      )
        return undefined
      return `operator.methodcaller:${name}`
    }
  }
  if (node.type === 'await_expression') return identity(node.namedChild(0), bindings)
  return undefined
}

// Traversal and returned-object provenance must agree on what forwarding actually invokes.
// Arguments stay as AST nodes: no source evaluation, and normal traversal still sees eager effects.
const jsInvocation = (
  node: Node,
  bindings: Bindings,
  initialCallee: string | undefined,
  values?: ReadonlyMap<number, string | undefined>
): {
  callee: string | undefined
  args: Node[]
  construct: boolean
  uncertainArgs: boolean
  thisValue: string | undefined
} => {
  const valueOf = (node: Node | null): string | undefined =>
    node && values?.has(node.id) ? values.get(node.id) : identity(node, bindings)
  let called = fieldChild(node, 'function') ?? fieldChild(node, 'constructor')
  while (called?.type === 'parenthesized_expression')
    called = called.namedChildren.find((child) => child.type !== 'comment') ?? null
  let callee = initialCallee
  let args =
    fieldChild(node, 'arguments')?.namedChildren.filter(
      (child) => !['comma', 'comment'].includes(child.type)
    ) ?? []
  let construct = node.type === 'new_expression'
  let uncertainArgs = false
  let thisValue = valueOf(fieldChild(called, 'object'))
  const unpack = (array: Node | undefined): Node[] => {
    while (array?.type === 'parenthesized_expression')
      array = array.namedChildren.find((child) => child.type !== 'comment')
    const unpacked: Node[] = []
    if (array?.type === 'array')
      slots(array).forEach((entry, index) => {
        if (entry) unpacked[index] = entry
      })
    else if (array && !['null', 'undefined'].includes(array.type)) uncertainArgs = true
    return unpacked
  }
  let hops = 0
  while (!construct) {
    const boundApply = jsApplyBoundTarget(callee ?? '')
    const method = /\.(call|apply)$/.exec(callee ?? '')?.[1]
    const reflection = /^(?:(?:globalThis|global)\.)?Reflect\.(?:apply|construct)$/.test(
      callee ?? ''
    )
    if (!boundApply && !method && !reflection) break
    if (hops++ >= 64) {
      callee = undefined
      uncertainArgs = true
      break
    }
    if (boundApply) {
      callee = boundApply
      thisValue = undefined
      args = unpack(args[0])
    } else if (reflection) {
      construct = callee!.endsWith('.construct')
      callee = valueOf(args[0] ?? null)
      thisValue = construct ? undefined : valueOf(args[1] ?? null)
      args = unpack(args[construct ? 1 : 2])
    } else {
      // Each function helper invokes its actual this receiver, which may itself be another
      // forwarding helper. The helper's source spelling does not identify the final function.
      if (!thisValue || thisValue === '<dynamic>') {
        // Ordinary model.apply(...) methods on unknown returned objects are not proof of
        // Function.apply. An already forwarded helper with an unknown receiver remains dynamic.
        if (hops > 1) {
          callee = undefined
          uncertainArgs = true
        }
        break
      }
      callee = thisValue
      if (
        possibleTargets(callee).length > 1 &&
        possibleTargets(callee).some((value) => /\.(?:call|apply)$/.test(value ?? ''))
      )
        uncertainArgs = true
      thisValue = valueOf(args[0] ?? null)
      if (method === 'call') {
        if (args[0]?.type === 'spread_element') uncertainArgs = true
        args = args.slice(1)
      } else args = unpack(args[1])
    }
  }
  return { callee, args, construct, uncertainArgs, thisValue }
}

// Literal getattr is attribute access, just like obj.member. Unknown names retain review;
// receivers and eager default arguments still go through normal effect traversal.
const pythonAttributeLookup = (
  node: Node,
  bindings: Bindings,
  callee: string | undefined,
  raw: Node[],
  values?: ReadonlyMap<number, string | undefined>
): { member: string; fallback: Node | undefined; present: boolean } | undefined => {
  if (node.type !== 'call') return undefined
  if (!/^(?:builtins\.)?getattr$/.test(callee ?? '')) return undefined
  if (raw.some((arg) => ['dictionary_splat', 'keyword_argument'].includes(arg.type)))
    return undefined
  const args = pythonPositional(raw)
  if (args.length < 2 || args.length > 3) return undefined
  if (args.some((arg) => ['list_splat', 'dictionary_splat', 'keyword_argument'].includes(arg.type)))
    return undefined
  const property = processString(args[1])
  if (property === undefined) return undefined
  const receiver = unparenthesized(args[0])!
  const object = values?.has(args[0].id) ? values.get(args[0].id) : identity(args[0], bindings)
  // Only native slots on closed literals/types or a freshly constructed builtin file are
  // proved present. Module, named mutable-object and custom descriptor defaults stay possible.
  const stringMethods =
    /^(?:upper|lower|strip|lstrip|rstrip|split|rsplit|splitlines|startswith|endswith|find|rfind|index|rindex|count|replace|join|partition|rpartition|capitalize|casefold|swapcase|title|center|ljust|rjust|zfill|isalnum|isalpha|isascii|isdigit|islower|isspace|istitle|isupper)$/
  const stringReceiver =
    /^(?:builtins\.)?str$/.test(object ?? '') ||
    (['string', 'concatenated_string'].includes(receiver.type) &&
      !/^[rubf]*b/i.test(receiver.text) &&
      pythonNonCallableData(receiver))
  const nativeCallable =
    /^(?:builtins\.)?(?:str|bytes|int|float|bool|tuple|list|dict|set|frozenset|object|type)$/.test(
      object ?? ''
    )
  const freshFile =
    receiver.type === 'call' &&
    /^(?:(?:builtins\.|io\.)?open)$/.test(
      identity(fieldChild(receiver, 'function'), bindings) ?? ''
    ) &&
    pythonStableLiteralConstruction(receiver, bindings) &&
    (!args[2] || pythonStableLiteralConstruction(args[2], bindings))
  return {
    member:
      property === '__call__' && object !== 'operator'
        ? (object ?? '<dynamic>')
        : resolvedMemberTarget(object ?? args[0].text, property, bindings),
    fallback: args[2],
    present:
      (stringReceiver && stringMethods.test(property)) ||
      (nativeCallable && property === '__call__') ||
      (freshFile &&
        /^(?:read|readline|readlines|seek|tell|flush|close|fileno|readable|writable|seekable|isatty)$/.test(
          property
        ))
  }
}

// Module aliases share one identity. Do not use source names to invent identities for
// arbitrary instances (two Path/file objects can have different rewritten attributes).
const pythonModuleMemberKeys = (target: string | undefined, property: string): string[] =>
  possibleTargets(target).flatMap((value) =>
    /^(?:os(?:\.path)?|io|builtins|subprocess|functools|operator|shutil|itertools|heapq|bisect|pathlib(?:\.(?:Pure)?(?:Posix|Windows)?Path)?)$/.test(
      value ?? ''
    )
      ? [`${value}.${property}`]
      : []
  )

const assignment = (node: Node): { left: Node | null; right: Node | null } | undefined => {
  if (node.type === 'assignment' || node.type === 'assignment_expression')
    return { left: fieldChild(node, 'left'), right: fieldChild(node, 'right') }
  if (node.type === 'variable_declarator' || node.type === 'named_expression')
    return { left: fieldChild(node, 'name'), right: fieldChild(node, 'value') }
  if (node.type === 'binary_operator') {
    const left = fieldChild(node, 'lhs'),
      right = fieldChild(node, 'rhs')
    const operator = fieldChild(node, 'operator')?.text ?? ''
    if (['<-', '=', '<<-'].includes(operator)) return { left, right }
    if (['->', '->>'].includes(operator)) return { left: right, right: left }
  }
  return undefined
}

const isNotebookScope = (node: Node): boolean => {
  let scope = node.parent
  while (
    scope &&
    ![
      'module',
      'program',
      'function_definition',
      'function_declaration',
      'function_expression',
      'arrow_function',
      'generator_function',
      'generator_function_declaration',
      'method_definition',
      'class_definition',
      'class_declaration',
      'class'
    ].includes(scope.type)
  )
    scope = scope.parent
  return scope?.type === 'module' || scope?.type === 'program'
}

const slots = (sequence: Node): (Node | null)[] => {
  const result: (Node | null)[] = [null]
  for (const child of sequence.children) {
    if (child.type === ',') result.push(null)
    else if (child.isNamed && child.type !== 'comment') result[result.length - 1] = child
  }
  if (result.at(-1) === null) result.pop()
  return result
}

const bindingUpdates = (
  left: Node | null,
  right: Node | null,
  bindings: Bindings,
  language: Language,
  value?: string
): Bindings => {
  const updates = new Map<string, string>()
  const bind = (
    left: Node | null,
    right: Node | null,
    value = identity(right, bindings) ??
      (language === 'repl' && jsNonCallableLiteral(right) ? '@noncallable' : undefined)
  ): void => {
    if (!left) return
    if (['identifier', 'undefined', 'shorthand_property_identifier_pattern'].includes(left.type))
      updates.set(left.text, value === '@inline' ? '<dynamic>' : (value ?? '<dynamic>'))
    if (language === 'python' && left.type === 'attribute') {
      const object = identity(fieldChild(left, 'object'), bindings)
      const property = literal(fieldChild(left, 'attribute'))
      if (property)
        for (const member of pythonModuleMemberKeys(object, property))
          updates.set(
            member,
            possibleTargets(object).length > 1
              ? mergeTargets([
                  bindings.get(member) ?? member,
                  value === '@inline' ? '<dynamic>' : value
                ])
              : value === '@inline'
                ? '<dynamic>'
                : (value ?? '<dynamic>')
          )
    }
    if (left.type === 'object_pattern')
      for (const entry of left.namedChildren) {
        let keyNode = fieldChild(entry, 'key')
        if (keyNode?.type === 'computed_property_name') {
          const expression = keyNode.namedChildren.find((child) => child.type !== 'comment')
          keyNode =
            processString(expression) !== undefined ? (unparenthesized(expression) ?? null) : null
        }
        const key =
          literal(keyNode) ??
          (entry.type === 'shorthand_property_identifier_pattern'
            ? entry.text
            : entry.type === 'object_assignment_pattern'
              ? fieldChild(entry, 'left')?.text
              : undefined)
        // Recursively bind the target pattern, not its source text. A dynamic key cannot be
        // turned into a seemingly fixed member name, including inside a nested pattern.
        bind(
          fieldChild(entry, 'value') ?? entry,
          null,
          value && !['<dynamic>', '@noncallable'].includes(value) && key
            ? resolvedMemberTarget(value, key, bindings)
            : '<dynamic>'
        )
      }
    if (['assignment_pattern', 'object_assignment_pattern'].includes(left.type)) {
      const fallback = identity(fieldChild(left, 'right'), bindings)
      // Without evaluating the object, a default can select either value. Preserve an agreed
      // identity; otherwise retain uncertainty until the resulting binding is actually invoked.
      bind(fieldChild(left, 'left'), null, value === fallback ? value : '<dynamic>')
    }
    if (['pattern_list', 'tuple_pattern', 'list_pattern', 'array_pattern'].includes(left.type)) {
      const targets = slots(left)
      const values =
        right && ['expression_list', 'tuple', 'list', 'array'].includes(right.type)
          ? slots(right)
          : []
      // Unknown spreads can change positions; holes and trailing commas retain their slots.
      const spread = values.some((entry) =>
        ['list_splat', 'spread_element'].includes(entry?.type ?? '')
      )
      const rest = targets.findIndex((entry) =>
        ['list_splat_pattern', 'rest_pattern'].includes(entry?.type ?? '')
      )
      targets.forEach((target, index) => {
        const valueIndex =
          rest >= 0 && index > rest ? values.length - targets.length + index : index
        bind(target, spread || index === rest ? null : (values[valueIndex] ?? null))
      })
    }
    if (['list_splat_pattern', 'rest_pattern'].includes(left.type)) bind(left.namedChild(0), null)
  }
  bind(left, right, value)
  return updates
}

const recordBinding = (
  node: Node,
  bindings: Bindings,
  language: Language
): Bindings | undefined => {
  if (node.type === 'import_statement' && fieldChild(node, 'source')) {
    const module = literal(fieldChild(node, 'source'))?.replace('fs/promises', 'fs.promises')
    if (!module) return
    const readImport = (child: Node): void => {
      if (child.type === 'import_specifier') {
        const name = fieldChild(child, 'name')?.text
        if (name) bindings.set(fieldChild(child, 'alias')?.text ?? name, `${module}.${name}`)
      } else if (child.type === 'identifier') bindings.set(child.text, module)
      else for (const entry of child.namedChildren) readImport(entry)
    }
    for (const clause of node.namedChildren.filter((child) => child.type === 'import_clause'))
      readImport(clause)
    return
  }
  if (node.type === 'import_statement' || node.type === 'import_from_statement') {
    const module = fieldChild(node, 'module_name')?.text
    for (const name of fieldChildren(node, 'name')) {
      const imported = fieldChild(name, 'name')?.text ?? name.text
      const explicitAlias = fieldChild(name, 'alias')?.text
      const alias = explicitAlias ?? imported.split('.')[0]
      bindings.set(
        alias,
        module
          ? (bindings.get(`${module}.${imported}`) ?? `${module}.${imported}`)
          : explicitAlias
            ? imported
            : imported.split('.')[0]
      )
    }
  }
  if (language === 'python' && node.type === 'as_pattern' && node.parent?.type === 'with_item') {
    const value = identity(node.namedChild(0), bindings)
    const alias = fieldChild(node, 'alias')
    if (alias)
      bindings.set(
        alias.text,
        possibleTargets(value).every((target) => target?.startsWith('@python-file:'))
          ? value!
          : '<dynamic>'
      )
  }
  const assigned = assignment(node)
  if (assigned) {
    if (
      !assigned.right &&
      ((node.type === 'assignment' && fieldChild(node, 'type')) ||
        (node.type === 'variable_declarator' && node.parent?.type === 'variable_declaration'))
    ) {
      // Notebook-level annotations and bare var declarations do not replace an existing value.
      // Local declarations can shadow an outer binding; leave their conservative handling intact.
      if (isNotebookScope(node)) return
    }
    // Unknown values are ordinary data until called. Preserve uncertainty across aliases so
    // assigning a computed callable cannot silently discharge its per-execution review.
    if (
      language === 'repl' &&
      assigned.left &&
      ['member_expression', 'subscript_expression'].includes(assigned.left.type)
    ) {
      const object = identity(fieldChild(assigned.left, 'object'), bindings)
      const property =
        assigned.left.type === 'member_expression'
          ? literal(fieldChild(assigned.left, 'property'))
          : processString(fieldChild(assigned.left, 'index'))
      if (object && property)
        for (const target of possibleTargets(object))
          if (target?.startsWith('@object:'))
            bindings.set(`${target}.${property}`, identity(assigned.right, bindings) ?? '<dynamic>')
    }
    const updates = bindingUpdates(assigned.left, assigned.right, bindings, language)
    // All RHS identities use the old bindings: swaps must not observe half-written targets.
    for (const [name, value] of updates) bindings.set(name, value)
    return updates
  }
  return undefined
}

// Concatenating syntactic sequences preserves their visible slots. Unknown operands may
// dispatch custom operators, so do not infer their type from aliases or execute expressions.
const pythonSequence = (
  node: Node | null | undefined,
  depth = 0
): { type: string; values: Node[] } | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  if (['list', 'tuple'].includes(node.type)) return { type: node.type, values: node.namedChildren }
  if (node.type !== 'binary_operator' || fieldChild(node, 'operator')?.text !== '+')
    return undefined
  const left = pythonSequence(fieldChild(node, 'left'), depth + 1)
  const right = pythonSequence(fieldChild(node, 'right'), depth + 1)
  if (!left || !right || left.type !== right.type) return undefined
  const values = pythonPositional([...left.values, ...right.values], depth + 1)
  // An unknown iterable can move slots or run hooks while constructing the sequence.
  return values.some((value) => value.type === 'list_splat')
    ? undefined
    : { type: left.type, values }
}

// Expand visible tuple/list stars without evaluating iterables. Keep unknown stars in place
// so callback offsets and process arguments cannot appear more certain than the source.
const pythonPositional = (args: Node[], depth = 0): Node[] =>
  args
    .filter((arg) => !['comment', 'keyword_argument', 'dictionary_splat'].includes(arg.type))
    .flatMap((arg) => {
      if (arg.type !== 'list_splat' || depth >= 64) return [arg]
      const value = pythonSequence(arg.namedChild(0), depth)
      return value ? pythonPositional(value.values, depth + 1) : [arg]
    })

// operator.call forwards to its first positional callable, including nested forwarding.
// Retain AST arguments for process/callback checks and the normal eager source traversal.
const pythonInvocation = (
  args: Node[],
  bindings: Bindings,
  callee: string | undefined,
  values?: ReadonlyMap<number, string | undefined>,
  functionNode?: Node | null
): { callee: string | undefined; args: Node[]; partial: boolean; functionNode?: Node | null } => {
  let depth = 0
  let partial = false
  while (pythonPartialTarget(callee ?? '') || /^operator\.(?:call|__call__)$/.test(callee ?? '')) {
    // ponytail: bounded explicit forwarding, no arbitrary callable/iterable evaluation.
    if (++depth > 64) return { callee: '<dynamic>', args, partial }
    const target = pythonPartialTarget(callee ?? '')
    if (target) {
      partial = true
      callee = pythonPartialSensitive(target) ? '<dynamic>' : target
      continue
    }
    const positional = pythonPositional(args)
    const forwarded = positional[0]
    functionNode = forwarded
    callee =
      forwarded && values?.has(forwarded.id)
        ? values.get(forwarded.id)
        : identity(forwarded ?? null, bindings)
    args = [
      ...positional.slice(1),
      ...args.filter((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type))
    ]
  }
  functionNode = unparenthesized(functionNode)
  // A closed inline construction owns a fresh builtin dictionary. Normalize its lookup to the
  // same signature as dict.get/pop/setdefault; named/mutable receivers stay unresolved.
  while (
    functionNode?.type === 'attribute' &&
    fieldChild(functionNode, 'attribute')?.text === '__call__'
  ) {
    if (++depth > 64) return { callee: '<dynamic>', args, partial }
    functionNode = unparenthesized(fieldChild(functionNode, 'object'))
  }
  if (functionNode?.type === 'attribute') {
    const method = fieldChild(functionNode, 'attribute')?.text
    const receiver = fieldChild(functionNode, 'object')
    if (
      /^(?:get|pop|setdefault)$/.test(method ?? '') &&
      (pythonDictionaryEntries(receiver) || pythonClosedKeywords(receiver, bindings, 0, true))
    )
      return { callee: `dict.${method}`, args: [receiver!, ...args], partial }
  }
  return { callee, args, partial, functionNode }
}

// Builtin dictionary unions preserve entry order and right-hand replacement. Only fixed
// dictionary operands qualify; unknown keys/spreads can execute hashing or mapping hooks.
const pythonDictionaryEntries = (
  node: Node | null | undefined,
  depth = 0,
  fixed = false
): Node[] | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64 || node.tree.rootNode.type !== 'module') return undefined
  if (node.type === 'dictionary') {
    const entries = node.namedChildren.filter((entry) => entry.type !== 'comment')
    return !fixed ||
      entries.every((entry) =>
        entry.type === 'dictionary_splat'
          ? pythonDictionaryEntries(entry.namedChild(0), depth + 1, true) !== undefined
          : entry.type === 'pair' && processString(fieldChild(entry, 'key')) !== undefined
      )
      ? entries
      : undefined
  }
  if (node.type !== 'binary_operator' || fieldChild(node, 'operator')?.text !== '|')
    return undefined
  const left = pythonDictionaryEntries(fieldChild(node, 'left'), depth + 1, true)
  const right = pythonDictionaryEntries(fieldChild(node, 'right'), depth + 1, true)
  return left && right ? [...left, ...right] : undefined
}

// Native copies preserve visible members without invoking them. Unknown iterables and named
// mutable containers cannot supply this evidence; inspect raw construction separately.
const pythonNativeSequence = (
  node: Node | null | undefined,
  bindings: Bindings,
  depth = 0
): { type: string; values: Node[] } | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  const literal = pythonSequence(node, depth)
  if (literal) return literal
  if (node.type !== 'call') return undefined
  const functionNode = fieldChild(node, 'function')
  const invocation = pythonInvocation(
    fieldChild(node, 'arguments')?.namedChildren ?? [],
    bindings,
    identity(functionNode, bindings),
    undefined,
    functionNode
  )
  if (
    invocation.partial ||
    !/^(?:builtins\.)?(?:list|tuple)$/.test(invocation.callee ?? '') ||
    invocation.args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type))
  )
    return undefined
  const args = pythonPositional(invocation.args, depth)
  if (args.length > 1 || args.some(pythonSequenceSpread)) return undefined
  const source = args.length ? pythonNativeSequence(args[0], bindings, depth + 1) : undefined
  if (args.length && !source) return undefined
  const values = source ? pythonPositional(source.values, depth) : []
  return values.length <= 128 && !values.some(pythonSequenceSpread)
    ? { type: invocation.callee!.endsWith('tuple') ? 'tuple' : 'list', values }
    : undefined
}

const pythonItemKey = (node: Node | null | undefined, depth = 0): string | number | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  const text = fixedText(node)
  if (text !== undefined) return text
  if (node.type === 'true' || node.type === 'false') return node.type === 'true' ? 1 : 0
  if (node.type === 'integer') {
    const value = Number(node.text.replaceAll('_', ''))
    return Number.isSafeInteger(value) ? value : undefined
  }
  if (node.type === 'unary_operator') {
    const operand = pythonItemKey(
      node.namedChildren.find((child) => child.type !== 'comment'),
      depth + 1
    )
    const operator = fieldChild(node, 'operator')?.text
    return typeof operand === 'number' && /^[+-]$/.test(operator ?? '')
      ? operator === '-'
        ? -operand
        : operand
      : undefined
  }
  return undefined
}

const pythonStableLiteralConstruction = (value: Node, bindings: Bindings, level = 0): boolean => {
  if (level >= 64 || assignment(value)) return false
  if (value.type === 'lambda') {
    const body = fieldChild(value, 'body')
    // Creating a lambda evaluates defaults, not its deferred body.
    return value.namedChildren
      .filter((child) => child.id !== body?.id)
      .every((child) => pythonStableLiteralConstruction(child, bindings, level + 1))
  }
  if (value.type === 'list_splat' && !pythonEmbeddedSequenceSpread(value)) {
    const spread = pythonSequence(value.namedChild(0), level)
    if (
      !spread ||
      pythonPositional(spread.values, level).some((item) => item.type === 'list_splat')
    )
      return false
  }
  if (
    value.type === 'dictionary_splat' &&
    !pythonDictionaryEntries(value.namedChild(0), level, true) &&
    !pythonClosedKeywords(value.namedChild(0), bindings, level, true)
  )
    return false
  // Unknown hashable objects may run __hash__/__eq__ even in a non-selected entry.
  if (value.type === 'pair' && pythonItemKey(fieldChild(value, 'key')) === undefined) return false
  if (
    value.type === 'set' &&
    value.namedChildren.some((item) => item.type !== 'comment' && pythonItemKey(item) === undefined)
  )
    return false
  if (
    [
      'string',
      'concatenated_string',
      'unary_operator',
      'not_operator',
      'comparison_operator'
    ].includes(value.type) &&
    !pythonNonCallableData(value)
  )
    return false
  if (
    value.type === 'binary_operator' &&
    !pythonNonCallableData(value) &&
    !pythonSequence(value) &&
    !pythonDictionaryEntries(value, 0, true) &&
    !pythonClosedKeywords(value, bindings, level, true)
  )
    return false
  const selection = pythonSelection(value)
  if (selection && identity(selection[0], bindings) !== '@noncallable') return false
  if (value.type === 'attribute') {
    const object = fieldChild(value, 'object')
    const target = identity(object, bindings)
    const openResult =
      object?.type === 'call' &&
      /^(?:(?:builtins\.|io\.)?open)$/.test(
        identity(fieldChild(object, 'function'), bindings) ?? ''
      )
    if (
      !openResult &&
      !pythonNonCallableData(object) &&
      !pythonClosedKeywords(object, bindings, level + 1, true) &&
      !pythonPartialTarget(target ?? '') &&
      !/^(?:builtins|(?:builtins\.)?(?:str|bytes|int|float|bool|tuple|list|dict|set|frozenset)|io|os|operator|functools|subprocess|shutil|pathlib(?:\.(?:Path|PosixPath|WindowsPath))?)$/.test(
        target ?? ''
      )
    )
      return false
  }
  if (value.type === 'call') {
    const args = fieldChild(value, 'arguments')?.namedChildren ?? []
    const callee = identity(fieldChild(value, 'function'), bindings)
    const opener = pythonKeyword(args, 'opener', bindings, true)
    const processValue = pythonProcessValue(value, bindings)
    const closedProcessValue =
      processValue !== undefined &&
      (typeof processValue === 'string' || pythonPathIntact(processValue, bindings))
    const closedProcessVector =
      bindings.get(`@argv:${value.id}`)?.startsWith('[') &&
      pythonArgumentVectors(value, bindings)?.every((vector) =>
        vector.values.every(
          (value) =>
            value !== undefined && (typeof value === 'string' || pythonPathIntact(value, bindings))
        )
      )
    if (
      /^(?:(?:builtins\.|io\.)?open|pathlib\.(?:Path|PosixPath|WindowsPath))$/.test(callee ?? '')
    ) {
      // Inspect effective keyword inputs; the recursive walk below still checks overwritten
      // expressions and assignments in the original construction.
      const inputs = [
        ...pythonPositional(args),
        ...args.flatMap((arg) =>
          arg.type === 'keyword_argument'
            ? [fieldChild(arg, 'value')]
            : arg.type === 'dictionary_splat'
              ? [
                  ...new Map(
                    (pythonClosedKeywords(arg.namedChild(0), bindings, level, true) ?? []).map(
                      ({ name, value }) => [name, value]
                    )
                  ).values()
                ]
              : []
        )
      ]
      if (
        args.some(
          (arg) =>
            arg.type === 'dictionary_splat' &&
            !pythonClosedKeywords(arg.namedChild(0), bindings, level, true)
        ) ||
        inputs.some((input) => {
          const target = identity(input ?? null, bindings)
          return (
            target !== '@noncallable' &&
            !/^pathlib\.(?:Path|PosixPath|WindowsPath)$/.test(target ?? '')
          )
        })
      )
        return false
    }
    if (
      (!/^(?:(?:builtins\.|io\.)?open|pathlib\.(?:Path|PosixPath|WindowsPath)|functools\.partial|operator\.(?:attrgetter|itemgetter))$/.test(
        callee ?? ''
      ) &&
        !pythonClosedKeywords(value, bindings, level, true) &&
        !pythonNativeSequence(value, bindings, level) &&
        !closedProcessValue &&
        !closedProcessVector) ||
      (/^(?:(?:builtins\.|io\.)?open)$/.test(callee ?? '') &&
        opener !== undefined &&
        opener?.type !== 'none')
    )
      return false
  }
  return value.namedChildren.every((child) =>
    pythonStableLiteralConstruction(child, bindings, level + 1)
  )
}

// Only closed inline builtin containers qualify. Named containers may be mutated through aliases;
// user calls or assignments during construction can also replace an earlier member's source.
const pythonLiteralItemNode = (
  node: Node | null | undefined,
  key: string | number,
  bindings: Bindings,
  depth = 0
): Node | null | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  if (!pythonStableLiteralConstruction(node, bindings)) return undefined
  const sequence = pythonNativeSequence(node, bindings, depth)
  if (sequence && typeof key === 'number') {
    const entries = pythonPositional(sequence.values, depth)
    if (entries.some(pythonSequenceSpread)) return undefined
    return entries[key < 0 ? entries.length + key : key] ?? null
  }
  const mapping = pythonClosedKeywords(node, bindings, depth, true)
  if (mapping && typeof key === 'string')
    return new Map(mapping.map((entry) => [entry.name, entry.value])).get(key) ?? null
  const entries = pythonDictionaryEntries(node, depth)
  if (!entries) return undefined
  let selected: Node | null = null
  for (const entry of entries) {
    if (entry.type === 'dictionary_splat') {
      const nested = pythonLiteralItemNode(entry.namedChild(0), key, bindings, depth + 1)
      // A missing key in a closed spread leaves the earlier value intact.
      if (nested === undefined) return undefined
      if (nested) selected = nested
    } else {
      const entryKey = pythonItemKey(fieldChild(entry, 'key'))
      if (entryKey === undefined) return undefined
      if (entryKey === key) selected = fieldChild(entry, 'value')
    }
  }
  return selected
}

type PythonKeywordEntry = { name: string; value: Node }

// Inline native mapping evidence keeps source locations, never live parser nodes or grants.
const pythonClosedKeywords = (
  node: Node | null | undefined,
  bindings: Bindings,
  depth = 0,
  preview = false
): PythonKeywordEntry[] | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  if (node.type === 'call') {
    if (preview) {
      // Lookahead uses current source provenance, never a previous loop's cached call.
      const functionNode = fieldChild(node, 'function')
      const invocation = pythonInvocation(
        fieldChild(node, 'arguments')?.namedChildren ?? [],
        bindings,
        identity(functionNode, bindings),
        undefined,
        functionNode
      )
      return invocation.partial
        ? undefined
        : pythonConstructedKeywords(invocation.callee, invocation.args, bindings, depth + 1, true)
    }
    const cached = bindings.get(`@kwargs:${node.id}`)
    if (!cached?.startsWith('[')) return undefined
    const entries: PythonKeywordEntry[] = []
    for (const [name, start, end, id] of JSON.parse(cached) as [string, number, number, number][]) {
      const value = node.namedDescendantForIndex(start, end)
      if (!value || value.id !== id) return undefined
      entries.push({ name, value })
    }
    return entries
  }
  if (node.type === 'binary_operator' && fieldChild(node, 'operator')?.text === '|') {
    const left = pythonClosedKeywords(fieldChild(node, 'left'), bindings, depth + 1, preview)
    const right = pythonClosedKeywords(fieldChild(node, 'right'), bindings, depth + 1, preview)
    return left && right && left.length + right.length <= 128 ? [...left, ...right] : undefined
  }
  const source = pythonDictionaryEntries(node)
  if (!source) return undefined
  const entries: PythonKeywordEntry[] = []
  for (const entry of source) {
    if (entry.type === 'dictionary_splat') {
      const nested = pythonClosedKeywords(entry.namedChild(0), bindings, depth + 1, preview)
      if (!nested) return undefined
      entries.push(...nested)
    } else {
      const name = fixedText(fieldChild(entry, 'key'))
      const value = fieldChild(entry, 'value')
      if (name === undefined || !value) return undefined
      entries.push({ name, value })
    }
    if (entries.length > 128) return undefined
  }
  return entries
}

const pythonConstructedKeywords = (
  callee: string | undefined,
  args: Node[],
  bindings: Bindings,
  depth = 0,
  preview = false
): PythonKeywordEntry[] | undefined => {
  if (depth >= 64 || !/^(?:builtins\.)?dict$/.test(callee ?? '')) return undefined
  const positional = pythonPositional(args)
  if (positional.length > 1 || positional.some((arg) => arg.type === 'list_splat')) return undefined
  let entries: PythonKeywordEntry[] = []
  if (positional.length) {
    const source = positional[0]
    const mapping = pythonClosedKeywords(source, bindings, depth + 1, preview)
    if (mapping) entries = mapping
    else {
      const sequence = pythonSequence(source)
      if (!sequence) return undefined
      for (const item of pythonPositional(sequence.values)) {
        const pair = pythonSequence(item)
        if (!pair) return undefined
        const values = pythonPositional(pair.values)
        if (values.length !== 2) return undefined
        const name = fixedText(values[0])
        if (name === undefined) return undefined
        entries.push({ name, value: values[1] })
        if (entries.length > 128) return undefined
      }
    }
  }
  // dict's keyword inputs replace keys from its positional mapping. Duplicate call kwargs
  // still raise before dict runs; do not reuse dictionary last-write rules to invent a call.
  const names = new Set<string>()
  for (const arg of args) {
    let supplied: PythonKeywordEntry[] | undefined
    if (arg.type === 'keyword_argument') {
      const value = fieldChild(arg, 'value')
      const name = fieldChild(arg, 'name')?.text
      if (name === undefined || !value) return undefined
      supplied = [{ name, value }]
    } else if (arg.type === 'dictionary_splat')
      supplied = pythonClosedKeywords(arg.namedChild(0), bindings, depth + 1, preview)
    else continue
    if (!supplied) return undefined
    // A closed dictionary's duplicate keys have already been replaced before ** expansion.
    const unique = new Map(supplied.map((entry) => [entry.name, entry]))
    for (const entry of unique.values()) {
      if (names.has(entry.name)) return undefined
      names.add(entry.name)
    }
    entries.push(...supplied)
    if (entries.length > 128) return undefined
  }
  return entries.every(({ value }) => {
    const target = identity(value, bindings)
    const processValue = pythonProcessValue(value, bindings)
    if (
      pythonLiteralTruth(value, 0, bindings) !== undefined ||
      (processValue !== undefined &&
        (typeof processValue === 'string' || pythonPathIntact(processValue, bindings))) ||
      /^subprocess\.(?:PIPE|DEVNULL|STDOUT)$/.test(target ?? '')
    )
      return true
    const vectors = pythonArgumentVectors(value, bindings)
    if (
      vectors?.every((vector) => vector.values.every((value) => value !== undefined)) &&
      pythonStableLiteralConstruction(value, bindings, depth + 1)
    )
      return true
    // Function values carry source evidence; an unresolved named callback keeps the mapping
    // opaque rather than silently discharging its consumer's existing review.
    return (
      pythonStableLiteralConstruction(value, bindings, depth + 1) &&
      (['lambda', 'attribute'].includes(value.type) ||
        target?.startsWith('@function:') ||
        pythonPartialTarget(target ?? '') !== undefined ||
        pythonAttrgetterNames(target ?? '') !== undefined ||
        pythonItemgetterKeys(target ?? '') !== undefined ||
        /^(?:(?:builtins\.)?(?:str|bytes|int|float|bool|tuple|list|dict|set|frozenset|len|abs|open)|os\.(?:remove|unlink|rmdir|removedirs))$/.test(
          target ?? ''
        ))
    )
  })
    ? entries
    : undefined
}

// Empty native inputs cannot invoke collection callbacks. Require the original
// construction too: another iterable, default or alias write can still have effects.
const pythonSequenceSpread = (value: Node): boolean => {
  let reference: Node | null | undefined = value
  for (let depth = 0; reference && depth < 64; depth++) {
    if (reference.type === 'list_splat') return true
    // The grammar attaches *factory() and *object.member to their reference,
    // unlike the parenthesized *(factory()) spread form.
    reference = unparenthesized(
      reference.type === 'call'
        ? fieldChild(reference, 'function')
        : reference.type === 'attribute'
          ? fieldChild(reference, 'object')
          : reference.type === 'subscript'
            ? fieldChild(reference, 'value')
            : null
    )
  }
  return !!reference
}

// In [*module.factory()[key]], the grammar puts * on the module/reference. It does not
// unpack that reference before calling it. Only this spine inside a literal container qualifies.
const pythonEmbeddedSequenceSpread = (node: Node): boolean => {
  let reference = node
  for (let depth = 0; depth < 64; depth++) {
    const parent = reference.parent
    if (!parent) return false
    if (['list', 'tuple'].includes(parent.type)) return depth > 0
    const owner =
      parent.type === 'call'
        ? fieldChild(parent, 'function')
        : parent.type === 'attribute'
          ? fieldChild(parent, 'object')
          : parent.type === 'subscript'
            ? fieldChild(parent, 'value')
            : undefined
    if (owner?.id !== reference.id) return false
    reference = parent
  }
  return false
}

const pythonUnusedCallback = (
  callee: string,
  args: Node[],
  bindings: Bindings,
  functionNode?: Node | null
): boolean => {
  const positional = pythonPositional(args)
  if (/^(?:(?:builtins\.)?open|io\.open)$/.test(callee)) {
    const file = unparenthesized(pythonKeyword(args, 'file', bindings, true) ?? positional[0])
    // Native open ignores an opener when given an existing descriptor.
    return !!file && ['integer', 'true', 'false', 'none'].includes(file.type)
  }
  if (positional.length > 128) return false
  const sequence = (value: Node | undefined): Node[] | undefined => {
    const source = pythonSequence(value)
    if (!source || source.values.length > 128) return undefined
    const entries = pythonPositional(source.values)
    return entries.length <= 128 && !entries.some(pythonSequenceSpread) ? entries : undefined
  }
  const empty = (value: Node | undefined): boolean => sequence(value)?.length === 0
  let unused = false
  if (/^(?:builtins\.)?map$/.test(callee))
    unused =
      positional.length >= 2 &&
      positional.slice(1).every((value) => sequence(value) !== undefined) &&
      positional.slice(1).some(empty)
  else if (
    /^(?:(?:builtins\.)?filter|itertools\.(?:starmap|dropwhile|takewhile|filterfalse)|functools\.reduce)$/.test(
      callee
    )
  )
    unused =
      positional.length >= 2 &&
      positional.length <= (callee === 'functools.reduce' ? 3 : 2) &&
      empty(positional[1])
  else if (/^itertools\.(?:accumulate|groupby)$/.test(callee))
    unused = positional.length >= 1 && positional.length <= 2 && empty(positional[0])
  else if (/^(?:(?:builtins\.)?(?:sorted|min|max)|(?:builtins\.)?list\.sort)$/.test(callee))
    unused = positional.length === 1 && empty(positional[0])
  else if (/^heapq\.(?:nlargest|nsmallest)$/.test(callee)) {
    const count = pythonItemKey(positional[0])
    unused =
      positional.length === 2 &&
      typeof count === 'number' &&
      count >= 0 &&
      (empty(positional[1]) || (count === 0 && sequence(positional[1]) !== undefined))
  } else if (/^bisect\.bisect(?:_left|_right)?$/.test(callee))
    unused = positional.length === 2 && empty(positional[0])
  else if (
    functionNode?.type === 'attribute' &&
    fieldChild(functionNode, 'attribute')?.text === 'sort'
  ) {
    const receiver = unparenthesized(fieldChild(functionNode, 'object'))
    unused =
      positional.length === 0 &&
      pythonSequence(receiver)?.type === 'list' &&
      empty(receiver ?? undefined) &&
      pythonStableLiteralConstruction(receiver!, bindings)
  }
  return unused && args.every((arg) => pythonStableLiteralConstruction(arg, bindings))
}

// A fresh native container can discard a function value without invoking its body.
// Keep ordinary escaping lambdas conservative; only prove unreachable literal members.
const pythonDiscardedLambda = (value: Node, bindings: Bindings): boolean => {
  const contains = (node: Node): boolean =>
    node.startIndex <= value.startIndex && node.endIndex >= value.endIndex
  const overwritten = (entries: PythonKeywordEntry[] | undefined): boolean => {
    if (!entries) return false
    const final = new Map(entries.map((entry) => [entry.name, entry.value]))
    return entries.some((entry) => contains(entry.value) && !contains(final.get(entry.name)!))
  }
  const boundedContainer = (node: Node | undefined): boolean => {
    const entries =
      pythonNativeSequence(node, bindings)?.values ??
      pythonClosedKeywords(node, bindings, 0, true) ??
      pythonDictionaryEntries(node)
    return entries !== undefined && entries.length <= 128
  }
  let parent = value.parent
  for (let depth = 0; parent && depth < 64; depth++, parent = parent.parent) {
    if (
      assignment(parent) ||
      ['lambda', 'function_definition', 'class_definition'].includes(parent.type)
    )
      return false
    if (
      overwritten(pythonClosedKeywords(parent, bindings, 0, true)) &&
      pythonStableLiteralConstruction(parent, bindings)
    )
      return true
    if (parent.type === 'subscript') {
      const indices = fieldChildren(parent, 'subscript')
      const key = indices.length === 1 ? pythonItemKey(indices[0]) : undefined
      const container = fieldChild(parent, 'value') ?? undefined
      const selected =
        key === undefined || !boundedContainer(container)
          ? undefined
          : pythonLiteralItemNode(container, key, bindings)
      return !!selected && !contains(selected) && pythonStableLiteralConstruction(parent, bindings)
    }
    if (parent.type !== 'call') continue
    const functionNode = fieldChild(parent, 'function')
    const args = fieldChild(parent, 'arguments')?.namedChildren ?? []
    const invocation = pythonInvocation(
      args,
      bindings,
      identity(functionNode, bindings),
      undefined,
      functionNode
    )
    if (invocation.partial) return false
    const callee = invocation.callee ?? ''
    if (
      /^(?:builtins\.)?(?:list|tuple)$/.test(callee) &&
      pythonNativeSequence(parent, bindings) &&
      args.every((arg) => pythonStableLiteralConstruction(arg, bindings))
    )
      continue
    if (pythonUnusedCallback(callee, invocation.args, bindings, invocation.functionNode)) {
      const keyword = pythonCallbackKeyword(callee)
      const supplied = keyword ? pythonKeyword(invocation.args, keyword, bindings, true) : undefined
      const slot = pythonCallbackIndex(callee)
      const callback =
        supplied === undefined && slot !== undefined
          ? pythonPositional(invocation.args)[slot]
          : supplied
      if (
        callback &&
        contains(callback) &&
        invocation.args.every((arg) => pythonStableLiteralConstruction(arg, bindings))
      )
        return true
    }
    if (/^(?:builtins\.)?dict$/.test(callee)) {
      const entries = pythonConstructedKeywords(callee, invocation.args, bindings, 0, true)
      if (!entries || !args.every((arg) => pythonStableLiteralConstruction(arg, bindings)))
        return false
      if (overwritten(entries)) return true
      // Native dict preserves a value; an enclosing native consumer may discard it later.
      continue
    }
    const positional = pythonPositional(invocation.args)
    if (
      invocation.args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)) ||
      positional.some((arg) => arg.type === 'list_splat') ||
      !boundedContainer(positional[0])
    )
      return false
    let selected: (Node | null | undefined)[]
    const items = pythonItemgetterKeys(callee)
    if (items || /^operator\.(?:getitem|__getitem__)$/.test(callee)) {
      if (positional.length !== (items ? 1 : 2)) return false
      selected = (items ?? [pythonItemKey(positional[1])]).map((key) =>
        key === undefined ? undefined : pythonLiteralItemNode(positional[0], key, bindings)
      )
    } else if (/^(?:builtins\.)?dict\.(?:get|pop|setdefault)$/.test(callee)) {
      const key = pythonItemKey(positional[1])
      if (positional.length < 2 || positional.length > 3 || key === undefined) return false
      const item = pythonLiteralItemNode(positional[0], key, bindings)
      selected = [item === null ? positional[2] : item]
    } else return false
    return (
      selected.every((item) => !!item && !contains(item)) &&
      invocation.args.every((arg) => pythonStableLiteralConstruction(arg, bindings))
    )
  }
  return false
}

// undefined means absent, null means a packed mapping may supply the keyword.
// Literal dictionaries retain Python's last-write semantics; separate ** arguments cannot
// override an explicit keyword (duplicates raise before the callee runs).
const pythonKeyword = (
  args: Node[],
  name: string,
  bindings?: Bindings,
  preview = false
): Node | null | undefined => {
  const explicit = args.find(
    (arg) => arg.type === 'keyword_argument' && fieldChild(arg, 'name')?.text === name
  )
  if (explicit) return fieldChild(explicit, 'value')
  const fromDictionary = (node: Node | null, depth = 0): Node | null | undefined => {
    node = unparenthesized(node) ?? null
    if (
      bindings &&
      (node?.type === 'call' ||
        (node?.type === 'binary_operator' && fieldChild(node, 'operator')?.text === '|'))
    ) {
      const closed = pythonClosedKeywords(node, bindings, depth, preview)
      return closed ? closed.findLast((entry) => entry.name === name)?.value : null
    }
    const entries = pythonDictionaryEntries(node, depth)
    if (!entries) return null
    let result: Node | null | undefined
    for (const entry of entries) {
      if (entry.type === 'comment') continue
      if (entry.type === 'dictionary_splat') {
        const nested = fromDictionary(entry.namedChild(0), depth + 1)
        if (nested !== undefined) result = nested
      } else {
        const key = fieldChild(entry, 'key')
        const text = processString(key)
        if (text === name) result = fieldChild(entry, 'value')
        else if (text === undefined) result = null
      }
    }
    return result
  }
  let result: Node | null | undefined
  for (const arg of args) {
    if (arg.type !== 'dictionary_splat') continue
    const candidate = fromDictionary(arg.namedChild(0))
    if (candidate) return candidate
    if (candidate === null) result = null
  }
  return result
}

// Process flags use Python truth testing. Only closed native values and captured builtin
// results qualify; unknown construction/truth hooks can run even when the result is false.
const pythonLiteralTruth = (
  node: Node | null | undefined,
  depth = 0,
  bindings?: Bindings
): boolean | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  if (['call', 'subscript'].includes(node.type) && bindings) {
    const mapping = node.type === 'call' ? pythonClosedKeywords(node, bindings) : undefined
    if (mapping) return mapping.length > 0
    const cached = bindings.get(`@truth:${node.id}`)
    if (cached?.startsWith('{')) {
      const { eligible, truth } = JSON.parse(cached) as { eligible: boolean; truth?: boolean }
      if (eligible && truth !== undefined) return truth
    }
    return undefined
  }
  if (node.type === 'none' || node.type === 'false') return false
  if (node.type === 'true') return true
  if (['string', 'concatenated_string', 'binary_operator'].includes(node.type)) {
    const text = literal(node)
    if (text !== undefined) return text.length > 0
  }
  const sequence = pythonSequence(node, depth)
  if (sequence) {
    const values = pythonPositional(sequence.values, depth)
    if (
      !values.every(
        (value) =>
          pythonLiteralTruth(
            value.type === 'list_splat' ? value.namedChild(0) : value,
            depth + 1,
            bindings
          ) !== undefined
      )
    )
      return undefined
    // A native constructor inside * may contribute zero elements, not one call node.
    const vectors = bindings ? pythonArgumentVectors(node, bindings) : undefined
    const truths = vectors?.map((vector) => vector.values.length > 0)
    return truths
      ? truths.every((truth) => truth === truths[0])
        ? truths[0]
        : undefined
      : values.length > 0
  }
  if (node.type === 'set') {
    const values = pythonPositional(node.namedChildren, depth)
    return values.every((value) => pythonLiteralTruth(value, depth + 1, bindings) !== undefined)
      ? values.length > 0
      : undefined
  }
  const entries = pythonDictionaryEntries(node, depth)
  if (entries) {
    let nonempty = false
    for (const entry of entries) {
      if (entry.type === 'dictionary_splat') {
        const truth = pythonLiteralTruth(entry.namedChild(0), depth + 1, bindings)
        if (truth === undefined) return undefined
        nonempty ||= truth
      } else if (entry.type !== 'comment') {
        if (
          entry.type !== 'pair' ||
          pythonLiteralTruth(fieldChild(entry, 'key'), depth + 1, bindings) === undefined ||
          pythonLiteralTruth(fieldChild(entry, 'value'), depth + 1, bindings) === undefined
        )
          return undefined
        nonempty = true
      }
    }
    return nonempty
  }
  const selection = pythonSelection(node)
  if (selection) {
    const [condition, consequence, alternative] = selection
    const truth = pythonLiteralTruth(condition, depth + 1, bindings)
    if (truth !== undefined)
      return pythonLiteralTruth(truth ? consequence : alternative, depth + 1, bindings)
    const cached = bindings?.get(`@truth:${node.id}`)
    if (cached?.startsWith('{')) {
      const { eligible, result } = JSON.parse(cached) as { eligible: boolean; result?: boolean }
      if (eligible) return result
    }
    return undefined
  }
  if (['integer', 'float'].includes(node.type)) {
    const text = node.text.replaceAll('_', '')
    // Integers are arbitrary precision; do not round them through a floating point parser.
    if (node.type === 'integer' && !/j$/i.test(text)) return !/^(?:0[xob])?0+$/i.test(text)
    const value = Number(text.replace(/j$/i, ''))
    return Number.isNaN(value) ? undefined : value !== 0
  }
  if (
    node.type === 'not_operator' ||
    (node.type === 'unary_operator' && /^[+-]$/.test(fieldChild(node, 'operator')?.text ?? ''))
  ) {
    const operand = node.namedChildren.find((child) => child.type !== 'comment')
    const truth = pythonLiteralTruth(operand, depth + 1, bindings)
    return truth === undefined ? undefined : node.type === 'not_operator' ? !truth : truth
  }
  return undefined
}

// Keep raw Path protocols and bytes distinct from already converted native strings.
type PythonProcessPath = { text: string; windows: boolean; classes?: string[]; bytes?: true }
type PythonProcessValue = string | PythonProcessPath | undefined
type PythonArgumentVector = { tuple: boolean; values: PythonProcessValue[] }

const pythonPathClasses = (callee: string | undefined): string[] | undefined => {
  const kind = callee?.match(/^pathlib\.((?:Pure)?(?:Posix|Windows)?Path)$/)?.[1]
  if (!kind) return undefined
  const windows =
    kind.includes('Windows') || (!kind.includes('Posix') && process.platform === 'win32')
  const classes = ['pathlib.PurePath', `pathlib.Pure${windows ? 'Windows' : 'Posix'}Path`]
  if (!kind.startsWith('Pure'))
    classes.push('pathlib.Path', `pathlib.${windows ? 'Windows' : 'Posix'}Path`)
  return classes
}

const pythonPathIntact = (path: PythonProcessPath, bindings: Bindings): boolean =>
  !path.classes?.some((kind) => bindings.has(`@path-class:${kind}`))

const pythonProcessValue = (
  node: Node | null | undefined,
  bindings: Bindings
): PythonProcessValue => {
  const text = processString(node)
  if (text !== undefined)
    return fixedText(node) !== undefined ? text : { text, windows: false, bytes: true }
  node = unparenthesized(node)
  const cached = node && bindings.get(`@path:${node.id}`)
  return cached?.startsWith('{') || cached?.startsWith('"')
    ? (JSON.parse(cached) as PythonProcessValue)
    : undefined
}

const pythonProcessText = (value: PythonProcessValue, bindings: Bindings): string | undefined =>
  typeof value === 'string' || value === undefined
    ? value
    : pythonPathIntact(value, bindings)
      ? value.windows && process.platform === 'win32'
        ? value.text.replaceAll('\\', '/')
        : value.text
      : undefined

const pythonNativeText = (
  node: Node | null | undefined,
  bindings: Bindings
): string | undefined => {
  const text = fixedText(node)
  if (text !== undefined) return text
  // A completed native conversion is a string; an intact Path object still is not one.
  if (!['call', 'subscript'].includes(unparenthesized(node)?.type ?? '')) return undefined
  const value = pythonProcessValue(node, bindings)
  return typeof value === 'string'
    ? value
    : value && !value.bytes && !value.classes?.length
      ? value.text
      : undefined
}

const pythonConstructedText = (
  callee: string | undefined,
  args: Node[],
  functionNode: Node | null | undefined,
  bindings: Bindings
): string | undefined => {
  const method = callee?.match(
    /^(?:(?:builtins\.)?str|@noncallable)\.(strip|lstrip|rstrip|lower|upper|casefold|removeprefix|removesuffix|replace|join)$/
  )?.[1]
  if (!method || args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)))
    return undefined
  let positional = pythonPositional(args)
  if (positional.some((arg) => arg.type === 'list_splat')) return undefined
  const receiver =
    functionNode?.type === 'attribute' ? fieldChild(functionNode, 'object') : undefined
  let text = pythonNativeText(receiver, bindings)
  if (text === undefined && /^(?:builtins\.)?str\./.test(callee ?? '')) {
    text = pythonNativeText(positional[0], bindings)
    positional = positional.slice(1)
  }
  const ascii = (value: string | undefined): value is string =>
    // ponytail: bounded ASCII semantics, not a second Unicode/string-protocol interpreter.
    // eslint-disable-next-line no-control-regex -- Python and JavaScript Unicode rules differ.
    value !== undefined && value.length <= 4096 && !/[^\x00-\x7f]/.test(value)
  if (!ascii(text)) return undefined
  if (['lower', 'upper', 'casefold'].includes(method))
    return positional.length
      ? undefined
      : method === 'upper'
        ? text.toUpperCase()
        : text.toLowerCase()
  if (['strip', 'lstrip', 'rstrip'].includes(method)) {
    if (positional.length > 1) return undefined
    const chars =
      !positional.length || positional[0].type === 'none'
        ? ' \t\r\n\v\f\x1c\x1d\x1e\x1f'
        : pythonNativeText(positional[0], bindings)
    if (!ascii(chars)) return undefined
    const removed = new Set(chars)
    let start = 0
    let end = text.length
    if (method !== 'rstrip') while (start < end && removed.has(text[start])) start++
    if (method !== 'lstrip') while (end > start && removed.has(text[end - 1])) end--
    return text.slice(start, end)
  }
  if (['removeprefix', 'removesuffix'].includes(method)) {
    if (positional.length !== 1) return undefined
    const part = pythonNativeText(positional[0], bindings)
    if (!ascii(part)) return undefined
    return method === 'removeprefix'
      ? text.startsWith(part)
        ? text.slice(part.length)
        : text
      : part && text.endsWith(part)
        ? text.slice(0, -part.length)
        : text
  }
  if (method === 'join') {
    if (positional.length !== 1 || !pythonStableLiteralConstruction(positional[0], bindings))
      return undefined
    const sequence = pythonNativeSequence(positional[0], bindings)
    const scalar = pythonNativeText(positional[0], bindings)
    const parts = sequence
      ? pythonPositional(sequence.values).map((value) => pythonNativeText(value, bindings))
      : ascii(scalar)
        ? scalar.split('')
        : undefined
    if (
      !parts?.every(ascii) ||
      parts.length > 1024 ||
      parts.reduce((size, part) => size + part.length, 0) +
        Math.max(0, parts.length - 1) * text.length >
        4096
    )
      return undefined
    return parts.join(text)
  }
  if (positional.length < 2 || positional.length > 3) return undefined
  const old = pythonNativeText(positional[0], bindings)
  const replacement = pythonNativeText(positional[1], bindings)
  const count = positional.length === 3 ? pythonItemKey(positional[2]) : -1
  if (
    !ascii(old) ||
    !ascii(replacement) ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count)
  )
    return undefined
  const parts = old ? text.split(old) : undefined
  const occurrences = parts ? parts.length - 1 : text.length + 1
  const limit = count < 0 ? occurrences : Math.min(count, occurrences)
  if (text.length + limit * (replacement.length - old.length) > 4096) return undefined
  if (parts)
    return (
      parts.slice(0, limit + 1).join(replacement) +
      (limit < occurrences ? old + parts.slice(limit + 1).join(old) : '')
    )
  let result = ''
  for (let index = 0; index < limit; index++) result += replacement + (text[index] ?? '')
  return result + text.slice(limit)
}

const pythonConstructedPath = (
  callee: string | undefined,
  args: Node[],
  bindings: Bindings
): PythonProcessValue => {
  if (
    !/^(?:pathlib\.(?:Pure)?(?:Posix|Windows)?Path|(?:builtins\.)?str|os\.fspath)$/.test(
      callee ?? ''
    )
  )
    return undefined
  if (args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)))
    return undefined
  const positional = pythonPositional(args)
  if (positional.length !== 1 || positional[0].type === 'list_splat') return undefined
  const source = pythonProcessValue(positional[0], bindings)
  // str(bytes) is a representation, not the bytes' filesystem text. Do not decode literals.
  const literal = fixedText(positional[0])
  const value =
    literal === undefined &&
    !['call', 'subscript'].includes(unparenthesized(positional[0])?.type ?? '')
      ? undefined
      : source
  if (
    value === undefined ||
    (typeof value !== 'string' && value.bytes) ||
    (typeof value === 'string' ? value.length : value.text.length) > 4096
  )
    return undefined
  if (/^(?:(?:builtins\.)?str|os\.fspath)$/.test(callee ?? ''))
    return typeof value === 'string'
      ? value
      : pythonPathIntact(value, bindings)
        ? { ...value, classes: undefined }
        : value
  const kind = callee?.match(/^pathlib\.((?:Pure)?(?:Posix|Windows)?Path)$/)?.[1]
  if (!kind) return undefined
  const windows =
    kind.includes('Windows') || (!kind.includes('Posix') && process.platform === 'win32')
  if (typeof value !== 'string') {
    if (!pythonPathIntact(value, bindings)) return value
    if (value.windows !== windows) return undefined
  }
  const text = typeof value === 'string' ? value : value.text
  // Ambiguous Windows device/extra-root spellings need their own grammar proof.
  if (windows && /^[\\/]{3}/.test(text)) return undefined
  // PurePath removes redundant separators and '.', but preserves '..' and POSIX double roots.
  const root = windows
    ? win32.parse(text).root
    : text.startsWith('//') && !text.startsWith('///')
      ? '//'
      : text.startsWith('/')
        ? '/'
        : ''
  const normalized =
    (windows ? root.replaceAll('/', '\\') : root) +
    text
      .slice(root.length)
      .split(windows ? /[\\/]/ : '/')
      .filter((part) => part && part !== '.')
      .join(windows ? '\\' : '/')
  return { text: normalized || '.', windows, classes: pythonPathClasses(callee) }
}

const pythonValueLength = (value: PythonProcessValue): number =>
  typeof value === 'string' ? value.length : value ? JSON.stringify(value).length : 0

const boundedPythonVector = (
  tuple: boolean,
  values: PythonProcessValue[]
): PythonArgumentVector | undefined =>
  values.length <= 1024 &&
  values.reduce((size, value) => size + pythonValueLength(value), 0) <= 64_000
    ? { tuple, values }
    : undefined

const pythonVectorChoices = (
  candidates: (PythonArgumentVector | undefined)[]
): PythonArgumentVector[] | undefined => {
  if (!candidates.length) return undefined
  const unique = new Map<string, PythonArgumentVector>()
  let slots = 0,
    characters = 0
  for (const vector of candidates) {
    if (!vector) return undefined
    const key = JSON.stringify(vector)
    if (unique.has(key)) continue
    slots += vector.values.length
    characters += vector.values.reduce((size, value) => size + pythonValueLength(value), 0)
    if (unique.size >= 16 || slots > 1024 || characters > 64_000) return undefined
    unique.set(key, vector)
  }
  return [...unique.values()]
}

const pythonArgumentVectors = (
  node: Node | null | undefined,
  bindings: Bindings,
  depth = 0
): PythonArgumentVector[] | undefined => {
  node = unparenthesized(node)
  if (!node || depth >= 64) return undefined
  const cached = bindings.get(`@argv:${node.id}`)
  if (cached !== undefined) {
    // A branch join may contain an unevaluated node; it cannot provide a definite result.
    if (!cached.startsWith('[')) return undefined
    const vectors = JSON.parse(cached) as {
      tuple: boolean
      values: (PythonProcessValue | null)[]
    }[]
    return vectors.map((vector) => ({
      tuple: vector.tuple,
      values: vector.values.map((value) => value ?? undefined)
    }))
  }
  if (node.type === 'binary_operator' && fieldChild(node, 'operator')?.text === '+') {
    const left = pythonArgumentVectors(fieldChild(node, 'left'), bindings, depth + 1)
    const right = pythonArgumentVectors(fieldChild(node, 'right'), bindings, depth + 1)
    return left && right
      ? pythonVectorChoices(
          left.flatMap((l) =>
            right.map((r) =>
              l.tuple === r.tuple
                ? boundedPythonVector(l.tuple, [...l.values, ...r.values])
                : undefined
            )
          )
        )
      : undefined
  }
  if (node.type === 'subscript') {
    const indices = fieldChildren(node, 'subscript')
    if (indices.length !== 1 || indices[0].type !== 'slice') return undefined
    const vectors = pythonArgumentVectors(fieldChild(node, 'value'), bindings, depth + 1)
    if (!vectors) return undefined
    const bounds: (number | undefined)[] = [undefined, undefined, undefined]
    let slot = 0
    for (const part of indices[0].children) {
      if (part.type === ':') slot++
      else if (part.isNamed && part.type !== 'comment') {
        const value = unparenthesized(part)
        const bound = value?.type === 'none' ? undefined : pythonItemKey(value)
        if (value?.type !== 'none' && typeof bound !== 'number') return undefined
        bounds[slot] = bound as number | undefined
      }
      if (slot > 2) return undefined
    }
    const step = bounds[2] ?? 1
    if (step === 0) return undefined
    return pythonVectorChoices(
      vectors.map((vector) => {
        const length = vector.values.length
        const normalize = (value: number | undefined, fallback: number): number =>
          value === undefined
            ? fallback
            : Math.max(
                step > 0 ? 0 : -1,
                Math.min(step > 0 ? length : length - 1, value < 0 ? length + value : value)
              )
        // An omitted reverse stop is -1; an explicit -1 instead refers to length - 1.
        const start = normalize(bounds[0], step > 0 ? 0 : length - 1)
        const stop = normalize(bounds[1], step > 0 ? length : -1)
        const values: PythonProcessValue[] = []
        for (let index = start; step > 0 ? index < stop : index > stop; index += step)
          values.push(vector.values[index])
        return { tuple: vector.tuple, values }
      })
    )
  }
  const sequence = pythonSequence(node)
  if (!sequence) return undefined
  let vectors: PythonArgumentVector[] | undefined = [
    { tuple: sequence.type === 'tuple', values: [] }
  ]
  for (const item of pythonPositional(sequence.values)) {
    if (pythonSequenceSpread(item)) {
      const spread = pythonArgumentVectors(
        item.type === 'list_splat' ? item.namedChild(0) : item,
        bindings,
        depth + 1
      )
      if (!spread) return undefined
      vectors = pythonVectorChoices(
        vectors.flatMap((vector) =>
          spread.map((item) =>
            boundedPythonVector(vector.tuple, [...vector.values, ...item.values])
          )
        )
      )
    } else {
      const text = pythonProcessValue(item, bindings)
      for (const vector of vectors) vector.values.push(text)
    }
    if (!vectors || vectors.reduce((count, vector) => count + vector.values.length, 0) > 1024)
      return undefined
  }
  return pythonVectorChoices(vectors)
}

// Select only from fresh native containers or completed native vector receipts. Named mutable
// containers and custom key/index protocols cannot supply a stable process value.
const pythonProcessItem = (
  node: Node | null | undefined,
  key: string | number,
  bindings: Bindings
): PythonProcessValue => {
  if (typeof key === 'number') {
    const vectors = pythonArgumentVectors(node, bindings)
    if (vectors) {
      const values = vectors.map(
        (vector) => vector.values[key < 0 ? vector.values.length + key : key]
      )
      const value = values[0]
      return value !== undefined &&
        values.every((item) => JSON.stringify(item) === JSON.stringify(value))
        ? value
        : undefined
    }
    // A rejected/oversized vector must not fall back to an unbounded AST item lookup.
    if (!pythonDictionaryEntries(node) && !pythonClosedKeywords(node, bindings, 0, true))
      return undefined
  }
  const item = pythonLiteralItemNode(node, key, bindings)
  return item ? pythonProcessValue(item, bindings) : undefined
}

type PythonProcessSelection = { value?: PythonProcessValue; vectors?: PythonArgumentVector[] }

const pythonProcessItemSelection = (
  node: Node | null | undefined,
  key: string | number,
  bindings: Bindings
): PythonProcessSelection | undefined => {
  const value = pythonProcessItem(node, key, bindings)
  if (value !== undefined) return { value }
  node = unparenthesized(node)
  if (!node || node.text.length > 64_000) return undefined
  const sequence = pythonNativeSequence(node, bindings)
  if (sequence && pythonPositional(sequence.values).length > 1024) return undefined
  const item = pythonLiteralItemNode(node, key, bindings)
  const vectors = item ? pythonArgumentVectors(item, bindings) : undefined
  return vectors ? { vectors } : undefined
}

const pythonSelectedProcessResult = (
  callee: string | undefined,
  args: Node[],
  bindings: Bindings
): PythonProcessSelection | undefined => {
  const items = pythonItemgetterKeys(callee ?? '')
  const mapping = /^(?:builtins\.)?dict\.(?:get|pop|setdefault)$/.test(callee ?? '')
  if (!items && !mapping && !/^operator\.(?:getitem|__getitem__)$/.test(callee ?? ''))
    return undefined
  const positional = pythonPositional(args)
  if (
    args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)) ||
    positional.some((arg) => arg.type === 'list_splat') ||
    positional.length < (items ? 1 : 2) ||
    positional.length > (mapping ? 3 : items ? 1 : 2)
  )
    return undefined
  const key = items ? items[0] : pythonItemKey(positional[1])
  if (key === undefined) return undefined
  if (!mapping) {
    if (!items || items.length === 1)
      return pythonProcessItemSelection(positional[0], key, bindings)
    const source = pythonArgumentVectors(positional[0], bindings)
    const select = (vector?: PythonArgumentVector): PythonArgumentVector | undefined => {
      const values = items.map((key) =>
        vector && typeof key === 'number'
          ? vector.values[key < 0 ? vector.values.length + key : key]
          : pythonProcessItem(positional[0], key, bindings)
      )
      return values.some((value) => value === undefined)
        ? undefined
        : boundedPythonVector(true, values)
    }
    const vectors = pythonVectorChoices(
      source && items.every((key) => typeof key === 'number') ? source.map(select) : [select()]
    )
    return vectors ? { vectors } : undefined
  }
  if (
    (!pythonDictionaryEntries(positional[0]) &&
      !pythonClosedKeywords(positional[0], bindings, 0, true)) ||
    !positional.every((arg) => pythonStableLiteralConstruction(arg, bindings))
  )
    return undefined
  const selected = pythonLiteralItemNode(positional[0], key, bindings)
  if (selected === undefined) return undefined
  const result = selected ?? positional[2]
  return {
    value: pythonProcessValue(result, bindings),
    vectors: pythonArgumentVectors(result, bindings)
  }
}

const pythonConstructedVector = (
  callee: string | undefined,
  args: Node[],
  functionNode: Node | null | undefined,
  bindings: Bindings
): PythonArgumentVector[] | undefined => {
  let positional = pythonPositional(args)
  if (positional.some((arg) => arg.type === 'list_splat')) return undefined
  if (/^(?:builtins\.)?(?:list|tuple)$/.test(callee ?? '')) {
    if (
      args.some((arg) => ['keyword_argument', 'dictionary_splat'].includes(arg.type)) ||
      positional.length > 1
    )
      return undefined
    const source = positional.length ? pythonArgumentVectors(positional[0], bindings) : undefined
    return positional.length && !source
      ? undefined
      : pythonVectorChoices(
          (source ?? [{ tuple: false, values: [] }]).map((vector) => ({
            tuple: callee!.endsWith('tuple'),
            values: vector.values
          }))
        )
  }
  const method = callee?.split('.').at(-1)
  if (!['split', 'rsplit'].includes(method ?? '')) return undefined
  const names = new Set<string>()
  for (const arg of args) {
    const entries =
      arg.type === 'dictionary_splat'
        ? pythonClosedKeywords(arg.namedChild(0), bindings)
        : arg.type === 'keyword_argument'
          ? [{ name: fieldChild(arg, 'name')?.text ?? '' }]
          : []
    if (
      !entries ||
      (arg.type === 'dictionary_splat' &&
        pythonLiteralTruth(arg.namedChild(0), 0, bindings) === undefined)
    )
      return undefined
    for (const name of new Set(entries.map((entry) => entry.name))) {
      if (!['sep', 'maxsplit'].includes(name) || names.has(name)) return undefined
      names.add(name)
    }
  }
  let text: string | undefined
  if (/^(?:builtins\.)?str\.(?:split|rsplit)$/.test(callee ?? '')) {
    text = pythonNativeText(positional[0], bindings)
    positional = positional.slice(1)
  } else if (
    /^@noncallable\.(?:split|rsplit)$/.test(callee ?? '') &&
    functionNode?.type === 'attribute'
  )
    text = pythonNativeText(fieldChild(functionNode, 'object'), bindings)
  if (
    text === undefined ||
    text.length > 64_000 ||
    positional.length > 2 ||
    args.some(
      (arg) =>
        arg.type === 'keyword_argument' &&
        !['sep', 'maxsplit'].includes(fieldChild(arg, 'name')?.text ?? '')
    )
  )
    return undefined
  const separator = pythonKeyword(args, 'sep', bindings)
  const limit = pythonKeyword(args, 'maxsplit', bindings)
  if ((separator !== undefined && positional[0]) || (limit !== undefined && positional[1]))
    return undefined
  const sep = separator === undefined ? positional[0] : separator
  const max = limit === undefined ? positional[1] : limit
  const count = max === undefined ? -1 : pythonItemKey(max)
  if (typeof count !== 'number' || !Number.isSafeInteger(count)) return undefined
  let words: string[]
  if (sep === undefined || sep?.type === 'none') {
    // ponytail: ASCII whitespace only; do not substitute JavaScript's Unicode whitespace
    // rules for Python's or infer arbitrary __index__/descriptor/iterator behavior.
    // eslint-disable-next-line no-control-regex -- The range deliberately rejects non-ASCII source text.
    if (/[^\x00-\x7f]/.test(text)) return undefined
    // eslint-disable-next-line no-control-regex -- Python treats ASCII file/group/record/unit separators as whitespace.
    const matches = [...text.matchAll(/[^ \t\r\n\v\f\x1c-\x1f]+/g)]
    if (count >= 0 && count < matches.length) {
      const boundary = method === 'rsplit' ? matches.length - count - 1 : count
      words =
        method === 'rsplit'
          ? [
              text.slice(0, matches[boundary].index + matches[boundary][0].length),
              ...matches.slice(boundary + 1).map((match) => match[0])
            ]
          : [
              ...matches.slice(0, boundary).map((match) => match[0]),
              text.slice(matches[boundary].index)
            ]
    } else words = matches.map((match) => match[0])
  } else {
    const delimiter = fixedText(sep)
    if (!delimiter) return undefined
    if (method === 'rsplit') {
      words = []
      let end = text.length
      while (end >= delimiter.length && (count < 0 || words.length < count)) {
        const index = text.lastIndexOf(delimiter, end - delimiter.length)
        if (index < 0) break
        words.push(text.slice(index + delimiter.length, end))
        end = index
        if (words.length > 1024) return undefined
      }
      words = [text.slice(0, end), ...words.reverse()]
    } else {
      words = text.split(delimiter)
      if (count >= 0 && count < words.length - 1)
        words = [...words.slice(0, count), words.slice(count).join(delimiter)]
    }
  }
  return pythonVectorChoices([boundedPythonVector(false, words)])
}

// Capture only definite builtin results; never invoke user truth/integer/length hooks.
const pythonConstructedTruth = (
  callee: string | undefined,
  args: Node[],
  bindings: Bindings,
  vectors?: PythonArgumentVector[]
): boolean | undefined => {
  const kind = callee?.replace(/^builtins\./, '')
  // Split vectors are produced only from closed strings and native option literals.
  if (vectors && ['split', 'rsplit'].includes(kind?.split('.').at(-1) ?? '')) {
    const truths = vectors.map((vector) => vector.values.length > 0)
    return truths.every((truth) => truth === truths[0]) ? truths[0] : undefined
  }
  if (!['bool', 'int', 'len', 'list', 'tuple'].includes(kind ?? '')) return undefined
  if (args.some((arg) => ['dictionary_splat', 'keyword_argument'].includes(arg.type)))
    return undefined
  const positional = pythonPositional(args)
  if (positional.length > 1 || positional.some((arg) => arg.type === 'list_splat')) return undefined
  if (!positional.length) return kind === 'len' ? undefined : false
  const value = unparenthesized(positional[0])!
  const truth = pythonLiteralTruth(value, 0, bindings)
  if (kind === 'list' || kind === 'tuple') return vectors ? truth : undefined
  if (kind === 'bool') return truth
  if (kind === 'int') {
    let numeric = value
    while (
      numeric.type === 'unary_operator' &&
      /^[+-]$/.test(fieldChild(numeric, 'operator')?.text ?? '')
    )
      numeric = unparenthesized(numeric.namedChildren.find((child) => child.type !== 'comment'))!
    if (['true', 'false', 'integer', 'not_operator'].includes(numeric.type)) return truth
    // These call proofs are produced only for builtin bool/int/len, all integral results.
    if (
      value.type === 'call' &&
      bindings.get(`@truth:${value.id}`)?.startsWith('{') &&
      pythonArgumentVectors(value, bindings) === undefined
    )
      return truth
    const text = processString(value)?.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g, '')
    return text !== undefined && text.length <= 4096 && /^[+-]?\d(?:_?\d)*$/.test(text)
      ? /[1-9]/.test(text)
      : undefined
  }
  return ['string', 'concatenated_string', 'list', 'tuple', 'dictionary', 'set'].includes(
    value.type
  ) ||
    pythonArgumentVectors(value, bindings) !== undefined ||
    pythonClosedKeywords(value, bindings) !== undefined
    ? truth
    : undefined
}

// Popen and its convenience functions share the forwarded positional/keyword contract.
// Only direct calls provide command arguments; callback values remain deferred execution.
const pythonProcessRisk = (args: Node[], bindings: Bindings): boolean => {
  const positional = pythonPositional(args)
  if (positional.some((arg) => arg.type === 'list_splat')) return true
  const argument = (name: string, index: number): Node | null | undefined => {
    const keyword = pythonKeyword(args, name, bindings)
    let value = keyword === undefined ? positional[index] : keyword
    while (value?.type === 'parenthesized_expression') value = value.namedChild(0)
    return value
  }
  const executable = argument('executable', 2)
  const preexec = argument('preexec_fn', 6)
  const shell = argument('shell', 8)
  const env = argument('env', 10)
  const executableText = (): string | undefined =>
    pythonProcessText(pythonProcessValue(executable, bindings), bindings)
  const none = (node: Node | null | undefined): boolean =>
    node === undefined || node?.type === 'none'
  if (
    !none(preexec) ||
    !literalProcessEnvironment(env, 0, bindings) ||
    !(shell === undefined || pythonLiteralTruth(shell, 0, bindings) === false)
  )
    return true
  let inspected = 0
  let choices: PythonArgumentVector[] | undefined = []
  const inspect = (argv: Node | null | undefined, depth = 0): boolean => {
    argv = unparenthesized(argv)
    if (depth >= 64 || ++inspected > 64) return true
    const vectors = pythonArgumentVectors(argv, bindings)
    if (vectors) {
      // Recursive fallback must retain the same aggregate bounds as cached choices.
      choices = pythonVectorChoices([...(choices ?? []), ...vectors])
      if (!choices) return true
      return vectors.some(({ values }) => {
        // Every path operand is converted, even for a reader command that ignores unknown data.
        if (values.some((value) => typeof value === 'object' && !pythonPathIntact(value, bindings)))
          return true
        const text = values.map((value) => pythonProcessText(value, bindings))
        return (
          !text.length ||
          commandRisk(none(executable) ? text[0] : executableText(), text.slice(1)) !== undefined
        )
      })
    }
    const selection = argv && pythonSelection(argv)
    if (selection) {
      const evidence = bindings.get(`@truth:${argv!.id}`)
      if (!evidence?.startsWith('{')) return true
      const { eligible, truth } = JSON.parse(evidence) as {
        eligible: boolean
        truth?: boolean
      }
      if (!eligible) return true
      const [, consequence, alternative] = selection
      return truth === undefined
        ? inspect(consequence, depth + 1) || inspect(alternative, depth + 1)
        : inspect(truth ? consequence : alternative, depth + 1)
    }
    const scalar = pythonProcessValue(argv, bindings)
    const text = pythonProcessText(scalar, bindings)
    if (text !== undefined) {
      // POSIX string args name one executable; with an override they supply only argv0.
      // Windows strings are command lines. Do not reinterpret quoted/spaced argv as Bash.
      if (
        (process.platform === 'win32' &&
          !(typeof scalar === 'object' && scalar.classes?.length) &&
          /[\s'"]/.test(text)) ||
        (none(executable) && /\s/.test(text.split('/').at(-1)!))
      )
        return true
      return commandRisk(none(executable) ? text : executableText(), []) !== undefined
    }
    const sequence = pythonSequence(argv)
    const slots = sequence ? pythonPositional(sequence.values) : undefined
    const values = slots?.some((value) => value.type === 'list_splat')
      ? undefined
      : slots?.map((value) => pythonProcessText(pythonProcessValue(value, bindings), bindings))
    if (!values?.length) return true
    const command = none(executable) ? values[0] : executableText()
    return commandRisk(command, values.slice(1)) !== undefined
  }
  return inspect(argument('args', 0))
}

const unparenthesized = (node: Node | null | undefined): Node | undefined => {
  while (node?.type === 'parenthesized_expression')
    node = node.namedChildren.find((child) => child.type !== 'comment')
  return node ?? undefined
}
const processString = (node: Node | null | undefined): string | undefined => {
  node = unparenthesized(node)
  return node &&
    [
      'string',
      'raw_string',
      'concatenated_string',
      'template_string',
      'binary_operator',
      'binary_expression'
    ].includes(node.type)
    ? literal(node)
    : undefined
}

const outputEnvironmentSetting = /^(?:NO_COLOR|NODE_DISABLE_COLORS|FORCE_COLOR|PYTHONUNBUFFERED)$/

// Literal locale, thread and output settings do not select a program or load startup code.
// Keep a narrow literal contract: unknown settings/snapshots retain review, not inferred trust.
const passiveEnvironmentEntry = (
  name: string | undefined,
  value: string | undefined,
  shellSource = false
): boolean => {
  if (name === undefined || value === undefined) return false
  // OS environment mappings carry literal data; R instead joins values into shell source.
  // These output flags neither select an executable nor load startup code.
  if (outputEnvironmentSetting.test(name)) return !shellSource || /^[\w./:+,@-]*$/.test(value)
  if (name === 'PYTHONUTF8') return /^[01]?$/.test(value)
  if (name === 'PYTHONIOENCODING')
    // Only standard stream encodings/handlers: unknown codec names may select imported code.
    return /^(?:utf-?8|ascii|latin-?1|iso-8859-1)(?::(?:strict|ignore|replace|backslashreplace|surrogateescape|surrogatepass|xmlcharrefreplace|namereplace))?$/i.test(
      value
    )
  if (['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'].includes(name))
    return /^[1-9]\d*(?:,[1-9]\d*)*$/.test(value)
  return (
    /^(?:LANG|LANGUAGE|TZ|LC_(?:ALL|CTYPE|NUMERIC|TIME|COLLATE|MONETARY|MESSAGES|PAPER|NAME|ADDRESS|TELEPHONE|MEASUREMENT|IDENTIFICATION))$/.test(
      name
    ) &&
    // R's env is joined into shell source. Also avoids coercion/evaluation of nonliteral values.
    /^[\w./:+,@-]*$/.test(value)
  )
}
const literalProcessEnvironment = (
  node: Node | null | undefined,
  depth = 0,
  bindings?: Bindings
): boolean => {
  // A null lookup denotes an unknown packed Python mapping, not an absent env option.
  if (node === null || depth >= 64) return false
  const environment = unparenthesized(node)
  if (!environment || ['none', 'null'].includes(environment.type)) return true
  const python = environment.tree.rootNode.type === 'module'
  const closedValue = (value: Node | undefined): boolean =>
    !!value &&
    (processString(value) !== undefined ||
      ['integer', 'float', 'number', 'true', 'false', 'none', 'null'].includes(value.type) ||
      (['string', 'template_string'].includes(value.type) &&
        value.namedChildren.every((child) =>
          [
            'string_content',
            'string_fragment',
            'string_start',
            'string_end',
            'escape_sequence'
          ].includes(child.type)
        )))
  const values = new Map<string, Node | undefined>()
  const collect = (mapping: Node, level: number): boolean => {
    if (level >= 64) return false
    if (python && mapping.type === 'call' && bindings) {
      const entries = pythonClosedKeywords(mapping, bindings, level)
      if (!entries) return false
      for (const { name, value } of entries) {
        if (values.has(name) && !closedValue(values.get(name))) return false
        values.set(name, unparenthesized(value))
      }
      return true
    }
    const entries = python
      ? pythonDictionaryEntries(mapping, level)
      : mapping.type === 'object'
        ? mapping.namedChildren
        : undefined
    if (!entries) return false
    for (const entry of entries) {
      if (entry.type === 'comment') continue
      if (['dictionary_splat', 'spread_element'].includes(entry.type)) {
        const nested = unparenthesized(entry.namedChild(0))
        // Check every spread's shape: unknown mapping hooks/getters run even if later overwritten.
        if (!nested || !collect(nested, level + 1)) return false
        continue
      }
      if (entry.type !== 'pair') return false
      let key = fieldChild(entry, 'key')
      if (key?.type === 'computed_property_name') {
        key = unparenthesized(key.namedChild(0)) ?? null
        if (processString(key) === undefined) return false
      }
      // Python identifier keys are evaluated; JavaScript property identifiers are fixed names.
      const name = python ? processString(key) : literal(key)
      if (name === undefined || (!python && name === '__proto__')) return false
      // A discarded conversion/factory can still execute hooks while constructing the mapping.
      if (values.has(name) && !closedValue(values.get(name))) return false
      values.set(name, unparenthesized(fieldChild(entry, 'value')))
    }
    return true
  }
  if (!collect(environment, depth)) return false
  // Only final literal values reach the process. Eager construction effects are visited separately.
  return [...values].every(([name, value]) => {
    // Static escaped output metadata stays OS data; no decoding as executable source.
    // Interpolation/tagged templates and their eager effects retain the normal traversal.
    if (
      outputEnvironmentSetting.test(name) &&
      value &&
      ['string', 'template_string'].includes(value.type) &&
      closedValue(value)
    )
      return true
    // Node converts plain numeric env values to strings; Python requires string values.
    const text =
      !python && value?.type === 'number' && /^\d+$/.test(value.text)
        ? value.text
        : processString(value)
    return passiveEnvironmentEntry(name, text)
  })
}
const jsProcessArguments = (
  target: string,
  args: Node[],
  bindings: Bindings,
  capturedValues?: ReadonlyMap<number, string | undefined>
): { values: (Node | null)[]; options?: Node; callback?: Node } | undefined => {
  if (args.some((arg) => arg.type === 'spread_element')) return undefined
  const callbackAPI = /\.(?:exec|execFile)$/.test(target)
  const callbackValue = (node: Node | undefined): boolean => {
    const value =
      node && capturedValues?.has(node.id)
        ? capturedValues.get(node.id)
        : identity(node ?? null, bindings)
    return (
      !!value &&
      (value === '@inline' ||
        value.startsWith('@function:') ||
        jsDeletion.test(value) ||
        processCall.test(value) ||
        /^(?:console\.(?:log|error|warn))$/.test(value))
    )
  }
  const second = unparenthesized(args[1])
  const values = second?.type === 'array' ? slots(second) : []
  if (values.some((value) => value?.type === 'spread_element')) return undefined
  const rest = args
    .slice(['array', 'null'].includes(second?.type ?? '') ? 2 : 1)
    .map(unparenthesized)
  if (callbackAPI && rest.length === 1 && callbackValue(rest[0]))
    return { values, callback: rest[0] }
  if (!rest.length) return { values }
  const options = rest.shift()
  if (
    options?.type === 'null' &&
    /\.(?:exec|execFile)(?:Sync)?$/.test(target) &&
    rest.length <= (callbackAPI ? 1 : 0)
  )
    return { values, callback: rest[0] }
  if (options?.type !== 'object' || rest.length > (callbackAPI ? 1 : 0)) return undefined
  return { values, options, callback: rest[0] }
}
const jsProcessOptionsRisk = (options: Node | undefined): boolean => {
  const values = new Map<string, Node | undefined>()
  const collect = (object: Node, depth = 0): boolean => {
    if (depth >= 64) return false
    for (const entry of object.namedChildren) {
      if (entry.type === 'comment') continue
      if (entry.type === 'spread_element') {
        const nested = unparenthesized(entry.namedChild(0))
        // Only ordinary visible objects: getters and unknown spreads may execute during copying.
        if (nested?.type !== 'object' || !collect(nested, depth + 1)) return false
        continue
      }
      if (entry.type !== 'pair') return false
      let key = fieldChild(entry, 'key')
      if (key?.type === 'computed_property_name') {
        const computed = key.namedChildren.find((child) => child.type !== 'comment')
        key = processString(computed) !== undefined ? (unparenthesized(computed) ?? null) : null
      }
      const name = literal(key)
      // Prototype setters are not ordinary copied options, even if a later field replaces them.
      if (!name || name === '__proto__') return false
      values.set(name, unparenthesized(fieldChild(entry, 'value')))
    }
    return true
  }
  if (options && !collect(options)) return true
  // Literal options use their last value. Eager construction effects are visited separately.
  for (const [name, value] of values) {
    if (name === 'env' && !literalProcessEnvironment(value)) return true
    if (
      ['shell', 'windowsVerbatimArguments'].includes(name) &&
      !['false', 'null'].includes(value?.type ?? '')
    )
      return true
  }
  return false
}
const jsProcessRisk = (args: Node[], call: ReturnType<typeof jsProcessArguments>): boolean => {
  return (
    !call ||
    jsProcessOptionsRisk(call.options) ||
    commandRisk(processString(args[0]), call.values.map(processString)) !== undefined
  )
}
const rArguments = (args: Node[], formals: string[]): Map<string, Node> => {
  const matched = new Map<string, Node>()
  // R matches exact names first, then unique partial names, then remaining positions.
  for (const arg of args) {
    const name = literal(fieldChild(arg, 'name'))
    if (name && formals.includes(name)) matched.set(name, arg)
  }
  for (const arg of args) {
    const name = literal(fieldChild(arg, 'name'))
    if (!name || formals.includes(name)) continue
    const candidates = formals.filter((formal) => !matched.has(formal) && formal.startsWith(name))
    if (candidates.length === 1) matched.set(candidates[0], arg)
  }
  const positional = args.filter((arg) => !fieldChild(arg, 'name'))
  for (const formal of formals) {
    if (matched.has(formal)) continue
    const arg = positional.shift()
    if (arg) matched.set(formal, arg)
  }
  return matched
}
// do.call evaluates language objects held in its argument list. Normalize only visible data
// and function values; unknown lists, expressions and custom environments retain review.
const rInvocation = (
  args: Node[],
  bindings: Bindings,
  callee: string | undefined
): { callee: string | undefined; args: Node[] } => {
  const data = (node: Node | null, depth = 0): boolean => {
    node = unparenthesized(node) ?? null
    if (!node || depth > 64) return false
    if (
      [
        'integer',
        'float',
        'complex',
        'na',
        'inf',
        'nan',
        'string',
        'true',
        'false',
        'null'
      ].includes(node.type)
    )
      return true
    const operator = fieldChild(node, 'operator')?.text
    if (
      (node.type === 'unary_operator' && ['+', '-'].includes(operator ?? '')) ||
      (node.type === 'binary_operator' &&
        [':', '+', '-', '*', '/', '^', '%%', '%/%'].includes(operator ?? ''))
    )
      return (
        (node.type === 'unary_operator' || data(fieldChild(node, 'lhs'), depth + 1)) &&
        data(fieldChild(node, 'rhs'), depth + 1)
      )
    const target = identity(node, bindings)
    if (['identifier', 'namespace_operator'].includes(node.type))
      return possibleTargets(target).every(
        (value) =>
          value?.startsWith('@function:') ||
          /^(?:base::)?(?:sum|mean|abs|length|rbind|cbind|paste|paste0|identity|list|c|do\.call|unlink|file\.remove|lapply|sapply|vapply|apply|mapply|Map|Reduce|Filter|Find|Position|system2?)$/.test(
            value ?? ''
          )
      )
    if (
      node.type === 'call' &&
      /^(?:base::)?(?:list|c|data\.frame)$/.test(
        identity(fieldChild(node, 'function'), bindings) ?? ''
      )
    )
      return (fieldChild(node, 'arguments')?.namedChildren ?? []).every(
        (entry) =>
          ['comment', 'comma'].includes(entry.type) ||
          (entry.type === 'argument' && data(fieldChild(entry, 'value'), depth + 1))
      )
    return false
  }
  for (let depth = 0; /^(?:base::)?do\.call$/.test(callee ?? ''); depth++) {
    if (depth >= 64) return { callee: '<dynamic>', args }
    const matched = rArguments(args, ['what', 'args', 'quote', 'envir'])
    const value = (name: string): Node | null => fieldChild(matched.get(name), 'value')
    const quote = value('quote')
    const list = value('args')
    if (
      new Set(matched.values()).size !== args.length ||
      matched.has('envir') ||
      (matched.has('quote') && quote?.type !== 'false') ||
      list?.type !== 'call' ||
      !/^(?:base::)?list$/.test(identity(fieldChild(list, 'function'), bindings) ?? '') ||
      !data(list)
    )
      break
    const what = value('what')
    const name = processString(what)
    // Strings request a lookup now; function values retain their frozen source identity.
    const target = name !== undefined ? (bindings.get(name) ?? name) : identity(what, bindings)
    if (!target || name === '' || name?.includes('::')) break
    callee = target
    args =
      fieldChild(list, 'arguments')?.namedChildren.filter(
        (entry) => !['comment', 'comma'].includes(entry.type)
      ) ?? []
  }
  return { callee, args }
}

const rProcessRisk = (args: Node[], bindings: Bindings): boolean => {
  const matched = rArguments(args, [
    'command',
    'args',
    'stdout',
    'stderr',
    'stdin',
    'input',
    'env',
    'wait',
    'minimized',
    'invisible',
    'timeout',
    'receive.console.signals'
  ])
  if (new Set(matched.values()).size !== args.length) return true
  const value = (name: string): Node | undefined =>
    unparenthesized(fieldChild(matched.get(name), 'value'))
  // Only closed argument construction can preserve a quoting function's current binding.
  // Other argument expressions may rebind it before R forces the quoted argument promise.
  const inert = (node: Node | null | undefined, depth = 0): boolean => {
    node = unparenthesized(node)
    if (!node || depth >= 64) return false
    if (['string', 'null', 'true', 'false', 'integer', 'float'].includes(node.type)) return true
    if (node.type !== 'call') return false
    const target = identity(fieldChild(node, 'function'), bindings)
    return (
      /^(?:base::)?(?:c|character|shQuote)$/.test(target ?? '') &&
      (fieldChild(node, 'arguments')?.namedChildren ?? []).every(
        (entry) =>
          ['comment', 'comma'].includes(entry.type) ||
          (entry.type === 'argument' && inert(fieldChild(entry, 'value'), depth + 1))
      )
    )
  }
  const closedArguments = args.every((arg) => inert(fieldChild(arg, 'value')))
  const vector = (
    node: Node | undefined,
    allowQuotes = false,
    depth = 0
  ): { text: string | undefined; quoted: boolean }[] | undefined => {
    node = unparenthesized(node)
    if (depth >= 64) return undefined
    if (!node || node.type === 'null') return []
    if (node.type === 'string') return [{ text: processString(node), quoted: false }]
    if (node.type !== 'call') return undefined
    const constructor = identity(fieldChild(node, 'function'), bindings)
    const entries =
      fieldChild(node, 'arguments')?.namedChildren.filter((arg) => arg.type === 'argument') ?? []
    if (
      /^(?:base::)?character$/.test(constructor ?? '') &&
      (!entries.length ||
        (entries.length === 1 &&
          (!fieldChild(entries[0], 'name') ||
            literal(fieldChild(entries[0], 'name')) === 'length') &&
          fieldChild(entries[0], 'value')?.text === '0'))
    )
      return []
    if (/^(?:base::)?shQuote$/.test(constructor ?? '')) {
      if (!allowQuotes || !closedArguments || process.platform === 'win32') return undefined
      const options = rArguments(entries, ['string', 'type'])
      const type = unparenthesized(fieldChild(options.get('type'), 'value'))
      const input = unparenthesized(fieldChild(options.get('string'), 'value'))
      if (
        new Set(options.values()).size !== entries.length ||
        !input ||
        (type && !['sh', 's'].includes(processString(type) ?? ''))
      )
        return undefined
      const values = vector(input, false, depth + 1)
      // Nested quoting yields different argument text; unknown coercion is not literal data.
      return values?.every((entry) => entry.text !== undefined)
        ? values.map((entry) => ({ ...entry, quoted: true }))
        : undefined
    }
    if (!/^(?:base::)?c$/.test(constructor ?? '')) return undefined
    const values = entries.map((arg) =>
      vector(unparenthesized(fieldChild(arg, 'value')), allowQuotes, depth + 1)
    )
    return values.every((entry) => entry !== undefined) ? values.flat() : undefined
  }

  for (const name of ['stdout', 'stderr']) {
    const output = value(name)
    if (output && !['true', 'false', 'null'].includes(output.type) && processString(output) !== '')
      return true
  }
  if (value('stdin') && processString(value('stdin')) !== '') return true
  const environment = vector(value('env'))
  if (
    !environment ||
    environment.some((entry) => {
      if (entry.text === undefined || entry.quoted) return true
      const equal = entry.text.indexOf('=')
      return (
        equal < 0 ||
        !passiveEnvironmentEntry(entry.text.slice(0, equal), entry.text.slice(equal + 1), true)
      )
    })
  )
    return true
  const values = vector(value('args'), true)
  // system2 joins args into shell source. Visible sh quoting preserves one argument;
  // unquoted source keeps its existing plain-token restriction.
  if (
    !values ||
    values.some(
      (arg) => arg.text === undefined || (!arg.quoted && !/^[\w./:+=,@%~ \t-]*$/.test(arg.text))
    )
  )
    return true
  return (
    commandRisk(
      processString(value('command')),
      values.flatMap((arg) => (arg.quoted ? [arg.text!] : arg.text!.trim().split(/[ \t]+/)))
    ) !== undefined
  )
}

const pythonShellCommand = (
  target: string,
  args: Node[],
  bindings: Bindings
): string | undefined => {
  const literalKeywords = (node: Node | null, depth = 0): boolean => {
    if (unparenthesized(node)?.type === 'call')
      return pythonClosedKeywords(node, bindings, depth) !== undefined
    const entries = pythonDictionaryEntries(node, depth)
    return (
      !!entries &&
      entries.every(
        (entry) =>
          entry.type === 'comment' ||
          (entry.type === 'dictionary_splat'
            ? literalKeywords(entry.namedChild(0), depth + 1)
            : entry.type === 'pair' && processString(fieldChild(entry, 'key')) !== undefined)
      )
    )
  }
  // ** may execute an unknown mapping's hooks even when explicit keywords fix the command.
  if (args.some((arg) => arg.type === 'dictionary_splat' && !literalKeywords(arg.namedChild(0))))
    return undefined
  const positional = pythonPositional(args)
  if (positional.some((arg) => arg.type === 'list_splat')) return undefined
  const argument = (name: string, index: number): Node | null | undefined => {
    const keyword = pythonKeyword(args, name, bindings)
    // Unknown packed options must not collapse into absent/default options during shell probing.
    return keyword === null
      ? null
      : unparenthesized(keyword === undefined ? positional[index] : keyword)
  }
  if (/^os\.(?:system|popen)$/.test(target))
    return processString(argument(target.endsWith('.system') ? 'command' : 'cmd', 0))
  if (/^subprocess\.get(?:status)?output$/.test(target)) return processString(argument('cmd', 0))
  if (!/^subprocess\.(?:run|call|check_call|check_output|Popen)$/.test(target)) return undefined
  if (pythonLiteralTruth(argument('shell', 8), 0, bindings) !== true) return undefined
  for (const [name, index] of [
    ['executable', 2],
    ['preexec_fn', 6]
  ] as const) {
    const value = argument(name, index)
    if (value === null || (value && value.type !== 'none')) return undefined
  }
  if (!literalProcessEnvironment(argument('env', 10), 0, bindings)) return undefined
  const argv = argument('args', 0)
  const sequence = pythonSequence(argv)
  if (sequence) {
    const values = pythonPositional(sequence.values)
    if (values.some((value) => value?.type === 'list_splat')) return undefined
    return processString(values[0])
  }
  return processString(argv)
}
const rShellCommand = (args: Node[]): string | undefined => {
  if (args.some((arg) => arg.text === '...' || fieldChild(arg, 'value')?.text === '...'))
    return undefined
  const matched = rArguments(args, [
    'command',
    'intern',
    'ignore.stdout',
    'ignore.stderr',
    'wait',
    'input',
    'show.output.on.console',
    'minimized',
    'invisible',
    'timeout'
  ])
  return new Set(matched.values()).size === args.length
    ? processString(fieldChild(matched.get('command'), 'value'))
    : undefined
}
const plainShellSource = (root: Node): boolean => {
  // Preserve review for shell state/provenance we do not reconstruct. This does not change
  // ordinary Bash admission; it bounds discharge of an otherwise opaque nested process call.
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (['variable_assignment', 'function_definition'].includes(node.type)) return false
    if (node.type === 'command') {
      const name = literal(fieldChild(node, 'name'))?.split('/').at(-1)
      if (
        [
          'alias',
          'unalias',
          'trap',
          'shopt',
          'hash',
          'export',
          'declare',
          'typeset',
          'readonly',
          'local',
          'read',
          'builtin',
          'env',
          'command'
        ].includes(name ?? '')
      )
        return false
    }
    stack.push(...node.namedChildren)
  }
  return true
}

const shellPattern = (node: Node | null): boolean =>
  node?.type === 'word'
    ? /(?:^|[^\\])(?:\\\\)*[*?[]/.test(node.text)
    : !!node &&
      (['expansion', 'simple_expansion'].includes(node.type) ||
        (['concatenation', 'command_name'].includes(node.type) &&
          node.namedChildren.some(shellPattern)))

const shellRisk = (node: Node): string | undefined => {
  const nameNode = fieldChild(node, 'name')
  const command = shellPattern(nameNode) ? undefined : literal(nameNode)
  const argumentNodes = fieldChildren(node, 'argument')
  return commandRisk(
    command,
    // Only a raw Bash escaped semicolon is a literal token. Direct argv keeps its own spelling.
    argumentNodes.map((arg) => {
      if (arg.text === '\\;') return ';'
      const value = literal(arg)
      if (value !== undefined || shellPattern(arg)) return value
      const name = command?.split('/').at(-1) ?? ''
      const tar = ['tar', 'gtar', 'bsdtar'].includes(name)
      if (!tar && !['dd', 'gdd'].includes(name)) return undefined
      // Fixed operand prefixes survive quoted scalar values without evaluating their contents.
      // Quoted $@/array[@] can still produce extra argv entries, including an output operand.
      const stack = [arg]
      while (stack.length) {
        const node = stack.pop()!
        if (['simple_expansion', 'expansion'].includes(node.type) && node.text.includes('@'))
          return undefined
        stack.push(...node.namedChildren)
      }
      let quoted = arg
      if (
        tar &&
        arg.type === 'concatenation' &&
        arg.namedChildCount === 2 &&
        literal(arg.namedChild(0)) === '--checkpoint-action=' &&
        arg.namedChild(1)?.type === 'string'
      )
        quoted = arg.namedChild(1)!
      const first = ['concatenation', 'string'].includes(quoted.type) ? quoted.namedChild(0) : null
      const prefix = first?.type === 'string_content' ? first.text : literal(first)
      if (tar) {
        // Quoted echo text remains one nonexecuting action; substitutions are visited separately.
        if (quoted.type !== 'string') return undefined
        const echo = prefix?.match(/^(?:--checkpoint-action=)?echo=/)?.[0]
        return echo === 'echo=' && quoted !== arg ? '--checkpoint-action=echo=' : echo
      }
      return prefix?.match(/^(?:if|ibs|obs|bs|cbs|count|skip|iseek)=/)?.[0]
    }),
    argumentNodes.map(shellPattern)
  )
}

const commandRisk = (
  command: string | undefined,
  args: (string | undefined)[],
  patterns: readonly boolean[] = [],
  depth = 0,
  nested = false
): string | undefined => {
  if (depth >= 64) return 'command wrapper analysis limit'
  if (!command) return 'dynamic shell command'
  if (command.includes('\\')) return 'escaped shell command'
  const name = command
    .split('/')
    .at(-1)!
    .replace(/\.(?:exe|cmd|bat)$/i, '')
  // Scripts own their argument semantics; --help/--version do not prove they avoid effects.
  if (/\.(?:sh|py|r|js|ps1|cmd|bat)$/i.test(command)) return 'script execution'
  if (args.length === 1 && ['--help', '--version'].includes(args[0] ?? '')) return undefined
  // Find children and their wrappers can interpret executable scripts beyond argv semantics.
  // Keep these nested programs reviewable until their own language effects are analyzed.
  if (
    nested &&
    /^(?:sed|[gmnl]?awk|perl(?:\d+(?:\.\d+)*)?|ruby|lua(?:\d+(?:\.\d+)*)?|luajit|osascript)$/.test(
      name
    )
  )
    return `${name} nested script execution`
  if (name === 'builtin') {
    const index = args[0] === '--' ? 1 : 0
    return index === args.length
      ? undefined
      : commandRisk(
          patterns[index] ? undefined : args[index],
          args.slice(index + 1),
          patterns.slice(index + 1),
          depth + 1,
          nested
        )
  }
  if (name === 'command') {
    let index = 0
    let lookup = false
    while (args[index]?.startsWith('-')) {
      if (patterns[index]) return 'unresolved command wrapper'
      const option = args[index++]!
      if (option === '--') break
      if (!/^-[pvV]+$/.test(option)) return 'unresolved command wrapper'
      lookup ||= /[vV]/.test(option)
    }
    // Discovery does not execute the named tool. Substitutions are still visited separately.
    return lookup || index === args.length
      ? undefined
      : commandRisk(
          patterns[index] ? undefined : args[index],
          args.slice(index + 1),
          patterns.slice(index + 1),
          depth + 1,
          nested
        )
  }
  if (name === 'env') {
    let index = 0
    while (args[index]?.startsWith('-')) {
      if (patterns[index]) return 'unresolved env wrapper'
      const option = args[index++]!
      if (option === '--' || option === '-') break
      if (['--ignore-environment', '--null', '--debug'].includes(option)) continue
      if (['--unset', '--chdir'].includes(option)) {
        if (patterns[index] || args[index++] === undefined) return 'unresolved env wrapper'
        continue
      }
      if (/^--(?:unset|chdir)=/.test(option)) continue
      if (option.startsWith('--')) return 'unresolved env wrapper'
      // -u/-C consume the rest of a short-option cluster, or the following argument.
      for (let offset = 1; offset < option.length; offset++) {
        const flag = option[offset]
        if (flag === 'u' || flag === 'C') {
          if (offset === option.length - 1 && (patterns[index] || args[index++] === undefined))
            return 'unresolved env wrapper'
          break
        }
        if (!'i0v'.includes(flag)) return 'unresolved env wrapper'
      }
    }
    // Options precede assignments. Values and option operands are data, not command names.
    const assignments = index
    while (args[index]?.includes('=')) {
      if (patterns[index]) return 'unresolved env wrapper'
      index++
    }
    if (index === args.length) return undefined
    // These assignments explicitly load code even when the visible utility only reads data.
    if (
      args
        .slice(assignments, index)
        .some((arg) => /^(?:LD_PRELOAD|LD_AUDIT|DYLD_INSERT_LIBRARIES)=./s.test(arg!))
    )
      return 'env dynamic library loading'
    for (const entry of args.slice(assignments, index)) {
      const equal = entry!.indexOf('=')
      const risk = commandOptionOverrideRisk(entry!.slice(0, equal), entry!.slice(equal + 1))
      if (risk) return risk
    }
    return commandRisk(
      patterns[index] ? undefined : args[index],
      args.slice(index + 1),
      patterns.slice(index + 1),
      depth + 1,
      nested
    )
  }
  if (name === 'fc' || name === 'enable') {
    let listing = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === undefined) return `${name} dynamic options`
      if (arg === '--' || !arg.startsWith('-') || /^-\d+$/.test(arg)) break
      for (let offset = 1; offset < arg.length; offset++) {
        const flag = arg[offset]
        if (name === 'enable' && flag === 'f') return 'enable native code loading'
        if (name === 'fc' && flag === 's') return 'fc history execution'
        if (name === 'fc' && flag === 'l') listing = true
        if (name === 'fc' && flag === 'e') {
          if (offset === arg.length - 1) index++
          break
        }
      }
    }
    return name === 'fc' && !listing ? 'fc history execution' : undefined
  }
  if (name === 'sed') {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === '--') break
      if (arg === undefined) continue
      if (arg === '--in-place' || arg.startsWith('--in-place=')) return 'sed file overwrite'
      if (['-e', '-f', '--expression', '--file'].includes(arg)) {
        index++
        continue
      }
      if (arg.startsWith('--') || !arg.startsWith('-')) continue
      // -e/-f consume the remaining short-option text as a script/file, not more flags.
      for (const flag of arg.slice(1)) {
        if (flag === 'e' || flag === 'f') break
        if (flag === 'i') return 'sed file overwrite'
      }
    }
  }
  if (name === 'tee') {
    let options = true
    let append = false
    let writesFile = false
    for (const arg of args) {
      if (options && arg === '--') {
        options = false
        continue
      }
      if (options && arg === '--append') {
        append = true
        continue
      }
      if (options && arg?.startsWith('-') && arg !== '-') {
        if (/^-[ai]+$/.test(arg)) append ||= arg.includes('a')
        continue
      }
      // BSD/POSIX parsing stops at the first file. A later -a may itself be a filename,
      // so it cannot establish append mode (even GNU honors this with POSIXLY_CORRECT).
      options = false
      writesFile ||= arg !== '/dev/null'
    }
    if (writesFile && !append) return 'tee file overwrite'
  }
  if (name === 'dd' || name === 'gdd') {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === undefined || patterns[index]) return 'dd unresolved operands'
      const equal = arg.indexOf('=')
      if (equal < 0) return 'dd unresolved operands'
      const key = arg.slice(0, equal)
      const value = arg.slice(equal + 1)
      // Even count=0 truncates an explicit output. notrunc/append do not prove preservation.
      if (key === 'of') {
        if (value !== '/dev/null') return 'dd file or device overwrite'
      } else if (['if', 'ibs', 'obs', 'bs', 'cbs', 'count', 'skip', 'iseek'].includes(key)) {
        continue
      } else if (key === 'status') {
        if (!['none', 'noxfer', 'progress'].includes(value)) return 'dd unresolved operands'
      } else if (key === 'conv' || key === 'iflag') {
        const allowed =
          key === 'conv'
            ? [
                'ascii',
                'ebcdic',
                'ibm',
                'block',
                'unblock',
                'lcase',
                'ucase',
                'swab',
                'noerror',
                'sync',
                'notrunc'
              ]
            : [
                'fullblock',
                'count_bytes',
                'skip_bytes',
                'direct',
                'nocache',
                'nonblock',
                'noatime',
                'noctty',
                'nofollow',
                'directory'
              ]
        if (value.split(',').some((flag) => !allowed.includes(flag)))
          return 'dd unresolved operands'
      } else return 'dd output or unresolved operands'
    }
    // Fixed input/conversion operands copy to captured stdout; redirections are visited separately.
    return undefined
  }
  if (
    ['gzip', 'gunzip', 'zcat', 'bzip2', 'bunzip2', 'bzcat', 'xz', 'unxz', 'xzcat'].includes(name)
  ) {
    const family = /^(?:xz|unxz|xzcat)$/.test(name)
      ? 'xz'
      : /^(?:bzip2|bunzip2|bzcat)$/.test(name)
        ? 'bzip2'
        : 'gzip'
    const unresolved = `${name} unresolved compression options`
    let stdout = name.endsWith('cat')
    let keep = false
    let force = false
    let inspect = false
    let files = false
    let options = true
    let prefix = true
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === undefined || patterns[index]) {
        // These native compressors cannot cancel an already selected stdout destination.
        // After --, even an unknown path is data; without stdout it may still be removed.
        if (stdout || !options) {
          files = true
          prefix = false
          continue
        }
        return unresolved
      }
      if (options && arg === '--') {
        options = false
        continue
      }
      if (!options || arg === '-' || !arg.startsWith('-')) {
        files ||= arg !== '-'
        // bzip2 keeps parsing options after filenames, even with POSIXLY_CORRECT.
        // gzip/xz can stop there and delete inputs before treating trailing flags as files.
        if (family !== 'bzip2') prefix = false
        continue
      }
      if (arg.startsWith('--')) {
        const equal = arg.indexOf('=')
        const flag = equal < 0 ? arg : arg.slice(0, equal)
        if (family === 'xz' && ['--files', '--files0'].includes(flag)) {
          files = true
          continue // Optional file-list operands must be attached.
        }
        if (
          family === 'xz' &&
          [
            '--lzma1',
            '--lzma2',
            '--delta',
            '--x86',
            '--arm',
            '--armthumb',
            '--arm64',
            '--powerpc',
            '--ia64',
            '--sparc',
            '--riscv'
          ].includes(flag)
        )
          continue // Optional filter settings never consume the following input filename.
        const operand =
          (family === 'gzip' && flag === '--suffix') ||
          (family === 'xz' &&
            [
              '--suffix',
              '--format',
              '--check',
              '--threads',
              '--memlimit',
              '--memlimit-compress',
              '--memlimit-decompress',
              '--memlimit-mt-decompress',
              '--block-size',
              '--block-list'
            ].includes(flag))
        if (operand) {
          if (equal < 0 && (args[++index] === undefined || patterns[index])) return unresolved
          continue
        }
        if (equal >= 0) return unresolved
        if (['--stdout', '--to-stdout'].includes(flag)) stdout ||= prefix
        else if (flag === '--keep') keep ||= prefix
        else if (flag === '--force') force = true
        else if (flag === '--test' || (flag === '--list' && family !== 'bzip2')) inspect ||= prefix
        else if (['--compress', '--decompress', '--uncompress'].includes(flag)) {
          // xz modes are mutually exclusive; the last mode can cancel an earlier test/list.
          if (family === 'xz' || family === 'bzip2') inspect = false
        } else if (
          ![
            '--quiet',
            '--verbose',
            '--no-name',
            '--name',
            '--recursive',
            '--rsyncable',
            '--fast',
            '--best',
            '--small',
            '--extreme',
            '--single-stream',
            '--robot',
            '--ignore-check',
            '--no-adjust',
            '--no-warn'
          ].includes(flag)
        )
          return unresolved
      } else {
        for (let offset = 1; offset < arg.length; offset++) {
          const flag = arg[offset]
          if ((flag === 'S' && family !== 'bzip2') || (family === 'xz' && 'FMT'.includes(flag))) {
            if (offset === arg.length - 1 && (args[++index] === undefined || patterns[index]))
              return unresolved
            break // An attached suffix/format/number is data, not more options.
          }
          if (flag === 'c') stdout ||= prefix
          else if (flag === 'k') keep ||= prefix
          else if (flag === 'f') force = true
          else if (flag === 't' || (flag === 'l' && family !== 'bzip2')) inspect ||= prefix
          else if ('dz'.includes(flag)) {
            if (family !== 'gzip') inspect = false
          } else if (!'123456789qvnrNse'.includes(flag)) return unresolved
        }
      }
    }
    if (inspect || stdout || !files) return undefined
    if (force) return `${name} compressed file overwrite`
    return keep ? undefined : `${name} source file removal`
  }
  if (name === 'rsync') {
    const unresolved = 'rsync unresolved options'
    let preview = false
    let listing = false
    let mutation = false
    let options = true
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === undefined || patterns[index]) return unresolved
      if (options && arg === '--') {
        options = false
        continue
      }
      if (!options || arg === '-' || !arg.startsWith('-')) continue
      if (arg.startsWith('--')) {
        const equal = arg.indexOf('=')
        const flag = equal < 0 ? arg : arg.slice(0, equal)
        // A trial transfer can still execute a custom transport or write a log/batch file.
        if (
          [
            '--rsh',
            '--rsync-path',
            '--remote-option',
            '--daemon',
            '--server',
            '--config',
            '--log-file',
            '--write-batch',
            '--only-write-batch'
          ].includes(flag)
        )
          return 'rsync execution or auxiliary file writes'
        if (
          [
            '--exclude',
            '--exclude-from',
            '--include',
            '--include-from',
            '--filter',
            '--files-from',
            '--out-format',
            '--log-file-format',
            '--suffix',
            '--backup-dir',
            '--temp-dir',
            '--partial-dir',
            '--compare-dest',
            '--copy-dest',
            '--link-dest',
            '--max-delete',
            '--max-size',
            '--min-size',
            '--bwlimit',
            '--timeout',
            '--contimeout',
            '--block-size',
            '--compress-level',
            '--chmod',
            '--usermap',
            '--groupmap',
            '--chown',
            '--skip-compress',
            '--info',
            '--debug',
            '--checksum-choice',
            '--checksum-seed',
            '--modify-window',
            '--compress-choice',
            '--port',
            '--address',
            '--password-file',
            '--read-batch'
          ].includes(flag)
        ) {
          if (equal < 0 && (args[++index] === undefined || patterns[index])) return unresolved
          if (flag === '--read-batch') mutation = true
          continue
        }
        if (equal >= 0) return unresolved
        if (flag === '--dry-run') preview = true
        else if (flag === '--no-dry-run' || flag === '--no-n') preview = false
        else if (flag === '--list-only') listing = true
        else if (flag === '--no-list-only') listing = false
        else if (
          [
            '--delete',
            '--del',
            '--delete-before',
            '--delete-after',
            '--delete-during',
            '--delete-delay',
            '--delete-excluded',
            '--delete-missing-args',
            '--remove-source-files',
            '--remove-sent-files',
            '--force',
            '--inplace',
            '--append',
            '--append-verify'
          ].includes(flag)
        )
          mutation = true
        else if (
          ![
            '--archive',
            '--recursive',
            '--relative',
            '--verbose',
            '--quiet',
            '--checksum',
            '--update',
            '--backup',
            '--existing',
            '--ignore-existing',
            '--ignore-times',
            '--size-only',
            '--ignore-errors',
            '--ignore-missing-args',
            '--list-only',
            '--dirs',
            '--links',
            '--copy-links',
            '--copy-dirlinks',
            '--keep-dirlinks',
            '--safe-links',
            '--hard-links',
            '--perms',
            '--executability',
            '--acls',
            '--xattrs',
            '--owner',
            '--group',
            '--devices',
            '--specials',
            '--times',
            '--omit-dir-times',
            '--omit-link-times',
            '--sparse',
            '--whole-file',
            '--one-file-system',
            '--compress',
            '--numeric-ids',
            '--stats',
            '--progress',
            '--itemize-changes',
            '--human-readable',
            '--partial',
            '--delay-updates',
            '--prune-empty-dirs',
            '--from0',
            '--protect-args',
            '--secluded-args',
            '--cvs-exclude',
            '--no-recursive',
            '--no-r',
            '--no-links',
            '--no-l',
            '--no-perms',
            '--no-p',
            '--no-owner',
            '--no-o',
            '--no-group',
            '--no-g',
            '--no-times',
            '--no-t',
            '--no-compress',
            '--no-z',
            '--no-implied-dirs'
          ].includes(flag)
        )
          return unresolved
      } else {
        for (let offset = 1; offset < arg.length; offset++) {
          const flag = arg[offset]
          if (flag === 'e' || flag === 'M') return 'rsync custom command execution'
          if (flag === 'f' || flag === 'B') {
            if (offset === arg.length - 1 && (args[++index] === undefined || patterns[index]))
              return unresolved
            break
          }
          if (flag === 'n') preview = true
          else if (!'avqcrRbulLKkHptgoDAXOSWxdzCiPhsFEUVNI'.includes(flag)) return unresolved
        }
      }
    }
    return mutation && !preview && !listing
      ? 'rsync file deletion or in-place overwrite'
      : undefined
  }
  if (name === 'tar' || name === 'gtar' || name === 'bsdtar') {
    const unresolved = 'tar unresolved options'
    let mode: string | undefined
    let stdout = false
    let options = true
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      if (arg === undefined || patterns[index]) return unresolved
      if (options && arg === '--') {
        options = false
        continue
      }
      if (!options) continue
      if (arg.startsWith('--')) {
        const equal = arg.indexOf('=')
        const flag = equal < 0 ? arg : arg.slice(0, equal)
        if (flag === '--checkpoint') {
          // The optional frequency must be attached; it never consumes the next action.
          if (equal >= 0 && !/^\.?\d+$/.test(arg.slice(equal + 1))) return unresolved
          continue
        }
        if (flag === '--checkpoint-action') {
          const action = equal < 0 ? args[++index] : arg.slice(equal + 1)
          if (
            action === undefined ||
            patterns[index] ||
            !/^(?:echo(?:=[\s\S]*)?|dot|\.|totals|sleep=\d+|wait=(?:SIG)?(?:HUP|QUIT|INT|USR1|USR2))$/.test(
              action
            )
          )
            return 'tar command execution or unresolved checkpoint action'
          continue
        }
        if (
          [
            '--remove-files',
            '--unlink-first',
            '--recursive-unlink',
            '--delete',
            '--concatenate',
            '--append',
            '--update',
            '--overwrite',
            '--overwrite-dir'
          ].includes(flag)
        )
          return 'tar file removal or overwrite'
        if (
          [
            '--to-command',
            '--use-compress-program',
            '--rsh-command',
            '--info-script',
            '--new-volume-script',
            '--listed-incremental'
          ].includes(flag)
        )
          return 'tar command execution or auxiliary file writes'
        if (
          [
            '--file',
            '--directory',
            '--files-from',
            '--exclude',
            '--exclude-from',
            '--format',
            '--transform',
            '--xform',
            '--strip-components',
            '--blocking-factor',
            '--record-size',
            '--label',
            '--newer',
            '--newer-mtime',
            '--starting-file',
            '--mtime',
            '--owner',
            '--group',
            '--mode',
            '--warning',
            '--sort'
          ].includes(flag)
        ) {
          if (equal < 0 && (args[++index] === undefined || patterns[index])) return unresolved
          continue
        }
        if (equal >= 0) return unresolved
        if (['--create', '--list', '--extract', '--get', '--diff', '--compare'].includes(flag)) {
          const selected =
            flag === '--create'
              ? 'c'
              : flag === '--list'
                ? 't'
                : ['--extract', '--get'].includes(flag)
                  ? 'x'
                  : 'd'
          if (mode && mode !== selected) return unresolved
          mode = selected
        } else if (flag === '--to-stdout') stdout = true
        else if (
          ![
            '--verbose',
            '--gzip',
            '--gunzip',
            '--ungzip',
            '--bzip2',
            '--xz',
            '--lzma',
            '--zstd',
            '--auto-compress',
            '--no-recursion',
            '--recursion',
            '--null',
            '--verbatim-files-from',
            '--no-verbatim-files-from',
            '--anchored',
            '--no-anchored',
            '--wildcards',
            '--no-wildcards',
            '--wildcards-match-slash',
            '--no-wildcards-match-slash',
            '--ignore-case',
            '--no-ignore-case',
            '--keep-old-files',
            '--skip-old-files',
            '--keep-newer-files',
            '--no-same-owner',
            '--no-same-permissions',
            '--numeric-owner',
            '--sparse',
            '--totals',
            '--touch'
          ].includes(flag)
        )
          return unresolved
      } else {
        // Traditional tar bundles (cf archive file) consume operands from following argv slots.
        const traditional = index === 0 && !arg.startsWith('-')
        if (!traditional && (!arg.startsWith('-') || arg === '-')) continue
        const flags = traditional ? arg : arg.slice(1)
        for (let offset = 0; offset < flags.length; offset++) {
          const flag = flags[offset]
          if ('ruA'.includes(flag)) return 'tar archive overwrite'
          if ('IFg'.includes(flag)) return 'tar command execution or auxiliary file writes'
          if ('fCTXbKLN'.includes(flag)) {
            if (traditional || offset === flags.length - 1) {
              if (args[++index] === undefined || patterns[index]) return unresolved
            }
            if (!traditional) break
          } else if ('ctxd'.includes(flag)) {
            if (mode && mode !== flag) return unresolved
            mode = flag
          } else if (flag === 'O') stdout = true
          else if (!'vzjJaZhpPsmokSw'.includes(flag)) return unresolved
        }
      }
    }
    return mode === 'x' && !stdout ? 'tar extraction file overwrite' : undefined
  }
  if (name === 'mv') return 'mv source removal or destination overwrite'
  if (name === 'cp') {
    const risk = 'cp destination overwrite or unresolved options'
    let noClobber = false
    let operands = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      // After --, expansions are paths; before it they can introduce overriding options.
      if (arg === undefined || patterns[index]) return risk
      if (arg === '--') return noClobber ? undefined : risk
      if (arg.startsWith('-') && arg !== '-') {
        // Require protection before the first operand on both BSD and GNU parsers.
        if (operands) return risk
        if (arg === '--no-clobber') noClobber = true
        else if (['--recursive', '--verbose'].includes(arg)) continue
        else if (/^-[nRrv]+$/.test(arg)) noClobber ||= arg.includes('n')
        else return risk
      } else operands = true
    }
    return noClobber ? undefined : risk
  }
  if (['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mkfs'].includes(name)) return name
  if (name === 'find') {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      const execution = 'find mutation or command execution'
      // An unquoted expansion can introduce additional predicates or move an action boundary.
      if (arg === undefined || patterns[index]) return execution
      if (arg === '-delete') return execution
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(arg)) {
        const start = index + 1
        let end = start
        while (
          end < args.length &&
          args[end] !== ';' &&
          !(arg.startsWith('-exec') && args[end] === '+' && args[end - 1] === '{}')
        )
          end++
        if (end === args.length || end === start) return execution
        // Substituted paths are data, not fixed executable/option evidence, including embedded {}.
        const child = args
          .slice(start, end)
          .map((value) => (value?.includes('{}') ? undefined : value))
        if (
          commandRisk(
            patterns[start] ? undefined : child[0],
            child.slice(1),
            patterns.slice(start + 1, end),
            depth + 1,
            true
          ) !== undefined
        )
          return execution
        index = end
        continue
      }
      if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg)) return 'find file overwrite'
      // These primaries consume one literal/pattern operand. An operand named "-delete"
      // is not an action; the next primary must still be checked. Substitutions are visited.
      if (
        [
          '-name',
          '-iname',
          '-path',
          '-ipath',
          '-wholename',
          '-iwholename',
          '-regex',
          '-iregex',
          '-lname',
          '-ilname',
          '-printf',
          '-regextype',
          '-newer',
          '-anewer',
          '-cnewer',
          '-samefile',
          '-f'
        ].includes(arg)
      ) {
        if (patterns[index + 1]) return execution
        index++
      }
    }
  }
  if (name === 'git') {
    // Match the subcommand, not a log search term or a path named "clean" / "restore".
    let index = 0
    while (args[index]?.startsWith('-')) {
      const option = args[index++]
      if (
        [
          '-C',
          '-c',
          '--git-dir',
          '--work-tree',
          '--namespace',
          '--config-env',
          '--super-prefix'
        ].includes(option!)
      )
        index++
    }
    const subcommand = args[index]
    const options = args.slice(index + 1)
    const separator = options.indexOf('--')
    const flags = separator < 0 ? options : options.slice(0, separator)
    if (subcommand === 'clean') {
      let dryRun = false
      for (let index = 0; index < flags.length; index++) {
        const arg = flags[index]
        // An expansion can introduce --no-dry-run or -- and change subsequent option meaning.
        if (arg === undefined) return 'git working-tree mutation'
        if (arg === '--dry-run') dryRun = true
        else if (arg === '--no-dry-run') dryRun = false
        else if (arg === '--exclude' || arg === '-e') {
          if (flags[++index] === undefined) return 'git working-tree mutation'
        } else if (arg.startsWith('--exclude=')) continue
        else if (arg.startsWith('--')) {
          if (
            ![
              '--force',
              '--no-force',
              '--interactive',
              '--no-interactive',
              '--quiet',
              '--no-quiet'
            ].includes(arg)
          )
            return 'git working-tree mutation'
        } else if (arg.startsWith('-')) {
          for (let offset = 1; offset < arg.length; offset++) {
            const flag = arg[offset]
            if (flag === 'e') {
              if (offset === arg.length - 1 && flags[++index] === undefined)
                return 'git working-tree mutation'
              break
            }
            if (flag === 'n') dryRun = true
            else if (!'dfiqxX'.includes(flag)) return 'git working-tree mutation'
          }
        }
      }
      return dryRun ? undefined : 'git working-tree mutation'
    }
    if (subcommand === 'restore') {
      let staged = false
      let worktree = false
      for (let index = 0; index < flags.length; index++) {
        const arg = flags[index]
        if (arg === undefined) return 'git working-tree mutation'
        if (arg === '--staged') staged = true
        else if (arg === '--no-staged') staged = false
        else if (arg === '--worktree') worktree = true
        else if (arg === '--no-worktree') worktree = false
        else if (
          [
            '--source',
            '--pathspec-from-file',
            '--conflict',
            '--unified',
            '--inter-hunk-context'
          ].includes(arg)
        ) {
          // Option operands named --staged are data, not destination evidence.
          if (flags[++index] === undefined) return 'git working-tree mutation'
        } else if (
          /^--(?:source|pathspec-from-file|conflict|unified|inter-hunk-context)=/.test(arg)
        )
          continue
        else if (arg.startsWith('--')) {
          if (
            ![
              '--quiet',
              '--progress',
              '--no-progress',
              '--patch',
              '--ours',
              '--theirs',
              '--merge',
              '--ignore-unmerged',
              '--ignore-skip-worktree-bits',
              '--recurse-submodules',
              '--no-recurse-submodules',
              '--overlay',
              '--no-overlay',
              '--pathspec-file-nul'
            ].includes(arg)
          )
            return 'git working-tree mutation'
        } else if (arg.startsWith('-')) {
          for (let offset = 1; offset < arg.length; offset++) {
            const flag = arg[offset]
            if (flag === 'S') staged = true
            else if (flag === 'W') worktree = true
            else if (flag === 's' || flag === 'U') {
              if (offset === arg.length - 1 && flags[++index] === undefined)
                return 'git working-tree mutation'
              break
            } else if (!'qpm'.includes(flag)) return 'git working-tree mutation'
          }
        }
      }
      return staged && !worktree ? undefined : 'git working-tree mutation'
    }
    if (subcommand === 'branch') {
      let deletion = false
      let force = false
      for (let index = 0; index < flags.length; index++) {
        const arg = flags[index]
        if (arg === undefined) return 'dynamic git command'
        if (arg === '--delete' || arg === '--delete-merged' || arg.startsWith('--delete-merged='))
          deletion = true
        else if (arg === '--no-delete') deletion = false
        else if (['--force', '--move', '--copy'].includes(arg)) force ||= arg === '--force'
        else if (arg === '--no-force') force = false
        else if (['--format', '--sort', '--points-at', '--set-upstream-to'].includes(arg)) {
          if (flags[++index] === undefined) return 'dynamic git command'
        } else if (['--contains', '--no-contains', '--merged', '--no-merged'].includes(arg)) {
          if (flags[index + 1] !== undefined && !flags[index + 1]!.startsWith('-')) index++
        } else if (
          /^--(?:format|sort|points-at|set-upstream-to|contains|no-contains|merged|no-merged|abbrev|color|column|track)=/.test(
            arg
          )
        )
          continue
        else if (arg.startsWith('--')) {
          if (
            ![
              '--list',
              '--show-current',
              '--all',
              '--remotes',
              '--verbose',
              '--quiet',
              '--color',
              '--no-color',
              '--column',
              '--no-column',
              '--abbrev',
              '--no-abbrev',
              '--track',
              '--no-track',
              '--create-reflog',
              '--no-create-reflog',
              '--unset-upstream',
              '--recurse-submodules'
            ].includes(arg)
          )
            return 'dynamic git command'
        } else if (arg.startsWith('-')) {
          for (let offset = 1; offset < arg.length; offset++) {
            const flag = arg[offset]
            if ('dD'.includes(flag)) deletion = true
            else if ('fMC'.includes(flag)) force = true
            else if (flag === 'u') {
              if (offset === arg.length - 1 && flags[++index] === undefined)
                return 'dynamic git command'
              break
            } else if (!'avqrlimct'.includes(flag)) return 'dynamic git command'
          }
        }
      }
      if (deletion || force) return 'git reference deletion or overwrite'
    }
    if (subcommand === 'stash') {
      if (['drop', 'clear'].includes(options[0] ?? '')) return 'git stash deletion'
      if (options.length && options[0] === undefined) return 'dynamic git command'
    }
    if (subcommand === 'checkout' || subcommand === 'switch') {
      let force = false
      for (let index = 0; index < flags.length; index++) {
        const arg = flags[index]
        if (arg === '--force' || arg === '--discard-changes') force = true
        else if (arg === '--no-force' || arg === '--no-discard-changes') force = false
        else if (['--create', '--orphan', '--conflict'].includes(arg ?? '')) {
          if (arg === '--orphan' && subcommand === 'switch') return 'git working-tree mutation'
          index++
        } else if (arg?.startsWith('--orphan=') && subcommand === 'switch')
          return 'git working-tree mutation'
        else if (arg === '--force-create' || arg?.startsWith('--force-create='))
          return 'git working-tree mutation'
        else if (arg?.startsWith('-') && !arg.startsWith('--')) {
          for (let offset = 1; offset < arg.length; offset++) {
            const flag = arg[offset]
            if (flag === 'f') force = true
            if ((subcommand === 'checkout' ? 'bB' : 'cC').includes(flag)) {
              if (flag === flag.toUpperCase()) return 'git working-tree mutation'
              if (offset === arg.length - 1) index++
              break
            }
          }
        }
      }
      if (force) return 'git working-tree mutation'
    }
    if (
      (subcommand === 'reset' && flags.includes('--hard')) ||
      (subcommand === 'checkout' && separator >= 0)
    )
      return 'git working-tree mutation'
    if (index < args.length && !subcommand) return 'dynamic git command'
  }
  if (name === 'xargs' || name === 'gxargs') {
    const unresolved = 'xargs command execution'
    let index = 0
    while (args[index]?.startsWith('-')) {
      if (patterns[index]) return unresolved
      const option = args[index++]!
      if (option === '--') break
      if (option === '-') return unresolved
      if (option.startsWith('--')) {
        const equal = option.indexOf('=')
        const flag = equal < 0 ? option : option.slice(0, equal)
        if (
          [
            '--null',
            '--no-run-if-empty',
            '--verbose',
            '--exit',
            '--interactive',
            '--open-tty'
          ].includes(flag)
        ) {
          if (equal >= 0) return unresolved
          continue
        }
        // These GNU long operands are optional and must be attached, never the next token.
        if (['--replace', '--eof', '--max-lines'].includes(flag)) {
          if (flag === '--max-lines' && equal >= 0 && !/^\d+$/.test(option.slice(equal + 1)))
            return unresolved
          continue
        }
        if (
          !['--max-args', '--max-procs', '--max-chars', '--arg-file', '--delimiter'].includes(flag)
        )
          return unresolved
        if (equal < 0 && (index >= args.length || patterns[index])) return unresolved
        const value = equal < 0 ? args[index++] : option.slice(equal + 1)
        if (flag.startsWith('--max-') && value !== undefined && !/^\d+$/.test(value))
          return unresolved
      } else {
        for (let offset = 1; offset < option.length; offset++) {
          const flag = option[offset]
          if ('0oprtx'.includes(flag)) continue
          if (!'EIJLnPsRSad'.includes(flag)) return unresolved
          const attached = offset < option.length - 1
          if (!attached && (index >= args.length || patterns[index])) return unresolved
          const value = attached ? option.slice(offset + 1) : args[index++]
          if ('LnPsRS'.includes(flag) && value !== undefined && !/^-?\d+$/.test(value))
            return unresolved
          break
        }
      }
    }
    // No utility means echo. Otherwise stdin may introduce arbitrary child options/arguments:
    // only fixed native readers/output tools qualify, never wrappers, scripts or interpreters.
    if (index === args.length) return undefined
    const child = args[index]
    if (!child || patterns[index] || child.includes('\\')) return unresolved
    return [
      'cat',
      'head',
      'tail',
      'wc',
      'echo',
      'printf',
      'ls',
      'stat',
      'cksum',
      'du',
      'grep'
    ].includes(child.split('/').at(-1)!)
      ? undefined
      : unresolved
  }
  if (['eval', 'source', '.', 'exec', 'sudo', 'doas', 'alias', 'busybox'].includes(name))
    return `${name} command execution`
  if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(name)) {
    const execution = `${name} nested execution`
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      // A word such as -W* can expand to -W and consume the subsequent query flag.
      // Keep this uncertainty local to option queries; known Git preview prefixes stay data.
      if (patterns[index]) return execution
      if (!arg || arg === '--' || arg === '-' || !arg.startsWith('-')) return execution
      if (['--help', '--help-env', '--help-xoptions', '--help-all', '--version'].includes(arg))
        return undefined
      if (arg === '--check-hash-based-pycs') {
        if (args[++index] === undefined) return execution
        continue
      }
      if (arg.startsWith('--')) return execution
      for (let offset = 1; offset < arg.length; offset++) {
        const flag = arg[offset]
        if ('h?V'.includes(flag)) return undefined
        // -c/-m end interpreter options; later --help belongs to the executed program.
        if (flag === 'c' || flag === 'm') return execution
        // -W/-X consume the rest of their cluster or the next argument, even if it is --help.
        if (flag === 'W' || flag === 'X') {
          if (offset === arg.length - 1 && args[++index] === undefined) return execution
          break
        }
        if (!'bBdEiIOPqRsSuvx'.includes(flag)) return execution
      }
    }
    return execution
  }
  if (
    ['sh', 'bash', 'dash', 'zsh', 'ksh', 'Rscript', 'node', 'pwsh', 'powershell', 'cmd'].includes(
      name
    )
  )
    return `${name} nested execution`
  if (['nice', 'gnice', 'nohup', 'gnohup', 'timeout', 'gtimeout'].includes(name)) {
    // Windows timeout pauses the console; it does not implement the GNU wrapper grammar.
    if (name === 'timeout' && process.platform === 'win32') return 'unresolved timeout wrapper'
    const wrapper = name.startsWith('g') ? name.slice(1) : name
    const unresolved = `unresolved ${wrapper} wrapper`
    let index = 0
    // Each wrapper stops parsing options at its first operand. Child flags/data belong
    // to the child, including words like "rm" and --help after the child command.
    while (args[index]?.startsWith('-')) {
      if (patterns[index]) return unresolved
      const option = args[index++]!
      if (option === '--') break
      if (wrapper === 'nice') {
        let adjustment: string | undefined
        if (option === '-n' || option === '--adjustment') {
          if (patterns[index]) return unresolved
          adjustment = args[index++]
        } else if (option.startsWith('--adjustment=')) adjustment = option.slice(13)
        else if (option.startsWith('-n')) adjustment = option.slice(2)
        // Documented obsolete -N, --N and -+N forms consume no additional operand.
        else if (/^-[+-]?\d+$/.test(option)) adjustment = option.slice(1)
        if (adjustment === undefined || !/^[+-]?\d+$/.test(adjustment)) return unresolved
      } else if (wrapper === 'timeout') {
        const duration = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[smhd]?$/i
        const signal = /^(?:\d+|(?:SIG)?[A-Z][A-Z0-9]*(?:[+-]\d+)?)$/
        if (['--foreground', '--preserve-status', '--verbose'].includes(option)) continue
        if (option.startsWith('--')) {
          const equal = option.indexOf('=')
          const flag = equal < 0 ? option : option.slice(0, equal)
          if (flag !== '--kill-after' && flag !== '--signal') return unresolved
          if (equal < 0 && patterns[index]) return unresolved
          const value = equal < 0 ? args[index++] : option.slice(equal + 1)
          if (value === undefined || !(flag === '--kill-after' ? duration : signal).test(value))
            return unresolved
        } else {
          for (let offset = 1; offset < option.length; offset++) {
            const flag = option[offset]
            if ('fpv'.includes(flag)) continue
            if (flag !== 'k' && flag !== 's') return unresolved
            const attached = offset < option.length - 1
            if (!attached && patterns[index]) return unresolved
            const value = attached ? option.slice(offset + 1) : args[index++]
            if (value === undefined || !(flag === 'k' ? duration : signal).test(value))
              return unresolved
            break
          }
        }
      } else return unresolved
    }
    if (wrapper === 'timeout') {
      const value = args[index++]
      if (
        patterns[index - 1] ||
        value === undefined ||
        !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[smhd]?$/i.test(value)
      )
        return unresolved
    }
    // Bare nice only queries niceness. Other missing payloads remain uncertain.
    if (index === args.length) return wrapper === 'nice' ? undefined : unresolved
    return commandRisk(
      patterns[index] ? undefined : args[index],
      args.slice(index + 1),
      patterns.slice(index + 1),
      depth + 1,
      nested
    )
  }
  return undefined
}

const commandOptionOverrideRisk = (key: string, value: string | undefined): string | undefined => {
  const command =
    key === 'TAR_OPTIONS'
      ? 'tar'
      : key === 'GZIP'
        ? 'gzip'
        : ['BZIP2', 'BZIP'].includes(key)
          ? 'bzip2'
          : ['XZ_OPT', 'XZ_DEFAULTS'].includes(key)
            ? 'xz'
            : undefined
  if (!command && key !== 'RSYNC_RSH') return undefined
  if (value === '') return undefined
  if (value === undefined || /["'\\`]/.test(value)) return 'unresolved command default options'
  if (key === 'RSYNC_RSH') return 'custom synchronization transport'
  // Only simple literal option words qualify; native environment quoting is not Bash quoting.
  // Use a preservation baseline to distinguish force/hooks from ordinary tuning defaults.
  return commandRisk(command, [
    ...value.trim().split(/\s+/).filter(Boolean),
    ...(command === 'tar' ? ['-cf', 'output.tar', 'input'] : ['-k', 'input'])
  ])
}

/**
 * Detect visible destructive effects and explicit dynamic execution. Reuses the Notebook parsers;
 * incomplete provenance and ordinary unknown scientific calls are not themselves deletion evidence.
 * Libraries/native extensions can still hide effects: the process sandbox remains the boundary.
 */
export async function analyzeNotebookCodeRisk(
  language: Language,
  source: string,
  context?: NotebookSourceFileAccessContext,
  previousSources: readonly (string | Readonly<{ script: string; incomplete: boolean }>)[] = [],
  signal?: AbortSignal
): Promise<NotebookCodeRisk[]> {
  const bindings: Bindings = new Map(
    context?.pythonBindings?.map(({ name, qualifiedName }) => [name, qualifiedName])
  )
  const functions = new Map<string, FunctionEvidence>()
  let objectMethodDepth = 0
  let objectRevision = 0
  let remainingWork = 100_000
  const shellScripts = new Map<string, boolean>()
  // Cache only pure literal Bash verdicts within this analysis, never execution permission.
  const shellVerdicts = new Map<string, boolean>()
  let verdictCharacters = 0
  const checkpoint = async (): Promise<void> => {
    signal?.throwIfAborted()
    await yieldAnalysis(undefined, { signal })
  }
  const spendWork = (): void => {
    if (--remainingWork < 0) throw new Error('Notebook risk analysis exceeds work limit')
  }
  const snapshot = (): string => {
    if (bindings.size > 4096 || functions.size > 2048)
      throw new Error('Notebook risk replay state exceeds analysis limit')
    const state: ReplaySnapshot = {
      bindings: [...bindings],
      functions: [...functions].map(([key, value]) => [
        key,
        { ...value, members: [...value.members] }
      ]),
      objectRevision
    }
    const serialized = JSON.stringify(state)
    if (serialized.length > MAX_REPLAY_STATE_CHARACTERS)
      throw new Error('Notebook risk replay state exceeds analysis limit')
    return serialized
  }
  const analyze = (root: Node, incomplete = false): RiskEvidence[] => {
    bindings.set(CWD_BINDING, INITIAL_CWD)
    bindings.set(FILE_SCOPE_BINDING, 'root')
    // Captured fresh handles become existing-file evidence on later Runs, including summaries
    // restored from the source cache. Handles opened inside the invoked function remain fresh.
    for (const fn of functions.values()) for (const effect of fn.effects) delete effect.freshHandle
    for (const [name, value] of bindings) {
      bindings.set(
        name,
        mergeTargets(
          possibleTargets(value).map((target) => {
            const file = target ? pythonFileHandle(target) : undefined
            return file
              ? `@python-file:${JSON.stringify({ ...file.handle, prior: true })};${file.member}`
              : target
          })
        )
      )
    }
    const risks: RiskEvidence[] = []
    const declarations = new Map<number, string>()
    const methodOwners = new Map<number, string>()
    const evaluatedNodeKeys = new Set<string>()
    const rememberVectors = (node: Node, vectors: PythonArgumentVector[] | undefined): void => {
      if (!vectors) return
      const key = `@argv:${node.id}`
      evaluatedNodeKeys.add(key)
      bindings.set(key, JSON.stringify(vectors))
    }
    const rememberTruth = (
      node: Node,
      eligible: boolean,
      truth: boolean | undefined,
      result?: boolean
    ): void => {
      const key = `@truth:${node.id}`
      evaluatedNodeKeys.add(key)
      bindings.set(key, JSON.stringify({ eligible, truth, result }))
    }
    const rememberProcessValue = (node: Node, value: PythonProcessValue): void => {
      if (value === undefined) return
      const key = `@path:${node.id}`
      evaluatedNodeKeys.add(key)
      bindings.set(key, JSON.stringify(value))
      if (typeof value === 'string' || !value.classes?.length) {
        const nodeKey = `@node:${node.id}`
        evaluatedNodeKeys.add(nodeKey)
        bindings.set(nodeKey, '@noncallable')
        rememberTruth(node, true, (typeof value === 'string' ? value : value.text).length > 0)
      }
    }
    const rememberSelectedVectors = (
      node: Node,
      vectors: PythonArgumentVector[] | undefined
    ): void => {
      if (!vectors) return
      rememberVectors(node, vectors)
      const nodeKey = `@node:${node.id}`
      evaluatedNodeKeys.add(nodeKey)
      bindings.set(nodeKey, '@noncallable')
      const truths = vectors.map((vector) => vector.values.length > 0)
      rememberTruth(
        node,
        true,
        truths.every((truth) => truth === truths[0]) ? truths[0] : undefined
      )
    }
    const exceptionPrefixes: Bindings[] = []
    let functionRevision = 0
    const functionModuleWrites: Set<string>[] = []
    const invalidatePathClass = (target: string | undefined): void => {
      for (const kind of possibleTargets(target)) {
        if (!/^pathlib\.(?:Pure)?(?:Posix|Windows)?Path$/.test(kind ?? '')) continue
        const key = `@path-class:${kind}`
        bindings.set(key, '<modified>')
        functionModuleWrites.at(-1)?.add(key)
      }
    }
    const noteModuleWrite = (member: string): void => {
      functionModuleWrites.at(-1)?.add(member)
      invalidatePathClass(member.slice(0, member.lastIndexOf('.')))
    }
    const restore = (state: Bindings): void => {
      bindings.clear()
      for (const [key, value] of state) bindings.set(key, value)
    }
    const capturePrefixes = (): void => {
      for (const prefix of exceptionPrefixes) {
        const merged = joinedBindings(prefix, bindings)
        prefix.clear()
        for (const [key, value] of merged) {
          spendWork()
          prefix.set(key, value)
        }
      }
    }
    const visit = (node: Node, output: RiskEvidence[]): void => {
      spendWork()
      // String contents are leaves; interpolations may contain real calls (Python f-strings,
      // JavaScript templates and Bash substitutions), so traverse their syntax rather than text.
      if (node.type === 'comment') return
      if (language === 'python' && node.type === 'subscript') {
        // A loop can evaluate this lookup again after a native factory was replaced.
        bindings.delete(`@path:${node.id}`)
        bindings.delete(`@node:${node.id}`)
        bindings.delete(`@truth:${node.id}`)
        bindings.delete(`@argv:${node.id}`)
      }
      if (['block', 'statement_block', 'braced_expression'].includes(node.type)) {
        const scopedNames =
          language === 'repl'
            ? node.namedChildren
                .filter((child) => child.type === 'lexical_declaration')
                .flatMap((declaration) =>
                  declaration.namedChildren.flatMap((child) => [
                    ...bindingUpdates(fieldChild(child, 'name'), null, bindings, language).keys()
                  ])
                )
            : []
        const before = new Map(bindings)
        const prefixes = exceptionPrefixes.map((prefix) => ({ prefix, before: new Map(prefix) }))
        for (const child of node.namedChildren) {
          visit(child, output)
          if (blockControl(child)) break
        }
        for (const name of scopedNames) {
          if (before.has(name)) bindings.set(name, before.get(name)!)
          else bindings.delete(name)
          for (const state of prefixes) {
            if (state.before.has(name)) state.prefix.set(name, state.before.get(name)!)
            else state.prefix.delete(name)
          }
        }
        capturePrefixes()
        return
      }
      const selection = language === 'python' ? pythonSelection(node) : undefined
      if (selection) {
        bindings.delete(`@argv:${node.id}`)
        const [condition, consequence, alternative] = selection
        const inertCondition = identity(condition, bindings) === '@noncallable'
        visit(condition, output)
        const truth = pythonLiteralTruth(condition, 0, bindings)
        const eligible = inertCondition || truth !== undefined
        const results: (boolean | undefined)[] = []
        const inspect = (value: Node): PythonArgumentVector[] | undefined => {
          // and/or may return the condition already evaluated above.
          if (value.id !== condition.id) visit(value, output)
          results.push(pythonLiteralTruth(value, 0, bindings))
          return pythonArgumentVectors(value, bindings)
        }
        let vectors: PythonArgumentVector[] | undefined
        if (truth !== undefined) vectors = inspect(truth ? consequence : alternative)
        else {
          const before = new Map(bindings)
          const left = inspect(consequence)
          const after = new Map(bindings)
          restore(before)
          const right = inspect(alternative)
          restore(joinedBindings(after, bindings))
          vectors = left && right ? pythonVectorChoices([...left, ...right]) : undefined
        }
        if (eligible) rememberVectors(node, vectors)
        // Later arguments can rebind the condition; retain its proof at evaluation time.
        rememberTruth(
          node,
          eligible,
          truth,
          results.every((result) => result !== undefined && result === results[0])
            ? results[0]
            : undefined
        )
        // A walrus update in a branch must not retroactively certify the earlier truth test.
        if (!eligible && identity(condition, bindings) === '@noncallable')
          output.push({
            operation: 'dynamic truth test',
            source: condition.text,
            line: condition.startPosition.row + 1
          })
        capturePrefixes()
        return
      }
      if (language === 'python' && node.type === 'class_definition') {
        // A user class named dict/bool/etc. is not the builtin with that spelling.
        // Class bases/body execute before the name is replaced; earlier aliases stay native.
        for (const child of node.namedChildren) visit(child, output)
        const name = fieldChild(node, 'name')?.text
        if (name) {
          bindings.set(name, `@class:${name}`)
          let scope = node.parent
          const scopes = ['module', 'function_definition', 'class_definition', 'lambda']
          while (scope && !scopes.includes(scope.type)) scope = scope.parent
          const declaresGlobal = (child: Node, depth = 0): boolean => {
            spendWork()
            if (depth >= 64) return true
            if (scopes.includes(child.type)) return false
            return child.type === 'global_statement'
              ? child.namedChildren.some((entry) => entry.text === name)
              : child.namedChildren.some((entry) => declaresGlobal(entry, depth + 1))
          }
          if (
            functionModuleWrites.length &&
            scope?.namedChildren.some((child) => declaresGlobal(child))
          )
            noteModuleWrite(name)
          capturePrefixes()
        }
        return
      }
      if (language !== 'bash' && node.type === 'if_statement') {
        const alternatives = fieldChildren(node, 'alternative')
        const clauses = [node, ...alternatives]
        const branch = (index: number): void => {
          const clause = clauses[index]
          if (!clause) return
          if (index > 0 && clause.type !== 'elif_clause') {
            // Python/JS else clauses wrap their suite; R stores the expression itself.
            visit(clause, output)
            return
          }
          const condition = fieldChild(clause, 'condition')
          const consequence = fieldChild(clause, 'consequence')
          if (condition) visit(condition, output)
          const truth = booleanCondition(condition)
          if (truth === false) {
            branch(index + 1)
            return
          }
          if (truth === true) {
            if (consequence) visit(consequence, output)
            return
          }
          // Mutually exclusive suites begin with the same bindings. A skipped assignment
          // cannot erase an earlier deletion target; two known readers remain known readers.
          const before = new Map(bindings)
          if (consequence) visit(consequence, output)
          const after = new Map(bindings)
          bindings.clear()
          for (const [key, value] of before) bindings.set(key, value)
          branch(index + 1)
          const names = new Set([...after.keys(), ...bindings.keys()])
          for (const name of names)
            bindings.set(name, mergeTargets([after.get(name) ?? name, bindings.get(name) ?? name]))
        }
        branch(0)
        return
      }
      if (
        language !== 'bash' &&
        [
          'for_statement',
          'for_in_statement',
          'while_statement',
          'do_statement',
          'repeat_statement'
        ].includes(node.type)
      ) {
        const initializer = fieldChild(node, 'initializer')
        if (initializer) visit(initializer, output)
        const condition = fieldChild(node, 'condition')
        const iterable = fieldChild(node, language === 'r' ? 'sequence' : 'right')
        const target = fieldChild(node, language === 'r' ? 'variable' : 'left')
        const body = fieldChild(node, 'body')
        const increment = fieldChild(node, 'increment')
        const alternative = fieldChild(node, 'alternative')
        const loopRisks: RiskEvidence[] = []
        let sequence = iterable
        while (sequence?.type === 'parenthesized_expression')
          sequence = sequence.namedChildren.find((child) => child.type !== 'comment') ?? null
        let values: (Node | null)[] | undefined
        if (
          sequence &&
          ['list', 'tuple', 'array'].includes(sequence.type) &&
          !(language === 'repl' && fieldChild(node, 'operator')?.text === 'in')
        ) {
          const entries = slots(sequence)
          if (
            !entries.some((entry) => ['list_splat', 'spread_element'].includes(entry?.type ?? ''))
          )
            values = entries
        }
        if (
          language === 'r' &&
          sequence?.type === 'call' &&
          /^(?:base::)?list$/.test(identity(fieldChild(sequence, 'function'), bindings) ?? '')
        )
          values = (
            fieldChild(sequence, 'arguments')?.namedChildren.filter(
              (child) => child.type === 'argument'
            ) ?? []
          ).map((arg) => fieldChild(arg, 'value'))
        const beforeValues = values?.map((value) =>
          bindingUpdates(target, value, bindings, language)
        )
        if (iterable) visit(iterable, output)
        const iterationValues = values?.map((value, index) =>
          joinedBindings(beforeValues![index], bindingUpdates(target, value, bindings, language))
        )
        if (condition && node.type !== 'do_statement') visit(condition, output)
        const entry = new Map(bindings)
        const loopNames = [...bindingUpdates(target, null, bindings, language).keys()]
        const scoped =
          language === 'repl' && ['let', 'const'].includes(fieldChild(node, 'kind')?.text ?? '')
        const prefixScopes = exceptionPrefixes.map((prefix) => ({
          prefix,
          before: new Map(prefix)
        }))
        const runBody = (): string | undefined => {
          if (body) visit(body, loopRisks)
          const control = blockControl(body)
          if (!control || ['continue_statement', 'next'].includes(control)) {
            if (increment) visit(increment, loopRisks)
            if (condition) visit(condition, loopRisks)
          }
          return control
        }
        if (iterationValues && iterationValues.length <= 16) {
          for (const value of iterationValues) {
            for (const [key, target] of value) bindings.set(key, target)
            capturePrefixes()
            const control = runBody()
            if (control && !['continue_statement', 'next'].includes(control)) break
          }
        } else if (node.type === 'do_statement' && booleanCondition(condition) === false) {
          runBody()
        } else if (booleanCondition(condition) !== false) {
          let converged = false
          const exits: Bindings[] = []
          for (let pass = 0; pass < 18; pass++) {
            const before = new Map(bindings)
            const revision = functionRevision
            if (target) {
              const value = iterationValues
                ? joinedBindings(...iterationValues)
                : bindingUpdates(
                    target,
                    null,
                    bindings,
                    language,
                    language === 'repl' && fieldChild(node, 'operator')?.text === 'in'
                      ? '@noncallable'
                      : undefined
                  )
              for (const [key, target] of value) bindings.set(key, target)
              capturePrefixes()
            }
            const control = runBody()
            exits.push(new Map(bindings))
            restore(joinedBindings(before, bindings))
            if (control && !['continue_statement', 'next'].includes(control)) {
              converged = true
              break
            }
            if (
              before.size === bindings.size &&
              [...before].every(([key, value]) => bindings.get(key) === value) &&
              revision === functionRevision
            ) {
              converged = true
              break
            }
          }
          if (!converged) {
            // Unknown iteration counts must not turn a bounded analysis into permission bypass.
            for (const [key, value] of bindings)
              if (entry.get(key) !== value) bindings.set(key, '@choices-overflow')
            runBody()
            exits.push(new Map(bindings))
          }
          restore(
            joinedBindings(
              ...exits,
              ...(['do_statement', 'repeat_statement'].includes(node.type) ? [] : [entry])
            )
          )
        }
        // A JS lexical loop variable does not replace an outer binding after the loop.
        if (scoped)
          for (const name of loopNames) {
            if (entry.has(name)) bindings.set(name, entry.get(name)!)
            else bindings.delete(name)
            for (const state of prefixScopes) {
              if (state.before.has(name)) state.prefix.set(name, state.before.get(name)!)
              else state.prefix.delete(name)
            }
          }
        if (alternative) {
          // Python else may be skipped by break. Inspect it without erasing the non-else exit.
          const exit = new Map(bindings)
          visit(alternative, loopRisks)
          if (
            iterationValues?.length !== 0 &&
            booleanCondition(condition) !== false &&
            containsLoopBreak(body)
          )
            restore(joinedBindings(exit, bindings))
        }
        output.push(...uniqueRisks(loopRisks))
        capturePrefixes()
        return
      }
      if ((language === 'python' || language === 'repl') && node.type === 'try_statement') {
        const prefix = new Map(bindings)
        exceptionPrefixes.push(prefix)
        const body = fieldChild(node, 'body')
        const tryRisks: RiskEvidence[] = []
        if (body) visit(body, tryRisks)
        exceptionPrefixes.pop()
        const alternative = node.namedChildren.find((child) => child.type === 'else_clause')
        if (alternative) visit(alternative, tryRisks)
        const exits = [new Map(bindings)]
        const handlers = node.namedChildren.filter((child) =>
          ['except_clause', 'except_group_clause', 'catch_clause'].includes(child.type)
        )
        for (const handler of handlers) {
          restore(prefix)
          let parameter =
            fieldChild(handler, 'parameter') ?? fieldChild(fieldChild(handler, 'value'), 'alias')
          if (parameter?.type === 'as_pattern_target') parameter = parameter.namedChild(0)
          const names = [...bindingUpdates(parameter, null, bindings, language).keys()]
          const old = new Map(bindings)
          for (const name of names) bindings.set(name, '<dynamic>')
          visit(handler, tryRisks)
          for (const name of names) {
            if (language === 'python') bindings.delete(name)
            else if (old.has(name)) bindings.set(name, old.get(name)!)
            else bindings.delete(name)
          }
          exits.push(new Map(bindings))
        }
        const normal = joinedBindings(...exits)
        const finalizer = node.namedChildren.find((child) => child.type === 'finally_clause')
        if (finalizer) {
          // Finally runs on both caught/normal exits and an uncaught partial-body exception.
          restore(joinedBindings(normal, prefix))
          visit(finalizer, tryRisks)
          restore(normal)
          visit(finalizer, tryRisks)
        } else restore(normal)
        output.push(...uniqueRisks(tryRisks))
        capturePrefixes()
        return
      }
      if (language === 'python' && node.type === 'delete_statement' && isNotebookScope(node)) {
        let conditional = false
        for (
          let child = node, parent = child.parent;
          parent && parent.type !== 'module';
          child = parent, parent = parent.parent
        ) {
          if (
            parent.type === 'if_statement' &&
            fieldChild(parent, 'condition')?.type === 'false' &&
            fieldChild(parent, 'consequence')?.id === child.id
          )
            return
          if (
            parent.type !== 'block' &&
            !(
              parent.type === 'if_statement' &&
              fieldChild(parent, 'condition')?.type === 'true' &&
              fieldChild(parent, 'consequence')?.id === child.id
            )
          )
            conditional = true
        }
        const removeBinding = (target: Node): void => {
          if (target.type === 'identifier') {
            // A skipped branch/iteration or caught exception can leave the old value alive.
            if (conditional) bindings.set(target.text, '<dynamic>')
            else bindings.delete(target.text)
          } else if (
            ['expression_list', 'tuple', 'list', 'parenthesized_expression'].includes(target.type)
          )
            for (const child of target.namedChildren) removeBinding(child)
          // Attribute/subscript deletion does not delete names used in its receiver or index.
          // Inspect their effects with the bindings left by earlier targets in this same del.
          else {
            visit(target, output)
            if (target.type === 'attribute') {
              const property = literal(fieldChild(target, 'attribute'))
              if (property)
                for (const member of pythonModuleMemberKeys(
                  identity(fieldChild(target, 'object'), bindings),
                  property
                )) {
                  bindings.set(member, '<dynamic>')
                  noteModuleWrite(member)
                }
            }
          }
        }
        for (const target of node.namedChildren) removeBinding(target)
        capturePrefixes()
        return
      }
      const add = (
        operation: string,
        overwritePath?: string,
        overwriteCwd = bindings.get(CWD_BINDING),
        copyBasename?: string | null,
        freshHandle?: boolean
      ): void => {
        spendWork()
        output.push({
          operation,
          source: node.text,
          line: node.startPosition.row + 1,
          ...(overwritePath !== undefined ? { overwritePath, overwriteCwd } : {}),
          ...(copyBasename !== undefined ? { copyBasename } : {}),
          ...(freshHandle ? { freshHandle } : {})
        })
      }
      if (language === 'repl' && node.type === 'object') {
        const entries = node.namedChildren.filter((child) => child.type !== 'comment')
        const keyOf = (entry: Node): string | undefined => {
          if (entry.type === 'shorthand_property_identifier') return entry.text
          const key = fieldChild(entry, entry.type === 'method_definition' ? 'name' : 'key')
          if (key?.type === 'computed_property_name') return processString(key.namedChild(0))
          return literal(key)
        }
        // Coercion/serialization/thenable hooks can run through containers and library calls.
        // Keep their bodies conservative until receiver/container provenance is available.
        if (
          entries.length <= 16 &&
          entries.every(
            (entry) =>
              ['pair', 'method_definition', 'shorthand_property_identifier'].includes(entry.type) &&
              keyOf(entry) !== undefined &&
              !['__proto__', 'toString', 'valueOf', 'toJSON', 'then'].includes(
                keyOf(entry) ?? ''
              ) &&
              !/^(?:get|set)\s/.test(entry.text)
          )
        ) {
          const object = `@object:${objectRevision++}`
          const nodeKey = `@node:${node.id}`
          evaluatedNodeKeys.add(nodeKey)
          bindings.set(nodeKey, object)
          for (const entry of entries) {
            const member = `${object}.${keyOf(entry)}`
            const value =
              entry.type === 'pair' ? unparenthesized(fieldChild(entry, 'value')) : entry
            const callable =
              value &&
              ['method_definition', 'arrow_function', 'function_expression'].includes(value.type)
            if (callable) methodOwners.set(value.id, member)
            // Property expressions execute now; stored functions execute on invocation. Later
            // duplicate keys replace earlier values, but cannot erase their eager effects.
            visit(entry, output)
            if (!callable)
              bindings.set(
                member,
                entry.type === 'shorthand_property_identifier'
                  ? (bindings.get(entry.text) ?? entry.text)
                  : (identity(value ?? null, bindings) ??
                      (jsNonCallableLiteral(value ?? null) ? '@noncallable' : '<dynamic>'))
              )
          }
          return
        }
      }
      if (language === 'repl' && objectMethodDepth && node.type === 'call_expression') {
        const called = fieldChild(node, 'function')
        if (
          called &&
          ['member_expression', 'subscript_expression'].includes(called.type) &&
          fieldChild(called, 'object')?.type === 'this'
        )
          add('dynamic object method receiver')
      }
      const assigned = assignment(node)
      let functionNode = assigned?.right ?? node
      while (functionNode.type === 'parenthesized_expression') {
        const inner = functionNode.namedChildren.find((child) => child.type !== 'comment')
        if (!inner) break
        functionNode = inner
      }
      if (
        [
          'lambda',
          'function_definition',
          'function_declaration',
          'arrow_function',
          'function_expression',
          ...(methodOwners.has(functionNode.id) ? ['method_definition'] : [])
        ].includes(functionNode.type)
      ) {
        const declaredName = fieldChild(functionNode, 'name')
        // R labels the anonymous `function` keyword as its name; it is not a declaration.
        const assignedObject =
          assigned?.left &&
          ['attribute', 'member_expression', 'subscript_expression'].includes(assigned.left.type)
            ? identity(fieldChild(assigned.left, 'object'), bindings)
            : undefined
        const assignedProperty = ['attribute', 'member_expression'].includes(
          assigned?.left?.type ?? ''
        )
          ? literal(fieldChild(assigned!.left, language === 'python' ? 'attribute' : 'property'))
          : assigned?.left?.type === 'subscript_expression'
            ? processString(fieldChild(assigned.left, 'index'))
            : undefined
        const name =
          methodOwners.get(functionNode.id) ??
          (assignedObject &&
          assignedProperty &&
          (assignedObject.startsWith('@object:') ||
            (language === 'python' &&
              pythonModuleMemberKeys(assignedObject, assignedProperty).length))
            ? `${assignedObject}.${assignedProperty}`
            : assigned?.left?.text) ??
          (['function_definition', 'function_declaration'].includes(node.type) &&
          declaredName?.isNamed
            ? declaredName.text
            : undefined)
        if (name) {
          const effects: RiskEvidence[] = []
          const parameters = fieldChild(functionNode, 'parameters')
          // Python evaluates defaults when defining the function; R/JS evaluate them on a call.
          if (language === 'python' && parameters) visit(parameters, output)
          const saved = new Map(bindings)
          bindings.set(CWD_BINDING, INITIAL_CWD)
          bindings.set(FILE_SCOPE_BINDING, `@scope:${functionNode.id}`)
          const savedPrefixes = exceptionPrefixes.splice(0)
          if (language !== 'python' && parameters) visit(parameters, effects)
          // Bash attaches these redirects to the definition, but performs them on each call.
          if (language === 'bash')
            for (const redirect of fieldChildren(functionNode, 'redirect')) visit(redirect, effects)
          const body = fieldChild(functionNode, 'body')
          const writes = new Set<string>()
          functionModuleWrites.push(writes)
          if (methodOwners.has(functionNode.id)) objectMethodDepth++
          try {
            if (body) visit(body, effects)
          } finally {
            if (methodOwners.has(functionNode.id)) objectMethodDepth--
            functionModuleWrites.pop()
          }
          const members = new Map([...writes].map((key) => [key, bindings.get(key) ?? '<dynamic>']))
          restore(saved)
          exceptionPrefixes.push(...savedPrefixes)
          const functionIdentity =
            declarations.get(functionNode.id) ?? `@function:${functions.size}`
          declarations.set(functionNode.id, functionIdentity)
          const previous = functions.get(functionIdentity)
          for (const [key, value] of previous?.members ?? [])
            members.set(key, members.has(key) ? mergeTargets([members.get(key), value]) : value)
          const mergedEffects = previous ? uniqueRisks([...previous.effects, ...effects]) : effects
          if (
            JSON.stringify(previous?.effects) !== JSON.stringify(mergedEffects) ||
            JSON.stringify([...(previous?.members ?? [])]) !== JSON.stringify([...members])
          )
            functionRevision++
          bindings.set(name, functionIdentity)
          if (assignedObject && assignedProperty)
            for (const target of possibleTargets(assignedObject))
              if (
                target?.startsWith('@object:') ||
                (language === 'python' && pythonModuleMemberKeys(target, assignedProperty).length)
              ) {
                bindings.set(
                  `${target}.${assignedProperty}`,
                  language === 'python' && possibleTargets(assignedObject).length > 1
                    ? mergeTargets([
                        bindings.get(`${target}.${assignedProperty}`) ??
                          `${target}.${assignedProperty}`,
                        functionIdentity
                      ])
                    : functionIdentity
                )
                if (language === 'python') noteModuleWrite(`${target}.${assignedProperty}`)
              }

          functions.set(functionIdentity, {
            name: methodOwners.has(functionNode.id)
              ? name.slice(name.lastIndexOf('.') + 1)
              : assignedObject && assignedProperty
                ? (assigned?.left?.text ?? assignedProperty)
                : name,
            effects: mergedEffects,
            members
          })
          capturePrefixes()
          return
        }
        if (
          language === 'python' &&
          functionNode.type === 'lambda' &&
          pythonDiscardedLambda(functionNode, bindings)
        ) {
          const parameters = fieldChild(functionNode, 'parameters')
          if (parameters) visit(parameters, output)
          return
        }
      }
      if (language === 'bash' && node.type === 'command') {
        const risk = shellRisk(node)
        if (risk) add(risk)
        const name = literal(fieldChild(node, 'name'))
        for (const effect of functions.get(bindings.get(name ?? '') ?? name ?? '')?.effects ?? [])
          add(`${name}: ${effect.operation}`)
      }
      if (language === 'bash' && node.type === 'variable_assignment') {
        const value = fieldChild(node, 'value')
        const risk = commandOptionOverrideRisk(
          fieldChild(node, 'name')?.text ?? '',
          value ? literal(value) : ''
        )
        if (risk) add(risk)
      }
      if (
        language === 'bash' &&
        node.type === 'command' &&
        ['export', 'declare', 'typeset', 'readonly', 'local'].includes(
          literal(fieldChild(node, 'name')) ?? ''
        ) &&
        fieldChildren(node, 'argument').some((arg) => {
          const entry = literal(arg)
          if (entry === undefined || !entry.includes('=')) return false
          const equal = entry.indexOf('=')
          return commandOptionOverrideRisk(entry.slice(0, equal), entry.slice(equal + 1))
        })
      )
        add('shell command option or transport overrides')
      if (language === 'bash' && node.type === 'file_redirect') {
        const operator = node.children.find((child) => !child.isNamed)?.type
        const destination = literal(fieldChild(node, 'destination'))
        const descriptorOnly = operator === '>&' && /^(?:\d+-?|-)$/.test(destination ?? '')
        if (
          ['>', '>|', '&>', '>&'].includes(operator ?? '') &&
          !descriptorOnly &&
          destination !== '/dev/null'
        )
          add('shell file overwrite')
      }
      let decorator = language === 'python' && node.type === 'decorator' ? node.namedChild(0) : null
      while (decorator?.type === 'parenthesized_expression')
        decorator = decorator.namedChildren.find((child) => child.type !== 'comment') ?? null
      // A bare decorator is an implicit call at definition time. Explicit factory calls are
      // already visited below; their returned callable needs separate provenance analysis.
      if (decorator?.type === 'call') decorator = null
      let evaluatedCallee: Node | null = null
      let evaluatedArguments: Node | null = null
      if (decorator || ['call', 'call_expression', 'new_expression'].includes(node.type)) {
        // Loops may evaluate this syntax again with different bindings.
        if (language === 'repl' || language === 'python') bindings.delete(`@node:${node.id}`)
        if (language === 'python') {
          bindings.delete(`@argv:${node.id}`)
          bindings.delete(`@truth:${node.id}`)
          bindings.delete(`@kwargs:${node.id}`)
          bindings.delete(`@path:${node.id}`)
        }
        const reference =
          decorator ?? fieldChild(node, 'function') ?? fieldChild(node, 'constructor')
        let called = reference
        // Python's grammar attaches the star of [*factory()] to the function reference.
        // Resolve the actual callable before arguments, just as in [*(factory())].
        if (
          language === 'python' &&
          called?.type === 'list_splat' &&
          ['list', 'tuple'].includes(node.parent?.type ?? '')
        )
          called = called.namedChild(0)
        // Evaluate the receiver/reference before resolving its callable. Object construction
        // can establish member provenance or produce eager effects; arguments come later.
        if (called) visit(called, output)
        evaluatedCallee = reference
        const resolved = identity(called, bindings)
        const argumentValues = new Map<number, string | undefined>()
        if (language === 'repl' || language === 'python') {
          const receiver = fieldChild(unparenthesized(called) ?? null, 'object')
          if (receiver) argumentValues.set(receiver.id, identity(receiver, bindings))
          const evaluate = (value: Node): void => {
            if (language === 'python' && value.type === 'lambda') {
              const args = evaluatedArguments?.namedChildren ?? []
              const unusedDefault = possibleTargets(resolved).every((callee) => {
                const lookup = pythonInvocation(args, bindings, callee, argumentValues, called)
                const attribute = pythonAttributeLookup(
                  node,
                  bindings,
                  lookup.callee,
                  lookup.args,
                  argumentValues
                )
                return (
                  !lookup.partial &&
                  ((/^(?:builtins\.)?dict\.(?:get|pop|setdefault)$/.test(lookup.callee ?? '') &&
                    pythonPositional(lookup.args)[2]?.id === value.id &&
                    identity(node, bindings, callee, argumentValues) !== undefined) ||
                    (attribute?.present && attribute.fallback?.id === value.id))
                )
              })
              if (unusedDefault) {
                const parameters = fieldChild(value, 'parameters')
                if (parameters) visit(parameters, output)
                argumentValues.set(value.id, identity(value, bindings))
                return
              }
            }
            // Capture array slots individually for apply/Reflect forwarding. Later arguments
            // may replace a member without replacing a function value already obtained.
            if (
              ['array', 'tuple', 'list', 'list_splat', 'parenthesized_expression'].includes(
                value.type
              )
            ) {
              spendWork()
              for (const child of value.namedChildren) evaluate(child)
            } else visit(value, output)
            argumentValues.set(value.id, identity(value, bindings))
          }
          evaluatedArguments = fieldChild(node, 'arguments')
          for (const value of evaluatedArguments?.namedChildren ?? []) evaluate(value)
        }
        if (
          language === 'r' &&
          possibleTargets(resolved).every((target) =>
            /^(?:base::)?(?:quote|expression)$/.test(target ?? '')
          )
        ) {
          // These special forms return syntax: argument calls and assignments have not run.
          // Still inspect the expression that obtains the special form itself.
          return
        }
        const invocations = possibleTargets(resolved).flatMap((callee) => {
          const args =
            fieldChild(node, 'arguments')?.namedChildren.filter(
              (child) => !['comma', 'comment'].includes(child.type)
            ) ?? []
          const invocation =
            language === 'repl'
              ? jsInvocation(node, bindings, callee, argumentValues)
              : {
                  ...(language === 'python'
                    ? pythonInvocation(args, bindings, callee, argumentValues, called)
                    : language === 'r'
                      ? rInvocation(args, bindings, callee)
                      : { callee, args }),
                  construct: node.type === 'new_expression',
                  uncertainArgs: false
                }
          return possibleTargets(invocation.callee).map((callee) => ({ ...invocation, callee }))
        })
        for (const invocation of invocations) {
          let { callee, args } = invocation
          const { construct } = invocation
          if (
            invocation.uncertainArgs &&
            (jsCallbackIndex(callee ?? '') !== undefined ||
              (construct && jsPromiseConstructor.test(callee ?? '')))
          )
            add('dynamic callback target')
          if (language === 'python' && callee?.startsWith('operator.methodcaller:')) {
            args = pythonPositional(args)
            const method = callee.slice('operator.methodcaller:'.length)
            const receiver = identity(args[0] ?? null, bindings)
            callee =
              method === '__call__'
                ? (receiver ?? '<dynamic>')
                : resolvedMemberTarget(receiver ?? args[0]?.text ?? '<dynamic>', method, bindings)
            // Frozen callback-bearing method signatures remain unresolved at construction.
            args = []
          }
          const targets = [callee]
          // R's function lookup can skip a non-function binding and find an outer function.
          // A NULL value is inert as an argument, but not proof that a named call is inert.
          if (language === 'r' && callee === '@noncallable') add('dynamic call target')
          if (invocation.uncertainArgs && /\.(?:call|apply)$/.test(callee ?? ''))
            add('dynamic call target')
          // Follow callback positions of ordinary collection operators, not arbitrary data arguments
          // such as print(cleanup). The enclosing call is the approval site.
          let callback: Node | undefined
          if (language === 'python') {
            const positional = pythonPositional(args)
            if (/^(?:builtins\.)?map$/.test(callee ?? '')) {
              const inputs = positional.slice(1).map((value) => {
                const source = pythonSequence(value)
                const entries = source && pythonPositional(source.values)
                return entries?.some(pythonSequenceSpread) ? undefined : entries
              })
              // map obtains every iterator before producing any item. One empty input cannot
              // hide an opaque iterable's __iter__ effects in another argument.
              if (inputs.some((input) => input?.length === 0) && inputs.some((input) => !input))
                add('dynamic iterable target')
            }
            const keyword = pythonCallbackKeyword(callee ?? '')
            const value = keyword ? pythonKeyword(args, keyword, bindings) : undefined
            const slot = /^(?:builtins\.)?iter$/.test(callee ?? '')
              ? positional.length > 1 || positional.some((arg) => arg.type === 'list_splat')
                ? 0
                : undefined
              : pythonCallbackIndex(callee ?? '')
            let uncertainCallback = false
            const ignored =
              'partial' in invocation &&
              !invocation.partial &&
              pythonUnusedCallback(
                callee ?? '',
                args,
                bindings,
                'functionNode' in invocation
                  ? (invocation.functionNode as Node | undefined)
                  : undefined
              )
            if (slot !== undefined && value === undefined) {
              if (positional.slice(0, slot).some((arg) => arg.type === 'list_splat'))
                uncertainCallback = true
              callback = positional[slot]
            }
            if (keyword) {
              if (value !== undefined) callback = value ?? undefined
              if (value === null && !ignored) add('dynamic callback target')
            }
            if (ignored) callback = undefined
            if (uncertainCallback && !ignored) add('dynamic callback target')
          }
          if (
            language === 'r' &&
            /^(?:base::)?(?:lapply|sapply|vapply|apply|mapply|\.mapply|eapply|tapply|rapply|by|outer|Map|Reduce|Filter|Find|Position)$/.test(
              callee ?? ''
            )
          ) {
            const collection = callee!.split('::').at(-1)
            const callbackName = ['rapply', 'Map', 'Reduce', 'Filter', 'Find', 'Position'].includes(
              collection!
            )
              ? 'f'
              : 'FUN'
            const formals =
              collection === 'rapply'
                ? ['object', 'f', 'classes', 'deflt', 'how']
                : collection === 'by'
                  ? ['data', 'INDICES', 'FUN']
                  : collection === 'outer'
                    ? ['X', 'Y', 'FUN']
                    : callbackName === 'f'
                      ? ['f']
                      : ['mapply', '.mapply'].includes(collection!)
                        ? ['FUN']
                        : collection === 'eapply'
                          ? ['env', 'FUN']
                          : collection === 'tapply'
                            ? ['X', 'INDEX', 'FUN']
                            : collection === 'apply'
                              ? ['X', 'MARGIN', 'FUN']
                              : collection === 'vapply'
                                ? ['X', 'FUN', 'FUN.VALUE']
                                : ['X', 'FUN']
            const matched = rArguments(args, formals)
            callback = fieldChild(matched.get(callbackName), 'value') ?? undefined
          }
          const jsCallbackSlot = language === 'repl' ? jsCallbackIndex(callee ?? '') : undefined
          if (jsCallbackSlot !== undefined) {
            // A spread before the callback can move its position. Do not silently treat it as data.
            if (args.slice(0, jsCallbackSlot).some((arg) => arg.type === 'spread_element'))
              add('dynamic callback target')
            callback = args[jsCallbackSlot]
          }
          const promiseCallbacks =
            language === 'repl' &&
            (jsPromiseCall.test(callee ?? '') ||
              (construct && jsPromiseConstructor.test(callee ?? '')))
          const callbacks = promiseCallbacks
            ? args.slice(0, callee!.endsWith('.then') ? 2 : 1)
            : callback
              ? [callback]
              : []
          const processArguments =
            language === 'repl' &&
            /^(?:node:)?child_process\.(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?)$/.test(
              callee ?? ''
            )
              ? jsProcessArguments(callee!, args, bindings, argumentValues)
              : undefined
          if (processArguments?.callback) callbacks.push(processArguments.callback)
          const shellCommand =
            language === 'python'
              ? pythonShellCommand(callee ?? '', args, bindings)
              : language === 'r' && /^(?:base::)?system$/.test(callee ?? '')
                ? rShellCommand(args)
                : language === 'repl' &&
                    /^(?:node:)?child_process\.exec(?:Sync)?$/.test(callee ?? '') &&
                    !invocation.uncertainArgs &&
                    processArguments &&
                    !processArguments.values.length &&
                    !jsProcessOptionsRisk(processArguments.options)
                  ? processString(args[0])
                  : undefined
          for (let callback of callbacks) {
            if (!callback) continue
            while (callback.type === 'parenthesized_expression') {
              const inner = callback.namedChildren.find((child) => child.type !== 'comment')
              if (!inner) break
              callback = inner
            }
            if (language === 'r' && callback.type === 'null') continue
            // rapply requires a function, unlike match.fun-based R collections accepting names.
            if (
              language === 'r' &&
              /^(?:base::)?rapply$/.test(callee ?? '') &&
              callback.type === 'string'
            )
              continue
            // JS uses these values as replacement text, ignores them as Promise handlers, or
            // rejects them as mappers. Eager expressions are still inspected by normal traversal.
            if (language === 'repl' && jsNonCallableLiteral(callback)) continue
            // A resolved function value keeps its identity after the original name is rebound.
            // Only R's string callback form requests another lookup by the current name.
            const callbackName = language === 'r' ? literal(callback) : undefined
            const callbackTarget =
              (argumentValues.has(callback.id)
                ? argumentValues.get(callback.id)
                : identity(callback, bindings)) ??
              (callbackName ? (bindings.get(callbackName) ?? callbackName) : undefined)
            // Knowing that an object is not callable says nothing about its member values.
            for (const target of possibleTargets(callbackTarget)) {
              if (target?.startsWith('@noncallable.')) add('dynamic callback target')
              else if (target) targets.push(target)
              else if (callback.type !== 'none') add('dynamic callback target')
            }
          }
          for (let target of targets.flatMap(possibleTargets)) {
            if (!target) continue
            if (language === 'python' && pythonPartialTarget(target)) {
              for (let depth = 0; depth < 64; depth++) {
                const partial = pythonPartialTarget(target)
                if (!partial) break
                target = pythonPartialSensitive(partial) ? '<dynamic>' : partial
              }
              if (pythonPartialTarget(target)) target = '<dynamic>'
            }
            if (language === 'repl' && jsApplyBoundTarget(target)) {
              for (let depth = 0; depth < 64; depth++) {
                const boundApply = jsApplyBoundTarget(target)
                if (!boundApply) break
                target = boundApply
              }
              if (
                jsApplyBoundTarget(target) !== undefined ||
                jsCallbackIndex(target) !== undefined ||
                /\.(?:call|apply|bind)$/.test(target) ||
                /^(?:(?:globalThis|global)\.)?Reflect\.(?:apply|construct)$/.test(target)
              )
                add('dynamic callback target')
            }
            if (target === '<dynamic>' || target === '@choices-overflow') add('dynamic call target')
            // As a callback/decorator this forwarder has no concrete argument list to inspect.
            if (language === 'python' && /^operator\.(?:call|__call__)$/.test(target))
              add(`${target} dynamic callable execution`)
            // A method wrapper used as a callback has no statically known receiver. Fixed reader
            // methods remain ordinary data access; destructive/process methods retain review.
            if (language === 'python' && target.startsWith('operator.methodcaller:')) {
              const method = target.slice('operator.methodcaller:'.length)
              if (
                /^(?:remove|unlink|rmdir|removedirs|rmtree|rm|truncate|__call__|eval|exec|getattr|__import__)$/.test(
                  method
                ) ||
                ['os', 'subprocess', 'pty', 'runpy'].some((module) =>
                  processCall.test(`${module}.${method}`)
                )
              )
                add(`${target} dynamic method execution`)
            }
            if (language === 'python' && target === callee) {
              const converted = /^(?:(?:builtins\.)?str|os\.fspath)$/.test(target)
                ? pythonProcessValue(pythonPositional(args)[0], bindings)
                : undefined
              if (
                pythonPathClasses(target)?.some((kind) => bindings.has(`@path-class:${kind}`)) ||
                (typeof converted === 'object' && !pythonPathIntact(converted, bindings))
              )
                add('modified path protocol')
            }
            const changesCwd =
              (language === 'python' && target === 'os.chdir') ||
              (language === 'repl' &&
                /^(?:(?:globalThis|global)\.)?process\.chdir$/.test(target)) ||
              (language === 'r' && /^(?:base::)?setwd$/.test(target))
            if (changesCwd) {
              const argument =
                language === 'python'
                  ? (pythonKeyword(args, 'path', bindings) ?? pythonPositional(args)[0])
                  : language === 'r'
                    ? fieldChild(rArguments(args, ['dir']).get('dir'), 'value')
                    : args[0]
              const path =
                target === callee &&
                !invocation.uncertainArgs &&
                !('partial' in invocation && invocation.partial)
                  ? language === 'python'
                    ? pythonProcessText(pythonProcessValue(argument, bindings), bindings)
                    : processString(argument)
                  : undefined
              const before = bindings.get(CWD_BINDING)
              const next = mergeTargets(
                possibleTargets(before).map((origin) =>
                  appendCwd(origin, path === undefined ? undefined : [path])
                )
              )
              bindings.set(
                CWD_BINDING,
                invocations.length > 1 ? mergeTargets([before, next]) : next
              )
              noteModuleWrite(CWD_BINDING)
              capturePrefixes()
            }
            if (language === 'python') {
              const file = pythonFileHandle(target)
              if (file && /^(?:\.write|\.writelines|\.truncate)$/.test(file.member)) {
                const { mode, prior } = file.handle
                const writable = /[wax+]/.test(mode)
                const mutates = file.member === '.truncate' || !mode.startsWith('a')
                // This cell's w open is reviewed at creation; x creates a new file exclusively.
                // A retained handle can contain data from earlier Runs even if originally w/x.
                if (writable && mutates) {
                  const fresh = !prior && /^[wx]/.test(mode)
                  const captured =
                    functionModuleWrites.length > 0 &&
                    file.handle.scope !== bindings.get(FILE_SCOPE_BINDING)
                  if (!fresh || captured)
                    add(
                      `file${file.member} existing-file overwrite`,
                      undefined,
                      undefined,
                      undefined,
                      fresh
                    )
                }
              }
            }
            if (explicitFileMutation(language, target)) add(target)
            if (
              target === callee &&
              !invocation.uncertainArgs &&
              !('partial' in invocation && invocation.partial)
            ) {
              const path = overwriteTarget(
                language,
                target,
                args,
                'functionNode' in invocation
                  ? (invocation.functionNode as Node | undefined)
                  : fieldChild(node, 'function'),
                bindings
              )
              if (path !== undefined) {
                const sourcePath =
                  language === 'python' && /^shutil\.copy2?$/.test(target)
                    ? pythonProcessText(
                        pythonProcessValue(
                          pythonKeyword(args, 'src', bindings) ?? pythonPositional(args)[0],
                          bindings
                        ),
                        bindings
                      )
                    : undefined
                add(
                  `${target} existing-file overwrite`,
                  path,
                  bindings.get(CWD_BINDING),
                  language === 'python' && /^shutil\.copy2?$/.test(target)
                    ? sourcePath === undefined
                      ? null
                      : basename(sourcePath)
                    : undefined
                )
              }
            }
            if (
              (language === 'python' && pythonDeletion.test(target)) ||
              (language === 'repl' && jsDeletion.test(target)) ||
              (language === 'r' && /^(?:base::)?(?:unlink|file\.remove)$/.test(target)) ||
              /\.(?:unlink|rmdir|rmtree|rmSync|unlinkSync|rmdirSync)$/.test(target)
            )
              add(target)
            if (
              (processCall.test(target) &&
                !(
                  language === 'python' &&
                  target === callee &&
                  /^subprocess\.(?:run|call|check_call|check_output|Popen)$/.test(target) &&
                  !pythonProcessRisk(args, bindings)
                ) &&
                !(
                  language === 'repl' &&
                  target === callee &&
                  /^(?:node:)?child_process\.(?:execFile(?:Sync)?|spawn(?:Sync)?)$/.test(target) &&
                  !invocation.uncertainArgs &&
                  processArguments &&
                  !jsProcessRisk(args, processArguments)
                ) &&
                !(
                  language === 'r' &&
                  target === callee &&
                  /^(?:base::)?system2$/.test(target) &&
                  !rProcessRisk(args, bindings)
                ) &&
                !(
                  target === callee &&
                  shellCommand !== undefined &&
                  shellScripts.get(shellCommand) === false
                )) ||
              (language === 'repl' && jsVmExecution.test(target))
            )
              add(`${target} nested execution`)
            if (
              (/^(?:eval|exec|compile|Function|source|do\.call|get|match\.fun|getattr|__import__)$/.test(
                target
              ) ||
                (language === 'python' &&
                  /^builtins\.(?:eval|exec|compile|getattr|__import__)$/.test(target)) ||
                (language === 'r' &&
                  /^(?:base::)?(?:eval(?:q|\.parent)?|do\.call|match\.fun|(?:sys\.)?source)$/.test(
                    target
                  ))) &&
              // Python compilation produces a code/AST object; exec/eval and eager argument
              // effects are reviewed separately. A rebound compile retains its resolved target.
              !(language === 'python' && /^(?:builtins\.)?compile$/.test(target)) &&
              // Suppress only this lookup's own effect, not a getattr used as a callback/decorator.
              !(
                language === 'python' &&
                target === callee &&
                pythonAttributeLookup(node, bindings, callee, args)
              ) &&
              // Selecting a visible function does not invoke it; its later call retains effects.
              !(
                language === 'r' &&
                target === callee &&
                /^(?:base::)?match\.fun$/.test(target) &&
                identity(node, bindings) !== undefined
              )
            )
              add(`${target} dynamic execution`)
            const fn = functions.get(target)
            if (fn) {
              for (const effect of fn.effects)
                add(
                  `${fn.name}: ${effect.operation}`,
                  effect.overwritePath,
                  composeCwd(bindings.get(CWD_BINDING), effect.overwriteCwd),
                  effect.copyBasename,
                  effect.freshHandle
                )
              // A summarized body may branch, return or fail before writing. Preserve both
              // the old member and its possible replacement; never invent a completed write.
              for (const [member, value] of fn.members) {
                bindings.set(
                  member,
                  mergeTargets([
                    bindings.get(member) ?? member,
                    member === CWD_BINDING ? composeCwd(bindings.get(member), value) : value
                  ])
                )
                noteModuleWrite(member)
              }
              if (fn.members.size) capturePrefixes()
            }
          }
          if (!callee && fieldChild(node, 'function')?.type !== 'lambda') add('dynamic call target')
          if (
            language === 'python' &&
            /^(?:builtins\.)?(?:setattr|delattr)$/.test(callee ?? '') &&
            !('partial' in invocation && invocation.partial)
          ) {
            const positional = pythonPositional(args)
            const setter = /setattr$/.test(callee!)
            const property = processString(positional[1])
            // A computed attribute name can rewrite an inherited path protocol too.
            const receiver =
              positional[0] &&
              (argumentValues.has(positional[0].id)
                ? argumentValues.get(positional[0].id)
                : identity(positional[0], bindings))
            invalidatePathClass(receiver)
            capturePrefixes()
            if (
              positional.length === (setter ? 3 : 2) &&
              property !== undefined &&
              !positional.some((arg) =>
                ['keyword_argument', 'dictionary_splat', 'list_splat'].includes(arg.type)
              )
            ) {
              const captured = (value: Node): string | undefined =>
                argumentValues.has(value.id)
                  ? argumentValues.get(value.id)
                  : identity(value, bindings)
              const receiver = captured(positional[0])
              for (const member of pythonModuleMemberKeys(receiver, property)) {
                bindings.set(
                  member,
                  setter
                    ? possibleTargets(receiver).length > 1 || invocations.length > 1
                      ? mergeTargets([bindings.get(member) ?? member, captured(positional[2])])
                      : (captured(positional[2]) ?? '<dynamic>')
                    : '<dynamic>'
                )
                noteModuleWrite(member)
              }
              capturePrefixes()
            }
          }
        }
        if (language === 'python') {
          const selections = invocations.map((invocation) =>
            'partial' in invocation && !invocation.partial
              ? pythonSelectedProcessResult(invocation.callee, invocation.args, bindings)
              : undefined
          )
          const paths = invocations.map((invocation, index) =>
            'partial' in invocation && !invocation.partial
              ? (pythonConstructedText(
                  invocation.callee,
                  invocation.args,
                  'functionNode' in invocation
                    ? (invocation.functionNode as Node | undefined)
                    : undefined,
                  bindings
                ) ??
                pythonConstructedPath(invocation.callee, invocation.args, bindings) ??
                selections[index]?.value)
              : undefined
          )
          const path = paths[0]
          if (
            path !== undefined &&
            paths.every((value) => JSON.stringify(value) === JSON.stringify(path))
          )
            rememberProcessValue(node, path)
          const keywordEntries = invocations.map((invocation) =>
            'partial' in invocation && !invocation.partial
              ? pythonConstructedKeywords(invocation.callee, invocation.args, bindings)
              : undefined
          )
          const evidence = keywordEntries.map(
            (entries) =>
              entries &&
              JSON.stringify(
                entries.map(({ name, value }) => [name, value.startIndex, value.endIndex, value.id])
              )
          )
          if (
            evidence.length &&
            evidence[0] !== undefined &&
            evidence[0].length <= 64_000 &&
            evidence.every((value) => value === evidence[0])
          ) {
            const key = `@kwargs:${node.id}`
            evaluatedNodeKeys.add(key)
            bindings.set(key, evidence[0])
          }
          const vectors = invocations.map((invocation, index) =>
            'partial' in invocation && !invocation.partial
              ? (pythonConstructedVector(
                  invocation.callee,
                  invocation.args,
                  'functionNode' in invocation
                    ? (invocation.functionNode as Node | undefined)
                    : undefined,
                  bindings
                ) ?? selections[index]?.vectors)
              : undefined
          )
          if (vectors.length && vectors.every((vector) => vector !== undefined)) {
            const result = pythonVectorChoices(vectors.flatMap((vector) => vector ?? []))
            if (selections.every((selection) => selection?.vectors !== undefined))
              rememberSelectedVectors(node, result)
            else rememberVectors(node, result)
          }
          const truths = invocations.map((invocation, index) =>
            'partial' in invocation && !invocation.partial
              ? pythonConstructedTruth(invocation.callee, invocation.args, bindings, vectors[index])
              : undefined
          )
          if (truths.length && truths.every((truth) => truth !== undefined && truth === truths[0]))
            rememberTruth(node, true, truths[0])
        }
        if (
          (language === 'repl' && ['call_expression', 'new_expression'].includes(node.type)) ||
          (language === 'python' &&
            invocations.some((invocation) => {
              const { callee } = invocation
              return (
                /^(?:(?:builtins|io)\.)?open$/.test(callee ?? '') ||
                /^pathlib\.(?:Path|PosixPath|WindowsPath)\.open$/.test(callee ?? '') ||
                callee === 'functools.partial' ||
                callee === 'operator.attrgetter' ||
                callee === 'operator.itemgetter' ||
                /^(?:builtins\.)?dict\.(?:get|pop|setdefault)$/.test(callee ?? '') ||
                /^operator\.(?:getitem|__getitem__)$/.test(callee ?? '') ||
                pythonAttrgetterNames(callee ?? '') !== undefined ||
                pythonItemgetterKeys(callee ?? '') !== undefined ||
                (/^(?:builtins\.)?getattr$/.test(callee ?? '') &&
                  !('partial' in invocation && invocation.partial))
              )
            }))
        ) {
          // A returned function belongs to this evaluation. Later argument/statement mutations
          // must not recompute an already captured receiver or accessor factory argument.
          const nodeKey = `@node:${node.id}`
          evaluatedNodeKeys.add(nodeKey)
          bindings.set(nodeKey, identity(node, bindings, resolved, argumentValues) ?? '<dynamic>')
        }
      }
      for (const child of node.namedChildren)
        if (child.id !== evaluatedCallee?.id && child.id !== evaluatedArguments?.id)
          visit(child, output)
      if (language === 'python' && node.type === 'subscript') {
        const indices = fieldChildren(node, 'subscript')
        const key = indices.length === 1 ? pythonItemKey(indices[0]) : undefined
        if (key !== undefined) {
          const result = pythonProcessItemSelection(fieldChild(node, 'value'), key, bindings)
          rememberProcessValue(node, result?.value)
          rememberSelectedVectors(node, result?.vectors)
        }
      }
      // An assignment's RHS executes with the previous bindings: erase = erase(path) must still
      // recognize the deletion before the name is replaced by the return value.
      const updates = recordBinding(node, bindings, language)
      if (language === 'python')
        for (const key of updates?.keys() ?? []) {
          const dot = key.lastIndexOf('.')
          if (pythonModuleMemberKeys(key.slice(0, dot), key.slice(dot + 1)).length)
            noteModuleWrite(key)
        }
      if (assignment(node) || ['import_statement', 'import_from_statement'].includes(node.type))
        capturePrefixes()
    }
    // A failed/timeout cell may leave bindings from any dispatched statement prefix.
    // Completed cells keep their exact final bindings; legacy string history retains that mode.
    const incompletePrefix = incomplete ? new Map(bindings) : undefined
    if (incompletePrefix) exceptionPrefixes.push(incompletePrefix)
    visit(root, risks)
    if (incompletePrefix) {
      exceptionPrefixes.pop()
      restore(joinedBindings(bindings, incompletePrefix))
    }
    // Prefix replay can reintroduce transient evidence; remove it after joining failed cells.
    for (const key of evaluatedNodeKeys) bindings.delete(key)
    return risks
  }
  try {
    const parserLanguage = language === 'repl' ? 'javascript' : language
    const parseSource = async (
      script: string,
      incomplete = false
    ): ReturnType<typeof withParsedNotebookSource<RiskEvidence[]>> => {
      remainingWork = 100_000
      if (language !== 'bash' && process.platform !== 'win32') {
        // Earlier data strings must not consume the current cell's literal probe allowance.
        // Function effects have already been summarized using their declaring source's verdicts.
        shellScripts.clear()
        let shellCharacters = 0
        const collected = await withParsedNotebookSource(parserLanguage, script, (root) => {
          const candidates: string[] = []
          const visit = (node: Node, inCall = false): void => {
            spendWork()
            inCall ||= ['call', 'call_expression'].includes(node.type)
            if (
              inCall &&
              [
                'string',
                'raw_string',
                'concatenated_string',
                'template_string',
                'binary_operator',
                'binary_expression'
              ].includes(node.type)
            ) {
              const text = processString(node)
              // ponytail: bounded literal probes, no general string evaluator or runtime execution.
              if (
                text !== undefined &&
                !shellScripts.has(text) &&
                shellScripts.size < 64 &&
                shellCharacters + text.length <= 64_000
              ) {
                shellScripts.set(text, true)
                shellCharacters += text.length
                candidates.push(text)
              }
            }
            for (const child of node.namedChildren) visit(child, inCall)
          }
          visit(root)
          return candidates
        })
        if (collected.state !== 'ok') return collected
        // Trees are deleted before any asynchronous probe; cache only text and verdicts.
        for (const candidate of collected.value) {
          if (shellVerdicts.has(candidate)) {
            shellScripts.set(candidate, shellVerdicts.get(candidate)!)
            continue
          }
          const plain = await withParsedNotebookSource('bash', candidate, plainShellSource)
          if (
            plain.state === 'ok' &&
            plain.value &&
            !(await analyzeNotebookCodeRisk('bash', candidate, undefined, [], signal)).length
          )
            shellScripts.set(candidate, false)
          if (shellVerdicts.size < 128 && verdictCharacters + candidate.length <= 64_000) {
            shellVerdicts.set(candidate, shellScripts.get(candidate)!)
            verdictCharacters += candidate.length
          }
          if (shellVerdicts.size % 8 === 0) await checkpoint()
        }
      }
      return withParsedNotebookSource(parserLanguage, script, (root) => analyze(root, incomplete))
    }
    // Exact ordered source and completion state determine replay evidence, never permission.
    // Bound each cell and the retained state rather than turning a long kernel into repeated consent.
    const initialKey = createHash('sha256')
      .update(JSON.stringify([language, process.platform, [...bindings]]))
      .digest('hex')
    let historyKey = initialKey
    let replayStart = 0
    let cached: string | undefined
    let cachedKey = initialKey
    for (let index = 0; index < previousSources.length; index++) {
      if (index % 32 === 0) await checkpoint()
      const previous = previousSources[index]
      const script = typeof previous === 'string' ? previous : previous.script
      if (script.length > MAX_REPLAY_STATE_CHARACTERS)
        return [{ operation: 'kernel source history exceeds analysis limit', source, line: 1 }]
      historyKey = replayKey(
        historyKey,
        script,
        typeof previous !== 'string' && previous.incomplete
      )
      const candidate = replaySnapshots.get(historyKey)
      if (candidate !== undefined) {
        cached = candidate
        cachedKey = historyKey
        replayStart = index + 1
      }
    }
    if (cached !== undefined) {
      const state = JSON.parse(cached) as ReplaySnapshot
      bindings.clear()
      for (const [name, value] of state.bindings) bindings.set(name, value)
      for (const [key, value] of state.functions)
        functions.set(key, { ...value, members: new Map(value.members) })
      objectRevision = state.objectRevision
      rememberReplaySnapshot(cachedKey, cached)
    }
    for (let index = replayStart; index < previousSources.length; index++) {
      await checkpoint()
      const previous = previousSources[index]
      const script = typeof previous === 'string' ? previous : previous.script
      const incomplete = typeof previous !== 'string' && previous.incomplete
      const parsed = await parseSource(script, incomplete)
      if (parsed.state !== 'ok') return [{ operation: parsed.reason, source, line: 1 }]
      cachedKey = replayKey(cachedKey, script, incomplete)
      rememberReplaySnapshot(cachedKey, snapshot())
    }
    await checkpoint()
    if (source.length > MAX_REPLAY_STATE_CHARACTERS)
      return [{ operation: 'code source exceeds analysis limit', source, line: 1 }]
    const parsed = await parseSource(source)
    if (parsed.state !== 'ok') return [{ operation: parsed.reason, source, line: 1 }]
    rememberReplaySnapshot(replayKey(historyKey, source, false), snapshot())
    return await resolveOverwriteRisks(parsed.value, context?.workingDirectory, signal)
  } catch {
    signal?.throwIfAborted()
    return [{ operation: 'code analysis unavailable', source, line: 1 }]
  }
}
