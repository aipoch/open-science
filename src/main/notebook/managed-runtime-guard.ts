import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'

export type NotebookExecutionSurface = NotebookLanguage | 'bash' | 'repl'

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
      /\b(?:python|python3|py)(?:\.\d+)?(?:\.exe)?\b[\s\S]{0,100}\s-m\s+(?:venv|virtualenv|ensurepip|pip)\b/iu
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
  python:
    /\b(?:open|Path\s*\([^)]*\)\s*\.(?:write_|touch|mkdir|rename|replace|unlink)|os\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|chmod|chown)|shutil\.(?:copy|copy2|copytree|move|rmtree))\s*\(/iu,
  r: /\b(?:unlink|file\.remove|file\.rename|file\.create|dir\.create|writeLines|writeBin|save|saveRDS)\s*\(/iu,
  repl: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|mkdir|mkdirSync|copyFile|copyFileSync)\s*\(/iu
}

const mentionsManagedRuntime = (source: string, runtimeRoot: string): boolean => {
  const canonical = resolve(runtimeRoot)
  const variants = new Set([
    canonical,
    canonical.split(sep).join('/'),
    canonical.split(sep).join('\\'),
    'OPEN_SCIENCE_RUNTIME_DIR'
  ])
  return [...variants].some((candidate) => candidate.length > 0 && source.includes(candidate))
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
    /(^|[;\r\n]|\s)([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;]+)/gmu
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
  return expanded.replace(/["']/gu, '')
}

const EXECUTION_BRIDGES: Record<NotebookExecutionSurface, RegExp> = {
  bash: /\b(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?\b[^\n]{0,80}\s(?:-c|\/c)\b|\beval\b/iu,
  python:
    /\b(?:subprocess\.(?:run|call|Popen|check_call|check_output)|os\.system|os\.popen|exec|eval)\s*\(/iu,
  r: /\b(?:system|system2|do\.call|get|match\.fun|eval|parse)\s*\(/iu,
  repl: /\b(?:exec|execFile|spawn|fork|eval)\s*\(|\bchild_process\s*\.\s*(?:exec|execFile|spawn|fork)\s*\(/iu
}

const matchingCall = (source: string, matchIndex: number): string | undefined => {
  const open = source.indexOf('(', matchIndex)
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

// Scan only the resolved bridge call rather than restoring every string/comment in the cell. This
// still catches literal subprocess/system/exec payloads, while `print("pip install"); system("echo")`
// remains ordinary output. Dynamically assembled argv is enforced by the persistent runtime hooks and
// the native process sandbox instead of guessed from unrelated source text.
const executionBridgeCandidates = (
  source: string,
  surface: NotebookExecutionSurface,
  maskedSource: string
): string[] => {
  if (surface === 'bash') return []
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

const shellMatchIsExecutable = (source: string, matchIndex: number): boolean => {
  const boundary = Math.max(
    source.lastIndexOf('\n', matchIndex - 1),
    source.lastIndexOf(';', matchIndex - 1),
    source.lastIndexOf('|', matchIndex - 1),
    source.lastIndexOf('&', matchIndex - 1)
  )
  const prefix = source.slice(boundary + 1, matchIndex).trim()
  if (/^(?:(?:sudo|env|command|exec|if|then|while|until|!)\s+)*$/iu.test(prefix)) return true
  return /\b(?:Rscript|R|python|python3|py|bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?\b[^\n]{0,80}(?:-e|-c|\/c)\s*["']?$/iu.test(
    prefix
  )
}

const findPackageMutationRule = (
  source: string,
  surface: NotebookExecutionSurface
): MutationRule | undefined => {
  const executableSource =
    surface === 'bash'
      ? stripShellComments(source)
      : surface === 'repl'
        ? maskJavascriptQuotedAndCommentText(source)
        : maskQuotedAndCommentText(source)
  const candidates = [
    executableSource,
    ...(surface === 'bash' ? [resolveShellLiteralAssignments(executableSource)] : []),
    ...executionBridgeCandidates(source, surface, executableSource)
  ]

  for (const candidate of candidates) {
    for (const rule of PACKAGE_MUTATION_RULES) {
      const match = rule.pattern.exec(candidate)
      if (!match) continue
      if (surface !== 'bash' || shellMatchIsExecutable(candidate, match.index)) return rule
    }
  }
  return undefined
}

const hasManagedRuntimeWrite = (
  source: string,
  surface: NotebookExecutionSurface,
  runtimeRoot: string
): boolean => {
  if (surface === 'bash') {
    return stripShellComments(source)
      .split(/[;\r\n|&]+/u)
      .some(
        (command) =>
          mentionsManagedRuntime(command, runtimeRoot) && RUNTIME_WRITE_RULES.bash.test(command)
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
    const call = matchingCall(source, match.index)
    if (call && mentionsManagedRuntime(call, runtimeRoot)) return true
    if (match[0].length === 0) pattern.lastIndex += 1
  }
  return false
}

// Single policy seam shared by data-cell and shell execution. This is intentionally independent from
// Agent instructions: a request is rejected in the trusted main process before any interpreter starts.
export const detectManagedRuntimeMutation = ({
  source,
  surface,
  runtimeRoot
}: {
  source: string
  surface: NotebookExecutionSurface
  runtimeRoot: string
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

  if (hasManagedRuntimeWrite(source, surface, runtimeRoot)) {
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
// cannot modify the app-owned runtime. The trusted main-process package manager is spawned outside
// this wrapper and remains the only writer. Other platforms still use the main-process policy; their
// native process-sandbox adapters can be added at this same seam without changing callers.
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
      `(deny file-write* (subpath ${seatbeltString(root)}))`
    ])
  ].join('\n')

  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', profile, invocation.executable, ...invocation.args]
  }
}
