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
const { randomUUID } = require('node:crypto')
const { fileURLToPath } = require('node:url')

// Protocol output line. console is captured into strings during a run (see run()), so writing the
// JSON here via process.stdout.write cannot be corrupted by user console output.
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const OUTPUT_LIMIT_BYTES =
  Number(process.env.OPEN_SCIENCE_NOTEBOOK_TEXT_LIMIT_BYTES) || 2 * 1024 * 1024
const DIAGNOSTIC_LIMIT_BYTES = Math.min(16 * 1024, Math.max(0, OUTPUT_LIMIT_BYTES))

const takeOutput = (budget, value) => {
  value = String(value)
  if (budget.remaining <= 0) {
    if (value) budget.truncated = true
    return ''
  }
  const candidate = value.length > budget.remaining ? value.slice(0, budget.remaining) : value
  const encoded = Buffer.from(candidate, 'utf8')
  if (encoded.byteLength <= budget.remaining) {
    budget.remaining -= encoded.byteLength
    if (candidate.length < value.length) budget.truncated = true
    return encoded.toString('utf8')
  }
  let end = Math.min(budget.remaining, encoded.byteLength)
  while (end > 0 && end < encoded.byteLength && (encoded[end] & 0xc0) === 0x80) end -= 1
  const prefix = encoded.subarray(0, end).toString('utf8')
  budget.remaining -= Buffer.byteLength(prefix, 'utf8')
  budget.truncated = true
  return prefix
}

const takeOutputTail = (budget, value) => {
  value = String(value)
  if (budget.remaining <= 0) {
    if (value) budget.truncated = true
    return ''
  }
  const candidate =
    value.length > budget.remaining ? value.slice(value.length - budget.remaining) : value
  const encoded = Buffer.from(candidate, 'utf8')
  if (encoded.byteLength <= budget.remaining) {
    budget.remaining -= encoded.byteLength
    if (candidate.length < value.length) budget.truncated = true
    return encoded.toString('utf8')
  }
  let start = encoded.byteLength - budget.remaining
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1
  const suffix = encoded.subarray(start).toString('utf8')
  budget.remaining -= Buffer.byteLength(suffix, 'utf8')
  budget.truncated = true
  return suffix
}

// Capture the connector RPC credentials privately, then delete them from process.env BEFORE the
// sandbox is built. The sandbox exposes `process` (for cwd() etc.), so leaving the token in
// process.env would let REPL user code read the connector Bearer token or POST to the RPC endpoint
// directly — bypassing the connector approval/policy gate that host.mcp routes through. host.mcp uses
// the captured values instead. (Broader filesystem/network egress isolation is a tracked follow-up.)
const RPC_ENDPOINT = process.env.OPEN_SCIENCE_MCP_RPC_ENDPOINT
const RPC_SOCKET_PATH = process.env.OPEN_SCIENCE_MCP_RPC_SOCKET_PATH
const RPC_TOKEN_FD = Number(process.env.OPEN_SCIENCE_MCP_RPC_TOKEN_FD)
const RPC_TOKEN =
  Number.isInteger(RPC_TOKEN_FD) && RPC_TOKEN_FD >= 3
    ? (() => {
        try {
          return fs.readFileSync(RPC_TOKEN_FD, 'utf8')
        } finally {
          fs.closeSync(RPC_TOKEN_FD)
        }
      })()
    : process.env.OPEN_SCIENCE_MCP_RPC_TOKEN
const RPC_PROXY_URL =
  !RPC_SOCKET_PATH &&
  RPC_ENDPOINT &&
  new URL(RPC_ENDPOINT).hostname === 'open-science-notebook-rpc.invalid'
    ? process.env.HTTP_PROXY
    : undefined
delete process.env.OPEN_SCIENCE_MCP_RPC_ENDPOINT
delete process.env.OPEN_SCIENCE_MCP_RPC_SOCKET_PATH
delete process.env.OPEN_SCIENCE_MCP_RPC_TOKEN
delete process.env.OPEN_SCIENCE_MCP_RPC_TOKEN_FD

// Notebook session/project identity for host.compute grant-scope approval memory (This conversation /
// This project). Not secret, but captured and removed alongside the RPC creds so sandbox user code that
// enumerates process.env sees neither the token nor the routing identity. Absent -> host.compute call
// payloads omit them and the approval broker falls back to 'once'-only semantics.
const COMPUTE_SESSION_ID = process.env.OPEN_SCIENCE_NOTEBOOK_SESSION_ID
const COMPUTE_PROJECT_ID =
  process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_ID || process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME
delete process.env.OPEN_SCIENCE_NOTEBOOK_SESSION_ID
delete process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_ID
delete process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME

// Updated only by the trusted kernel request frame while one serialized control invocation is
// running. It is never exposed to sandbox code; host.agents forwards it as server context so an
// approved switch can capture only this invocation's outer completion.
let ACTIVE_CONTROL_INVOCATION_ID
let DELEGATE_CALL_SEQUENCE = 0

// Private references to the RPC clients, captured before user code runs. host.mcp MUST use these, not
// the global `fetch`: a vm sandbox is not a security boundary, so sandbox code can reach the outer
// realm via `host.mcp.constructor('return globalThis')()` and reassign the outer fetch to a hook that
// would otherwise capture the connector Bearer token on the next host.mcp call. Module-scoped consts
// are not on globalThis and cannot be reassigned from that escape. (Sandbox code still has direct
// fetch/require/process — full FS + network-egress isolation is the tracked follow-up.)
const capturedFetch = fetch
const capturedHttpRequest = require('node:http').request
const capturedRpcFetch = (input, init = {}) => {
  if (!RPC_SOCKET_PATH && !RPC_PROXY_URL) return capturedFetch(input, init)

  const url = new URL(input)
  const proxy = RPC_PROXY_URL && new URL(RPC_PROXY_URL)
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  if (proxy) {
    const supplied = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    headers['proxy-authorization'] = `Basic ${Buffer.from(supplied).toString('base64')}`
  }
  return new Promise((resolve, reject) => {
    const request = capturedHttpRequest(
      {
        ...(RPC_SOCKET_PATH
          ? { socketPath: RPC_SOCKET_PATH }
          : { hostname: proxy.hostname, port: proxy.port || 80 }),
        path: proxy ? url.href : url.pathname + url.search,
        method: init.method || 'GET',
        headers
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.once('aborted', () => reject(new Error('RPC response was interrupted')))
        response.once('error', reject)
        response.once('end', () => {
          const status = response.statusCode || 500
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(body)
          })
        })
      }
    )
    request.once('error', reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
}

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

// host.mcp: async connector call over the app-local RPC endpoint (same protocol as the MCP bridge).
// Only injected here, in the trusted control plane. Accepts a single positional args object; keyword
// arguments are not idiomatic in JS, so a second object is treated as a fallback args source.
async function hostMcp(server, method, args = undefined, kwargs = undefined) {
  const callArgs = args ?? kwargs ?? {}
  if (!RPC_ENDPOINT) throw new Error('host.mcp is unavailable: connector RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    // Forward the notebook session id so the RPC server resolves the ACP session + specialist scope.
    // Without it the ConnectorService gate rejects the call with missing_session.
    body: JSON.stringify({
      method: 'mcpCall',
      params: {
        server,
        method,
        args: callArgs,
        sessionId: COMPUTE_SESSION_ID,
        ...(COMPUTE_PROJECT_ID ? { projectId: COMPUTE_PROJECT_ID } : {})
      }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || 'host.mcp HTTP ' + res.status)
  if (body.error) throw new Error('host.mcp error: ' + String(body.error))
  return body.result
}

const HOST_CAPABILITY_MAX_FIELDS = 64
const HOST_CAPABILITY_MAX_KEY_LENGTH = 64
const HOST_CAPABILITY_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/
const HOST_CAPABILITY_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// This is the JavaScript-side known catalog, intentionally mirrored by a contract test instead of
// importing TypeScript into the bundled REPL resource.
const HOST_CAPABILITY_KNOWN_KEYS = Object.freeze([
  'mcp',
  'compute',
  'agents',
  'skills',
  'artifacts',
  'lineage',
  'frames',
  'sessions',
  'llm',
  'currentModel',
  'listModels',
  'viewImage',
  'children',
  'collect',
  'delegate',
  'messageReceipt',
  'resolveMessage',
  'sendFrameMessage',
  'stopChild',
  'submitOutput'
])

function isValidHostCapabilityProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false

  const entries = Object.entries(value)
  const knownEntries = HOST_CAPABILITY_KNOWN_KEYS.filter((name) => Object.hasOwn(value, name)).map(
    (name) => [name, value[name]]
  )
  const unknownEntries = entries.filter(([name]) => !HOST_CAPABILITY_KNOWN_KEYS.includes(name))
  return (
    entries.length <= HOST_CAPABILITY_MAX_FIELDS &&
    knownEntries.every(([, enabled]) => typeof enabled === 'boolean') &&
    unknownEntries.every(
      ([name, enabled]) =>
        name.length <= HOST_CAPABILITY_MAX_KEY_LENGTH &&
        HOST_CAPABILITY_KEY_PATTERN.test(name) &&
        !HOST_CAPABILITY_DANGEROUS_KEYS.has(name) &&
        typeof enabled === 'boolean'
    )
  )
}

async function hostCapabilities(...args) {
  if (args.length !== 0) throw new TypeError('host.capabilities accepts no arguments')
  if (!RPC_ENDPOINT) throw new Error('host.capabilities is unavailable: RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'capabilitiesCall', params: {} })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(body.error || 'host.capabilities HTTP ' + res.status)
  }
  const result = body.result
  if (!isValidHostCapabilityProjection(result)) {
    throw new Error('host.capabilities returned an invalid capability projection')
  }
  return Object.freeze(Object.fromEntries(Object.entries(result)))
}

async function hostModelIntrospectionRpc(method, label) {
  if (!RPC_ENDPOINT) throw new Error(`${label} is unavailable: RPC endpoint not set`)
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method, params: {} })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) throw new Error(body.error || `${label} HTTP ` + res.status)
  return body.result
}

async function hostCurrentModel(...args) {
  if (args.length !== 0) throw new TypeError('host.currentModel accepts no arguments')
  const result = await hostModelIntrospectionRpc('currentModelCall', 'host.currentModel')
  if (typeof result !== 'string' || !result.trim() || result === 'provider-default') {
    throw new Error('host.currentModel returned an invalid model id')
  }
  return result
}

async function hostListModels(...args) {
  if (args.length !== 0) throw new TypeError('host.listModels accepts no arguments')
  const result = await hostModelIntrospectionRpc('listModelsCall', 'host.listModels')
  if (
    !Array.isArray(result) ||
    result.length === 0 ||
    result.some((model) => typeof model !== 'string' || !model.trim()) ||
    new Set(result).size !== result.length ||
    result.some((model, index) => index > 0 && result[index - 1] > model)
  ) {
    throw new Error('host.listModels returned an invalid model catalog')
  }
  return Object.freeze([...result])
}

const HOST_LLM_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled'
])

const validatedHostLlmUsage = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('host.llm returned invalid usage')
  }
  const required = ['inputTokens', 'cacheTokens', 'outputTokens']
  const optional = ['cachedReadTokens', 'cachedWriteTokens', 'turnCount']
  const keys = Object.keys(value)
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    [...required, ...optional].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)
    ) ||
    (value.turnCount !== undefined && value.turnCount < 1)
  ) {
    throw new Error('host.llm returned invalid usage')
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])))
}

const validatedHostLlmResult = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('host.llm returned an invalid result')
  }
  const keys = Object.keys(value)
  if (
    !['text', 'model', 'stopReason'].every((key) => keys.includes(key)) ||
    keys.some((key) => !['text', 'model', 'stopReason', 'usage'].includes(key)) ||
    typeof value.text !== 'string' ||
    typeof value.model !== 'string' ||
    !HOST_LLM_STOP_REASONS.has(value.stopReason)
  ) {
    throw new Error('host.llm returned an invalid result')
  }
  return Object.freeze({
    text: value.text,
    model: value.model,
    stopReason: value.stopReason,
    ...(value.usage === undefined ? {} : { usage: validatedHostLlmUsage(value.usage) })
  })
}

const normalizedHostLlmRequest = (value) => {
  if (typeof value === 'string') return value
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const keys = Reflect.ownKeys(value)
    const prompt = value.prompt
    if (keys.length !== 1 || keys[0] !== 'prompt' || typeof prompt !== 'string') {
      return undefined
    }
    return { prompt }
  } catch {
    return undefined
  }
}

const remappedHostObject = (value, label, keyMap) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
  const keys = Reflect.ownKeys(value)
  const unknown = keys.find(
    (key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(keyMap, key)
  )
  if (unknown !== undefined) throw new TypeError(`${label} unknown option: ${String(unknown)}`)
  return Object.fromEntries(keys.map((key) => [keyMap[key], value[key]]))
}

const normalizedHostLlmOptions = (value) => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('host.llm batch options only accept maxConcurrency.')
  }
  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError('host.llm batch options only accept maxConcurrency.')
  }
  const unknown = keys.find((key) => key !== 'maxConcurrency')
  if (unknown !== undefined) {
    throw new TypeError(`host.llm batch options unknown option: ${String(unknown)}`)
  }
  if (keys.length === 0) return {}
  let concurrency
  try {
    concurrency = value.maxConcurrency
  } catch {
    throw new TypeError('host.llm batch options only accept maxConcurrency.')
  }
  if (
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4
  ) {
    throw new TypeError('host.llm maxConcurrency must be an integer from 1 through 4.')
  }
  return { max_concurrency: concurrency }
}

async function hostLlm(request, options = undefined) {
  if (arguments.length < 1 || arguments.length > 2) {
    throw new TypeError('host.llm accepts a request and optional batch options')
  }
  const batch = Array.isArray(request)
  if (!batch && arguments.length > 1) {
    throw new TypeError('host.llm options are only accepted for batch calls')
  }
  const normalizedRequest = batch
    ? request.map((item) => normalizedHostLlmRequest(item) ?? null)
    : normalizedHostLlmRequest(request)
  if (!batch && normalizedRequest === undefined) {
    throw new TypeError('host.llm requests must be a prompt string or an exact { prompt } object.')
  }
  const normalizedOptions =
    batch && arguments.length > 1 ? normalizedHostLlmOptions(options) : undefined
  if (!RPC_ENDPOINT) throw new Error('host.llm is unavailable: RPC endpoint not set')
  const params = batch
    ? {
        requests: normalizedRequest,
        ...(arguments.length > 1 ? { options: normalizedOptions } : {})
      }
    : { request: normalizedRequest }
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'llmCall', params })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) throw new Error(body.error || 'host.llm HTTP ' + res.status)
  if (!batch) return validatedHostLlmResult(body.result)
  if (!Array.isArray(body.result) || body.result.length !== request.length) {
    throw new Error('host.llm returned an invalid batch result')
  }
  return Object.freeze(
    body.result.map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.keys(item).length === 1 &&
        typeof item.error === 'string'
      ) {
        return Object.freeze({ error: item.error })
      }
      return validatedHostLlmResult(item)
    })
  )
}

async function artifactsRpc(op, params) {
  if (!RPC_ENDPOINT)
    throw new Error(
      `host.${op === 'list' ? 'artifacts' : 'artifactPath'} is unavailable: RPC endpoint not set`
    )
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'artifactsCall', params: { op, ...params } })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(
      `host.${op === 'list' ? 'artifacts' : 'artifactPath'}: ${body.error || 'HTTP ' + res.status}`
    )
  }
  return body.result
}

const exactHostObject = (value, label, allowedKeys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  const keys = Reflect.ownKeys(value)
  const unknown = keys.find(
    (key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(allowedKeys, key)
  )
  if (unknown !== undefined) throw new TypeError(`${label} unknown option: ${String(unknown)}`)
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}

const frozenImageSize = (value, label) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Number.isInteger(value.width) ||
    value.width < 1 ||
    !Number.isInteger(value.height) ||
    value.height < 1
  ) {
    throw new Error(`host.viewImage returned invalid ${label}`)
  }
  return Object.freeze({ width: value.width, height: value.height })
}

const frozenImageCrop = (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !['left', 'top', 'right', 'bottom'].every(
      (key) => Number.isInteger(value[key]) && value[key] >= 0
    ) ||
    value.left >= value.right ||
    value.top >= value.bottom
  ) {
    throw new Error('host.viewImage returned invalid crop')
  }
  return Object.freeze({
    left: value.left,
    top: value.top,
    right: value.right,
    bottom: value.bottom
  })
}

const frozenViewImageResult = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('host.viewImage returned an invalid result')
  }
  const allowed = new Set([
    'attached',
    'sourceKind',
    'originalSize',
    'crop',
    'outputSize',
    'mimeType'
  ])
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.attached !== true ||
    !['artifactVersion', 'uploadVersion', 'workspacePath'].includes(value.sourceKind) ||
    !['image/png', 'image/jpeg'].includes(value.mimeType)
  ) {
    throw new Error('host.viewImage returned an invalid result')
  }
  return Object.freeze({
    attached: true,
    sourceKind: value.sourceKind,
    originalSize: frozenImageSize(value.originalSize, 'originalSize'),
    ...(value.crop === undefined ? {} : { crop: frozenImageCrop(value.crop) }),
    outputSize: frozenImageSize(value.outputSize, 'outputSize'),
    mimeType: value.mimeType
  })
}

async function hostViewImage(source, options = undefined) {
  if (arguments.length < 1 || arguments.length > 2) {
    throw new TypeError('host.viewImage accepts source and optional options')
  }
  const normalizedSource = exactHostObject(source, 'host.viewImage source', {
    versionId: true,
    path: true
  })
  const normalizedOptions =
    options === undefined
      ? undefined
      : exactHostObject(options, 'host.viewImage options', { crop: true, maxSize: true })
  if (normalizedOptions?.crop !== undefined) {
    normalizedOptions.crop = exactHostObject(normalizedOptions.crop, 'host.viewImage crop', {
      unit: true,
      left: true,
      top: true,
      right: true,
      bottom: true
    })
  }
  if (!RPC_ENDPOINT) throw new Error('host.viewImage is unavailable: RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'viewImageCall',
      params: {
        source: normalizedSource,
        ...(normalizedOptions === undefined ? {} : { options: normalizedOptions })
      }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) throw new Error(body.error || 'host.viewImage HTTP ' + res.status)
  return frozenViewImageResult(body.result)
}

const HOST_ARTIFACT_REQUIRED_KEYS = [
  'id',
  'filename',
  'contentType',
  'sizeBytes',
  'latestVersionId',
  'checksum',
  'projectId',
  'sessionId',
  'rootFrameId',
  'agentFrameId',
  'isUserUpload',
  'createdAt',
  'latestVersionCreatedAt'
]
const HOST_ARTIFACT_INPUT_KEYS = {
  versionId: 'version_id',
  frameId: 'frame_id',
  filename: 'filename',
  exact: 'exact',
  search: 'search',
  contentType: 'content_type',
  after: 'after',
  before: 'before',
  cursor: 'cursor',
  limit: 'limit'
}

const nullableHostArtifactString = (value) => value === null || typeof value === 'string'

const validatedHostArtifact = (value, projectId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('host.artifacts returned an invalid Artifact')
  }
  const keys = Object.keys(value)
  if (
    HOST_ARTIFACT_REQUIRED_KEYS.some((key) => !keys.includes(key)) ||
    typeof value.id !== 'string' ||
    typeof value.filename !== 'string' ||
    !nullableHostArtifactString(value.contentType) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    typeof value.latestVersionId !== 'string' ||
    !nullableHostArtifactString(value.checksum) ||
    value.projectId !== projectId ||
    typeof value.sessionId !== 'string' ||
    !nullableHostArtifactString(value.rootFrameId) ||
    !nullableHostArtifactString(value.agentFrameId) ||
    typeof value.isUserUpload !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    typeof value.latestVersionCreatedAt !== 'string'
  ) {
    throw new Error('host.artifacts returned an invalid Artifact')
  }
  return Object.freeze(
    Object.fromEntries(HOST_ARTIFACT_REQUIRED_KEYS.map((key) => [key, value[key]]))
  )
}

async function hostArtifacts(options = {}) {
  if (arguments.length > 1) throw new TypeError('host.artifacts accepts at most one options object')
  const result = await artifactsRpc('list', {
    options: remappedHostObject(options, 'host.artifacts options', HOST_ARTIFACT_INPUT_KEYS)
  })
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !Number.isSafeInteger(result.count) ||
    result.count < 0 ||
    typeof result.projectId !== 'string' ||
    typeof result.truncated !== 'boolean' ||
    (result.nextCursor !== undefined && typeof result.nextCursor !== 'string') ||
    !Array.isArray(result.artifacts) ||
    result.count < result.artifacts.length ||
    result.truncated !== (result.nextCursor !== undefined)
  ) {
    throw new Error('host.artifacts returned an invalid result')
  }
  const artifacts = Object.freeze(
    result.artifacts.map((artifact) => validatedHostArtifact(artifact, result.projectId))
  )
  return Object.freeze({
    count: result.count,
    projectId: result.projectId,
    truncated: result.truncated,
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    artifacts
  })
}

async function hostArtifactPath(versionId) {
  if (arguments.length !== 1) throw new TypeError('host.artifactPath accepts one versionId')
  const result = await artifactsRpc('path', { version_id: versionId })
  if (typeof result !== 'string' || !path.isAbsolute(result)) {
    throw new Error('host.artifactPath returned an invalid path')
  }
  return result
}

async function lineageRpc(op, params) {
  if (!RPC_ENDPOINT) throw new Error('host.lineage is unavailable: RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'lineageCall', params: { op, ...params } })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(`host.lineage.${op}: ${body.error || 'HTTP ' + res.status}`)
  }
  return body.result
}

const exactObject = (value, requiredKeys, optionalKeys = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return (
    requiredKeys.every((key) => keys.includes(key)) &&
    keys.every((key) => requiredKeys.includes(key) || optionalKeys.includes(key))
  )
}

const camelCasedHostValue = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(camelCasedHostValue))
  if (!value || typeof value !== 'object') return value
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()),
        camelCasedHostValue(entry)
      ])
    )
  )
}

const hostFrameString = (value) => typeof value === 'string'
const hostFrameCount = (value) => Number.isSafeInteger(value) && value >= 0
const hostFrameOptionalString = (value) => value === undefined || hostFrameString(value)
const frozenProjection = (value, keys) =>
  Object.freeze(
    Object.fromEntries(
      keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])
    )
  )

const HOST_FRAME_REQUIRED_KEYS = [
  'frame_id',
  'session_id',
  'session_title',
  'kind',
  'recorded_frame_status',
  'session_status',
  'created_at',
  'session_updated_at',
  'message_count',
  'child_count'
]
const HOST_FRAME_OPTIONAL_KEYS = [
  'parent_frame_id',
  'origin_message_id',
  'agent_name',
  'delegate_name',
  'linked_review_id',
  'completed_at',
  'archived_at'
]
const HOST_FRAME_KINDS = ['root', 'reviewer', 'delegate', 'compatibility']
const HOST_FRAME_STATUSES = ['running', 'completed', 'cancelled', 'error']
const HOST_SESSION_STATUSES = [
  'idle',
  'running',
  'waiting-for-user',
  'waiting-permission',
  'waiting-plan-approval',
  'error'
]

const validatedHostFrame = (value) => {
  if (
    !exactObject(value, HOST_FRAME_REQUIRED_KEYS, HOST_FRAME_OPTIONAL_KEYS) ||
    !hostFrameString(value.frame_id) ||
    !hostFrameString(value.session_id) ||
    !hostFrameString(value.session_title) ||
    !HOST_FRAME_KINDS.includes(value.kind) ||
    !HOST_FRAME_STATUSES.includes(value.recorded_frame_status) ||
    !HOST_SESSION_STATUSES.includes(value.session_status) ||
    !hostFrameString(value.created_at) ||
    !hostFrameString(value.session_updated_at) ||
    !hostFrameCount(value.message_count) ||
    !hostFrameCount(value.child_count) ||
    HOST_FRAME_OPTIONAL_KEYS.some((key) => !hostFrameOptionalString(value[key]))
  ) {
    throw new Error('host.frames returned an invalid Frame')
  }
  return frozenProjection(value, [...HOST_FRAME_REQUIRED_KEYS, ...HOST_FRAME_OPTIONAL_KEYS])
}

const validatedHostFrameSession = (value) => {
  const required = ['session_id', 'session_title', 'session_status', 'created_at', 'updated_at']
  const optional = ['archived_at']
  if (
    !exactObject(value, required, optional) ||
    !hostFrameString(value.session_id) ||
    !hostFrameString(value.session_title) ||
    !HOST_SESSION_STATUSES.includes(value.session_status) ||
    !hostFrameString(value.created_at) ||
    !hostFrameString(value.updated_at) ||
    !hostFrameOptionalString(value.archived_at)
  ) {
    throw new Error('host.frames.get returned an invalid Session')
  }
  return frozenProjection(value, [...required, ...optional])
}

const validatedHostFrameBranch = (value) => {
  const keys = ['branch_id', 'created_at', 'updated_at']
  if (!exactObject(value, keys) || keys.some((key) => !hostFrameString(value[key]))) {
    throw new Error('host.frames.get returned an invalid Branch')
  }
  return frozenProjection(value, keys)
}

const validatedHostFrameTurnUsage = (value) => {
  const required = ['input_tokens', 'cache_tokens', 'output_tokens']
  const optional = ['cached_read_tokens', 'cached_write_tokens', 'turn_count']
  if (
    !exactObject(value, required, optional) ||
    [...required, ...optional].some(
      (key) => value[key] !== undefined && !hostFrameCount(value[key])
    )
  ) {
    throw new Error('host.frames.get returned invalid turn usage')
  }
  return frozenProjection(value, [...required, ...optional])
}

const validatedHostFrameAttachment = (value) => {
  const required = ['kind', 'attachment_id']
  const optional = ['version_id', 'name', 'mime_type', 'size_bytes']
  if (
    !exactObject(value, required, optional) ||
    !['upload', 'artifact', 'image'].includes(value.kind) ||
    !hostFrameString(value.attachment_id) ||
    ['version_id', 'name', 'mime_type'].some((key) => !hostFrameOptionalString(value[key])) ||
    (value.size_bytes !== undefined && !hostFrameCount(value.size_bytes))
  ) {
    throw new Error('host.frames.get returned an invalid attachment')
  }
  return frozenProjection(value, [...required, ...optional])
}

const validatedHostFrameMessage = (value) => {
  const required = ['message_id', 'role', 'content', 'status', 'created_at', 'updated_at']
  const optional = [
    'response_to_message_id',
    'runtime_segment_id',
    'completed_at',
    'failed_at',
    'turn_usage',
    'attachments'
  ]
  if (
    !exactObject(value, required, optional) ||
    !hostFrameString(value.message_id) ||
    !['user', 'agent'].includes(value.role) ||
    !hostFrameString(value.content) ||
    !['complete', 'streaming', 'error'].includes(value.status) ||
    !hostFrameString(value.created_at) ||
    !hostFrameString(value.updated_at) ||
    ['response_to_message_id', 'runtime_segment_id', 'completed_at', 'failed_at'].some(
      (key) => !hostFrameOptionalString(value[key])
    ) ||
    (value.turn_usage !== undefined &&
      (!value.turn_usage ||
        typeof value.turn_usage !== 'object' ||
        Array.isArray(value.turn_usage))) ||
    (value.attachments !== undefined && !Array.isArray(value.attachments))
  ) {
    throw new Error('host.frames.get returned an invalid Message')
  }
  return Object.freeze({
    ...frozenProjection(
      value,
      [...required, ...optional].filter((key) => !['turn_usage', 'attachments'].includes(key))
    ),
    ...(value.turn_usage ? { turn_usage: validatedHostFrameTurnUsage(value.turn_usage) } : {}),
    ...(value.attachments
      ? { attachments: Object.freeze(value.attachments.map(validatedHostFrameAttachment)) }
      : {})
  })
}

const validatedHostFrameTranscript = (value) => {
  const required = ['messages', 'has_more_before']
  const optional = ['previous_cursor']
  if (
    !exactObject(value, required, optional) ||
    !Array.isArray(value.messages) ||
    typeof value.has_more_before !== 'boolean' ||
    !hostFrameOptionalString(value.previous_cursor) ||
    value.has_more_before !== (value.previous_cursor !== undefined)
  ) {
    throw new Error('host.frames.get returned an invalid transcript')
  }
  return Object.freeze({
    messages: Object.freeze(value.messages.map(validatedHostFrameMessage)),
    ...(value.previous_cursor !== undefined ? { previous_cursor: value.previous_cursor } : {}),
    has_more_before: value.has_more_before
  })
}

const validatedHostRuntimeSegment = (value) => {
  const required = ['runtime_segment_id', 'started_at']
  const optional = ['agent_name', 'ended_at']
  if (
    !exactObject(value, required, optional) ||
    !hostFrameString(value.runtime_segment_id) ||
    !hostFrameString(value.started_at) ||
    optional.some((key) => !hostFrameOptionalString(value[key]))
  ) {
    throw new Error('host.frames.get returned an invalid runtime segment')
  }
  return frozenProjection(value, [...required, ...optional])
}

const HOST_SESSION_CONNECTION_STATUSES = ['idle', 'connecting', 'connected', 'error', 'closed']
const HOST_SESSION_OBSERVATION_KINDS = [
  'system',
  'message',
  'thought',
  'tool',
  'plan',
  'permission',
  'artifact',
  'compaction',
  'error',
  'stop',
  'raw'
]
const HOST_SESSION_OBSERVATION_LEVELS = ['info', 'warning', 'error']

const validatedHostSessionRuntime = (value) => {
  const required = [
    'attached',
    'prompt_in_flight',
    'agent_prompt_in_flight',
    'permission_pending',
    'user_input_pending'
  ]
  const optional = ['connection_status']
  if (
    !exactObject(value, required, optional) ||
    required.some((key) => typeof value[key] !== 'boolean') ||
    (value.connection_status !== undefined &&
      !HOST_SESSION_CONNECTION_STATUSES.includes(value.connection_status))
  ) {
    throw new Error('host.sessions returned an invalid runtime projection')
  }
  return Object.freeze({
    attached: value.attached,
    ...(value.connection_status !== undefined ? { connectionStatus: value.connection_status } : {}),
    promptInFlight: value.prompt_in_flight,
    agentPromptInFlight: value.agent_prompt_in_flight,
    permissionPending: value.permission_pending,
    userInputPending: value.user_input_pending
  })
}

const validatedHostSessionConversation = (value) => {
  const keys = ['frame_id', 'branch_id', 'message_count']
  if (
    !exactObject(value, keys) ||
    !hostFrameString(value.frame_id) ||
    !hostFrameString(value.branch_id) ||
    !hostFrameCount(value.message_count)
  ) {
    throw new Error('host.sessions returned an invalid active conversation')
  }
  return Object.freeze({
    frameId: value.frame_id,
    branchId: value.branch_id,
    messageCount: value.message_count
  })
}

const validatedHostSessionObservation = (value) => {
  const required = ['timestamp', 'kind', 'level']
  const optional = ['status', 'title']
  if (
    !exactObject(value, required, optional) ||
    !hostFrameString(value.timestamp) ||
    !HOST_SESSION_OBSERVATION_KINDS.includes(value.kind) ||
    !HOST_SESSION_OBSERVATION_LEVELS.includes(value.level) ||
    !hostFrameOptionalString(value.status) ||
    !hostFrameOptionalString(value.title)
  ) {
    throw new Error('host.sessions returned an invalid latest observation')
  }
  return Object.freeze({
    timestamp: value.timestamp,
    kind: value.kind,
    level: value.level,
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.title !== undefined ? { title: value.title } : {})
  })
}

const validatedHostSession = (value) => {
  const required = ['session_id', 'title', 'status', 'created_at', 'updated_at', 'runtime']
  const optional = [
    'archived_at',
    'active_run_started_at',
    'active_conversation',
    'latest_observation'
  ]
  if (
    !exactObject(value, required, optional) ||
    !hostFrameString(value.session_id) ||
    !hostFrameString(value.title) ||
    !HOST_SESSION_STATUSES.includes(value.status) ||
    !hostFrameString(value.created_at) ||
    !hostFrameString(value.updated_at) ||
    !hostFrameOptionalString(value.archived_at) ||
    !hostFrameOptionalString(value.active_run_started_at) ||
    !value.runtime ||
    typeof value.runtime !== 'object' ||
    Array.isArray(value.runtime)
  ) {
    throw new Error('host.sessions returned an invalid Session')
  }
  return Object.freeze({
    sessionId: value.session_id,
    title: value.title,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...(value.archived_at !== undefined ? { archivedAt: value.archived_at } : {}),
    ...(value.active_run_started_at !== undefined
      ? { activeRunStartedAt: value.active_run_started_at }
      : {}),
    runtime: validatedHostSessionRuntime(value.runtime),
    ...(value.active_conversation !== undefined
      ? { activeConversation: validatedHostSessionConversation(value.active_conversation) }
      : {}),
    ...(value.latest_observation !== undefined
      ? { latestObservation: validatedHostSessionObservation(value.latest_observation) }
      : {})
  })
}

async function framesRpc(op, params) {
  if (!RPC_ENDPOINT) throw new Error(`host.frames.${op} is unavailable: RPC endpoint not set`)
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'framesCall', params: { op, ...params } })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(`host.frames.${op}: ${body.error || 'HTTP ' + res.status}`)
  }
  return body.result
}

const isHostLineageRecord = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const hasHostLineageKeys = (value, required, optional = []) => {
  if (!isHostLineageRecord(value)) return false
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key))
}

const validatedHostPackageSource = (value) => {
  if (
    hasHostLineageKeys(value, ['type', 'repository'], ['ref', 'commit']) &&
    value.type === 'github' &&
    typeof value.repository === 'string' &&
    (value.ref === undefined || typeof value.ref === 'string') &&
    (value.commit === undefined || typeof value.commit === 'string')
  ) {
    return Object.freeze({
      type: value.type,
      repository: value.repository,
      ...(value.ref !== undefined ? { ref: value.ref } : {}),
      ...(value.commit !== undefined ? { commit: value.commit } : {})
    })
  }
  if (
    hasHostLineageKeys(value, ['type'], ['version']) &&
    value.type === 'bioconductor' &&
    (value.version === undefined || typeof value.version === 'string')
  ) {
    return Object.freeze({
      type: value.type,
      ...(value.version !== undefined ? { version: value.version } : {})
    })
  }
  throw new Error('host.lineage.get returned an invalid package source')
}

const validatedHostLineageNode = (value) => {
  const required = [
    'file_id',
    'version_id',
    'filename',
    'version_number',
    'session_id',
    'root_frame_id',
    'agent_frame_id',
    'created_at',
    'size_bytes',
    'checksum',
    'is_user_upload'
  ]
  if (
    !hasHostLineageKeys(value, required, ['content_type']) ||
    ![
      value.file_id,
      value.version_id,
      value.filename,
      value.session_id,
      value.created_at,
      value.checksum
    ].every((entry) => typeof entry === 'string' && entry.length > 0) ||
    !Number.isSafeInteger(value.version_number) ||
    value.version_number < 1 ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    (value.root_frame_id !== null && typeof value.root_frame_id !== 'string') ||
    (value.agent_frame_id !== null && typeof value.agent_frame_id !== 'string') ||
    (value.content_type !== undefined && typeof value.content_type !== 'string') ||
    typeof value.is_user_upload !== 'boolean'
  ) {
    throw new Error('host.lineage.graph returned an invalid node')
  }
  return Object.freeze(
    Object.fromEntries(
      [...required, 'content_type']
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, value[key]])
    )
  )
}

const validatedHostLineageEdge = (value) => {
  const required = [
    'version_id',
    'depends_on_version_id',
    'ordinal',
    'source_kind',
    'input_filename',
    'association'
  ]
  if (
    !hasHostLineageKeys(value, required) ||
    ![value.version_id, value.depends_on_version_id, value.input_filename].every(
      (entry) => typeof entry === 'string' && entry.length > 0
    ) ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 0 ||
    !['artifact-version', 'upload-version'].includes(value.source_kind) ||
    !['turn-attached', 'resolver-accessed'].includes(value.association)
  ) {
    throw new Error('host.lineage.graph returned an invalid edge')
  }
  return Object.freeze(Object.fromEntries(required.map((key) => [key, value[key]])))
}

const validatedHostLineageGraph = (value) => {
  const required = ['project_id', 'root_version_id', 'direction', 'truncated', 'nodes', 'edges']
  const optional = ['truncation_reason', 'frontier_version_ids']
  if (
    !hasHostLineageKeys(value, required, optional) ||
    typeof value.project_id !== 'string' ||
    typeof value.root_version_id !== 'string' ||
    !['up', 'down'].includes(value.direction) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    (value.truncated
      ? !['max_depth', 'max_nodes'].includes(value.truncation_reason) ||
        !Array.isArray(value.frontier_version_ids) ||
        value.frontier_version_ids.length === 0 ||
        value.frontier_version_ids.some((entry) => typeof entry !== 'string' || !entry)
      : value.truncation_reason !== undefined || value.frontier_version_ids !== undefined)
  ) {
    throw new Error('host.lineage.graph returned an invalid result')
  }
  const nodes = Object.freeze(value.nodes.map(validatedHostLineageNode))
  const edges = Object.freeze(value.edges.map(validatedHostLineageEdge))
  const frontier = value.frontier_version_ids
    ? Object.freeze([...value.frontier_version_ids])
    : undefined
  return Object.freeze({
    project_id: value.project_id,
    root_version_id: value.root_version_id,
    direction: value.direction,
    truncated: value.truncated,
    ...(value.truncation_reason ? { truncation_reason: value.truncation_reason } : {}),
    ...(frontier ? { frontier_version_ids: frontier } : {}),
    nodes,
    edges
  })
}

const HOST_LINEAGE_UNAVAILABLE_REASONS = [
  'producer-not-supplied',
  'producer-source-unverifiable',
  'environment-not-supported',
  'environment-capture-failed',
  'environment-manifest-publication-failed',
  'legacy-environment-reference-unavailable'
]
const HOST_LINEAGE_ATTEMPT_REASONS = [
  'package-not-found',
  'solver-failed',
  'installer-unavailable',
  'permission',
  'network',
  'authentication',
  'tls-policy',
  'validation',
  'cancelled',
  'process-unconfirmed',
  'recovery-blocked',
  'unknown'
]

const validatedHostLineageAvailability = (value) => {
  if (
    !isHostLineageRecord(value) ||
    (value.state === 'unavailable'
      ? !hasHostLineageKeys(value, ['state', 'reason']) ||
        !HOST_LINEAGE_UNAVAILABLE_REASONS.includes(value.reason)
      : !hasHostLineageKeys(value, ['state']) || !['available', 'partial'].includes(value.state))
  ) {
    throw new Error('host.lineage.get returned an invalid availability projection')
  }
  return Object.freeze(
    value.state === 'unavailable'
      ? { state: value.state, reason: value.reason }
      : { state: value.state }
  )
}

const validatedHostLineageProducer = (value) => {
  if (value?.state === 'unavailable') {
    if (
      !hasHostLineageKeys(value, ['state', 'reason']) ||
      !['producer-not-supplied', 'producer-source-unverifiable'].includes(value.reason)
    ) {
      throw new Error('host.lineage.get returned an invalid producer projection')
    }
    return Object.freeze({ state: value.state, reason: value.reason })
  }
  const required = [
    'state',
    'notebook_session_id',
    'producer_run_id',
    'run_index',
    'kernel_kind',
    'association_method'
  ]
  if (
    !hasHostLineageKeys(value, required, ['environment_manifest_checksum']) ||
    value.state !== 'available' ||
    typeof value.notebook_session_id !== 'string' ||
    typeof value.producer_run_id !== 'string' ||
    !Number.isSafeInteger(value.run_index) ||
    value.run_index < 0 ||
    !['python', 'r', 'repl', 'bash'].includes(value.kernel_kind) ||
    !['agent-declared-and-session-validated', 'server-inferred-file-observation'].includes(
      value.association_method
    ) ||
    (value.environment_manifest_checksum !== undefined &&
      typeof value.environment_manifest_checksum !== 'string')
  ) {
    throw new Error('host.lineage.get returned an invalid producer projection')
  }
  return Object.freeze(
    Object.fromEntries(
      [...required, 'environment_manifest_checksum']
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, value[key]])
    )
  )
}

const validatedHostLineageEnvironment = (value) => {
  const required = [
    'capture_kind',
    'environment_name',
    'kernel_kind',
    'runtime_source',
    'packages',
    'inventory_sources',
    'installed_inventory',
    'captured_at',
    'source_manifest_checksum',
    'complete',
    'capture_status'
  ]
  const optional = [
    'runtime_version',
    'platform',
    'architecture',
    'python_version',
    'r_version',
    'op_log',
    'op_log_truncation',
    'warnings'
  ]
  const optionalStrings = [
    'runtime_version',
    'platform',
    'architecture',
    'python_version',
    'r_version'
  ]
  if (
    !hasHostLineageKeys(value, required, optional) ||
    value.capture_kind !== 'completed-run' ||
    typeof value.environment_name !== 'string' ||
    !['python', 'r'].includes(value.kernel_kind) ||
    !['managed', 'external'].includes(value.runtime_source) ||
    optionalStrings.some((key) => value[key] !== undefined && typeof value[key] !== 'string') ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.inventory_sources) ||
    value.inventory_sources.some(
      (entry) => !['kernel-native', 'interpreter-native', 'operation-log'].includes(entry)
    ) ||
    !hasHostLineageKeys(value.installed_inventory, ['captured_at', 'source', 'validation']) ||
    typeof value.installed_inventory.captured_at !== 'string' ||
    !['full-scan', 'cache-reused'].includes(value.installed_inventory.source) ||
    !['full-scan', 'best-effort'].includes(value.installed_inventory.validation) ||
    typeof value.captured_at !== 'string' ||
    typeof value.source_manifest_checksum !== 'string' ||
    typeof value.complete !== 'boolean' ||
    !['complete', 'partial'].includes(value.capture_status) ||
    (value.warnings !== undefined &&
      (!Array.isArray(value.warnings) || value.warnings.some((entry) => typeof entry !== 'string')))
  ) {
    throw new Error('host.lineage.get returned an invalid environment projection')
  }
  const packages = Object.freeze(
    value.packages.map((entry) => {
      const packageRequired = [
        'name',
        'version_status',
        'ecosystem',
        'evidence_sources',
        'loaded_state'
      ]
      const packageOptional = [
        'version',
        'library_rank',
        'library_scope',
        'built_for_runtime',
        'priority',
        'source'
      ]
      if (
        !hasHostLineageKeys(entry, packageRequired, packageOptional) ||
        typeof entry.name !== 'string' ||
        (entry.version !== undefined && typeof entry.version !== 'string') ||
        !['known', 'unavailable'].includes(entry.version_status) ||
        !['python', 'r', 'native', 'unknown'].includes(entry.ecosystem) ||
        !Array.isArray(entry.evidence_sources) ||
        entry.evidence_sources.some(
          (source) =>
            ![
              'python-importlib-metadata',
              'python-kernel-modules',
              'r-installed-packages',
              'r-session-info'
            ].includes(source)
        ) ||
        !['attached', 'loaded', 'installed-only', 'unknown'].includes(entry.loaded_state) ||
        (entry.library_rank !== undefined && !Number.isSafeInteger(entry.library_rank)) ||
        (entry.library_scope !== undefined &&
          !['environment', 'user', 'system', 'unknown'].includes(entry.library_scope)) ||
        (entry.built_for_runtime !== undefined && typeof entry.built_for_runtime !== 'string') ||
        (entry.priority !== undefined && !['base', 'recommended', 'other'].includes(entry.priority))
      ) {
        throw new Error('host.lineage.get returned an invalid environment package')
      }
      return Object.freeze({
        name: entry.name,
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        version_status: entry.version_status,
        ecosystem: entry.ecosystem,
        evidence_sources: Object.freeze([...entry.evidence_sources]),
        loaded_state: entry.loaded_state,
        ...(entry.library_rank !== undefined ? { library_rank: entry.library_rank } : {}),
        ...(entry.library_scope !== undefined ? { library_scope: entry.library_scope } : {}),
        ...(entry.built_for_runtime !== undefined
          ? { built_for_runtime: entry.built_for_runtime }
          : {}),
        ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
        ...(entry.source !== undefined ? { source: validatedHostPackageSource(entry.source) } : {})
      })
    })
  )
  if (value.op_log !== undefined && !Array.isArray(value.op_log)) {
    throw new Error('host.lineage.get returned an invalid environment operation log')
  }
  const opLog = value.op_log
    ? Object.freeze(
        value.op_log.map((entry) => {
          const operationRequired = [
            'operation_id',
            'timestamp',
            'operation',
            'packages',
            'result',
            'attempts',
            'fallback_used',
            'inventory_refresh',
            'inventory_refresh_attempts'
          ]
          if (
            !hasHostLineageKeys(entry, operationRequired, ['package_changes']) ||
            typeof entry.operation_id !== 'string' ||
            typeof entry.timestamp !== 'string' ||
            !['create', 'install', 'uninstall', 'update'].includes(entry.operation) ||
            !Array.isArray(entry.packages) ||
            entry.packages.some((item) => typeof item !== 'string') ||
            !['success', 'failure'].includes(entry.result) ||
            !Array.isArray(entry.attempts) ||
            typeof entry.fallback_used !== 'boolean' ||
            !['published', 'unchanged', 'failed'].includes(entry.inventory_refresh) ||
            !Array.isArray(entry.inventory_refresh_attempts) ||
            (entry.package_changes !== undefined && !Array.isArray(entry.package_changes))
          ) {
            throw new Error('host.lineage.get returned an invalid environment operation')
          }
          const attempts = Object.freeze(
            entry.attempts.map((attempt) => {
              const attemptRequired = [
                'group_ordinal',
                'installer',
                'packages',
                'status',
                'mutation_risk'
              ]
              if (
                !hasHostLineageKeys(attempt, attemptRequired, ['reason']) ||
                !Number.isSafeInteger(attempt.group_ordinal) ||
                ![
                  'conda',
                  'pip',
                  'uv',
                  'poetry',
                  'r-install-packages',
                  'renv',
                  'pak',
                  'biocmanager',
                  'github',
                  'unknown'
                ].includes(attempt.installer) ||
                !Array.isArray(attempt.packages) ||
                attempt.packages.some((item) => typeof item !== 'string') ||
                !['succeeded', 'failed', 'skipped'].includes(attempt.status) ||
                !['none', 'possible', 'confirmed', 'unknown'].includes(attempt.mutation_risk) ||
                (attempt.reason !== undefined &&
                  !HOST_LINEAGE_ATTEMPT_REASONS.includes(attempt.reason))
              ) {
                throw new Error('host.lineage.get returned an invalid environment attempt')
              }
              return Object.freeze({
                group_ordinal: attempt.group_ordinal,
                installer: attempt.installer,
                packages: Object.freeze([...attempt.packages]),
                status: attempt.status,
                mutation_risk: attempt.mutation_risk,
                ...(attempt.reason !== undefined ? { reason: attempt.reason } : {})
              })
            })
          )
          const refreshAttempts = Object.freeze(
            entry.inventory_refresh_attempts.map((attempt) => {
              if (
                !hasHostLineageKeys(
                  attempt,
                  ['attempt', 'trigger', 'timestamp', 'result'],
                  ['error']
                ) ||
                !Number.isSafeInteger(attempt.attempt) ||
                !['terminal', 'recovery'].includes(attempt.trigger) ||
                typeof attempt.timestamp !== 'string' ||
                !['published', 'unchanged', 'failed'].includes(attempt.result) ||
                (attempt.error !== undefined && typeof attempt.error !== 'string')
              ) {
                throw new Error('host.lineage.get returned an invalid inventory refresh attempt')
              }
              return Object.freeze({
                attempt: attempt.attempt,
                trigger: attempt.trigger,
                timestamp: attempt.timestamp,
                result: attempt.result,
                ...(attempt.error !== undefined ? { error: attempt.error } : {})
              })
            })
          )
          const packageChanges = entry.package_changes
            ? Object.freeze(
                entry.package_changes.map((change) => {
                  const changeRequired = ['name', 'ecosystem', 'relationship', 'change']
                  const changeOptional = [
                    'before_version',
                    'after_version',
                    'library_rank',
                    'library_scope',
                    'source'
                  ]
                  if (
                    !hasHostLineageKeys(change, changeRequired, changeOptional) ||
                    typeof change.name !== 'string' ||
                    !['python', 'r', 'native', 'unknown'].includes(change.ecosystem) ||
                    !['requested', 'dependency', 'unattributed'].includes(change.relationship) ||
                    !['installed', 'updated', 'removed', 'unchanged', 'observed'].includes(
                      change.change
                    ) ||
                    (change.before_version !== undefined &&
                      typeof change.before_version !== 'string') ||
                    (change.after_version !== undefined &&
                      typeof change.after_version !== 'string') ||
                    (change.library_rank !== undefined &&
                      !Number.isSafeInteger(change.library_rank)) ||
                    (change.library_scope !== undefined &&
                      !['environment', 'user', 'system', 'unknown'].includes(change.library_scope))
                  ) {
                    throw new Error('host.lineage.get returned an invalid package change')
                  }
                  return Object.freeze({
                    ...Object.fromEntries(
                      [...changeRequired, ...changeOptional]
                        .filter((key) => key !== 'source' && change[key] !== undefined)
                        .map((key) => [key, change[key]])
                    ),
                    ...(change.source !== undefined
                      ? { source: validatedHostPackageSource(change.source) }
                      : {})
                  })
                })
              )
            : undefined
          return Object.freeze({
            operation_id: entry.operation_id,
            timestamp: entry.timestamp,
            operation: entry.operation,
            packages: Object.freeze([...entry.packages]),
            result: entry.result,
            attempts,
            fallback_used: entry.fallback_used,
            inventory_refresh: entry.inventory_refresh,
            inventory_refresh_attempts: refreshAttempts,
            ...(packageChanges ? { package_changes: packageChanges } : {})
          })
        })
      )
    : undefined
  let opLogTruncation
  if (value.op_log_truncation !== undefined) {
    if (
      !hasHostLineageKeys(value.op_log_truncation, ['omitted_count'], ['earliest_retained_at']) ||
      !Number.isSafeInteger(value.op_log_truncation.omitted_count) ||
      value.op_log_truncation.omitted_count <= 0 ||
      (value.op_log_truncation.earliest_retained_at !== undefined &&
        typeof value.op_log_truncation.earliest_retained_at !== 'string')
    ) {
      throw new Error('host.lineage.get returned an invalid operation-log truncation')
    }
    opLogTruncation = Object.freeze({
      omitted_count: value.op_log_truncation.omitted_count,
      ...(value.op_log_truncation.earliest_retained_at
        ? { earliest_retained_at: value.op_log_truncation.earliest_retained_at }
        : {})
    })
  }
  return Object.freeze({
    capture_kind: value.capture_kind,
    environment_name: value.environment_name,
    kernel_kind: value.kernel_kind,
    runtime_source: value.runtime_source,
    ...Object.fromEntries(
      optionalStrings.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])
    ),
    packages,
    inventory_sources: Object.freeze([...value.inventory_sources]),
    installed_inventory: Object.freeze({
      captured_at: value.installed_inventory.captured_at,
      source: value.installed_inventory.source,
      validation: value.installed_inventory.validation
    }),
    ...(opLog ? { op_log: opLog } : {}),
    ...(opLogTruncation ? { op_log_truncation: opLogTruncation } : {}),
    captured_at: value.captured_at,
    source_manifest_checksum: value.source_manifest_checksum,
    complete: value.complete,
    capture_status: value.capture_status,
    ...(value.warnings ? { warnings: Object.freeze([...value.warnings]) } : {})
  })
}

const validatedHostLineageInput = (value) => {
  const required = [
    'ordinal',
    'version_id',
    'file_id',
    'source_kind',
    'session_id',
    'filename',
    'size_bytes',
    'checksum',
    'association'
  ]
  const optional = ['version_number', 'created_at', 'content_type']
  if (
    !hasHostLineageKeys(value, required, optional) ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 0 ||
    ![value.version_id, value.file_id, value.session_id, value.filename, value.checksum].every(
      (entry) => typeof entry === 'string' && entry.length > 0
    ) ||
    !['artifact-version', 'upload-version'].includes(value.source_kind) ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    !['turn-attached', 'resolver-accessed'].includes(value.association) ||
    (value.version_number !== undefined &&
      (!Number.isSafeInteger(value.version_number) || value.version_number < 1)) ||
    (value.created_at !== undefined && typeof value.created_at !== 'string') ||
    (value.content_type !== undefined && typeof value.content_type !== 'string')
  ) {
    throw new Error('host.lineage.get returned an invalid input')
  }
  return Object.freeze(
    Object.fromEntries(
      [...required, ...optional]
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, value[key]])
    )
  )
}

const validatedHostLineageVersion = (value) => {
  const required = [
    'project_id',
    'artifact_id',
    'version_id',
    'filename',
    'version_number',
    'session_id',
    'root_frame_id',
    'agent_frame_id',
    'message_branch_id',
    'runtime_segment_id',
    'prompt_message_id',
    'created_at',
    'size_bytes',
    'checksum',
    'content_status',
    'execution_status',
    'producer',
    'environment_status',
    'inputs'
  ]
  const optional = ['content_type', 'agent_name', 'reproduction_code', 'environment']
  const stringKeys = [
    'project_id',
    'artifact_id',
    'version_id',
    'filename',
    'session_id',
    'root_frame_id',
    'agent_frame_id',
    'message_branch_id',
    'runtime_segment_id',
    'prompt_message_id',
    'created_at',
    'checksum'
  ]
  if (
    !hasHostLineageKeys(value, required, optional) ||
    stringKeys.some((key) => typeof value[key] !== 'string' || !value[key]) ||
    !Number.isSafeInteger(value.version_number) ||
    value.version_number < 1 ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    ['content_type', 'agent_name', 'reproduction_code'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'string'
    ) ||
    !Array.isArray(value.inputs)
  ) {
    throw new Error('host.lineage.get returned an invalid result')
  }
  let contentStatus
  if (
    value.content_status?.state === 'available' &&
    hasHostLineageKeys(value.content_status, ['state'])
  ) {
    contentStatus = Object.freeze({ state: 'available' })
  } else if (
    value.content_status?.state === 'unavailable' &&
    hasHostLineageKeys(value.content_status, ['state', 'reason']) &&
    ['missing', 'checksum-mismatch'].includes(value.content_status.reason)
  ) {
    contentStatus = Object.freeze({
      state: 'unavailable',
      reason: value.content_status.reason
    })
  } else {
    throw new Error('host.lineage.get returned an invalid content status')
  }
  const inputs = Object.freeze(value.inputs.map(validatedHostLineageInput))
  const environment = value.environment
    ? validatedHostLineageEnvironment(value.environment)
    : undefined
  return Object.freeze({
    ...Object.fromEntries(
      [
        'project_id',
        'artifact_id',
        'version_id',
        'filename',
        'version_number',
        'session_id',
        'root_frame_id',
        'agent_frame_id',
        'message_branch_id',
        'runtime_segment_id',
        'prompt_message_id',
        'created_at',
        'content_type',
        'size_bytes',
        'checksum',
        'agent_name'
      ]
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, value[key]])
    ),
    content_status: contentStatus,
    ...(value.reproduction_code !== undefined
      ? { reproduction_code: value.reproduction_code }
      : {}),
    execution_status: validatedHostLineageAvailability(value.execution_status),
    producer: validatedHostLineageProducer(value.producer),
    environment_status: validatedHostLineageAvailability(value.environment_status),
    ...(environment ? { environment } : {}),
    inputs
  })
}

async function hostLineageGraph(versionId, options = {}) {
  if (arguments.length < 1 || arguments.length > 2) {
    throw new TypeError('host.lineage.graph accepts versionId and at most one options object')
  }
  return camelCasedHostValue(
    validatedHostLineageGraph(
      await lineageRpc('graph', {
        version_id: versionId,
        options: remappedHostObject(options, 'host.lineage.graph options', {
          direction: 'direction',
          maxDepth: 'max_depth',
          maxNodes: 'max_nodes'
        })
      })
    )
  )
}

async function hostLineageGet(versionId) {
  if (arguments.length !== 1) throw new TypeError('host.lineage.get accepts one versionId')
  return camelCasedHostValue(
    validatedHostLineageVersion(await lineageRpc('get', { version_id: versionId }))
  )
}

const hostLineage = Object.freeze({ graph: hostLineageGraph, get: hostLineageGet })

async function hostFramesList(options = {}) {
  if (arguments.length > 1)
    throw new TypeError('host.frames.list accepts at most one options object')
  const result = await framesRpc('list', {
    options: remappedHostObject(options, 'host.frames.list options', {
      sessionId: 'session_id',
      rootsOnly: 'roots_only',
      kind: 'kind',
      archived: 'archived',
      search: 'search',
      after: 'after',
      before: 'before',
      limit: 'limit',
      cursor: 'cursor'
    })
  })
  const required = ['project_id', 'frames', 'total_count']
  const optional = ['next_cursor']
  if (
    !exactObject(result, required, optional) ||
    !hostFrameString(result.project_id) ||
    !Array.isArray(result.frames) ||
    !hostFrameCount(result.total_count) ||
    result.total_count < result.frames.length ||
    !hostFrameOptionalString(result.next_cursor)
  ) {
    throw new Error('host.frames.list returned an invalid result')
  }
  return camelCasedHostValue({
    project_id: result.project_id,
    frames: result.frames.map(validatedHostFrame),
    total_count: result.total_count,
    ...(result.next_cursor !== undefined ? { next_cursor: result.next_cursor } : {})
  })
}

async function hostFramesGet(frameId, options = {}) {
  if (arguments.length < 1 || arguments.length > 2) {
    throw new TypeError('host.frames.get accepts frameId and at most one options object')
  }
  const result = await framesRpc('get', {
    frame_id: frameId,
    options: remappedHostObject(options, 'host.frames.get options', {
      sessionId: 'session_id',
      branchId: 'branch_id',
      before: 'before',
      limit: 'limit'
    })
  })
  const keys = ['project_id', 'session', 'frame', 'branch', 'transcript', 'runtime_segments']
  if (
    !exactObject(result, keys) ||
    !hostFrameString(result.project_id) ||
    !Array.isArray(result.runtime_segments)
  ) {
    throw new Error('host.frames.get returned an invalid result')
  }
  const session = validatedHostFrameSession(result.session)
  const frame = validatedHostFrame(result.frame)
  if (frame.frame_id !== frameId || frame.session_id !== session.session_id) {
    throw new Error('host.frames.get returned an invalid result')
  }
  return camelCasedHostValue({
    project_id: result.project_id,
    session,
    frame,
    branch: validatedHostFrameBranch(result.branch),
    transcript: validatedHostFrameTranscript(result.transcript),
    runtime_segments: result.runtime_segments.map(validatedHostRuntimeSegment)
  })
}

const hostFrames = Object.freeze({ list: hostFramesList, get: hostFramesGet })

const sessionsRpc = async (op, params) => {
  if (!RPC_ENDPOINT) throw new Error(`host.sessions.${op} is unavailable: RPC endpoint not set`)
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'sessionsCall', params: { op, ...params } })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(`host.sessions.${op}: ${body.error || 'HTTP ' + res.status}`)
  }
  return body.result
}

async function hostSessionsList(options = {}) {
  if (arguments.length > 1) {
    throw new TypeError('host.sessions.list accepts at most one options object')
  }
  const result = await sessionsRpc('list', {
    options: remappedHostObject(options, 'host.sessions.list options', {
      archived: 'archived',
      search: 'search',
      limit: 'limit',
      cursor: 'cursor'
    })
  })
  const required = ['total_count', 'sessions']
  const optional = ['next_cursor']
  if (
    !exactObject(result, required, optional) ||
    !hostFrameCount(result.total_count) ||
    !Array.isArray(result.sessions) ||
    result.total_count < result.sessions.length ||
    !hostFrameOptionalString(result.next_cursor)
  ) {
    throw new Error('host.sessions.list returned an invalid result')
  }
  return Object.freeze({
    totalCount: result.total_count,
    ...(result.next_cursor !== undefined ? { nextCursor: result.next_cursor } : {}),
    sessions: Object.freeze(result.sessions.map(validatedHostSession))
  })
}

async function hostSessionsInspect(sessionId) {
  if (arguments.length !== 1) {
    throw new TypeError('host.sessions.inspect accepts one sessionId')
  }
  return validatedHostSession(
    await sessionsRpc('inspect', {
      session_id: sessionId
    })
  )
}

const hostSessions = Object.freeze({ list: hostSessionsList, inspect: hostSessionsInspect })

// host.compute: async remote-compute calls over the SAME app-local RPC endpoint as host.mcp, routed to
// the main-process ComputeService via {method:'computeCall'}. Like host.mcp, this is only injected in
// the trusted control plane — the python/r data kernels have no host.compute, so SSH/approval always
// happens outside the sandbox workspace. Uses the captured RPC endpoint/token + client for the same
// token-isolation reasons documented on host.mcp above.
async function computeRpc(params) {
  if (!RPC_ENDPOINT) throw new Error('host.compute is unavailable: connector RPC endpoint not set')
  const isRetryableSubmit = params?.op === 'submit_job' && typeof params.invocation_id === 'string'
  const request = async () => {
    const res = await capturedRpcFetch(RPC_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
      body: JSON.stringify({ method: 'computeCall', params })
    })
    const body = await res.json().catch((error) => {
      if (isRetryableSubmit && res.ok) throw error
      return {}
    })
    return { res, body }
  }
  let response
  try {
    response = await request()
  } catch (error) {
    if (!isRetryableSubmit) throw error
    response = await request()
  }
  const { res, body } = response
  if (!res.ok || body.error) {
    throw computeError(body.error || 'host.compute HTTP ' + res.status)
  }
  return body.result
}

// host.agents: control-plane Specialist management SDK. Reads, ordinary mutations, and privileged
// delete/switch operations are routed over the SAME
// app-local RPC endpoint as host.mcp/host.compute but as its own `agentsCall` method — never through
// host.mcp(). Uses the captured RPC endpoint/token + client for the same token-isolation reasons. The
// trusted calling session identity is the COMPUTE_SESSION_ID captured at spawn time
// (above), forwarded on every call so switch() cannot be forged from sandbox user code.
async function agentsRpc(op, params = {}, sessionId = COMPUTE_SESSION_ID) {
  if (!RPC_ENDPOINT) throw new Error('host.agents is unavailable: connector RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'agentsCall',
      params: {
        op,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(ACTIVE_CONTROL_INVOCATION_ID
          ? { control_invocation_id: ACTIVE_CONTROL_INVOCATION_ID }
          : {}),
        ...(params || {})
      }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    // Server-side method errors are already `host.agents.<method>: <message>`. Boundary failures
    // (auth, unknown method) are not method-scoped, so prefix them with the op the caller invoked so
    // the agent always sees a host.agents.* namespaced, secret-free message.
    const serverMessage = body.error || 'host.agents HTTP ' + res.status
    const publicMethod =
      {
        list_skills: 'listSkills',
        list_connectors: 'listConnectors',
        attach_skill: 'attachSkill',
        detach_skill: 'detachSkill',
        attach_connector: 'attachConnector',
        detach_connector: 'detachConnector'
      }[op] || op
    const detail = String(serverMessage).replace(/^host\.agents\.[^:]+:\s*/, '')
    throw new Error(`host.agents.${publicMethod}: ${detail}`)
  }
  return body.result
}

// Delegation services intentionally retain their snake_case RPC/domain contracts. Project only the
// known public Host method and caller-input labels at this agent-facing seam; domain error codes,
// enum values, and unrelated diagnostic text must remain byte-for-byte unchanged.
const HOST_DELEGATION_ERROR_NAMES = Object.freeze([
  ['host.stop_child', 'host.stopChild'],
  ['host.send_frame_message', 'host.sendFrameMessage'],
  ['host.message_receipt', 'host.messageReceipt'],
  ['host.resolve_message', 'host.resolveMessage'],
  ['host.submit_output', 'host.submitOutput'],
  ['stop_child', 'stopChild'],
  ['send_frame_message', 'sendFrameMessage'],
  ['message_receipt', 'messageReceipt'],
  ['resolve_message', 'resolveMessage'],
  ['submit_output', 'submitOutput'],
  ['output_schema', 'outputSchema'],
  ['timeout_seconds', 'timeoutSeconds'],
  ['frame_ids', 'frameIds'],
  ['frame_id', 'frameId'],
  ['attempt_id', 'attemptId'],
  ['request_id', 'requestId'],
  ['reply_to_message_id', 'replyToMessageId'],
  ['message_id', 'messageId']
])

const projectedHostDelegationErrorText = (value) => {
  const text = value && typeof value === 'object' ? JSON.stringify(value) : String(value)
  return HOST_DELEGATION_ERROR_NAMES.reduce((projected, [privateName, publicName]) => {
    const escaped = privateName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return projected.replace(
      new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'gu'),
      (_, prefix) => prefix + publicName
    )
  }, text)
}

const hostDelegationError = (publicMethod, value) => {
  const projected = projectedHostDelegationErrorText(value)
  const detail = projected.replace(new RegExp(`^host\\.${publicMethod}:\\s*`), '')
  return new Error(`host.${publicMethod}: ${detail}`)
}

async function delegateRpc(request, options = {}) {
  if (!RPC_ENDPOINT) throw new Error('host.delegate is unavailable: control RPC endpoint not set')
  const delegationCallId = String(++DELEGATE_CALL_SEQUENCE)
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'delegatedWorkCall',
      params: { request, options, delegation_call_id: delegationCallId }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw hostDelegationError('delegate', body.error || 'HTTP ' + res.status)
  }
  const outcome = body.result || {}
  return {
    kind: outcome.kind,
    children: (outcome.children || []).map((child) => ({
      frameId: child.frameId,
      attemptId: child.attemptId,
      ...(child.name !== undefined ? { name: child.name } : {}),
      ...(child.agentName !== undefined ? { agentName: child.agentName } : {}),
      status: child.status,
      ...(child.terminalMessageId ? { terminalMessageId: child.terminalMessageId } : {}),
      ...(child.response !== undefined ? { response: child.response } : {}),
      ...(child.status !== 'running' ? { artifactsCreated: child.artifactsCreated || [] } : {}),
      ...(child.cancellationReason ? { cancellationReason: child.cancellationReason } : {}),
      ...(child.error ? { error: child.error } : {}),
      ...(child.structuredOutputUnsatisfied !== undefined
        ? { structuredOutputUnsatisfied: child.structuredOutputUnsatisfied }
        : {}),
      ...(child.structuredOutput !== undefined ? { structuredOutput: child.structuredOutput } : {})
    }))
  }
}

async function hostHelp(query = undefined) {
  if (!RPC_ENDPOINT) throw new Error('host.help is unavailable: control RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'hostSdkHelp',
      params: { ...(query !== undefined ? { query } : {}) }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(`host.help: ${body.error || 'HTTP ' + res.status}`)
  }
  return body.result
}

async function hostDelegate(request, options = {}) {
  const requests = Array.isArray(request) ? request : [request]
  const normalizedRequests = requests.map((candidate) =>
    remappedHostObject(candidate, 'host.delegate request', {
      task: 'task',
      name: 'name',
      profile: 'profile',
      inputs: 'inputs',
      outputSchema: 'output_schema'
    })
  )
  const normalizedOptions = remappedHostObject(options, 'host.delegate options', {
    wait: 'wait',
    timeoutSeconds: 'timeout_seconds'
  })
  return delegateRpc(
    Array.isArray(request) ? normalizedRequests : normalizedRequests[0],
    normalizedOptions
  )
}

async function hostStopChild(frameIds) {
  if (!RPC_ENDPOINT) throw new Error('host.stopChild is unavailable: control RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'delegatedWorkCall',
      params: { operation: 'stop_children', frame_ids: frameIds }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw hostDelegationError('stopChild', body.error || 'HTTP ' + res.status)
  }
  return (body.result || []).map((child) => ({
    frameId: child.frameId,
    status: child.status
  }))
}

async function delegatedObservationRpc(op, selectors = undefined, options = undefined) {
  if (!RPC_ENDPOINT) throw new Error(`host.${op} is unavailable: control RPC endpoint not set`)
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'delegatedWorkCall',
      params: {
        op,
        ...(selectors !== undefined
          ? op === 'collect'
            ? { selectors }
            : { frame_ids: selectors }
          : {}),
        ...(options !== undefined ? { options } : {})
      }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw hostDelegationError(op, body.error || 'HTTP ' + res.status)
  }
  return (body.result || []).map((child) => ({
    frameId: child.frameId,
    attemptId: child.attemptId,
    ...(child.title !== undefined ? { title: child.title } : {}),
    ...(child.name !== undefined ? { name: child.name } : {}),
    ...(child.agentName !== undefined ? { agentName: child.agentName } : {}),
    status: child.status,
    ...(child.terminalMessageId ? { terminalMessageId: child.terminalMessageId } : {}),
    ...(child.response !== undefined ? { response: child.response } : {}),
    ...(op === 'collect' && child.status !== 'running'
      ? { artifactsCreated: child.artifactsCreated || [] }
      : {}),
    ...(child.cancellationReason ? { cancellationReason: child.cancellationReason } : {}),
    ...(child.error ? { error: child.error } : {}),
    ...(child.structuredOutputUnsatisfied !== undefined
      ? { structuredOutputUnsatisfied: child.structuredOutputUnsatisfied }
      : {}),
    ...(child.structuredOutput !== undefined ? { structuredOutput: child.structuredOutput } : {})
  }))
}

async function hostSubmitOutput(value) {
  if (!RPC_ENDPOINT)
    throw new Error('host.submitOutput is unavailable: control RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'delegatedOutputCall', params: { value } })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw hostDelegationError('submitOutput', body.error || 'HTTP ' + res.status)
  }
  return body.result
}

async function hostChildren(frameIds = undefined) {
  return delegatedObservationRpc('children', frameIds)
}

async function hostCollect(selectors, options = undefined) {
  if (!Array.isArray(selectors)) {
    throw new TypeError('host.collect selectors must be an array.')
  }
  const normalizedSelectors = selectors.map((selector) =>
    typeof selector === 'string'
      ? selector
      : remappedHostObject(selector, 'host.collect selector', {
          frameId: 'frame_id',
          attemptId: 'attempt_id'
        })
  )
  const normalizedOptions =
    options === undefined
      ? undefined
      : remappedHostObject(options, 'host.collect options', {
          timeoutSeconds: 'timeout_seconds',
          returnWhen: 'return_when'
        })
  return delegatedObservationRpc('collect', normalizedSelectors, normalizedOptions)
}

async function hostSendFrameMessage(target, message, options = undefined) {
  const normalizedOptions =
    options === undefined
      ? undefined
      : remappedHostObject(options, 'host.sendFrameMessage options', {
          kind: 'kind',
          requestId: 'request_id',
          replyToMessageId: 'reply_to_message_id'
        })
  if (!RPC_ENDPOINT) {
    throw new Error('host.sendFrameMessage is unavailable: control RPC endpoint not set')
  }
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'delegatedWorkCall',
      params: {
        op: 'send_message',
        target,
        message,
        ...(normalizedOptions !== undefined ? { options: normalizedOptions } : {})
      }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw hostDelegationError('sendFrameMessage', body.error || 'HTTP ' + res.status)
  }
  return camelCasedHostValue(body.result)
}

async function hostMessageReceipt(selector, options = undefined) {
  const normalizedOptions =
    options === undefined
      ? undefined
      : remappedHostObject(options, 'host.messageReceipt options', {
          timeoutSeconds: 'timeout_seconds'
        })
  return delegatedMessageRpc('message_receipt', 'messageReceipt', {
    selector,
    options: normalizedOptions
  })
}

async function hostResolveMessage(messageId, options) {
  const normalizedOptions = remappedHostObject(options, 'host.resolveMessage options', {
    action: 'action'
  })
  return delegatedMessageRpc('resolve_message', 'resolveMessage', {
    message_id: messageId,
    action: normalizedOptions.action
  })
}

async function delegatedMessageRpc(op, publicMethod, params) {
  if (!RPC_ENDPOINT)
    throw new Error(`host.${publicMethod} is unavailable: control RPC endpoint not set`)
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({ method: 'delegatedWorkCall', params: { op, ...params } })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw hostDelegationError(publicMethod, body.error || 'HTTP ' + res.status)
  }
  return camelCasedHostValue(body.result)
}

// host.agents namespace. JavaScript methods, inputs, and returned records use camelCase. The private
// RPC operation names remain transport details.
// create/update/attachSkill/detachSkill/attachConnector/detachConnector are the ordinary-mutation
// surface (issue 03); they return a real
// post-write camelCase Profile read-back and never echo requested input. switch/delete are the
// privileged surface (issue 04/05): authorized this milestone by the /customize Skill's chat-text
// confirmation + the pass-through SDK approval gateway (design.md §7/§14), not the standard card.
const hostAgents = {
  async list() {
    return agentsRpc('list')
  },
  async get(name) {
    return agentsRpc('get', { name })
  },
  async listSkills(nameOrId = undefined) {
    return agentsRpc('list_skills', nameOrId !== undefined ? { name_or_id: nameOrId } : {})
  },
  async listConnectors(nameOrId = undefined) {
    return agentsRpc('list_connectors', nameOrId !== undefined ? { name_or_id: nameOrId } : {})
  },
  async create(input) {
    return agentsRpc(
      'create',
      remappedHostObject(input || {}, 'host.agents.create input', {
        name: 'name',
        displayName: 'display_name',
        description: 'description',
        systemPrompt: 'system_prompt',
        iconKey: 'icon_key',
        colorKey: 'color_key',
        enabled: 'enabled',
        unrestricted: 'unrestricted',
        skillNames: 'skill_names',
        connectorNames: 'connector_names'
      })
    )
  },
  async update(name, patch) {
    return agentsRpc('update', {
      name,
      patch: remappedHostObject(patch || {}, 'host.agents.update patch', {
        displayName: 'display_name',
        revision: 'revision',
        description: 'description',
        systemPrompt: 'system_prompt',
        iconKey: 'icon_key',
        colorKey: 'color_key',
        enabled: 'enabled',
        unrestricted: 'unrestricted',
        skillNames: 'skill_names',
        connectorNames: 'connector_names'
      })
    })
  },
  async attachSkill(name, skillRef, options) {
    return agentsRpc('attach_skill', { name, skill_ref: skillRef, ...(options || {}) })
  },
  async detachSkill(name, skillRef, options) {
    return agentsRpc('detach_skill', { name, skill_ref: skillRef, ...(options || {}) })
  },
  async attachConnector(name, connectorRef, options) {
    return agentsRpc('attach_connector', { name, connector_ref: connectorRef, ...(options || {}) })
  },
  async detachConnector(name, connectorRef, options) {
    return agentsRpc('detach_connector', { name, connector_ref: connectorRef, ...(options || {}) })
  },
  // Privileged: switch binds only the trusted calling session (server-captured). After approval the
  // outer control tool finishes, then the same task continues under the target; null reverts to Main.
  async switch(nameOrNull) {
    return agentsRpc('switch', { name: nameOrNull === undefined ? null : nameOrNull })
  },
  // Privileged and revision-guarded: bound conversations become unavailable (not Main) after delete.
  async delete(name, options) {
    return agentsRpc('delete', { name, ...(options || {}) })
  }
}

// host.skills: application-native Skill authoring. Draft files live in the app-managed Skill store;
// publish promotes a complete package directly into Personal Skills. This intentionally never routes
// through Artifact or conversation-import APIs.
async function skillsRpc(op, params = {}) {
  if (!RPC_ENDPOINT) throw new Error('host.skills is unavailable: connector RPC endpoint not set')
  const res = await capturedRpcFetch(RPC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (RPC_TOKEN || '') },
    body: JSON.stringify({
      method: 'skillsCall',
      params: {
        op,
        ...(COMPUTE_SESSION_ID ? { session_id: COMPUTE_SESSION_ID } : {}),
        ...(params || {})
      }
    })
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    const serverMessage = body.error || 'host.skills HTTP ' + res.status
    throw new Error(
      /^host\.skills\./.test(serverMessage) ? serverMessage : `host.skills.${op}: ${serverMessage}`
    )
  }
  return body.result
}

const hostSkills = {
  async list() {
    return skillsRpc('list')
  },
  async read(name, path = 'SKILL.md') {
    return skillsRpc('read', { name, path })
  },
  async validate(name) {
    return skillsRpc('validate', { name })
  },
  async edit(name, path, content, oldString = undefined) {
    if (oldString !== undefined && (typeof oldString !== 'string' || oldString.length === 0)) {
      throw new TypeError('host.skills.edit: oldString must be a non-empty string when provided')
    }
    return skillsRpc('edit', {
      name,
      path,
      content,
      ...(oldString !== undefined ? { old_string: oldString } : {})
    })
  },
  async publish(name, overwrite = false) {
    return skillsRpc('publish', { name, overwrite })
  },
  async delete(name) {
    return skillsRpc('delete', { name })
  }
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

// host.compute namespace. Public methods and input keys are camelCase; the adapter immediately maps
// them to the existing snake_case computeCall RPC contract.
const hostCompute = {
  // Legacy full-object discovery. The server filters this to hosts enabled for this Session.
  async list() {
    return computeRpc({ op: 'list' })
  },

  // Canonical compact Session catalog. Each enabled host has role selected or available.
  async listHosts() {
    return computeRpc({ op: 'list_hosts', session_id: COMPUTE_SESSION_ID })
  },

  // Compatibility discovery methods. Disabled registered hosts remain hidden.
  async listRegistered() {
    return computeRpc({ op: 'list_registered' })
  },

  async listPreferred() {
    return computeRpc({ op: 'list_preferred', session_id: COMPUTE_SESSION_ID })
  },

  // Returns session-enabled compute hosts (≠ list() which returns all registered hosts).
  // Uses COMPUTE_SESSION_ID from spawn env so the registry lookup is always session-scoped.
  async listCompute() {
    return computeRpc({ op: 'list_compute', session_id: COMPUTE_SESSION_ID })
  },
  // Bind a thin handle to one provider (no network call). callCommand runs one short remote command;
  // loginShell defaults to true (runs login profiles, then attempts a readable ~/.bashrc, before the
  // command). A .bashrc can deliberately return early for non-interactive shells. false performs no
  // shell initialization.
  // timeoutSeconds
  // is optional (the service applies its own default when omitted). Session/project context is threaded
  // from the spawn env so the approval broker can remember a grant for this conversation/project.
  //
  // submitJob: non-blocking job submission — returns {job_id, provider_id, status:'submitted',
  // remote_workdir} immediately, before any SSH. Background dispatch runs the job detached.
  // attachJob: returns a handle with status/result reads and durable cancellation.
  create(providerId) {
    return {
      provider_id: providerId,
      async callCommand(cmd, intent, options = {}) {
        const normalized = remappedHostObject(options, 'host.compute.callCommand options', {
          loginShell: 'login_shell',
          timeoutSeconds: 'timeout_seconds'
        })
        return computeRpc({
          op: 'call_command',
          provider_id: providerId,
          cmd,
          intent,
          login_shell: normalized.login_shell !== undefined ? normalized.login_shell : true,
          timeout_seconds: normalized.timeout_seconds,
          session_id: COMPUTE_SESSION_ID,
          project_id: COMPUTE_PROJECT_ID
        })
      },

      // Non-blocking job submission. Returns immediately with job_id + remote_workdir.
      // options: { environment?, resources?, inputs?, outputs?, timeoutSeconds?, harvest? }
      // Session/project context is always threaded from spawn env for grant-scope memory.
      // workspace_cwd is captured at spawn time so the main process can resolve workspace paths.
      async submitJob(intent, command, options = {}) {
        const normalized = remappedHostObject(options, 'host.compute.submitJob options', {
          environment: 'environment',
          resources: 'resources',
          inputs: 'inputs',
          outputs: 'outputs',
          timeoutSeconds: 'timeout_seconds',
          harvest: 'harvest'
        })
        if (normalized.inputs !== undefined && !Array.isArray(normalized.inputs)) {
          throw new TypeError('host.compute.submitJob inputs must be an array.')
        }
        const inputs = normalized.inputs?.map((input) =>
          remappedHostObject(input, 'host.compute.submitJob input', {
            src: 'src',
            dstFilename: 'dst_filename',
            remotePath: 'remote_path'
          })
        )
        const harvest =
          normalized.harvest === undefined
            ? undefined
            : remappedHostObject(normalized.harvest, 'host.compute.submitJob harvest', {
                exclude: 'exclude',
                maxFileMb: 'max_file_mb',
                maxTotalMb: 'max_total_mb'
              })
        const assertHarvestLimit = (field, value, maximum) => {
          if (
            value !== undefined &&
            (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum)
          ) {
            throw new TypeError(
              'host.compute.submitJob harvest.' +
                field +
                ' must be a finite number between 0 and ' +
                maximum +
                ' MiB.'
            )
          }
        }
        if (harvest !== undefined) {
          assertHarvestLimit('maxFileMb', harvest.max_file_mb, 100)
          assertHarvestLimit('maxTotalMb', harvest.max_total_mb, 500)
        }
        return computeRpc({
          op: 'submit_job',
          invocation_id: randomUUID(),
          provider_id: providerId,
          intent,
          command,
          environment: normalized.environment,
          resources: normalized.resources,
          inputs,
          outputs: normalized.outputs,
          timeout_seconds: normalized.timeout_seconds,
          harvest,
          session_id: COMPUTE_SESSION_ID,
          project_id: COMPUTE_PROJECT_ID,
          workspace_cwd: process.cwd()
        })
      },

      // Attaches this provider handle to an existing job by job_id. Server-side reads verify that
      // the job belongs to this provider and the trusted Session before returning data.
      // .status() reads from DB only (no SSH).
      // .result() returns the full JobResult (spec §11.4): scans the local harvest directory,
      // returns workspace-relative file paths, never triggers harvest or SSH (design §9).
      attachJob(jobId) {
        return {
          job_id: jobId,
          async status() {
            return computeRpc({ op: 'job_status', provider_id: providerId, job_id: jobId })
          },
          async cancel() {
            return computeRpc({ op: 'job_cancel', provider_id: providerId, job_id: jobId })
          },
          async result() {
            return computeRpc({ op: 'job_result', provider_id: providerId, job_id: jobId })
          }
        }
      },

      // Set session-level concurrency limit (Phase 3c). Limits the number of non-terminal jobs
      // that can run simultaneously across all providers in this session. Jobs exceeding the limit
      // enter 'queued' state and auto-dispatch when slots free up.
      async setConcurrencyLimit(k) {
        if (typeof k !== 'number' || k <= 0 || k > 500 || !Number.isInteger(k)) {
          throw new Error('setConcurrencyLimit: k must be a positive integer between 1 and 500')
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
  // needs `text` + `oldText` (oldText must match the current doc exactly, guarding against clobbering
  // a concurrent edit).
  async details(providerId, options = {}) {
    const normalized = remappedHostObject(options, 'host.compute.details options', {
      mode: 'mode',
      text: 'text',
      oldText: 'old_text'
    })
    return computeRpc({
      op: 'details',
      provider_id: providerId,
      mode: normalized.mode || 'read',
      text: normalized.text,
      old_text: normalized.old_text
    })
  }
}

// Keep this explicit object in sync with HostSdkHelpRegistry. Its keys are the published Subagent
// Host SDK surface and are checked by src/main/host-sdk/help.test.ts.
const subagentHostOperations = Object.freeze({
  delegate: hostDelegate,
  children: hostChildren,
  collect: hostCollect,
  stopChild: hostStopChild,
  sendFrameMessage: hostSendFrameMessage,
  messageReceipt: hostMessageReceipt,
  resolveMessage: hostResolveMessage,
  submitOutput: hostSubmitOutput
})

// Persistent sandbox: user-declared globals persist across requests (assign to `globalThis`/bare).
const sandbox = {
  host: {
    help: hostHelp,
    capabilities: hostCapabilities,
    currentModel: hostCurrentModel,
    listModels: hostListModels,
    llm: hostLlm,
    artifacts: hostArtifacts,
    artifactPath: hostArtifactPath,
    viewImage: hostViewImage,
    lineage: hostLineage,
    frames: hostFrames,
    sessions: hostSessions,
    mcp: hostMcp,
    compute: hostCompute,
    agents: hostAgents,
    skills: hostSkills,
    ...subagentHostOperations
  },
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
  // Try candidate statement boundaries from right to left. A newline or semicolon may be nested
  // inside a multiline call, string, or for-header; compile-checking progressively wider tails finds
  // the complete final expression without needing a second JavaScript parser in the runtime bundle.
  const boundaries = []
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] === '\n' || trimmed[index] === ';') boundaries.push(index)
  }
  boundaries.push(-1)
  for (const split of boundaries) {
    const head = split >= 0 ? trimmed.slice(0, split + 1) : ''
    const tail = trimmed.slice(split + 1).trim()
    // Only echo something that can start an expression — never a declaration/control statement.
    if (
      !tail ||
      /^(const|let|var|if|for|while|function|class|switch|try|throw|return|do|else|import|export)\b/.test(
        tail
      )
    ) {
      continue
    }
    const echo = '(async () => {\n' + head + '\nreturn (\n' + tail + '\n)\n})()'
    try {
      new vm.Script(echo, { filename: '<repl>' })
      return echo
    } catch {
      // This boundary was inside the final expression; retry with a wider candidate.
    }
  }
  return plain
}

// Runs one request against the persistent context. console is redirected into strings and restored in
// finally; the awaited value of the async IIFE (i.e. what the user code `return`s) becomes result.
async function run(code) {
  let out = '',
    err = ''
  const outputBudget = {
    remaining: OUTPUT_LIMIT_BYTES - DIAGNOSTIC_LIMIT_BYTES,
    truncated: false
  }
  const diagnosticBudget = { remaining: DIAGNOSTIC_LIMIT_BYTES, truncated: false }
  const origLog = console.log,
    origErr = console.error
  console.log = (...a) => {
    out += takeOutput(outputBudget, a.map(String).join(' ') + '\n')
  }
  console.error = (...a) => {
    err += takeOutput(outputBudget, a.map(String).join(' ') + '\n')
  }
  let error = null,
    result = null
  try {
    const value = await vm.runInContext(wrapForRun(code), context, { filename: '<repl>' })
    if (value !== undefined) {
      // Non-serializable (e.g. circular) echoes fall back to a string so a run never fails on output.
      try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value)
        // JSON.stringify returns undefined (without throwing) for functions and Symbols. Keep the
        // protocol's null result instead of fabricating the literal string "undefined".
        if (serialized !== undefined) result = takeOutput(outputBudget, serialized)
      } catch {
        result = takeOutput(outputBudget, String(value))
      }
    }
  } catch (e) {
    error = takeOutputTail(diagnosticBudget, e && e.stack ? String(e.stack) : String(e))
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return {
    stdout: out,
    stderr: err,
    error,
    result,
    cwd: process.cwd(),
    figures: [],
    output_truncated: outputBudget.truncated || diagnosticBudget.truncated
  }
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
    ACTIVE_CONTROL_INVOCATION_ID = request.control_invocation_id
    DELEGATE_CALL_SEQUENCE = 0
    try {
      const resp = await run(request.code || '')
      resp.req_id = request.req_id
      emit(resp)
    } finally {
      ACTIVE_CONTROL_INVOCATION_ID = undefined
    }
  })
})
