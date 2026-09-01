import { Buffer } from 'node:buffer'
import { realpathSync } from 'node:fs'
import { join, posix, resolve, win32 } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'

export type NotebookExecutionSurface = NotebookLanguage | 'bash' | 'powershell' | 'repl'

export type ManagedRuntimeMutation = {
  installer: string
  message: string
}

export type RuntimeProcessInvocation = {
  executable: string
  args: string[]
}

type MutationRule = {
  installer: string
  pattern: RegExp
}

// These are the package/environment writers an Agent might reach from bash, Python, or R instead of
// the trusted manage_packages path. Patterns require an actual mutating verb/call so ordinary package
// imports and version inspection remain available.
const PACKAGE_MUTATION_RULES: MutationRule[] = [
  {
    installer: 'conda/mamba',
    pattern:
      /\b(?:micromamba|mamba|conda)(?:\.exe)?\b[\s\S]{0,200}\b(?:install|update|upgrade|remove|uninstall|create|env\s+(?:create|remove|update))\b/iu
  },
  {
    installer: 'pip',
    pattern:
      /\b(?:pip|pip3|pipx)(?:\.\d+)?(?:\.exe)?\b[\s\S]{0,160}\b(?:install|uninstall|inject|upgrade|wheel)\b/iu
  },
  {
    installer: 'Python venv/ensurepip',
    pattern:
      /\b(?:python|python3|py)(?:\.\d+)?(?:\.exe)?\b[\s\S]{0,100}\s-m\s+(?:(?:venv|virtualenv|ensurepip)\b|pip\b[\s\S]{0,100}\b(?:install|uninstall|wheel)\b)/iu
  },
  {
    installer: 'Python venv',
    pattern: /\b(?:venv\s*\.\s*create|EnvBuilder|virtualenv)\s*\(/iu
  },
  {
    installer: 'uv',
    pattern:
      /\buv(?:\.exe)?\b[\s\S]{0,120}\b(?:add|remove|sync|venv|pip\s+install|pip\s+uninstall)\b/iu
  },
  {
    installer: 'Poetry',
    pattern: /\bpoetry(?:\.exe)?\b[\s\S]{0,120}\b(?:add|remove|install|update|sync)\b/iu
  },
  {
    installer: 'R install.packages',
    pattern: /(?:^|[^\w.])(?:(?:utils)\s*(?:::|:::)\s*)?(?:install|remove|update)\.packages\b/iu
  },
  {
    installer: 'R package installer',
    pattern:
      /\b(?:BiocManager|renv|pak|remotes|devtools)\s*(?:::|:::)\s*(?:install|restore|update|hydrate|pkg_install|pkg_remove|lockfile_install|install_[A-Za-z0-9_.]+)\b/iu
  },
  {
    installer: 'R CMD INSTALL',
    pattern: /\bR(?:\.exe)?\s+CMD\s+INSTALL\b/iu
  },
  {
    installer: 'system package manager',
    pattern:
      /\b(?:brew|apt|apt-get|yum|dnf|pacman|zypper|apk|choco|winget)(?:\.exe)?\b[\s\S]{0,100}\b(?:install|remove|uninstall|upgrade|update)\b/iu
  }
]

const RUNTIME_WRITE_RULES: Record<NotebookExecutionSurface, RegExp> = {
  bash: /\b(?:rm|mv|cp|install|mkdir|touch|truncate|chmod|chown|ln|tee|sed|perl|dd)\b/iu,
  powershell:
    /\b(?:New-Item|Remove-Item|Set-Content|Add-Content|Clear-Content|Out-File|Copy-Item|Move-Item|Rename-Item)\b/iu,
  python:
    /\b(?:open|Path\s*\([^)]*\)\s*\.(?:write_[A-Za-z0-9_]+|touch|mkdir|rename|replace|unlink)|os\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|chmod|chown|truncate)|shutil\.(?:copy|copy2|copytree|move|rmtree))\s*\(/iu,
  r: /\b(?:unlink|file\.(?:append|copy|remove|rename|link|symlink|create)|dir\.create|download\.file|fifo|pipe|writeLines|writeBin|save|saveRDS)\s*\(/iu,
  repl: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|copyFile|copyFileSync)\s*\(/iu
}

const guardPathApi = (platform: NodeJS.Platform): typeof posix =>
  platform === 'win32' ? win32 : posix

const canonicalGuardPath = (
  value: string,
  cwd: string,
  platform: NodeJS.Platform
): string | undefined => {
  const raw = value.trim().replace(/^(?:(["']))([\s\S]*)\1$/u, '$2')
  if (!raw || /[$%`<>|;&\r\n]/u.test(raw)) return undefined
  const pathApi = guardPathApi(platform)
  const absolute = pathApi.resolve(cwd, raw)
  let cursor = absolute
  const suffix: string[] = []
  while (true) {
    try {
      return pathApi.resolve(realpathSync(cursor), ...suffix)
    } catch {
      const parent = pathApi.dirname(cursor)
      if (parent === cursor) return absolute
      suffix.unshift(pathApi.basename(cursor))
      cursor = parent
    }
  }
}

const canonicalPathIsWithin = (
  candidate: string,
  root: string,
  platform: NodeJS.Platform
): boolean => {
  const pathApi = guardPathApi(platform)
  const normalizedCandidate = platform === 'win32' ? candidate.toLowerCase() : candidate
  const normalizedRoot = platform === 'win32' ? root.toLowerCase() : root
  const pathFromRoot = pathApi.relative(normalizedRoot, normalizedCandidate)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(pathFromRoot))
  )
}

const referencesManagedRuntimePath = (
  source: string,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform
): boolean => {
  const pathApi = guardPathApi(platform)
  const canonical = pathApi.resolve(runtimeRoot)
  const variants = new Set([
    canonical,
    canonical.replaceAll('\\', '/'),
    canonical.replaceAll('/', '\\'),
    runtimeRoot,
    runtimeRoot.replaceAll('\\', '/'),
    runtimeRoot.replaceAll('/', '\\')
  ])
  for (const candidate of variants) {
    if (!candidate) continue
    for (
      let index = source.indexOf(candidate);
      index >= 0;
      index = source.indexOf(candidate, index + 1)
    ) {
      const before = source[index - 1]
      const after = source[index + candidate.length]
      const startsAtPathBoundary = before === undefined || /[\s'"`([{=,:+]/u.test(before)
      const endsAtDirectoryBoundary = after === undefined || /[\\/\s'"`\])},:;]/u.test(after)
      if (startsAtPathBoundary && endsAtDirectoryBoundary) return true
    }
  }
  if (/(?:^|[^A-Za-z0-9_])OPEN_SCIENCE_RUNTIME_DIR(?:$|[^A-Za-z0-9_])/u.test(source)) {
    return true
  }
  const canonicalTarget = canonicalGuardPath(source, cwd, platform)
  const canonicalRoot = canonicalGuardPath(runtimeRoot, cwd, platform)
  return Boolean(
    canonicalTarget &&
    canonicalRoot &&
    canonicalPathIsWithin(canonicalTarget, canonicalRoot, platform)
  )
}

// Replaces quoted literals and comments with spaces while preserving line/column positions. Direct
// R/Python calls remain visible, but documentation such as `print("pip install pandas")` does not
// become an installer request merely because it names one. If the cell also contains a real dynamic
// execution bridge (subprocess/system/eval), the original source is scanned as a second candidate.
const maskQuotedAndCommentText = (source: string): string => {
  const chars = [...source]
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    if (char === '#') {
      while (index < chars.length && chars[index] !== '\n') chars[index++] = ' '
      continue
    }
    if (char !== "'" && char !== '"') {
      index += 1
      continue
    }

    const quote = char
    const triple = chars[index + 1] === quote && chars[index + 2] === quote
    const width = triple ? 3 : 1
    for (let offset = 0; offset < width; offset += 1) chars[index + offset] = ' '
    index += width
    while (index < chars.length) {
      if (chars[index] === '\\') {
        chars[index++] = ' '
        if (index < chars.length) chars[index++] = ' '
        continue
      }
      if (
        chars[index] === quote &&
        (!triple || (chars[index + 1] === quote && chars[index + 2] === quote))
      ) {
        for (let offset = 0; offset < width; offset += 1) chars[index + offset] = ' '
        index += width
        break
      }
      if (chars[index] !== '\n') chars[index] = ' '
      index += 1
    }
  }
  return chars.join('')
}

// JavaScript has two additional literal/comment forms that the Python/R masker does not: template
// strings and // / /* */ comments. Keep installer-looking documentation inert on the control REPL.
const maskJavascriptQuotedAndCommentText = (source: string): string => {
  const chars = [...source]
  let index = 0
  while (index < chars.length) {
    if (chars[index] === '/' && chars[index + 1] === '/') {
      chars[index++] = ' '
      chars[index++] = ' '
      while (index < chars.length && chars[index] !== '\n') chars[index++] = ' '
      continue
    }
    if (chars[index] === '/' && chars[index + 1] === '*') {
      chars[index++] = ' '
      chars[index++] = ' '
      while (index < chars.length) {
        if (chars[index] === '*' && chars[index + 1] === '/') {
          chars[index++] = ' '
          chars[index++] = ' '
          break
        }
        if (chars[index] !== '\n') chars[index] = ' '
        index += 1
      }
      continue
    }
    const quote = chars[index]
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      index += 1
      continue
    }
    chars[index++] = ' '
    while (index < chars.length) {
      if (chars[index] === '\\') {
        chars[index++] = ' '
        if (index < chars.length) chars[index++] = ' '
        continue
      }
      if (chars[index] === quote) {
        chars[index++] = ' '
        break
      }
      if (chars[index] !== '\n') chars[index] = ' '
      index += 1
    }
  }
  return chars.join('')
}

const stripShellComments = (source: string): string =>
  source
    .split(/\r?\n/u)
    .map((line) => {
      let quote: "'" | '"' | undefined
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]
        if (char === '\\') {
          index += 1
          continue
        }
        if (quote) {
          if (char === quote) quote = undefined
          continue
        }
        if (char === "'" || char === '"') {
          quote = char
          continue
        }
        if (char === '#' && (index === 0 || /\s/u.test(line[index - 1]))) {
          return line.slice(0, index)
        }
      }
      return line
    })
    .join('\n')

// Resolve simple shell literal assignments before policy matching. Agent-generated shell commonly uses
// `tool=python3; action=venv; "$tool" -m "$action" ...`; inspecting only the lexical command names would
// miss the exact same package mutation once routed through variables. This intentionally handles only
// literal assignments—native macOS filesystem isolation remains the hard boundary for arbitrary shell
// computation and path construction.
const resolveShellLiteralAssignments = (source: string): string => {
  const values = new Map<string, string>()
  const assignment =
    /(^|[;\r\n]|\s)([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\((?:\\.|[^)\\])*\)|[^\s;]+)/gmu
  const commands = source.replace(
    assignment,
    (whole, prefix: string, name: string, raw: string) => {
      const value =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw
      values.set(name, value)
      return `${prefix}${' '.repeat(Math.max(0, whole.length - prefix.length))}`
    }
  )
  const expanded = commands.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (token, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare
      return name ? (values.get(name) ?? token) : token
    }
  )
  // Unquote only simple argv words so expanded command/flag variables remain executable to the
  // scanners. Preserve quoted payloads containing spaces or separators; removing those quotes would
  // incorrectly promote a nested shell's `;` into the parent command sequence.
  return expanded.replace(/(["'])([^"'\\\s;&|]+)\1/gu, '$2')
}

const EXECUTION_BRIDGES: Record<NotebookExecutionSurface, RegExp> = {
  bash: /\b(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?\b[^\n]{0,80}\s(?:-c|\/c)\b|\beval\b/iu,
  powershell: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,80}\s(?:-Command|-EncodedCommand)\b/iu,
  python:
    /\b(?:subprocess\.(?:run|call|Popen|check_call|check_output)|os\.system|os\.popen|pip(?:\._internal(?:\.cli\.main)?)?\.main|exec|eval)\s*\(/iu,
  r: /\b(?:system|system2|pipe|do\.call|get|match\.fun|eval|parse)\s*\(/iu,
  repl: /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|eval)\s*\(|\bchild_process\s*\.\s*(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/iu
}

const matchingCall = (
  source: string,
  matchIndex: number,
  openIndex?: number
): string | undefined => {
  const open = openIndex ?? source.indexOf('(', matchIndex)
  if (open < 0) return undefined
  let depth = 0
  let quote: "'" | '"' | '`' | undefined
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '(') {
      depth += 1
    } else if (char === ')' && --depth === 0) {
      return source.slice(matchIndex, index + 1)
    }
  }
  return undefined
}

const callArguments = (call: string, openIndex: number): string[] => {
  const args: string[] = []
  let start = openIndex + 1
  let depth = 0
  let quote: "'" | '"' | '`' | undefined
  for (let index = start; index < call.length; index += 1) {
    const char = call[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      if (char === ')' && depth === 0) {
        const tail = call.slice(start, index).trim()
        if (tail || args.length > 0) args.push(tail)
        return args
      }
      depth -= 1
    } else if (char === ',' && depth === 0) {
      args.push(call.slice(start, index).trim())
      start = index + 1
    }
  }
  return args
}

const namedOrPositionalArgument = (
  args: string[],
  name: string,
  position: number
): string | undefined => {
  const named = args.find((arg) => new RegExp(`^${name}\\s*=`, 'iu').test(arg))
  return named ? named.replace(new RegExp(`^${name}\\s*=\\s*`, 'iu'), '') : args[position]
}

const runtimeWriteTargets = (
  surface: Exclude<NotebookExecutionSurface, 'bash'>,
  call: string,
  operation: string,
  openIndex: number
): string[] => {
  const args = callArguments(call, openIndex)
  const op = operation.toLowerCase()

  if (surface === 'python') {
    if (/^open\b/u.test(op)) {
      const mode = namedOrPositionalArgument(args, 'mode', 1)
      if (!mode || /^['"]r[bt]?['"]$/iu.test(mode.trim())) return []
      return args[0] ? [args[0]] : []
    }
    if (/^path\s*\(/u.test(op)) {
      const path = call.match(/^Path\s*\(([\s\S]*?)\)\s*\./u)?.[1]
      if (!path) return []
      return /\.(?:rename|replace)\b/iu.test(operation) && args[0] ? [path, args[0]] : [path]
    }
    if (/shutil\.(?:copy|copy2|copytree)\b/u.test(op)) return args[1] ? [args[1]] : []
    if (/shutil\.move\b/u.test(op)) return args.slice(0, 2)
    if (/os\.(?:rename|replace)\b/u.test(op)) return args.slice(0, 2)
    return args[0] ? [args[0]] : []
  }

  if (surface === 'r') {
    if (/\bfile\.(?:rename|link|symlink)\b/u.test(op)) return args.slice(0, 2)
    if (/\bfile\.copy\b/u.test(op)) return args[1] ? [args[1]] : []
    if (/\bdownload\.file\b/u.test(op)) {
      const target = namedOrPositionalArgument(args, 'destfile', 1)
      return target ? [target] : []
    }
    if (/\bfifo\b/u.test(op)) {
      const mode = namedOrPositionalArgument(args, 'open', 1)
      if (!mode || !/[wax+]/iu.test(mode)) return []
      const target = namedOrPositionalArgument(args, 'description', 0)
      return target ? [target] : []
    }
    if (/\bpipe\b/u.test(op)) {
      const command = namedOrPositionalArgument(args, 'description', 0)?.trim()
      const quote = command?.[0]
      if (!command || (quote !== "'" && quote !== '"') || command.at(-1) !== quote) return []
      return shellRuntimeWriteTargets(command.slice(1, -1))
    }
    if (/\b(?:writelines|writebin)\b/u.test(op)) {
      const target = namedOrPositionalArgument(args, 'con', 1)
      return target ? [target] : []
    }
    if (/\bsave\s*\(/u.test(op)) {
      const target = namedOrPositionalArgument(args, 'file', Number.MAX_SAFE_INTEGER)
      return target ? [target] : []
    }
    if (/\bsaverds\b/u.test(op)) {
      const target = namedOrPositionalArgument(args, 'file', 1)
      return target ? [target] : []
    }
    return args[0] ? [args[0]] : []
  }

  if (/\b(?:rename|renamesync)\b/u.test(op)) return args.slice(0, 2)
  if (/\b(?:copyfile|copyfilesync)\b/u.test(op)) return args[1] ? [args[1]] : []
  return args[0] ? [args[0]] : []
}

const shellWords = (command: string): string[] =>
  command.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^\s])+/gu) ?? []

const shellCommandSegments = (source: string): string[] => {
  const segments: string[] = []
  let start = 0
  let quote: "'" | '"' | '`' | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (!/[;\r\n|&]/u.test(char)) continue
    segments.push(source.slice(start, index))
    start = index + 1
  }
  segments.push(source.slice(start))
  return segments
}

const shellRedirectionTargets = (command: string): string[] => {
  const targets: string[] = []
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char !== '>' || command[index + 1] === '&') continue
    if (command[index + 1] === '>') index += 1
    while (/\s/u.test(command[index + 1] ?? '')) index += 1
    if (command[index + 1] === '|') index += 1
    const start = index + 1
    const targetQuote = command[start]
    if (targetQuote === "'" || targetQuote === '"') {
      let end = start + 1
      while (end < command.length && command[end] !== targetQuote) {
        if (command[end] === '\\') end += 1
        end += 1
      }
      targets.push(command.slice(start, Math.min(end + 1, command.length)))
      index = end
      continue
    }
    let end = start
    while (end < command.length && !/[\s;&|]/u.test(command[end])) end += 1
    const target = command.slice(start, end)
    if (target && !/^&?\d+$/u.test(target)) targets.push(target)
    index = end - 1
  }
  return targets
}

const shellRuntimeWriteTargetsFromWords = (
  words: string[],
  redirections: string[] = [],
  requireExecutablePosition = false
): string[] => {
  const commandIndex = words.findIndex((word) =>
    /^(?:rm|mv|cp|install|mkdir|touch|truncate|chmod|chown|ln|tee|sed|perl|dd)(?:\.exe)?$/iu.test(
      word
        .replace(/^['"]|['"]$/gu, '')
        .split(/[\\/]/u)
        .at(-1) ?? ''
    )
  )
  if (commandIndex < 0) return redirections
  if (
    requireExecutablePosition &&
    commandIndex > 0 &&
    !words.slice(0, commandIndex).every((word) => {
      const token = unquoteWord(word)
      return (
        /^(?:sudo|env|command|exec)$/u.test(token) ||
        token.startsWith('-') ||
        /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)
      )
    })
  ) {
    return redirections
  }
  const executable =
    words[commandIndex]
      .replace(/^['"]|['"]$/gu, '')
      .split(/[\\/]/u)
      .at(-1) ?? ''
  const args = words.slice(commandIndex + 1)
  const targetDirectory = args
    .find((arg) => /^--target-directory=/iu.test(arg))
    ?.split(/=(.*)/su)[1]
  const shortTargetIndex = args.findIndex((arg) => arg === '-t')
  if (targetDirectory) return [...redirections, targetDirectory]
  if (shortTargetIndex >= 0 && args[shortTargetIndex + 1]) {
    return [...redirections, args[shortTargetIndex + 1]]
  }

  if (/^dd(?:\.exe)?$/iu.test(executable)) {
    return [
      ...redirections,
      ...args.filter((arg) => /^of=/iu.test(arg)).map((arg) => arg.slice(arg.indexOf('=') + 1))
    ]
  }
  const positional = args.filter((arg) => !arg.startsWith('-'))
  if (/^ln(?:\.exe)?$/iu.test(executable)) {
    // A link outside the runtime can become a durable write alias back into it, so protect both the
    // source and destination instead of treating only the newly-created link path as a write target.
    return [...redirections, ...positional]
  }
  if (/^(?:cp|install)(?:\.exe)?$/iu.test(executable)) {
    return [...redirections, ...positional.slice(-1)]
  }
  if (/^mv(?:\.exe)?$/iu.test(executable)) return [...redirections, ...positional]
  if (/^(?:chmod|chown)(?:\.exe)?$/iu.test(executable)) {
    return [...redirections, ...positional.slice(1)]
  }
  if (/^(?:sed|perl)(?:\.exe)?$/iu.test(executable)) {
    return args.some((arg) => /^-.*i/u.test(arg))
      ? [...redirections, ...positional.slice(-1)]
      : redirections
  }
  return [...redirections, ...positional]
}

const shellRuntimeWriteTargets = (command: string): string[] =>
  shellRuntimeWriteTargetsFromWords(shellWords(command), shellRedirectionTargets(command))

const commandName = (word: string | undefined): string =>
  (word ?? '')
    .replace(/^['"]|['"]$/gu, '')
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase() ?? ''

const resolveSequenceCwd = (
  target: string | undefined,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform
): string => {
  if (!target) return cwd
  const unquoted = target.replace(/^['"]|['"]$/gu, '')
  const expanded = unquoted
    .replace(/\$\{?env:OPEN_SCIENCE_RUNTIME_DIR\}?/giu, () => runtimeRoot)
    .replace(/\$\{?OPEN_SCIENCE_RUNTIME_DIR\}?/gu, () => runtimeRoot)
    .replace(/%OPEN_SCIENCE_RUNTIME_DIR%/giu, () => runtimeRoot)
  const pathApi = guardPathApi(platform)
  const normalizedExpanded =
    pathApi.sep === '\\'
      ? expanded.replaceAll('/', pathApi.sep)
      : expanded.replaceAll('\\', pathApi.sep)
  const resolvedTarget = canonicalGuardPath(normalizedExpanded, cwd, platform)
  if (resolvedTarget) return resolvedTarget
  if (referencesManagedRuntimePath(target, runtimeRoot, cwd, platform)) {
    return canonicalGuardPath(runtimeRoot, cwd, platform) ?? pathApi.resolve(cwd, runtimeRoot)
  }
  return pathApi.resolve(cwd, normalizedExpanded)
}

const sequenceTargetWritesRuntime = (
  target: string,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform
): boolean => {
  if (referencesManagedRuntimePath(target, runtimeRoot, cwd, platform)) return true
  // Preserve the existing fail-closed behavior for a dynamic target while the current directory is
  // managed, but allow a statically resolved absolute destination outside the runtime.
  return (
    canonicalGuardPath(target, cwd, platform) === undefined &&
    referencesManagedRuntimePath('.', runtimeRoot, cwd, platform)
  )
}

const shellSequenceWritesRuntime = (
  source: string,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform,
  depth = 0
): boolean => {
  let currentCwd = cwd
  for (const command of shellCommandSegments(source)) {
    const words = shellWords(command)
    const executable = commandName(words[0])
    if (executable === 'cd') {
      const target = words.find((word, index) => index > 0 && !word.startsWith('-'))
      currentCwd = resolveSequenceCwd(target, runtimeRoot, currentCwd, platform)
    }
    const targets = shellRuntimeWriteTargets(command)
    if (
      targets.some((target) =>
        sequenceTargetWritesRuntime(target, runtimeRoot, currentCwd, platform)
      )
    ) {
      return true
    }
    if (referencesManagedRuntimePath('.', runtimeRoot, currentCwd, platform) && depth < 8) {
      const payload = invocationPayload(words)
      if (
        payload?.surface === 'bash' &&
        shellSequenceWritesRuntime(payload.source, runtimeRoot, currentCwd, platform, depth + 1)
      ) {
        return true
      }
      if (
        payload?.surface === 'powershell' &&
        powerShellSequenceWritesRuntime(
          payload.source,
          runtimeRoot,
          currentCwd,
          platform,
          depth + 1
        )
      ) {
        return true
      }
      if (
        payload &&
        payload.surface !== 'bash' &&
        payload.surface !== 'powershell' &&
        hasManagedRuntimeWrite(
          payload.source,
          payload.surface,
          runtimeRoot,
          currentCwd,
          platform,
          depth + 1
        )
      ) {
        return true
      }
    }
  }
  return false
}

const resolvePowerShellLiteralAssignments = (source: string): string => {
  const values = new Map<string, string>()
  const commands = source.replace(
    /(^|[;\r\n])\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\r\n]+)/gmu,
    (whole, prefix: string, name: string, value: string) => {
      values.set(name.toLowerCase(), value.trim())
      return `${prefix}${' '.repeat(Math.max(0, whole.length - prefix.length))}`
    }
  )
  return commands.replace(/\$(?!env:)\{?([A-Za-z_][A-Za-z0-9_]*)\}?/giu, (token, name: string) => {
    return values.get(name.toLowerCase()) ?? token
  })
}

const powerShellRuntimeWriteTargets = (command: string): string[] => {
  const redirections = shellRedirectionTargets(command)
  const words = shellWords(command)
  const executable = commandName(words[0])
  const args = words.slice(1)
  const positional = args.filter((arg) => !arg.startsWith('-'))
  const pathFlag = args.findIndex((arg) => /^-(?:literal)?path$|^-filepath$/iu.test(arg))
  const explicitPath = pathFlag >= 0 ? args[pathFlag + 1] : undefined
  if (/^(?:copy-item|copy|cp|cpi)$/u.test(executable)) {
    return [...redirections, ...positional.slice(-1)]
  }
  if (/^(?:move-item|move|mv|mi|rename-item|rename|ren|rni)$/u.test(executable)) {
    return [...redirections, ...positional]
  }
  if (/^(?:new-item|ni|mkdir|md|remove-item|ri|rm|del|erase|rmdir|rd)$/u.test(executable)) {
    return [...redirections, ...args]
  }
  if (executable === 'mklink') {
    // Either endpoint can create a durable alias into the managed runtime, so treat both the link
    // path and its target as security-relevant rather than allowing a later write through the alias.
    return [...redirections, ...args.filter((arg) => !/^\/[dhj]$/iu.test(arg))]
  }
  if (/^(?:set-content|sc|add-content|ac|clear-content|clc|out-file)$/u.test(executable)) {
    return [...redirections, ...(explicitPath ? [explicitPath] : positional.slice(0, 1))]
  }
  return redirections
}

const powerShellDotNetWritesRuntime = (
  source: string,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform
): boolean => {
  const pattern =
    /\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|AppendAllText|WriteAllBytes|Create|CreateText|AppendText|Move|Replace|Delete|CreateDirectory)\s*\(/giu
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const openIndex = match.index + match[0].lastIndexOf('(')
    const call = matchingCall(source, match.index, openIndex)
    const target = call ? callArguments(call, openIndex - match.index)[0] : undefined
    if (target && referencesManagedRuntimePath(target, runtimeRoot, cwd, platform)) return true
  }
  return false
}

const powerShellSequenceWritesRuntime = (
  source: string,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform,
  depth = 0
): boolean => {
  let currentCwd = cwd
  for (const command of shellCommandSegments(source)) {
    const words = shellWords(command)
    const executable = commandName(words[0])
    if (/^(?:set-location|cd|chdir|sl)$/u.test(executable)) {
      const pathFlag = words.findIndex((word) => /^-(?:literal)?path$/iu.test(word))
      const target =
        pathFlag >= 0
          ? words[pathFlag + 1]
          : words.find((word, index) => index > 0 && !word.startsWith('-'))
      currentCwd = resolveSequenceCwd(target, runtimeRoot, currentCwd, platform)
    }
    const targets = powerShellRuntimeWriteTargets(command)
    if (
      targets.some((target) =>
        sequenceTargetWritesRuntime(target, runtimeRoot, currentCwd, platform)
      )
    ) {
      return true
    }
    if (powerShellDotNetWritesRuntime(command, runtimeRoot, currentCwd, platform)) return true
    if (referencesManagedRuntimePath('.', runtimeRoot, currentCwd, platform) && depth < 8) {
      const payload = invocationPayload(words)
      if (
        payload?.surface === 'bash' &&
        shellSequenceWritesRuntime(payload.source, runtimeRoot, currentCwd, platform, depth + 1)
      ) {
        return true
      }
      if (
        payload?.surface === 'powershell' &&
        powerShellSequenceWritesRuntime(
          payload.source,
          runtimeRoot,
          currentCwd,
          platform,
          depth + 1
        )
      ) {
        return true
      }
      if (
        payload &&
        payload.surface !== 'bash' &&
        payload.surface !== 'powershell' &&
        hasManagedRuntimeWrite(
          payload.source,
          payload.surface,
          runtimeRoot,
          currentCwd,
          platform,
          depth + 1
        )
      ) {
        return true
      }
    }
  }
  return false
}

// Scan only the resolved bridge call rather than restoring every string/comment in the cell. This
// still catches literal subprocess/system/exec payloads, while `print("pip install"); system("echo")`
// remains ordinary output. Dynamically assembled argv is enforced by the persistent runtime hooks;
// macOS additionally has the native Seatbelt layer below this policy. Linux and Windows intentionally
// do not claim a hostile native-code sandbox.
const executionBridgeCandidates = (
  source: string,
  surface: NotebookExecutionSurface,
  maskedSource: string
): string[] => {
  if (surface === 'bash' || surface === 'powershell') return []
  const base = EXECUTION_BRIDGES[surface]
  const flags = base.flags.includes('g') ? base.flags : `${base.flags}g`
  const pattern = new RegExp(base.source, flags)
  const candidates: string[] = []
  for (let match = pattern.exec(maskedSource); match; match = pattern.exec(maskedSource)) {
    const call = matchingCall(source, match.index)
    if (call) candidates.push(call)
    if (match[0].length === 0) pattern.lastIndex += 1
  }
  return candidates
}

type ExecutionPayload = { surface: NotebookExecutionSurface; source: string }

const unquoteWord = (value: string): string =>
  value.replace(/^(["'`])([\s\S]*)\1$/u, '$2').replace(/\\([\\"'`])/gu, '$1')

const invocationPayload = (rawWords: string[]): ExecutionPayload | undefined => {
  const words = rawWords.map(unquoteWord)
  const commandIndex = words[0] === '&' ? 1 : 0
  const executable = commandName(words[commandIndex])
  const flagFor = (pattern: RegExp): string | undefined => {
    const index = words.findIndex((word, position) => position > commandIndex && pattern.test(word))
    return index >= 0 ? words[index + 1] : undefined
  }
  if (/^(?:python|python3|py)(?:\.\d+)?(?:\.exe)?$/u.test(executable)) {
    const source = flagFor(/^-c$/u)
    return source ? { surface: 'python', source } : undefined
  }
  if (/^(?:r|rscript)(?:\.exe)?$/u.test(executable)) {
    const source = flagFor(/^-e$/u)
    return source ? { surface: 'r', source } : undefined
  }
  if (/^(?:node|nodejs)(?:\.exe)?$/u.test(executable)) {
    const source = flagFor(/^(?:-e|--eval)$/u)
    return source ? { surface: 'repl', source } : undefined
  }
  if (/^(?:bash|sh|zsh)(?:\.exe)?$/u.test(executable)) {
    const source = flagFor(/^-c$/u)
    return source ? { surface: 'bash', source } : undefined
  }
  if (/^(?:powershell|pwsh)(?:\.exe)?$/u.test(executable)) {
    const source = flagFor(/^(?:-command|-c)$/iu)
    if (source) return { surface: 'powershell', source }
    const encodedIndex = words.findIndex((word, position) => {
      if (position <= commandIndex || !word.startsWith('-')) return false
      const flag = word.slice(1).toLowerCase()
      return (
        flag === 'e' || flag === 'ec' || (flag.length >= 2 && 'encodedcommand'.startsWith(flag))
      )
    })
    const encoded = encodedIndex >= 0 ? words[encodedIndex + 1] : undefined
    return encoded
      ? { surface: 'powershell', source: Buffer.from(encoded, 'base64').toString('utf16le') }
      : undefined
  }
  if (/^cmd(?:\.exe)?$/u.test(executable)) {
    const flagIndex = words.findIndex(
      (word, position) => position > commandIndex && /^\/c$/iu.test(word)
    )
    const source = flagIndex >= 0 ? words.slice(flagIndex + 1).join(' ') : undefined
    // The Windows command aliases covered by the PowerShell target scanner (copy, move, mkdir,
    // del, redirections, and related forms) also describe the cmd.exe write surface we permit here.
    return source ? { surface: 'powershell', source } : undefined
  }
  return undefined
}

const quotedLiteralValues = (source: string): string[] => {
  const values: string[] = []
  const pattern = /(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*)\1/gu
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    values.push(unquoteWord(match[0]))
  }
  return values
}

const bridgeUsesShellCommandString = (call: string, surface: NotebookExecutionSurface): boolean => {
  if (surface === 'python') {
    if (/\b(?:os\.system|os\.popen)\s*\(/iu.test(call)) return true
    if (/\bsubprocess\.(?:run|call|Popen|check_call|check_output)\s*\(/u.test(call)) {
      const openIndex = call.indexOf('(')
      const firstArgument = openIndex >= 0 ? callArguments(call, openIndex)[0] : undefined
      return firstArgument !== undefined && !/^\s*[[(]/u.test(firstArgument)
    }
    return false
  }
  if (surface === 'r') return /\b(?:system|pipe)\s*\(/u.test(call)
  if (surface === 'repl') return /\b(?:exec|execSync)\s*\(/u.test(call)
  return false
}

const executionPayloads = (
  source: string,
  surface: NotebookExecutionSurface
): ExecutionPayload[] => {
  if (surface === 'bash' || surface === 'powershell') {
    return shellCommandSegments(source)
      .map((command) => invocationPayload(shellWords(command)))
      .filter((payload): payload is ExecutionPayload => payload !== undefined)
  }

  const maskedSource =
    surface === 'repl'
      ? maskJavascriptQuotedAndCommentText(source)
      : maskQuotedAndCommentText(source)
  return executionBridgeCandidates(source, surface, maskedSource).flatMap((call) => {
    const values = quotedLiteralValues(call)
    const argvPayload = invocationPayload(
      /\bsys\s*\.\s*executable\b/u.test(call) ? ['python', ...values] : values
    )
    if (argvPayload) return [argvPayload]
    if (!bridgeUsesShellCommandString(call, surface)) return []
    return values
      .slice(0, 1)
      .map((value) => invocationPayload(shellWords(value)))
      .filter((payload): payload is ExecutionPayload => payload !== undefined)
  })
}

const packageExecutionBridgeCandidates = (
  source: string,
  surface: NotebookExecutionSurface,
  maskedSource: string
): string[] =>
  executionBridgeCandidates(source, surface, maskedSource).flatMap((call) => {
    if (/\bpip(?:\._internal(?:\.cli\.main)?)?\.main\s*\(/iu.test(call)) return [call]
    const values = quotedLiteralValues(call)
    const argvValues = /\bsys\s*\.\s*executable\b/u.test(call) ? ['python', ...values] : values
    const executable = commandName(argvValues[0])
    if (
      /^(?:micromamba|mamba|conda|pip|pip3|pipx|uv|poetry|python|python3|py|r|rscript|brew|apt|apt-get|yum|dnf|pacman|zypper|apk|choco|winget)(?:\.exe)?$/u.test(
        executable
      )
    ) {
      return [argvValues.join(' ')]
    }
    return bridgeUsesShellCommandString(call, surface) ? values.slice(0, 1) : []
  })

const lastOpenCommandSubstitution = (source: string, before: number): number => {
  let closedDepth = 0
  for (let index = before - 1; index > 0; index -= 1) {
    if (source[index] === ')') {
      closedDepth += 1
      continue
    }
    if (source[index] !== '(' || source[index - 1] !== '$') continue
    if (closedDepth === 0) return index
    closedDepth -= 1
  }
  return -1
}

const shellMatchIsExecutable = (source: string, matchIndex: number): boolean => {
  const commandSubstitution = lastOpenCommandSubstitution(source, matchIndex)
  const boundary = Math.max(
    source.lastIndexOf('\n', matchIndex - 1),
    source.lastIndexOf(';', matchIndex - 1),
    source.lastIndexOf('|', matchIndex - 1),
    source.lastIndexOf('&', matchIndex - 1),
    commandSubstitution < 0 ? -1 : commandSubstitution + 1
  )
  const prefix = source
    .slice(boundary + 1, matchIndex)
    .trim()
    .replace(/["']/gu, '')
    // PACKAGE_MUTATION_RULES match the executable basename inside `/prefix/bin/pip`. Remove only
    // the final path-bearing word; any earlier word (for example `echo /prefix/bin/pip install`)
    // remains and correctly proves this is an argument rather than the command position.
    .replace(/(?:^|\s)[^\s;|&()]*[\\/]$/u, '')
    .trim()
  const allowedPrefixTokens = /^(?:sudo|env|command|exec|if|then|while|until|!|&)$/iu
  if (
    !prefix ||
    prefix
      .split(/\s+/u)
      .every(
        (token) => allowedPrefixTokens.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=[^\s]+$/u.test(token)
      )
  ) {
    return true
  }
  return /\b(?:Rscript|R|python|python3|py|bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?\b[^\n]{0,80}(?:-e|-c|\/c)\s*["']?$/iu.test(
    prefix
  )
}

const findPackageMutationRule = (
  source: string,
  surface: NotebookExecutionSurface,
  depth = 0
): MutationRule | undefined => {
  const executableSource =
    surface === 'bash' || surface === 'powershell'
      ? stripShellComments(source)
      : surface === 'repl'
        ? maskJavascriptQuotedAndCommentText(source)
        : maskQuotedAndCommentText(source)
  const candidates = [
    executableSource,
    ...(surface === 'bash' ? [resolveShellLiteralAssignments(executableSource)] : []),
    ...(surface === 'powershell' ? [resolvePowerShellLiteralAssignments(executableSource)] : []),
    ...packageExecutionBridgeCandidates(source, surface, executableSource)
  ]

  for (const candidate of candidates) {
    for (const rule of PACKAGE_MUTATION_RULES) {
      const match = rule.pattern.exec(candidate)
      if (!match) continue
      if (
        (surface !== 'bash' && surface !== 'powershell') ||
        shellMatchIsExecutable(candidate, match.index)
      ) {
        return rule
      }
    }
  }
  if (depth < 8) {
    for (const payload of executionPayloads(source, surface)) {
      const nestedRule = findPackageMutationRule(payload.source, payload.surface, depth + 1)
      if (nestedRule) return nestedRule
    }
  }
  return undefined
}

const hasDirectManagedRuntimeWrite = (
  source: string,
  surface: NotebookExecutionSurface,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform
): boolean => {
  if (surface === 'bash') {
    const executableSource = stripShellComments(source)
    return [executableSource, resolveShellLiteralAssignments(executableSource)].some((candidate) =>
      shellSequenceWritesRuntime(candidate, runtimeRoot, cwd, platform)
    )
  }

  if (surface === 'powershell') {
    const executableSource = stripShellComments(source)
    return [executableSource, resolvePowerShellLiteralAssignments(executableSource)].some(
      (candidate) =>
        powerShellSequenceWritesRuntime(candidate, runtimeRoot, cwd, platform) ||
        powerShellDotNetWritesRuntime(candidate, runtimeRoot, cwd, platform)
    )
  }

  const maskedSource =
    surface === 'repl'
      ? maskJavascriptQuotedAndCommentText(source)
      : maskQuotedAndCommentText(source)
  const base = RUNTIME_WRITE_RULES[surface]
  const flags = base.flags.includes('g') ? base.flags : `${base.flags}g`
  const pattern = new RegExp(base.source, flags)
  for (let match = pattern.exec(maskedSource); match; match = pattern.exec(maskedSource)) {
    const openIndex = match.index + match[0].lastIndexOf('(')
    const call = matchingCall(source, match.index, openIndex)
    if (
      call &&
      runtimeWriteTargets(
        surface,
        call,
        source.slice(match.index, openIndex + 1),
        openIndex - match.index
      ).some((target) => referencesManagedRuntimePath(target, runtimeRoot, cwd, platform))
    ) {
      return true
    }
    if (match[0].length === 0) pattern.lastIndex += 1
  }
  return false
}

const executionBridgeWritesRuntime = (
  source: string,
  surface: NotebookExecutionSurface,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform
): boolean => {
  if (surface === 'bash' || surface === 'powershell') return false
  const maskedSource =
    surface === 'repl'
      ? maskJavascriptQuotedAndCommentText(source)
      : maskQuotedAndCommentText(source)
  return executionBridgeCandidates(source, surface, maskedSource).some((call) => {
    const openIndex = call.indexOf('(')
    const firstArgument = openIndex >= 0 ? callArguments(call, openIndex)[0]?.trim() : undefined
    if (!firstArgument) return false

    if (bridgeUsesShellCommandString(call, surface)) {
      const command = quotedLiteralValues(firstArgument)[0]
      return command ? shellSequenceWritesRuntime(command, runtimeRoot, cwd, platform) : false
    }

    if (
      surface !== 'python' ||
      !/\bsubprocess\.(?:run|call|Popen|check_call|check_output)\s*\(/u.test(call) ||
      !/^\s*[[(]/u.test(firstArgument)
    ) {
      return false
    }
    const opening = firstArgument[0]
    const closing = opening === '[' ? ']' : ')'
    if (firstArgument.at(-1) !== closing) return false
    const argv = callArguments(`(${firstArgument.slice(1, -1)})`, 0)
    return shellRuntimeWriteTargetsFromWords(argv, [], true).some((target) =>
      sequenceTargetWritesRuntime(target, runtimeRoot, cwd, platform)
    )
  })
}

const hasManagedRuntimeWrite = (
  source: string,
  surface: NotebookExecutionSurface,
  runtimeRoot: string,
  cwd: string,
  platform: NodeJS.Platform,
  depth = 0
): boolean =>
  hasDirectManagedRuntimeWrite(source, surface, runtimeRoot, cwd, platform) ||
  executionBridgeWritesRuntime(source, surface, runtimeRoot, cwd, platform) ||
  (depth < 8 &&
    executionPayloads(source, surface).some((payload) =>
      hasManagedRuntimeWrite(payload.source, payload.surface, runtimeRoot, cwd, platform, depth + 1)
    ))

// Single policy seam shared by data-cell and shell execution. This is intentionally independent from
// Agent instructions: a request is rejected in the trusted main process before any interpreter starts.
export const detectManagedRuntimeMutation = ({
  source,
  surface,
  runtimeRoot,
  cwd = process.cwd(),
  platform = process.platform
}: {
  source: string
  surface: NotebookExecutionSurface
  runtimeRoot: string
  cwd?: string
  platform?: NodeJS.Platform
}): ManagedRuntimeMutation | undefined => {
  const rule = findPackageMutationRule(source, surface)
  if (rule) {
    return {
      installer: rule.installer,
      message:
        `${rule.installer} cannot modify packages from a ${surface} execution. ` +
        'Use manage_packages so Open Science can preserve the bound interpreter and audit the change.'
    }
  }

  if (hasManagedRuntimeWrite(source, surface, runtimeRoot, cwd, platform)) {
    return {
      installer: 'direct managed-runtime write',
      message:
        'The managed runtime is read-only from notebook and shell execution. Use manage_packages or ' +
        'the runtime Repair workflow instead of modifying runtime files directly.'
    }
  }
  return undefined
}

const seatbeltString = (value: string): string => JSON.stringify(value)

// macOS Seatbelt is the hard filesystem layer beneath the semantic policy above. It applies to the
// whole child process tree, so dynamically constructed paths and nested R/Python/subprocess writers
// cannot modify managed runtime state. The sole writable exception is the marker-owned workload-cache
// subtree, which contains disposable third-party cache data rather than environments or app metadata.
// The trusted main-process package manager is spawned outside this wrapper and remains the only managed
// runtime writer. Other platforms still use the main-process policy; their native process-sandbox
// adapters can be added at this same seam without changing callers.
export const protectManagedRuntimeWrites = (
  invocation: RuntimeProcessInvocation,
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform
): RuntimeProcessInvocation => {
  if (platform !== 'darwin') return invocation

  const resolvedRoot = resolve(runtimeRoot)
  let physicalRoot = resolvedRoot
  try {
    physicalRoot = realpathSync(resolvedRoot)
  } catch {
    // A first-use runtime may not exist yet. The resolved target still protects the path once created.
  }
  const protectedRoots = [...new Set([resolvedRoot, physicalRoot])]
  const profile = [
    '(version 1)',
    '(allow default)',
    ...protectedRoots.flatMap((root) => [
      `(deny file-write* (literal ${seatbeltString(root)}))`,
      `(deny file-write* (require-all`,
      `  (subpath ${seatbeltString(root)})`,
      `  (require-not (literal ${seatbeltString(join(root, 'cache', 'notebook'))}))`,
      `  (require-not (subpath ${seatbeltString(join(root, 'cache', 'notebook'))}))))`
    ])
  ].join('\n')

  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', profile, invocation.executable, ...invocation.args]
  }
}
