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
  // Bind a thin handle to one provider (no network call). call_command runs one short remote command;
  // login_shell defaults to true (loads the login shell so module/conda PATH is visible), timeout_seconds
  // is optional (the service applies its own default when omitted). Session/project context is threaded
  // from the spawn env so the approval broker can remember a grant for this conversation/project.
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
