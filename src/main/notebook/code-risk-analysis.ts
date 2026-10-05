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

export async function analyzePowerShellCodeRisk(
  source: string,
  signal?: AbortSignal,
  version: '5.1' | '7.6' = '5.1'
): Promise<NotebookCodeRisk[]> {
  try {
    const commands = await parsePowerShellSearchCommands(source, signal, version, true)
    return commands.flatMap(({ name, arguments: args }) => {
      const command = name?.split('\\').at(-1)?.toLowerCase()
      const risky =
        !command ||
        [
          'remove-item',
          'ri',
          'rm',
          'rmdir',
          'del',
          'erase',
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
        (!command.startsWith('@') &&
          commandRisk(
            command,
            args.map((arg) => arg ?? undefined)
          ))
      return risky
        ? [
            {
              operation: name ?? 'dynamic PowerShell command',
              source: args.filter((arg) => arg !== null).join(' '),
              line: 1
            }
          ]
        : []
    })
  } catch {
    signal?.throwIfAborted()
    return [{ operation: 'PowerShell analysis unavailable', source, line: 1 }]
  }
}
const pythonDeletion =
  /^(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|pathlib\.(?:Path|PosixPath|WindowsPath)\.(?:unlink|rmdir))$/
const jsDeletion = /^(?:node:)?fs(?:\.promises)?\.(?:rm|unlink|rmdir)(?:Sync)?$/
const processCall =
  /^(?:os\.(?:system|popen)|subprocess\.(?:run|call|Popen|check_call|check_output)|(?:node:)?child_process\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)|(?:base::)?system2?)$/

const literal = (node: Node | null): string | undefined => {
  if (!node) return undefined
  if (['word', 'number', 'identifier', 'property_identifier'].includes(node.type)) return node.text
  if (['string', 'raw_string'].includes(node.type)) {
    if (
      node.namedChildren.some(
        (child) =>
          !['string_content', 'string_fragment', 'string_start', 'string_end'].includes(child.type)
      )
    )
      return undefined
    // Escaped/interpolated strings are deliberately not decoded as executable source.
    if (node.text.includes('\\')) return undefined
    return node.text.replace(/^[rub]*(['"])(?:\1\1)?/i, '').replace(/(['"])(?:\1\1)?$/, '')
  }
  if (node.type === 'command_name') return literal(node.namedChild(0))
  return undefined
}

const identity = (node: Node | null, bindings: Bindings): string | undefined => {
  if (!node) return undefined
  if (node.type === 'identifier') return bindings.get(node.text) ?? node.text
  if (['attribute', 'member_expression'].includes(node.type)) {
    const object = identity(fieldChild(node, 'object'), bindings)
    const property = literal(fieldChild(node, node.type === 'attribute' ? 'attribute' : 'property'))
    return object && property ? `${object}.${property}` : undefined
  }
  if (node.type === 'namespace_operator')
    return `${fieldChild(node, 'lhs')?.text}::${fieldChild(node, 'rhs')?.text}`
  if (['call', 'call_expression'].includes(node.type)) {
    const callee = identity(fieldChild(node, 'function'), bindings)
    const args = fieldChild(node, 'arguments')?.namedChildren ?? []
    if (callee === 'require' || callee === 'import')
      return literal(args[0] ?? null)?.replace('fs/promises', 'fs.promises')
    if (/^pathlib\.(Path|PosixPath|WindowsPath)$/.test(callee ?? '')) return callee
  }
  if (node.type === 'await_expression') return identity(node.namedChild(0), bindings)
  return undefined
}

const assignment = (node: Node): { left: Node | null; right: Node | null } | undefined => {
  if (node.type === 'assignment')
    return { left: fieldChild(node, 'left'), right: fieldChild(node, 'right') }
  if (node.type === 'variable_declarator')
    return { left: fieldChild(node, 'name'), right: fieldChild(node, 'value') }
  if (node.type === 'binary_operator') {
    const left = fieldChild(node, 'lhs'),
      right = fieldChild(node, 'rhs')
    const operator =
      left && right
        ? node.text
            .slice(left.endIndex - node.startIndex, right.startIndex - node.startIndex)
            .trim()
        : ''
    if (['<-', '=', '<<-'].includes(operator)) return { left, right }
  }
  return undefined
}

const recordBinding = (node: Node, bindings: Bindings): void => {
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
        module ? `${module}.${imported}` : explicitAlias ? imported : imported.split('.')[0]
      )
    }
  }
  const assigned = assignment(node)
  if (assigned) {
    const { left, right } = assigned
    const value = identity(right, bindings)
    if (left?.type === 'identifier') bindings.set(left.text, value ?? '<local>')
    if (left?.type === 'object_pattern')
      for (const entry of left.namedChildren) {
        const key = fieldChild(entry, 'key')?.text ?? entry.text
        const name = fieldChild(entry, 'value')?.text ?? entry.text
        bindings.set(name, value ? `${value}.${key}` : '<local>')
      }
  }
}

const shellRisk = (node: Node): string | undefined => {
  const nameNode = fieldChild(node, 'name')
  const command = literal(nameNode)
  const args = fieldChildren(node, 'argument').map(literal)
  return commandRisk(command, args)
}

const commandRisk = (
  command: string | undefined,
  args: (string | undefined)[]
): string | undefined => {
  if (!command) return 'dynamic shell command'
  if (command.includes('\\')) return 'escaped shell command'
  const name = command
    .split('/')
    .at(-1)!
    .replace(/\.(?:exe|cmd|bat)$/i, '')
  if (args.length === 1 && ['--help', '--version'].includes(args[0] ?? '')) return undefined
  if (['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mkfs', 'dd'].includes(name)) return name
  if (
    name === 'find' &&
    args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg ?? ''))
  )
    return 'find mutation or command execution'
  if (
    name === 'git' &&
    (args.includes('clean') ||
      args.includes('restore') ||
      (args.includes('reset') && args.includes('--hard')) ||
      (args.includes('checkout') && args.includes('--')))
  )
    return 'git working-tree mutation'
  if (['eval', 'source', '.', 'exec', 'xargs', 'sudo', 'doas', 'alias', 'busybox'].includes(name))
    return `${name} command execution`
  if (
    [
      'sh',
      'bash',
      'dash',
      'zsh',
      'ksh',
      'python',
      'python3',
      'Rscript',
      'node',
      'pwsh',
      'powershell',
      'cmd'
    ].includes(name)
  )
    return `${name} nested execution`
  if (['command', 'env', 'nohup', 'timeout', 'nice'].includes(name)) {
    // Wrapper flags and assignments vary; do not accidentally classify the wrapper as the payload.
    return args.some((arg) =>
      ['rm', 'unlink', 'rmdir', 'shred', 'truncate'].includes(arg?.split('/').at(-1) ?? '')
    )
      ? 'wrapped filesystem deletion'
      : 'wrapped command execution'
  }
  if (/\.(?:sh|py|r|js|ps1)$/i.test(name)) return 'script execution'
  return undefined
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
  previousSources: readonly string[] = []
): Promise<NotebookCodeRisk[]> {
  const bindings: Bindings = new Map(
    context?.pythonBindings?.map(({ name, qualifiedName }) => [name, qualifiedName])
  )
  const functions = new Map<string, NotebookCodeRisk[]>()
  const analyze = (root: Node): NotebookCodeRisk[] => {
    const risks: NotebookCodeRisk[] = []
    const visit = (node: Node, output: NotebookCodeRisk[]): void => {
      // String contents are leaves; interpolations may contain real calls (Python f-strings,
      // JavaScript templates and Bash substitutions), so traverse their syntax rather than text.
      if (node.type === 'comment') return
      const add = (operation: string): void => {
        output.push({ operation, source: node.text, line: node.startPosition.row + 1 })
      }
      const assigned = assignment(node)
      const functionNode = assigned?.right ?? node
      if (
        [
          'function_definition',
          'function_declaration',
          'arrow_function',
          'function_expression'
        ].includes(functionNode.type)
      ) {
        const name = assigned?.left?.text ?? fieldChild(functionNode, 'name')?.text
        if (name) {
          const effects: NotebookCodeRisk[] = []
          const saved = new Map(bindings)
          const body = fieldChild(functionNode, 'body')
          if (body) visit(body, effects)
          bindings.clear()
          for (const [key, value] of saved) bindings.set(key, value)
          const functionIdentity = `@function:${name}`
          bindings.set(name, functionIdentity)
          functions.set(functionIdentity, effects)
          return
        }
      }
      if (language === 'bash' && node.type === 'command') {
        const risk = shellRisk(node)
        if (risk) add(risk)
        const name = literal(fieldChild(node, 'name'))
        for (const effect of functions.get(bindings.get(name ?? '') ?? name ?? '') ?? [])
          add(`${name}: ${effect.operation}`)
      }
      if (
        language === 'bash' &&
        node.type === 'file_redirect' &&
        /^\s*\d*\s*>(?!>)/.test(node.text)
      )
        add('shell file overwrite')
      if (['call', 'call_expression', 'new_expression'].includes(node.type)) {
        const callee = identity(
          fieldChild(node, 'function') ?? fieldChild(node, 'constructor'),
          bindings
        )
        if (
          callee &&
          (pythonDeletion.test(callee) ||
            jsDeletion.test(callee) ||
            /^(?:base::)?(?:unlink|file\.remove)$/.test(callee))
        )
          add(callee)
        else if (callee && /\.(?:unlink|rmdir|rmtree|rmSync|unlinkSync|rmdirSync)$/.test(callee))
          add(callee)
        if (callee && processCall.test(callee)) add(`${callee} nested execution`)
        if (
          callee &&
          /^(?:eval|exec|compile|Function|source|do\.call|get|match\.fun|getattr|__import__)$/.test(
            callee
          )
        )
          add(`${callee} dynamic execution`)
        if (callee && functions.has(callee))
          for (const effect of functions.get(callee)!)
            add(`${callee.replace('@function:', '')}: ${effect.operation}`)
        if (!callee && fieldChild(node, 'function')?.type !== 'lambda') add('dynamic call target')
      }
      for (const child of node.namedChildren) visit(child, output)
      // An assignment's RHS executes with the previous bindings: erase = erase(path) must still
      // recognize the deletion before the name is replaced by the return value.
      recordBinding(node, bindings)
    }
    visit(root, risks)
    return risks
  }
  try {
    const parserLanguage = language === 'repl' ? 'javascript' : language
    // Prior source is same-kernel evidence only. Bound work; never silently drop uncertain history.
    if (previousSources.reduce((size, script) => size + script.length, 0) > 256_000) {
      return [{ operation: 'kernel source history exceeds analysis limit', source, line: 1 }]
    }
    for (const previous of previousSources) {
      const parsed = await withParsedNotebookSource(parserLanguage, previous, analyze)
      if (parsed.state !== 'ok') return [{ operation: parsed.reason, source, line: 1 }]
    }
    const parsed = await withParsedNotebookSource(parserLanguage, source, analyze)
    return parsed.state === 'ok' ? parsed.value : [{ operation: parsed.reason, source, line: 1 }]
  } catch {
    return [{ operation: 'code analysis unavailable', source, line: 1 }]
  }
}
