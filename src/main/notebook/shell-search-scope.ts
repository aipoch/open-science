import { realpath } from 'node:fs/promises'
import { parsePowerShellSearchCommands } from './powershell-search-parser'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fieldChildren, withParsedNotebookSource, type Node } from './dependency-analysis-parser'

const denied = (reason: string): never => {
  throw new Error(
    `Shell search scope denied: ${reason}. Search an explicit directory inside the session cwd, or use host.artifacts() for managed files.`
  )
}

type State = { cwd: string | undefined; variables: Map<string, string> }

// Resolve only syntax whose value is known without executing the user's command. Quoted expansion
// is one argument; unquoted expansion can undergo splitting/globbing and is deliberately unresolved.
const literal = (node: Node | null, state: State, quoted = false): string | undefined => {
  if (!node) return undefined
  if (node.type === 'command_name') return literal(node.namedChild(0), state)
  if (node.type === 'raw_string') return node.text.slice(1, -1)
  if (node.type === 'word' || node.type === 'number' || node.type === 'string_content') {
    if (node.type === 'word' && /[~*?[\]{}]/.test(node.text)) return undefined
    return node.text.replace(/\\\n/g, '').replace(quoted ? /\\([$`"\\\n])/g : /\\(.)/gs, '$1')
  }
  if (node.type === 'simple_expansion' || node.type === 'expansion') {
    const name = node.namedChild(0)
    return quoted && name?.type === 'variable_name' && node.namedChildCount === 1
      ? (state.variables.get(name.text) ?? (name.text === 'PWD' ? state.cwd : undefined))
      : undefined
  }
  if (node.type === 'string' || node.type === 'concatenation') {
    const parts = node.namedChildren.map((child) =>
      literal(child, state, node.type === 'string' || quoted)
    )
    return parts.every((part) => part !== undefined) ? parts.join('') : undefined
  }
  return undefined
}

const inside = (root: string, target: string): boolean => {
  const part = relative(root, target)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

// Check existing ancestors, too: a not-yet-existing filename under an escaping symlink is outside.
const physicalPath = async (target: string): Promise<string> => {
  try {
    return await realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(target)
    if (parent === target) throw error
    return resolve(await physicalPath(parent), relative(parent, target))
  }
}

const searchTools = new Set([
  'find',
  'fd',
  'fdfind',
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ls',
  'tree',
  'du',
  'locate',
  'plocate',
  'mlocate',
  'mdfind'
])
const shells = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])
const commandName = (value: string): string => value.split('/').at(-1) ?? value

// These options consume values, which must not be confused with search roots. Unknown options are
// rejected for discovery commands: guessing their arity can hide an outside path behind an option.
const valueOptions: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    rg: '-e --regexp -f --file -g --glob --iglob -t --type -T --type-not --type-add --type-clear --ignore-file --encoding -E -A -B -C --after-context --before-context --context -m --max-count --max-depth --max-filesize --threads -j --sort --sortr --color --colors --replace -r --field-match-separator --field-context-separator --path-separator --hyperlink-format --engine --regex-size-limit --dfa-size-limit',
    grep: '-e --regexp -f --file -A -B -C --after-context --before-context --context -m --max-count -d --directories -D --devices --exclude --exclude-dir --include --exclude-from --label',
    fd: '-e --extension -t --type -E --exclude -d --max-depth --min-depth --max-results -j --threads --ignore-file --color -x --exec -X --exec-batch',
    ls: '-I --ignore --hide --block-size --format --sort --time --time-style --width --tabsize',
    tree: '-L -I -P --charset --sort --filelimit --timefmt',
    du: '-d --max-depth --exclude --exclude-from -X -B --block-size --threshold -t'
  }).map(([name, options]) => [name, new Set(options.split(' '))])
)
const flagOptions = new Set([
  '--files',
  '--hidden',
  '--no-ignore',
  '--no-ignore-vcs',
  '--no-ignore-parent',
  '--no-ignore-dot',
  '--no-ignore-global',
  '--no-ignore-exclude',
  '--no-messages',
  '--no-heading',
  '--heading',
  '--line-number',
  '--with-filename',
  '--no-filename',
  '--count',
  '--count-matches',
  '--files-with-matches',
  '--files-without-match',
  '--ignore-case',
  '--smart-case',
  '--case-sensitive',
  '--fixed-strings',
  '--word-regexp',
  '--line-regexp',
  '--invert-match',
  '--only-matching',
  '--quiet',
  '--null',
  '--null-data',
  '--text',
  '--binary',
  '--stats',
  '--json',
  '--pcre2',
  '--multiline',
  '--multiline-dotall',
  '--crlf',
  '--mmap',
  '--no-mmap',
  '--one-file-system',
  '--prune',
  '--dirsfirst',
  '--noreport',
  '--all',
  '--apparent-size',
  '--bytes',
  '--human-readable',
  '--summarize',
  '--total',
  '--si',
  '--recursive',
  '--absolute-path',
  '--full-path',
  '--strip-cwd-prefix',
  '--print0',
  '--show-errors'
])

const rootsFor = (name: string, args: string[]): string[] => {
  if (['locate', 'plocate', 'mlocate'].includes(name))
    return denied('global filename indexes are not scoped to cwd')
  if (
    args.some((arg) =>
      [
        '--follow',
        '--dereference',
        '--dereference-command-line',
        '--dereference-recursive'
      ].includes(arg)
    )
  )
    return denied('following directory links can leave cwd')
  if (['grep', 'egrep', 'fgrep'].includes(name) && args.some((arg) => /^-[^-]*R/.test(arg)))
    return denied('recursive grep with -R follows directory links')
  if (name === 'rg' && args.some((arg) => /^-[^-]*L/.test(arg)))
    return denied('ripgrep with -L follows directory links')
  if (name === 'find') {
    if (args.some((arg) => /^-(D|O)/.test(arg)))
      return denied('find startup options require an explicit scoped command')
    if (
      args.some((arg) =>
        ['-L', '-H', '-f', '-files0-from', '-exec', '-execdir', '-ok', '-okdir'].includes(arg)
      )
    )
      return denied(
        'indirect find roots, link following, and nested execution need an explicit scoped command'
      )
    const roots: string[] = []
    for (const arg of args) {
      if (['-P', '-E', '-X', '-s', '-d', '-x', '--'].includes(arg)) continue
      if (arg.startsWith('-') || arg === '!' || arg === '(') {
        if (!roots.length) return denied('find options require an explicit search root')
        break
      }
      roots.push(arg)
    }
    return roots.length ? roots : ['.']
  }
  if (name === 'mdfind') {
    const index = args.indexOf('-onlyin')
    if (index < 0 || !args[index + 1]) return denied('mdfind requires -onlyin inside cwd')
    return args.flatMap((arg, offset) => (arg === '-onlyin' ? [args[offset + 1] ?? ''] : []))
  }
  const paths: string[] = []
  const optionPaths: string[] = []
  let explicitPattern = false
  let endOptions = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!endOptions && arg === '--') {
      endOptions = true
      continue
    }
    if (!endOptions && arg.startsWith('-') && arg !== '-') {
      const [option] = arg.split('=', 1)
      // -L means files-without-match in grep, but link following in traversal utilities.
      if (
        (['ls', 'du'].includes(name) && /^-[^-]*[LH]/.test(arg)) ||
        (name === 'tree' && /^-[^-]*l/.test(arg)) ||
        (['fd', 'fdfind'].includes(name) && /^-[^-]*L/.test(arg))
      )
        return denied('following directory links can leave cwd')
      if (
        ['fd', 'fdfind'].includes(name) &&
        ['-x', '-X', '--exec', '--exec-batch'].includes(option)
      )
        return denied('nested search execution requires a separate scoped command')
      const optionOwner = ['egrep', 'fgrep'].includes(name)
        ? 'grep'
        : name === 'fdfind'
          ? 'fd'
          : name
      if (valueOptions[optionOwner]?.has(option)) {
        if (!arg.startsWith('--') && arg.includes('='))
          return denied('attached short option values cannot be resolved')
        if (option === '-e' || option === '--regexp' || option === '-f' || option === '--file')
          explicitPattern = true
        if (!arg.includes('=')) {
          if (++index >= args.length) return denied(`missing value for ${option}`)
        }
        if (
          ['-f', '--file', '--ignore-file', '--exclude-from'].includes(option) ||
          (optionOwner === 'du' && option === '-X')
        ) {
          const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index]
          if (!value || value === '-') return denied('search option files require a scoped path')
          optionPaths.push(value)
        }
      } else if (flagOptions.has(option) || /^-[a-zA-Z0-9]+$/.test(arg)) {
        // Only argument-free short options can be clustered. Attached option values are ambiguous.
        const flags =
          name === 'rg'
            ? 'inHhclLqsvwFxzUaouP0'
            : ['grep', 'egrep', 'fgrep'].includes(name)
              ? 'rinHhclLqsvwFxzEaobRZI'
              : name === 'ls'
                ? 'RalAdhiltSr1Fpn'
                : name === 'du'
                  ? 'achskmxP'
                  : name === 'tree'
                    ? 'adfiprsuC'
                    : 'HhIislap0'
        if (!arg.startsWith('--') && [...arg.slice(1)].some((flag) => !flags.includes(flag)))
          return denied(`unresolved ${name} option ${arg}`)
      } else return denied(`unresolved ${name} option ${arg}`)
      continue
    }
    paths.push(arg)
  }
  if (
    ['rg', 'grep', 'egrep', 'fgrep', 'fd', 'fdfind'].includes(name) &&
    !args.includes('--files') &&
    !explicitPattern
  )
    paths.shift()
  return [...(paths.length ? paths : ['.']), ...optionPaths]
}

export const assertShellSearchScope = async (
  command: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal
): Promise<void> => {
  const root = await physicalPath(resolve(cwd))
  if (dirname(root) === root) return denied('the session cwd must not be a filesystem root')
  const check = async (path: string, state: State): Promise<void> => {
    if (!path || (!isAbsolute(path) && !state.cwd))
      return denied('the search directory cannot be resolved')
    const target = resolve(state.cwd ?? root, path)
    if (!inside(root, target) || !inside(root, await physicalPath(target)))
      return denied('the search directory is outside the session cwd')
  }
  const analyze = async (source: string, state: State, depth = 0): Promise<void> => {
    if (depth > 8) return denied('nested shell commands are too deeply wrapped to resolve')
    // Walk synchronously while the tree is alive. Defer filesystem checks using only plain
    // strings and state snapshots, never tree-sitter nodes.
    const checks: (() => Promise<void>)[] = []
    const parsed = await withParsedNotebookSource('bash', source, (rootNode) => {
      const functions = new Set(
        rootNode
          .descendantsOfType('function_definition')
          .map((node) => node.childForFieldName('name')?.text)
      )
      const visit = (node: Node, context: State): void => {
        if (node.type === 'variable_assignment') {
          const name = node.childForFieldName('name')?.text
          if (name === 'BASH_ENV' || name === 'ENV')
            return denied('shell startup files cannot be inspected')
          const value = literal(node.childForFieldName('value'), context, true)
          if (name) {
            if (value === undefined) context.variables.delete(name)
            else context.variables.set(name, value)
          }
        }
        if (node.type === 'command') {
          const name = literal(node.childForFieldName('name'), context)
          const argNodes = fieldChildren(node, 'argument')
          const args = argNodes.map((arg) => literal(arg, context))
          if (
            node.namedChildren.some(
              (child) => child.type === 'variable_assignment' && /^(BASH_ENV|ENV)=/.test(child.text)
            )
          )
            return denied('shell startup files cannot be inspected')
          if (!name) return denied('the command name cannot be resolved')
          let tool: string | undefined = commandName(name)
          let values = args
          while (
            tool &&
            [
              'command',
              'builtin',
              'exec',
              'env',
              'time',
              'busybox',
              'rtk',
              'nice',
              'nohup',
              'timeout',
              'stdbuf',
              'sudo'
            ].includes(tool)
          ) {
            let offset = 0
            if (tool === 'rtk' && values[0] === 'proxy') offset++
            if (tool === 'timeout') {
              if (!values[0] || values[0].startsWith('-'))
                return denied('timeout wrapper options cannot be resolved')
              offset++
            }
            if (tool === 'nice' && values[0] === '-n') offset = 2
            if (tool === 'stdbuf') {
              while (values[offset] && /^-[ioe].+/.test(values[offset]!)) offset++
            }
            if (tool === 'sudo' && values[0]?.startsWith('-'))
              return denied('sudo options can change the command scope')
            while (
              /^[A-Za-z_][A-Za-z0-9_]*=/.test(values[offset] ?? '') ||
              values[offset] === '--' ||
              (tool === 'env' && values[offset] === '-i')
            ) {
              if (/^(BASH_ENV|ENV)=/.test(values[offset] ?? ''))
                return denied('shell startup files cannot be inspected')
              offset++
            }
            if (!values[offset] || values[offset]?.startsWith('-'))
              return denied('the command wrapper cannot be resolved')
            tool = values[offset] && commandName(values[offset]!)
            values = values.slice(offset + 1)
          }
          if (functions.has(tool)) {
            context.cwd = undefined
            context.variables.clear()
          }
          if (tool === 'xargs')
            return denied('xargs search arguments depend on input; use a direct scoped search')
          if (tool === 'printf' && values.includes('-v')) context.variables.clear()
          if (tool === 'alias') return denied('aliases can hide search commands')
          if (tool === 'hash') return denied('command rebinding can hide search commands')
          if (tool === 'trap') return denied('shell traps can change the search context')
          if (
            tool === 'ln' ||
            tool === 'link' ||
            (tool === 'cp' &&
              values.some((value) => value === '--symbolic-link' || /^-[^-]*s/.test(value ?? '')))
          )
            return denied('link creation can change search paths after inspection')
          if (tool === 'source' || tool === '.')
            return denied('sourced shell files cannot be inspected; use an inline shell command')
          if (['read', 'export', 'declare', 'typeset', 'local'].includes(tool ?? '')) {
            context.variables.clear()
          }
          if (tool === 'cd' || tool === 'pushd' || tool === 'popd') {
            context.cwd =
              values.length === 1 && values[0] && context.cwd
                ? resolve(context.cwd, values[0])
                : undefined
          } else if (tool && searchTools.has(tool)) {
            if (values.some((value) => value === undefined))
              return denied('a search argument contains an unresolved expansion or glob')
            const roots = rootsFor(tool, values as string[])
            const snapshot = { ...context }
            for (const path of roots) checks.push(() => check(path, snapshot))
          } else if (tool === 'eval') {
            if (values.some((value) => value === undefined))
              return denied('eval cannot be resolved')
            const script = values.join(' ')
            const snapshot = { cwd: context.cwd, variables: new Map(context.variables) }
            checks.push(() => analyze(script, snapshot, depth + 1))
            context.cwd = undefined
            context.variables.clear()
          } else if (tool && shells.has(tool)) {
            const index = values.findIndex((value) => value !== undefined && /^-[^-]*c/.test(value))
            // Only accept simple execution flags before the inline payload. A positional
            // script or an option with its own operand must not be mistaken for `-c` input.
            const flags = index >= 0 ? values.slice(0, index + 1) : values
            if (flags.some((value) => !value || !/^-[ceuvxs]+$/.test(value)))
              return denied('shell script files and unresolved shell options cannot be inspected')
            if (index >= 0) {
              const script = values[index + 1]
              if (script === undefined) return denied('the nested shell command cannot be resolved')
              const snapshot = { cwd: context.cwd, variables: new Map(context.variables) }
              checks.push(() => analyze(script, snapshot, depth + 1))
            } else {
              const redirected = node.parent?.type === 'redirected_statement' ? node.parent : node
              const redirects = redirected.descendantsOfType([
                'heredoc_redirect',
                'herestring_redirect',
                'file_redirect'
              ])
              if (
                redirects.length !== 1 ||
                redirects[0].type === 'file_redirect' ||
                !['', '0'].includes(redirects[0].childForFieldName('descriptor')?.text ?? '')
              )
                return denied('the shell requires one unambiguous inline stdin source')
              const hereString = node.descendantsOfType('herestring_redirect')[0]
              if (hereString) {
                const script = literal(hereString.namedChild(0), context)
                if (script === undefined) return denied('the shell here-string cannot be resolved')
                const snapshot = { cwd: context.cwd, variables: new Map(context.variables) }
                checks.push(() => analyze(script, snapshot, depth + 1))
              }
              const body =
                node.parent?.type === 'redirected_statement'
                  ? node.parent.descendantsOfType('heredoc_body')[0]
                  : undefined
              if (!hereString && !body)
                return denied('the shell requires a statically resolvable inline command')
              if (body) {
                const script = body.text
                const snapshot = { cwd: context.cwd, variables: new Map(context.variables) }
                checks.push(() => analyze(script, snapshot, depth + 1))
              }
            }
          }
          // Substitutions execute even in non-search commands; quoted ordinary text does not.
          for (const arg of node.namedChildren) {
            for (const child of arg.descendantsOfType([
              'command_substitution',
              'process_substitution'
            ]))
              visit(child, { ...context, variables: new Map(context.variables) })
          }
          return
        }
        if (node.type === 'pipeline') {
          for (const child of node.namedChildren)
            visit(child, { ...context, variables: new Map(context.variables) })
          return
        }
        const scoped = [
          'subshell',
          'command_substitution',
          'process_substitution',
          'function_definition'
        ].includes(node.type)
        const next = scoped ? { ...context, variables: new Map(context.variables) } : context
        // Control flow can change paths/variables in ways this preflight does not evaluate.
        if (
          [
            'if_statement',
            'for_statement',
            'while_statement',
            'case_statement',
            'function_definition'
          ].includes(node.type)
        ) {
          next.cwd = undefined
          next.variables.clear()
        }
        for (const child of node.namedChildren) {
          if (node.type === 'list' && node.children.some((part) => part.type === '||')) {
            next.cwd = undefined
            next.variables.clear()
          }
          visit(
            child,
            child.nextSibling?.type === '&' ? { ...next, variables: new Map(next.variables) } : next
          )
        }
        if (
          ['if_statement', 'for_statement', 'while_statement', 'case_statement'].includes(node.type)
        ) {
          next.cwd = undefined
          next.variables.clear()
        }
      }
      visit(rootNode, state)
    })
    // Run deferred checks only after the complete syntax walk succeeds.
    for (const check of checks) await check()
    if (parsed.state !== 'ok') return denied('the shell syntax could not be parsed')
  }
  if (platform === 'win32') {
    const commands = await parsePowerShellSearchCommands(command, signal)
    const normalize = (name: string): string =>
      name
        .split(/[\\/]/)
        .at(-1)!
        .replace(/\.exe$/i, '')
        .toLowerCase()
    const moved = commands.some(
      (entry) =>
        entry.name &&
        [
          'cd',
          'chdir',
          'sl',
          'set-location',
          'pushd',
          'popd',
          'push-location',
          'pop-location'
        ].includes(normalize(entry.name))
    )
    for (const entry of commands) {
      if (!entry.name) return denied('the PowerShell command name cannot be resolved')
      const name = normalize(entry.name)
      // The unqualified PowerShell alias filters pipeline objects; executable paths do not.
      if (
        /^where$/i.test(entry.name) &&
        !entry.arguments.some((arg) => arg?.toLowerCase() === '/r')
      )
        continue
      if (
        [
          'cmd',
          'powershell',
          'pwsh',
          'iex',
          'invoke-expression',
          'wsl',
          'bash',
          'sh',
          'start-process',
          'saps',
          'start'
        ].includes(name)
      )
        return denied('nested Windows shell execution requires a direct scoped PowerShell command')
      if (['set-alias', 'new-alias', 'sal', 'nal'].includes(name))
        return denied('aliases can hide search commands')
      if (
        ['new-item', 'ni'].includes(name) &&
        entry.arguments.some((arg) => /^(symboliclink|junction|hardlink)$/i.test(arg ?? ''))
      )
        return denied('link creation can change search paths after inspection')
      if (
        [
          'new-item',
          'ni',
          'set-item',
          'si',
          'copy-item',
          'cpi',
          'cp',
          'copy',
          'move-item',
          'mi',
          'mv',
          'move',
          'rename-item',
          'rni',
          'ren',
          'clear-item',
          'cli',
          'remove-item',
          'ri',
          'rm',
          'rmdir',
          'rd',
          'del',
          'erase'
        ].includes(name) &&
        (moved ||
          entry.arguments.some(
            (arg) => arg === null || /(?:^|[\\:])(?:alias|function):/i.test(arg)
          ))
      )
        return denied('provider mutations can hide search commands')
      const nativeDiscovery = [
        'get-childitem',
        'gci',
        'dir',
        'ls',
        'get-item',
        'gi',
        'select-string',
        'sls'
      ].includes(name)
      if (!nativeDiscovery && !searchTools.has(name) && name !== 'where') continue
      if (entry.arguments.some((arg) => arg === null))
        return denied('a PowerShell search argument contains an unresolved expression')
      const args = entry.arguments as string[]
      const paths: string[] = []
      if (nativeDiscovery) {
        for (let index = 0; index < args.length; index++) {
          const arg = args[index]
          if (arg.startsWith('-')) {
            const option = arg.toLowerCase()
            if (['-path', '-literalpath'].includes(option)) {
              paths.push(args[++index] ?? '')
              continue
            }
            if (
              [
                '-filter',
                '-include',
                '-exclude',
                '-depth',
                '-pattern',
                '-encoding',
                '-context'
              ].includes(option)
            ) {
              index++
              continue
            }
            if (
              [
                '-recurse',
                '-force',
                '-file',
                '-directory',
                '-name',
                '-hidden',
                '-allmatches',
                '-casesensitive',
                '-simplematch',
                '-list',
                '-quiet',
                '-notmatch',
                '-raw'
              ].includes(option)
            )
              continue
            return denied('the PowerShell search option cannot be resolved')
          }
          paths.push(arg)
        }
      } else if (name === 'where') {
        const index = args.findIndex((arg) => arg.toLowerCase() === '/r')
        if (index < 0) return denied('where requires an explicit /r directory')
        paths.push(args[index + 1] ?? '')
      } else paths.push(...rootsFor(name, args))
      for (const path of paths.length ? paths : ['.']) {
        if (/[~*?[\]{}]/.test(path) || (path.includes(':') && !/^[a-z]:[\\/][^:]*$/i.test(path)))
          return denied(
            'the PowerShell search directory contains an unresolved wildcard, provider, or drive-relative path'
          )
        await check(path, { cwd: moved ? undefined : root, variables: new Map() })
      }
    }
    return
  }
  await analyze(command, { cwd: root, variables: new Map() })
}
