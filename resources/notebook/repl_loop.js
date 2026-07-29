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

const assertPackageCommandAllowed = (command, args) => {
  if (packageMutationCommand.test(commandText(command, args))) {
    throw new Error(
      'Package/environment mutation is not allowed in the control REPL; use manage_packages.'
    )
  }
}

const childProcess = require('node:child_process')
for (const method of ['exec', 'execSync']) {
  const original = childProcess[method]
  childProcess[method] = function guardedExec(command, ...args) {
    assertPackageCommandAllowed(command)
    return original.call(this, command, ...args)
  }
}
for (const method of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = childProcess[method]
  childProcess[method] = function guardedExecFile(command, args, ...rest) {
    assertPackageCommandAllowed(command, args)
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

// Enforce the managed-runtime read-only boundary at the Node filesystem API as well as in the main
// process source policy. This catches paths assembled dynamically inside the persistent REPL and is
// the hard backstop on platforms without sandbox-exec.
const runtimeRootValue = process.env.OPEN_SCIENCE_RUNTIME_DIR
const canonicalGuardPath = (value) => {
  if (typeof value === 'number' || value === undefined || value === null) return undefined
  let raw = value
  if (raw instanceof URL) raw = fileURLToPath(raw)
  if (Buffer.isBuffer(raw)) raw = raw.toString()
  if (typeof raw !== 'string') return undefined

  const absolute = path.resolve(raw)
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
  'truncate',
  'truncateSync',
  'chmod',
  'chmodSync',
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
for (const method of [
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'link',
  'linkSync',
  'symlink',
  'symlinkSync'
]) {
  const original = fs[method]
  if (typeof original !== 'function') continue
  fs[method] = function guardedFsCopy(source, destination, ...args) {
    assertRuntimeWriteAllowed(destination)
    return original.call(this, source, destination, ...args)
  }
}
for (const method of ['open', 'openSync']) {
  const original = fs[method]
  fs[method] = function guardedFsOpen(target, flags, ...args) {
    if (writeOpenFlags(flags)) assertRuntimeWriteAllowed(target)
    return original.call(this, target, flags, ...args)
  }
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
for (const method of ['copyFile', 'cp', 'link', 'symlink']) {
  const original = fsPromises[method]
  if (typeof original !== 'function') continue
  fsPromises[method] = function guardedPromiseCopy(source, destination, ...args) {
    assertRuntimeWriteAllowed(destination)
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
    body: JSON.stringify({ method: 'mcpCall', params: { server, method, args: callArgs } })
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
