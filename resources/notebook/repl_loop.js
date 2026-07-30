// Persistent REPL control-plane kernel: one persistent Node process. Reads one JSON request per line,
// runs it in a persistent vm context (with an injected async host.mcp connector bridge), and returns
// one JSON response per line. This is the ONLY kernel with outbound connector access; the python/r
// data kernels have none. Not Jupyter, not a data-analysis kernel.
//
// Node -> loop:  { "req_id", "code" }
// loop -> Node:  { "req_id", "stdout", "stderr", "error", "result", "cwd", "figures":[] }
//
// REPL output convention: a trailing bare expression is echoed like a REPL — its value becomes
// `result` (best-effort; see wrapForRun). Explicit `return <expr>` or `console.log(...)` also work.
const vm = require('node:vm')
const readline = require('node:readline')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

// Protocol output line. console is captured into strings during a run (see run()), so writing the
// JSON here via process.stdout.write cannot be corrupted by user console output.
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

// Capture the connector RPC credentials privately, then delete them from process.env BEFORE the
// sandbox is built. The sandbox exposes `process` (for cwd() etc.), so leaving the token in
// process.env would let REPL user code read the connector Bearer token or POST to the RPC endpoint
// directly — bypassing the connector approval/policy gate that host.mcp routes through. host.mcp uses
// the captured values instead. (Broader filesystem/network egress isolation is a tracked follow-up.)
const RPC_ENDPOINT = process.env.OPEN_SCIENCE_MCP_RPC_ENDPOINT
const RPC_TOKEN = process.env.OPEN_SCIENCE_MCP_RPC_TOKEN
delete process.env.OPEN_SCIENCE_MCP_RPC_ENDPOINT
delete process.env.OPEN_SCIENCE_MCP_RPC_TOKEN

// Notebook session/project identity for host.compute grant-scope approval memory (This conversation /
// This project). Not secret, but captured and removed alongside the RPC creds so sandbox user code that
// enumerates process.env sees neither the token nor the routing identity. Absent -> host.compute call
// payloads omit them and the approval broker falls back to 'once'-only semantics.
const COMPUTE_SESSION_ID = process.env.OPEN_SCIENCE_NOTEBOOK_SESSION_ID
const COMPUTE_PROJECT_NAME = process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME
delete process.env.OPEN_SCIENCE_NOTEBOOK_SESSION_ID
delete process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME

// Private reference to the real fetch, captured before user code runs. host.mcp MUST use this, not the
// global `fetch`: a vm sandbox is not a security boundary, so sandbox code can reach the outer realm
// via `host.mcp.constructor('return globalThis')()` and reassign the outer `globalThis.fetch` to a
// hook that would otherwise capture the connector Bearer token on the next host.mcp call. A module-
// scoped const is not on any globalThis and cannot be reassigned from that escape, so the token only
// ever flows to the real endpoint. (Sandbox code still has direct fetch/require/process — full FS +
// network-egress isolation is the tracked follow-up, not solvable in-process.)
const capturedFetch = fetch

// The control REPL must not become a second package-manager entry point. Patch the shared built-in
// child_process exports before user code is evaluated, so computed property access such as
// `cp['ex' + 'ec'](...)` is checked against the resolved command at call time. The main process source
// policy rejects obvious calls earlier; this runtime layer covers dynamically assembled argv.
const packageMutationCommand =
  /(?:\b(?:micromamba|mamba|conda|pip|pip3|pipx|uv|poetry)(?:\.exe)?\b.{0,160}\b(?:install|uninstall|update|upgrade|remove|create|sync|add|venv)\b|\b(?:python|python3|py)(?:\.\d+)?(?:\.exe)?\b.{0,80}\s-m\s+(?:(?:venv|virtualenv|ensurepip)\b|pip\b.{0,100}\b(?:install|uninstall|wheel)\b)|\bR(?:script)?(?:\.exe)?\b.{0,120}(?:\bCMD\s+INSTALL\b|(?:install|remove|update)\.packages\b))/isu

const commandText = (command, args = []) =>
  [command, ...(Array.isArray(args) ? args : [])]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part))
    .join(' ')

const powerShellEncodedSource = (words, commandIndex = 0) => {
  const encodedFlag = words.findIndex((word, index) => {
    if (index <= commandIndex || !String(word).startsWith('-')) return false
    const flag = String(word).slice(1).toLowerCase()
    return flag === 'e' || flag === 'ec' || (flag.length >= 2 && 'encodedcommand'.startsWith(flag))
  })
  return encodedFlag >= 0
    ? Buffer.from(
        String(words[encodedFlag + 1] ?? '').replace(/^['"]|['"]$/gu, ''),
        'base64'
      ).toString('utf16le')
    : undefined
}

const packageInstallerExecutables = new Set([
  'micromamba',
  'mamba',
  'conda',
  'pip',
  'pip3',
  'pipx',
  'uv',
  'poetry',
  'python',
  'python3',
  'py',
  'r',
  'rscript'
])

const packageWordsMutate = (rawWords) => {
  const words = rawWords
    .filter((word) => word !== undefined && word !== null)
    .map((word) => String(word))
  let commandIndex = 0
  while (commandIndex < words.length) {
    const executable = commandName(words[commandIndex]).replace(/\.exe$/u, '')
    if (executable === 'sudo') {
      commandIndex += 1
      while (commandIndex < words.length && words[commandIndex].startsWith('-')) commandIndex += 1
      continue
    }
    if (executable === 'env') {
      commandIndex += 1
      while (
        commandIndex < words.length &&
        (words[commandIndex].startsWith('-') ||
          /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[commandIndex]))
      ) {
        commandIndex += 1
      }
      continue
    }
    if (executable === 'command' || executable === 'exec') {
      commandIndex += 1
      while (commandIndex < words.length && words[commandIndex].startsWith('-')) commandIndex += 1
      continue
    }
    break
  }
  if (commandIndex >= words.length) return false

  const executable = commandName(words[commandIndex]).replace(/\.exe$/u, '')
  const argv = words.slice(commandIndex + 1)
  const shellFlag = argv.findIndex((word) => /^-c$/u.test(word))
  if (/^(?:bash|sh|zsh)$/u.test(executable) && shellFlag >= 0) {
    return packageShellMutates(argv[shellFlag + 1] ?? '')
  }
  const cmdFlag = argv.findIndex((word) => /^\/c$/iu.test(word))
  if (executable === 'cmd' && cmdFlag >= 0) {
    return packageShellMutates(argv.slice(cmdFlag + 1).join(' '))
  }
  if (/^(?:powershell|pwsh)$/u.test(executable)) {
    const payload = powerShellInvocationSource(words, commandIndex)
    return payload !== undefined && packageShellMutates(payload)
  }
  return (
    (packageInstallerExecutables.has(executable) || /^python\d+(?:\.\d+)*$/u.test(executable)) &&
    packageMutationCommand.test([words[commandIndex], ...argv].join(' '))
  )
}

const packageShellMutates = (source) =>
  shellCommandSegments(String(source)).some((segment) => packageWordsMutate(shellWords(segment)))

const assertPackageCommandAllowed = (command, args, shellCommand = false) => {
  const mutates = shellCommand
    ? packageShellMutates(command)
    : packageWordsMutate([command, ...(Array.isArray(args) ? args : [])])
  if (mutates) {
    throw new Error(
      'Package/environment mutation is not allowed in the control REPL; use manage_packages.'
    )
  }
}

const childProcess = require('node:child_process')
for (const method of ['exec', 'execSync']) {
  const original = childProcess[method]
  childProcess[method] = function guardedExec(command, ...args) {
    assertPackageCommandAllowed(command, [], true)
    assertRuntimeProcessCommandAllowed(command, [], true)
    return original.call(this, command, ...args)
  }
}
for (const method of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = childProcess[method]
  childProcess[method] = function guardedExecFile(command, args, ...rest) {
    assertPackageCommandAllowed(command, args)
    assertRuntimeProcessCommandAllowed(command, args)
    return original.call(this, command, args, ...rest)
  }
}

// A forked Node process would start outside this patched control plane and could perform package
// mutations through dynamically assembled code. Keep helper processes behind the guarded spawn APIs.
childProcess.fork = function guardedFork() {
  throw new Error(
    'child_process.fork is not allowed in the control REPL; use manage_packages for package changes.'
  )
}

// A Worker starts a fresh Node isolate and reloads pristine built-in fs/child_process modules, so it
// would bypass every in-process guard installed by this control loop. Keep worker isolates outside the
// notebook control plane until they can inherit an OS-enforced runtime write boundary.
const workerThreads = require('node:worker_threads')
workerThreads.Worker = class GuardedWorker {
  constructor() {
    throw new Error(
      'worker_threads.Worker is not allowed in the control REPL; managed runtime guards cannot be inherited.'
    )
  }
}

// Enforce the managed-runtime read-only boundary at the Node filesystem API as well as in the main
// process source policy. This catches paths assembled dynamically inside the persistent REPL and is
// the hard backstop on platforms without sandbox-exec.
const runtimeRootValue = process.env.OPEN_SCIENCE_RUNTIME_DIR
const descriptorGuardPaths = new Map()
const canonicalGuardPath = (value, cwd = process.cwd()) => {
  if (value === undefined || value === null) return undefined
  let raw = value
  if (typeof raw === 'number') {
    const trackedPath = descriptorGuardPaths.get(raw)
    if (trackedPath) {
      raw = trackedPath
    } else {
      const descriptorPath =
        process.platform === 'linux' ? `/proc/self/fd/${raw}` : `/dev/fd/${raw}`
      try {
        raw = fs.realpathSync.native(descriptorPath)
      } catch {
        return undefined
      }
    }
  }
  if (raw instanceof URL) raw = fileURLToPath(raw)
  if (Buffer.isBuffer(raw)) raw = raw.toString()
  if (typeof raw !== 'string') return undefined

  const absolute = path.resolve(cwd, raw)
  let cursor = absolute
  const suffix = []
  while (true) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...suffix)
    } catch {
      const parent = path.dirname(cursor)
      if (parent === cursor) return absolute
      suffix.unshift(path.basename(cursor))
      cursor = parent
    }
  }
}
const managedRuntimeRoot = runtimeRootValue && canonicalGuardPath(runtimeRootValue)
const comparableGuardPath = (value) =>
  process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value
const assertRuntimeWriteAllowed = (...values) => {
  if (!managedRuntimeRoot) return
  const root = comparableGuardPath(managedRuntimeRoot)
  for (const value of values) {
    const resolved = canonicalGuardPath(value)
    if (!resolved) continue
    const candidate = comparableGuardPath(resolved)
    if (candidate === root || candidate.startsWith(root + path.sep)) {
      throw new Error(
        'Managed runtime files are read-only in the control REPL; use manage_packages for changes.'
      )
    }
  }
}
const runtimeWriteCommand =
  /(?:\b(?:rm|mv|cp|install|mkdir|touch|truncate|chmod|chown|ln|tee|sed|perl|dd)\b|\b(?:open|write_text|write_bytes|writeFile|writeFileSync|mkdtemp|mkdtempSync)\s*\(|\b(?:os|shutil)\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|chmod|chown|copy|copy2|copytree|move|rmtree)\s*\(|\b(?:unlink|file\.remove|file\.rename|file\.link|file\.symlink|file\.create|dir\.create|writeLines|writeBin|save|saveRDS)\s*\(|\b(?:New-Item|Remove-Item|Set-Content|Add-Content|Clear-Content|Out-File)\b|\[IO\.File\]::(?:WriteAllText|AppendAllText|WriteAllBytes|Create|Delete)\s*\()/isu
// Child commands are assembled after the main-process source policy runs, so this loop must classify
// their resolved argv itself. Mirror the main policy's endpoint semantics: copying OUT is read-only,
// moves/links protect both endpoints, and writes are rejected only when their target reaches the
// runtime. The broad regex remains a fail-closed fallback for interpreter payloads not parsed here.
const runtimeTextReferencesManagedRuntime = (text) => {
  const comparable = comparableGuardPath(
    String(text)
      .replaceAll('\\', '/')
      .replace(/\/{2,}/gu, '/')
  )
  const roots = [managedRuntimeRoot, runtimeRootValue]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => comparableGuardPath(value.replaceAll('\\', '/').replace(/\/{2,}/gu, '/')))
  return (
    String(text).includes('OPEN_SCIENCE_RUNTIME_DIR') ||
    roots.some((root) => comparable.includes(root))
  )
}
const runtimeTargetIsManaged = (value, cwd = process.cwd()) => {
  if (!managedRuntimeRoot || value === undefined || value === null) return false
  const text = String(value).trim()
  if (runtimeTextReferencesManagedRuntime(text)) return true
  const unquoted = text.replace(/^(?:(["'`]))([\s\S]*)\1$/u, '$2')
  const resolved = canonicalGuardPath(unquoted, cwd)
  if (!resolved) return false
  const candidate = comparableGuardPath(resolved)
  const root = comparableGuardPath(managedRuntimeRoot)
  return candidate === root || candidate.startsWith(root + path.sep)
}
const commandName = (value) =>
  path.basename(String(value ?? '').replace(/^["']|["']$/gu, '')).toLowerCase()
const unquoteShellWord = (value) =>
  String(value)
    .replace(/^(["'`])([\s\S]*)\1$/u, '$2')
    .replace(/\\([\\"'`])/gu, '$1')
const shellWords = (command) =>
  String(command).match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^\s])+/gu) ?? []
const resolvedCommandCwd = (target, cwd) => {
  if (!target) return cwd
  const unquoted = unquoteShellWord(target)
  const expanded = managedRuntimeRoot
    ? unquoted
        .replace(/\$\{?env:OPEN_SCIENCE_RUNTIME_DIR\}?/giu, () => managedRuntimeRoot)
        .replace(/\$\{?OPEN_SCIENCE_RUNTIME_DIR\}?/gu, () => managedRuntimeRoot)
        .replace(/%OPEN_SCIENCE_RUNTIME_DIR%/giu, () => managedRuntimeRoot)
    : unquoted
  const normalizedExpanded =
    path.sep === '\\' ? expanded.replaceAll('/', path.sep) : expanded.replaceAll('\\', path.sep)
  if (managedRuntimeRoot && runtimeTextReferencesManagedRuntime(target)) {
    return canonicalGuardPath(normalizedExpanded, cwd) ?? managedRuntimeRoot
  }
  return canonicalGuardPath(normalizedExpanded, cwd) ?? cwd
}
const powerShellInvocationSource = (words, commandIndex = 0) => {
  const commandFlag = words.findIndex(
    (word, index) => index > commandIndex && /^(?:-command|-c)$/iu.test(word)
  )
  if (commandFlag >= 0) return unquoteShellWord(words[commandFlag + 1] ?? '')
  return powerShellEncodedSource(words, commandIndex)
}
const shellCommandSegments = (source) => {
  const segments = []
  let start = 0
  let quote
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
const shellRedirectionTargets = (command) => {
  const targets = []
  let quote
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
const writeTargetsForWords = (words, redirections = []) => {
  const commandIndex = words.findIndex((word) =>
    /^(?:rm|mv|cp|install|mkdir|touch|truncate|chmod|chown|ln|tee|sed|perl|dd)(?:\.exe)?$/iu.test(
      commandName(word)
    )
  )
  if (commandIndex < 0) return redirections
  const executable = commandName(words[commandIndex])
  const args = words.slice(commandIndex + 1).map(String)
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
  if (/^ln(?:\.exe)?$/iu.test(executable)) return [...redirections, ...positional]
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
const powerShellWriteTargets = (command) => {
  const redirections = shellRedirectionTargets(command)
  const words = shellWords(command)
  const commandIndex = words[0] === '&' ? 1 : 0
  const executable = commandName(words[commandIndex])
  const args = words.slice(commandIndex + 1).map(String)
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
    return [...redirections, ...args.filter((arg) => !/^\/[dhj]$/iu.test(arg))]
  }
  if (/^(?:set-content|sc|add-content|ac|clear-content|clc|out-file)$/u.test(executable)) {
    return [...redirections, ...(explicitPath ? [explicitPath] : positional.slice(0, 1))]
  }
  return redirections
}
const matchingCall = (source, matchIndex) => {
  const open = source.indexOf('(', matchIndex)
  if (open < 0) return undefined
  let depth = 0
  let quote
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') depth += 1
    else if (char === ')' && --depth === 0) return source.slice(matchIndex, index + 1)
  }
  return undefined
}
const callArguments = (call) => {
  const open = call.indexOf('(')
  if (open < 0) return []
  const args = []
  let start = open + 1
  let depth = 0
  let quote
  for (let index = start; index < call.length; index += 1) {
    const char = call[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
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
const maskJavascriptQuotedAndCommentText = (source) => {
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
const staticLiteralTarget = (target) => /^(?:(["'`]))[\s\S]*\1$/u.test(String(target).trim())
const staticShellTarget = (target) => {
  const value = String(target)
    .trim()
    .replace(/^(?:(["']))([\s\S]*)\1$/u, '$2')
  return value.length > 0 && !/[$%`<>&;|()\r\n]/u.test(value)
}
const powerShellSourceWritesRuntime = (source, cwd = process.cwd(), depth = 0) => {
  const referencesRuntime = runtimeTextReferencesManagedRuntime(source)
  let currentCwd = cwd
  for (const segment of shellCommandSegments(String(source))) {
    const words = shellWords(segment)
    const commandIndex = words[0] === '&' ? 1 : 0
    const executable = commandName(words[commandIndex])
    if (/^(?:set-location|cd|chdir|sl)$/u.test(executable)) {
      const args = words.slice(commandIndex + 1)
      const pathFlag = args.findIndex((word) => /^-(?:literal)?path$/iu.test(word))
      const target =
        pathFlag >= 0 ? args[pathFlag + 1] : args.find((word) => !String(word).startsWith('-'))
      currentCwd = resolvedCommandCwd(target, currentCwd)
    }
    const targets = powerShellWriteTargets(segment)
    if (targets.some((target) => runtimeTargetIsManaged(target, currentCwd))) return true
    if (referencesRuntime && targets.some((target) => !staticShellTarget(target))) return true
    const dotNetWrites =
      /\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAllText|AppendAllText|WriteAllBytes|Create|CreateText|AppendText|Move|Replace|Delete|CreateDirectory)\s*\(/giu
    for (let match = dotNetWrites.exec(segment); match; match = dotNetWrites.exec(segment)) {
      const call = matchingCall(segment, match.index)
      const target = call ? callArguments(call)[0] : undefined
      if (target && runtimeTargetIsManaged(target, currentCwd)) return true
      if (target && referencesRuntime && !staticLiteralTarget(target)) return true
    }
    if (depth >= 8) continue
    const shellFlag = words.findIndex((word) => /^-c$/u.test(word))
    if (
      /^(?:bash|sh|zsh)(?:\.exe)?$/u.test(executable) &&
      shellFlag >= 0 &&
      shellSourceWritesRuntime(unquoteShellWord(words[shellFlag + 1] ?? ''), currentCwd, depth + 1)
    ) {
      return true
    }
    const powerShellPayload = powerShellInvocationSource(words, commandIndex)
    if (
      /^(?:powershell|pwsh)(?:\.exe)?$/u.test(executable) &&
      powerShellPayload !== undefined &&
      powerShellSourceWritesRuntime(powerShellPayload, currentCwd, depth + 1)
    ) {
      return true
    }
    const inlineFlag = words.findIndex((word) => /^(?:-e|--eval)$/u.test(word))
    if (
      (/^(?:node|nodejs)(?:\.exe)?$/u.test(executable) ||
        words[commandIndex] === process.execPath) &&
      inlineFlag >= 0 &&
      javascriptSourceWritesRuntime(unquoteShellWord(words[inlineFlag + 1] ?? ''), currentCwd)
    ) {
      return true
    }
    if (
      /^(?:python|python3|py|r|rscript)(?:\.exe)?$/u.test(executable) &&
      (runtimeTargetIsManaged('.', currentCwd) || runtimeTextReferencesManagedRuntime(segment)) &&
      runtimeWriteCommand.test(segment)
    ) {
      return true
    }
  }
  return false
}
const javascriptSourceWritesRuntime = (source, cwd = process.cwd()) => {
  const masked = maskJavascriptQuotedAndCommentText(source)
  const operations =
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|truncate|truncateSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|cp|cpSync|link|linkSync|symlink|symlinkSync|open|openSync|createWriteStream)\s*\(/gu
  const referencesRuntime = runtimeTextReferencesManagedRuntime(source)
  for (let match = operations.exec(masked); match; match = operations.exec(masked)) {
    const call = matchingCall(source, match.index)
    if (!call) continue
    const args = callArguments(call)
    const operation = match[0].slice(0, match[0].indexOf('(')).toLowerCase()
    const targets = /^(?:copyfile|copyfilesync|cp|cpsync)$/u.test(operation)
      ? args.slice(1, 2)
      : /^(?:rename|renamesync|link|linksync|symlink|symlinksync)$/u.test(operation)
        ? args.slice(0, 2)
        : /^(?:open|opensync)$/u.test(operation) &&
            args[1] &&
            /^(?:["'])r[bt]?(?:["'])$/u.test(args[1].trim())
          ? []
          : args.slice(0, 1)
    if (targets.some((target) => runtimeTargetIsManaged(target, cwd))) return true
    if (referencesRuntime && targets.some((target) => !staticLiteralTarget(target))) return true
  }
  return false
}
const shellSourceWritesRuntime = (source, cwd = process.cwd(), depth = 0) => {
  const referencesRuntime = runtimeTextReferencesManagedRuntime(source)
  let currentCwd = cwd
  for (const segment of shellCommandSegments(String(source))) {
    const words = shellWords(segment)
    const executable = commandName(words[0])
    if (executable === 'cd') {
      const target = words.find((word, index) => index > 0 && !String(word).startsWith('-'))
      currentCwd = resolvedCommandCwd(target, currentCwd)
    }
    const targets = writeTargetsForWords(words, shellRedirectionTargets(segment))
    if (targets.some((target) => runtimeTargetIsManaged(target, currentCwd))) return true
    if (referencesRuntime && targets.some((target) => !staticShellTarget(target))) return true
    if (depth >= 8) continue
    const inlineFlag = words.findIndex((word) => /^(?:-e|--eval)$/u.test(word))
    if (
      (/^(?:node|nodejs)(?:\.exe)?$/u.test(executable) || words[0] === process.execPath) &&
      inlineFlag >= 0 &&
      javascriptSourceWritesRuntime(unquoteShellWord(words[inlineFlag + 1] ?? ''), currentCwd)
    ) {
      return true
    }
    const shellFlag = words.findIndex((word) => /^-c$/u.test(word))
    if (
      /^(?:bash|sh|zsh)(?:\.exe)?$/u.test(executable) &&
      shellFlag >= 0 &&
      shellSourceWritesRuntime(unquoteShellWord(words[shellFlag + 1] ?? ''), currentCwd, depth + 1)
    ) {
      return true
    }
    const powerShellPayload = powerShellInvocationSource(words)
    if (
      /^(?:powershell|pwsh)(?:\.exe)?$/u.test(executable) &&
      powerShellPayload !== undefined &&
      powerShellSourceWritesRuntime(powerShellPayload, currentCwd, depth + 1)
    ) {
      return true
    }
    const cmdFlag = words.findIndex((word) => /^\/c$/iu.test(word))
    if (
      /^cmd(?:\.exe)?$/u.test(executable) &&
      cmdFlag >= 0 &&
      powerShellSourceWritesRuntime(
        words
          .slice(cmdFlag + 1)
          .map(unquoteShellWord)
          .join(' '),
        currentCwd,
        depth + 1
      )
    ) {
      return true
    }
    if (
      /^(?:python|python3|py|r|rscript)(?:\.exe)?$/u.test(executable) &&
      (runtimeTargetIsManaged('.', currentCwd) || runtimeTextReferencesManagedRuntime(segment)) &&
      runtimeWriteCommand.test(segment)
    ) {
      return true
    }
  }
  return false
}
const runtimeProcessCommandWritesRuntime = (command, args, shellCommand) => {
  if (shellCommand) return shellSourceWritesRuntime(String(command))
  const argv = Array.isArray(args) ? args.map(String) : []
  const executable = commandName(command)
  const shellFlag = argv.findIndex((word) => /^-c$/u.test(word))
  if (/^(?:bash|sh|zsh)(?:\.exe)?$/u.test(executable) && shellFlag >= 0) {
    return shellSourceWritesRuntime(argv[shellFlag + 1] ?? '')
  }
  const powerShellPayload = powerShellInvocationSource([command, ...argv])
  if (/^(?:powershell|pwsh)(?:\.exe)?$/u.test(executable) && powerShellPayload !== undefined) {
    return powerShellSourceWritesRuntime(powerShellPayload)
  }
  const cmdFlag = argv.findIndex((word) => /^\/c$/iu.test(word))
  if (/^cmd(?:\.exe)?$/u.test(executable) && cmdFlag >= 0) {
    return powerShellSourceWritesRuntime(argv.slice(cmdFlag + 1).join(' '))
  }
  const inlineFlag = argv.findIndex((word) => /^(?:-e|--eval)$/u.test(word))
  if (
    (/^(?:node|nodejs)(?:\.exe)?$/u.test(executable) || command === process.execPath) &&
    inlineFlag >= 0
  ) {
    return javascriptSourceWritesRuntime(argv[inlineFlag + 1] ?? '')
  }
  const directTargets = writeTargetsForWords([command, ...argv])
  if (directTargets.length > 0) {
    return directTargets.some((target) => runtimeTargetIsManaged(target))
  }
  const text = commandText(command, argv)
  return runtimeTextReferencesManagedRuntime(text) && runtimeWriteCommand.test(text)
}
const assertRuntimeProcessCommandAllowed = (command, args = [], shellCommand = false) => {
  if (!managedRuntimeRoot) return
  if (runtimeProcessCommandWritesRuntime(command, args, shellCommand)) {
    throw new Error(
      'Managed runtime files are read-only in control REPL child processes; use manage_packages for changes.'
    )
  }
}
const writeOpenFlags = (flags) =>
  (typeof flags === 'string' && /[wax+]/u.test(flags)) ||
  (typeof flags === 'number' &&
    Boolean(
      flags &
      (fs.constants.O_WRONLY |
        fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_APPEND)
    ))

for (const method of [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'unlink',
  'unlinkSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'truncate',
  'truncateSync',
  'chmod',
  'chmodSync',
  'fchmod',
  'fchmodSync',
  'chown',
  'chownSync'
]) {
  const original = fs[method]
  if (typeof original !== 'function') continue
  fs[method] = function guardedFsWrite(target, ...args) {
    assertRuntimeWriteAllowed(target)
    return original.call(this, target, ...args)
  }
}
for (const method of ['rename', 'renameSync']) {
  const original = fs[method]
  fs[method] = function guardedFsRename(source, destination, ...args) {
    assertRuntimeWriteAllowed(source, destination)
    return original.call(this, source, destination, ...args)
  }
}
for (const method of ['copyFile', 'copyFileSync', 'cp', 'cpSync']) {
  const original = fs[method]
  if (typeof original !== 'function') continue
  fs[method] = function guardedFsCopy(source, destination, ...args) {
    assertRuntimeWriteAllowed(destination)
    return original.call(this, source, destination, ...args)
  }
}
for (const method of ['link', 'linkSync']) {
  const original = fs[method]
  if (typeof original !== 'function') continue
  fs[method] = function guardedFsLink(source, destination, ...args) {
    assertRuntimeWriteAllowed(source, destination)
    return original.call(this, source, destination, ...args)
  }
}
const symbolicLinkSourcePath = (source, destination) => {
  if (typeof source !== 'string' || path.isAbsolute(source)) return source
  const resolvedDestination = canonicalGuardPath(destination)
  return resolvedDestination ? path.resolve(path.dirname(resolvedDestination), source) : source
}
for (const method of ['symlink', 'symlinkSync']) {
  const original = fs[method]
  if (typeof original !== 'function') continue
  fs[method] = function guardedFsSymlink(source, destination, ...args) {
    assertRuntimeWriteAllowed(symbolicLinkSourcePath(source, destination), destination)
    return original.call(this, source, destination, ...args)
  }
}
const originalOpenSync = fs.openSync
fs.openSync = function guardedOpenSync(target, flags, ...args) {
  if (writeOpenFlags(flags)) assertRuntimeWriteAllowed(target)
  const descriptor = originalOpenSync.call(this, target, flags, ...args)
  descriptorGuardPaths.set(descriptor, canonicalGuardPath(target))
  return descriptor
}
const originalOpen = fs.open
fs.open = function guardedOpen(target, flags, ...args) {
  if (writeOpenFlags(flags)) assertRuntimeWriteAllowed(target)
  const callbackIndex = args.findLastIndex((value) => typeof value === 'function')
  if (callbackIndex >= 0) {
    const callback = args[callbackIndex]
    args[callbackIndex] = function trackedOpenCallback(error, descriptor, ...callbackArgs) {
      if (!error && typeof descriptor === 'number') {
        descriptorGuardPaths.set(descriptor, canonicalGuardPath(target))
      }
      return callback.call(this, error, descriptor, ...callbackArgs)
    }
  }
  return originalOpen.call(this, target, flags, ...args)
}
const originalCloseSync = fs.closeSync
fs.closeSync = function trackedCloseSync(descriptor, ...args) {
  try {
    return originalCloseSync.call(this, descriptor, ...args)
  } finally {
    descriptorGuardPaths.delete(descriptor)
  }
}
const originalClose = fs.close
fs.close = function trackedClose(descriptor, callback) {
  if (typeof callback !== 'function') return originalClose.call(this, descriptor, callback)
  return originalClose.call(this, descriptor, function trackedCloseCallback(error) {
    descriptorGuardPaths.delete(descriptor)
    return callback.call(this, error)
  })
}
const originalCreateWriteStream = fs.createWriteStream
fs.createWriteStream = function guardedCreateWriteStream(target, ...args) {
  assertRuntimeWriteAllowed(target)
  return originalCreateWriteStream.call(this, target, ...args)
}

const fsPromises = fs.promises
for (const method of [
  'writeFile',
  'appendFile',
  'rm',
  'rmdir',
  'unlink',
  'mkdir',
  'mkdtemp',
  'truncate',
  'chmod',
  'chown'
]) {
  const original = fsPromises[method]
  if (typeof original !== 'function') continue
  fsPromises[method] = function guardedPromiseWrite(target, ...args) {
    assertRuntimeWriteAllowed(target)
    return original.call(this, target, ...args)
  }
}
for (const method of ['rename']) {
  const original = fsPromises[method]
  fsPromises[method] = function guardedPromiseRename(source, destination, ...args) {
    assertRuntimeWriteAllowed(source, destination)
    return original.call(this, source, destination, ...args)
  }
}
for (const method of ['copyFile', 'cp']) {
  const original = fsPromises[method]
  if (typeof original !== 'function') continue
  fsPromises[method] = function guardedPromiseCopy(source, destination, ...args) {
    assertRuntimeWriteAllowed(destination)
    return original.call(this, source, destination, ...args)
  }
}
for (const method of ['link']) {
  const original = fsPromises[method]
  if (typeof original !== 'function') continue
  fsPromises[method] = function guardedPromiseLink(source, destination, ...args) {
    assertRuntimeWriteAllowed(source, destination)
    return original.call(this, source, destination, ...args)
  }
}
for (const method of ['symlink']) {
  const original = fsPromises[method]
  if (typeof original !== 'function') continue
  fsPromises[method] = function guardedPromiseSymlink(source, destination, ...args) {
    assertRuntimeWriteAllowed(symbolicLinkSourcePath(source, destination), destination)
    return original.call(this, source, destination, ...args)
  }
}
const originalPromiseOpen = fsPromises.open
fsPromises.open = function guardedPromiseOpen(target, flags, ...args) {
  if (writeOpenFlags(flags)) assertRuntimeWriteAllowed(target)
  return originalPromiseOpen.call(this, target, flags, ...args)
}

// host.mcp: async connector call over the loopback RPC endpoint (same protocol as the python bridge).
// Only injected here, in the trusted control plane. Accepts a single positional args object; keyword
// arguments are not idiomatic in JS, so a second object is treated as a fallback args source.
async function hostMcp(server, method, args = undefined, kwargs = undefined) {
  const callArgs = args ?? kwargs ?? {}
  if (!RPC_ENDPOINT) throw new Error('host.mcp is unavailable: connector RPC endpoint not set')
  const res = await capturedFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    // Forward the notebook session id so the RPC server resolves the ACP session + specialist scope.
    // Without it the ConnectorService gate rejects the call with missing_session.
    body: JSON.stringify({
      method: 'mcpCall',
      params: { server, method, args: callArgs, sessionId: COMPUTE_SESSION_ID }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || 'host.mcp HTTP ' + res.status)
  if (body.error) throw new Error('host.mcp error: ' + String(body.error))
  return body.result
}

// host.compute: async remote-compute calls over the SAME loopback RPC endpoint as host.mcp, routed to
// the main-process ComputeService via {method:'computeCall'}. Like host.mcp, this is only injected in
// the trusted control plane — the python/r data kernels have no host.compute, so SSH/approval always
// happens outside the sandbox workspace. Uses the captured RPC_ENDPOINT/TOKEN + capturedFetch for the
// same token-isolation reasons documented on host.mcp above.
async function computeRpc(params) {
  if (!RPC_ENDPOINT) throw new Error('host.compute is unavailable: connector RPC endpoint not set')
  const res = await capturedFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'computeCall', params })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw computeError(body.error || 'host.compute HTTP ' + res.status)
  }
  return body.result
}

// Maps a computeCall failure into an Error. ComputeService raises structured errors that the RPC layer
// re-serializes as a JSON string in `error` ({error_code, message, retry_after_user_action}); parse it
// and hang those fields off the Error so REPL code can branch on `e.error_code` (matching the old Python
// shim's RuntimeError.error_code contract). A plain (non-JSON) message falls back to a bare Error.
function computeError(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.error_code) {
      const err = new Error(parsed.message || parsed.error_code)
      err.error_code = parsed.error_code
      err.retry_after_user_action = parsed.retry_after_user_action
      return err
    }
  } catch {
    // Not a structured JSON error — fall through to a plain Error below.
  }
  return new Error(String(raw))
}

// host.compute namespace mirroring the spec's Python API surface (kept snake_case on purpose — a JS
// camelCase pass is a deferred one-shot rename once the whole compute feature lands; see roadmap §8).
const hostCompute = {
  // Enumerate registered compute hosts for discovery. No approval, no session context.
  async list() {
    return computeRpc({ op: 'list' })
  },

  // Returns session-enabled compute hosts (≠ list() which returns all registered hosts).
  // Uses COMPUTE_SESSION_ID from spawn env so the registry lookup is always session-scoped.
  async list_compute() {
    return computeRpc({ op: 'list_compute', session_id: COMPUTE_SESSION_ID })
  },
  // Bind a thin handle to one provider (no network call). call_command runs one short remote command;
  // login_shell defaults to true (runs login profiles, then attempts a readable ~/.bashrc, before the
  // command). A .bashrc can deliberately return early for non-interactive shells. false performs no
  // shell initialization.
  // timeout_seconds
  // is optional (the service applies its own default when omitted). Session/project context is threaded
  // from the spawn env so the approval broker can remember a grant for this conversation/project.
  //
  // submit_job: non-blocking job submission — returns {job_id, provider_id, status:'submitted',
  // remote_workdir} immediately, before any SSH. Background dispatch runs the job detached.
  // attach_job: returns a handle with .status() to read job state from DB without SSH.
  create(providerId) {
    return {
      provider_id: providerId,
      async call_command(cmd, intent, options = {}) {
        return computeRpc({
          op: 'call_command',
          provider_id: providerId,
          cmd,
          intent,
          login_shell: options.login_shell !== undefined ? options.login_shell : true,
          timeout_seconds: options.timeout_seconds,
          session_id: COMPUTE_SESSION_ID,
          project_id: COMPUTE_PROJECT_NAME
        })
      },

      // Non-blocking job submission. Returns immediately with job_id + remote_workdir.
      // options: { environment?, resources?, inputs?, outputs?, timeout_seconds?, harvest? }
      // Session/project context is always threaded from spawn env for grant-scope memory.
      // workspace_cwd is captured at spawn time so the main process can resolve workspace paths.
      async submit_job(intent, command, options = {}) {
        return computeRpc({
          op: 'submit_job',
          provider_id: providerId,
          intent,
          command,
          environment: options.environment,
          resources: options.resources,
          inputs: options.inputs,
          outputs: options.outputs,
          timeout_seconds: options.timeout_seconds,
          harvest: options.harvest,
          session_id: COMPUTE_SESSION_ID,
          project_id: COMPUTE_PROJECT_NAME,
          workspace_cwd: process.cwd()
        })
      },

      // Attaches to an existing job by job_id. .status() reads from DB only (no SSH).
      // .result() returns the full JobResult (spec §11.4): scans the local harvest directory,
      // returns workspace-relative file paths, never triggers harvest or SSH (design §9).
      attach_job(jobId) {
        return {
          job_id: jobId,
          async status() {
            return computeRpc({ op: 'job_status', job_id: jobId })
          },
          async result() {
            return computeRpc({ op: 'job_result', job_id: jobId })
          }
        }
      },

      // Set session-level concurrency limit (Phase 3c). Limits the number of non-terminal jobs
      // that can run simultaneously across all providers in this session. Jobs exceeding the limit
      // enter 'queued' state and auto-dispatch when slots free up.
      async set_concurrency_limit(k) {
        if (typeof k !== 'number' || k <= 0 || k > 500 || !Number.isInteger(k)) {
          throw new Error('set_concurrency_limit: k must be a positive integer between 1 and 500')
        }
        return computeRpc({
          op: 'set_concurrency_limit',
          session_id: COMPUTE_SESSION_ID,
          limit: k
        })
      },

      // Query session concurrency status (Phase 3c). Returns session_limit (user-set or null),
      // active_count (non-terminal jobs in session), queued_count (queued jobs in session),
      // and provider_ceilings (per-provider hard limits).
      async status() {
        return computeRpc({
          op: 'concurrency_status',
          session_id: COMPUTE_SESSION_ID
        })
      }
    }
  },
  // Read/append/replace the host knowledge doc. mode defaults to 'read'; append needs `text`; replace
  // needs `text` + `old_text` (old_text must match the current doc exactly, guarding against clobbering
  // a concurrent edit). Snake_case option keys mirror the RPC contract and the spec's Python surface.
  async details(providerId, options = {}) {
    return computeRpc({
      op: 'details',
      provider_id: providerId,
      mode: options.mode || 'read',
      text: options.text,
      old_text: options.old_text
    })
  }
}

// Persistent sandbox: user-declared globals persist across requests (assign to `globalThis`/bare).
const sandbox = {
  host: { mcp: hostMcp, compute: hostCompute },
  console,
  process,
  require,
  fetch,
  URL,
  Buffer,
  setTimeout
}
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)

// Builds the async IIFE for one request. To behave like a REPL, a trailing bare expression is echoed
// (its value becomes `result`): the last line is returned as an expression when that still parses —
// compile-checked, so a statement / multi-line / already-`return`ing tail safely falls back to a plain
// run with no echo. Explicit `return <expr>` and `console.log(...)` continue to work either way.
function wrapForRun(code) {
  const plain = '(async () => {\n' + code + '\n})()'
  const trimmed = code.replace(/[\s;]+$/, '')
  if (!trimmed) return plain
  // Split at the rightmost top-level statement boundary (newline or ';'); the tail is the candidate
  // trailing expression. A ';' inside a string/for-header just yields a tail that won't compile below.
  const split = Math.max(trimmed.lastIndexOf('\n'), trimmed.lastIndexOf(';'))
  const head = split >= 0 ? trimmed.slice(0, split + 1) : ''
  const tail = trimmed.slice(split + 1).trim()
  // Only echo something that can start an expression — never a declaration/control statement.
  if (
    !tail ||
    /^(const|let|var|if|for|while|function|class|switch|try|throw|return|do|else|import|export)\b/.test(
      tail
    )
  ) {
    return plain
  }
  const echo = '(async () => {\n' + head + '\nreturn (\n' + tail + '\n)\n})()'
  try {
    new vm.Script(echo, { filename: '<repl>' })
    return echo
  } catch {
    return plain
  }
}

// Runs one request against the persistent context. console is redirected into strings and restored in
// finally; the awaited value of the async IIFE (i.e. what the user code `return`s) becomes result.
async function run(code) {
  let out = '',
    err = ''
  const origLog = console.log,
    origErr = console.error
  console.log = (...a) => {
    out += a.map(String).join(' ') + '\n'
  }
  console.error = (...a) => {
    err += a.map(String).join(' ') + '\n'
  }
  let error = null,
    result = null
  try {
    const value = await vm.runInContext(wrapForRun(code), context, { filename: '<repl>' })
    if (value !== undefined) {
      // Non-serializable (e.g. circular) echoes fall back to a string so a run never fails on output.
      try {
        result = typeof value === 'string' ? value : JSON.stringify(value)
      } catch {
        result = String(value)
      }
    }
  } catch (e) {
    error = e && e.stack ? String(e.stack) : String(e)
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return { stdout: out, stderr: err, error, result, cwd: process.cwd(), figures: [] }
}

const rl = readline.createInterface({ input: process.stdin })

// Serialize requests (one in flight) via a promise chain so the persistent context stays consistent.
let chain = Promise.resolve()
rl.on('line', (line) => {
  line = line.trim()
  if (!line) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  chain = chain.then(async () => {
    const resp = await run(request.code || '')
    resp.req_id = request.req_id
    emit(resp)
  })
})
