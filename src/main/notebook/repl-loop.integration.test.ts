import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { framePythonRequest, parseLoopResponse, type KernelLoopResponse } from './kernel-protocol'

// Run with: RUN_KERNEL=1 npx vitest run src/main/notebook/repl-loop.integration.test.ts
// Node is always available in vitest, so the only gate is RUN_KERNEL. The child is spawned exactly
// as the driver will spawn it: this process's executable with ELECTRON_RUN_AS_NODE=1 (harmless
// under plain node, makes the Electron binary behave as Node in production).
const gate = process.env.RUN_KERNEL ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

// Minimal one-shot client over the loop's JSON-lines stdio protocol, reusing the shared framing and
// parsing helpers so the test exercises the real wire format.
const startLoop = (
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<KernelLoopResponse>
} => {
  const child = spawn(process.execPath, [LOOP], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }
  })
  const rl = createInterface({ input: child.stdout })
  const waiters = new Map<string, (v: KernelLoopResponse) => void>()
  rl.on('line', (line) => {
    const msg = parseLoopResponse(line)
    if (!msg) return
    const w = waiters.get(msg.reqId)
    if (w) {
      waiters.delete(msg.reqId)
      w(msg)
    }
  })
  const send = (code: string): Promise<KernelLoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(framePythonRequest(reqId, code))
    })
  return { child, send }
}

gate('repl_loop.js', () => {
  it('captures console.log, keeps a persistent context, and survives a thrown error', async () => {
    const { child, send } = startLoop({})
    try {
      // console.log is captured into stdout.
      const a = await send("console.log('hi')")
      expect(a.error).toBeNull()
      expect(a.stdout).toContain('hi')

      // User-assigned globals persist across requests.
      const b = await send('globalThis.x = 41')
      expect(b.error).toBeNull()
      const c = await send('console.log(globalThis.x + 1)')
      expect(c.error).toBeNull()
      expect(c.stdout).toContain('42')

      // A thrown error is reported as a stack string, not a crash.
      const d = await send("throw new Error('boom')")
      expect(d.error).toContain('boom')

      // The loop survives the throw and keeps serving requests.
      const e = await send("console.log('still alive')")
      expect(e.error).toBeNull()
      expect(e.stdout).toContain('still alive')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks dynamically assembled child_process package commands at runtime', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `const cp = require('node:child_process'); ` +
          `cp['ex' + 'ec']('p' + 'ip in' + 'stall pandas')`
      )
      expect(result.error).toMatch(/manage_packages/)

      const encoded = Buffer.from('pip install pandas', 'utf16le').toString('base64')
      const encodedResult = await send(
        `require('node:child_process').execFileSync('powershell.exe', ` +
          `${JSON.stringify(['-NoProfile', '-ec', encoded])})`
      )
      expect(encodedResult.error).toMatch(/manage_packages/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('allows dynamically assembled pip inspection commands at runtime', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `require('node:child_process')['spa' + 'wnSync'](` +
          `'python3', ['-m', 'p' + 'ip', 'li' + 'st', '--help']); 'allowed'`
      )
      expect(result.error).toBeNull()
      expect(result.result).toBe('allowed')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks child_process.fork from escaping the runtime guard', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `const cp = require('node:child_process'); cp['fo' + 'rk']('untrusted-helper.js')`
      )
      expect(result.error).toMatch(/child_process\.fork is not allowed/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks Worker isolates that would reload unguarded built-in modules', async () => {
    const { child, send } = startLoop({})
    try {
      const result = await send(
        `const { Worker } = require('node:worker_threads'); ` +
          `new Worker('require("node:fs").writeFileSync("escape.txt", "x")', { eval: true })`
      )
      expect(result.error).toMatch(/Worker is not allowed/)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('blocks child process payloads that write into the managed runtime', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-child-guard-'))
    const blockedPath = join(runtimeRoot, 'child-blocked.txt')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const result = await send(
        `require('node:child_process').execFileSync('/bin/sh', ` +
          `['-c', 'touch "$OPEN_SCIENCE_RUNTIME_DIR/child-blocked.txt"'])`
      )
      expect(result.error).toMatch(/manage_packages/)
      expect(existsSync(blockedPath)).toBe(false)
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    [
      'shell',
      '/bin/sh',
      ['-c', 'cd "$OPEN_SCIENCE_RUNTIME_DIR"; touch relative-shell.txt'],
      'relative-shell.txt'
    ],
    [
      'PowerShell',
      'powershell.exe',
      [
        '-NoProfile',
        '-c',
        'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; Set-Content relative-powershell.txt x'
      ],
      'relative-powershell.txt'
    ],
    [
      'shell from a runtime subdirectory',
      '/bin/sh',
      ['-c', 'cd "$OPEN_SCIENCE_RUNTIME_DIR/subdir"; cd ..; touch relative-shell-subdir.txt'],
      'relative-shell-subdir.txt'
    ],
    [
      'PowerShell from a runtime subdirectory',
      'powershell.exe',
      [
        '-NoProfile',
        '-c',
        'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR\\subdir; Set-Location ..; Set-Content relative-powershell-subdir.txt x'
      ],
      'relative-powershell-subdir.txt'
    ]
  ] as const)(
    'blocks %s child-process writes after entering the managed runtime',
    async (_name, command, args, relativeTarget) => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-child-cwd-'))
      await mkdir(join(runtimeRoot, 'subdir'))
      const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
      try {
        const result = await send(
          `require('node:child_process').execFileSync(${JSON.stringify(command)}, ` +
            `${JSON.stringify(args)})`
        )
        expect(result.error).toMatch(/manage_packages/)
        expect(existsSync(join(runtimeRoot, relativeTarget))).toBe(false)
      } finally {
        child.kill()
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('allows child process payloads that only read the runtime and write elsewhere', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-child-read-'))
    const workspace = await mkdtemp(join(tmpdir(), 'os-repl-child-output-'))
    const source = join(runtimeRoot, 'source.txt')
    const copied = join(workspace, 'copied.txt')
    const report = join(workspace, 'report.txt')
    await writeFile(source, 'runtime input')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const payload = [
        `const fs = require('node:fs')`,
        `console.log(process.env.OPEN_SCIENCE_RUNTIME_DIR)`,
        `fs.copyFileSync(${JSON.stringify(source)}, ${JSON.stringify(copied)})`,
        `fs.writeFileSync(${JSON.stringify(report)}, 'workspace output')`
      ].join('; ')
      const result = await send(
        `require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(payload)}])`
      )

      expect(result.error).toBeNull()
      expect(await readFile(copied, 'utf8')).toBe('runtime input')
      expect(await readFile(report, 'utf8')).toBe('workspace output')

      if (process.platform !== 'win32') {
        const shellCopy = join(workspace, 'shell-copy.txt')
        const shellReport = join(workspace, 'shell-report.txt')
        const shellPayload =
          `cp "$OPEN_SCIENCE_RUNTIME_DIR/source.txt" ${JSON.stringify(shellCopy)}; ` +
          `printf '%s' "$OPEN_SCIENCE_RUNTIME_DIR" > /dev/null; ` +
          `cd "$OPEN_SCIENCE_RUNTIME_DIR"; ` +
          `touch ${JSON.stringify(shellReport)}`
        const shellResult = await send(
          `require('node:child_process').execFileSync('/bin/sh', ['-c', ${JSON.stringify(shellPayload)}])`
        )
        expect(shellResult.error).toBeNull()
        expect(await readFile(shellCopy, 'utf8')).toBe('runtime input')
        expect(existsSync(shellReport)).toBe(true)
      }
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it('uses PowerShell write targets instead of blocking every runtime-path mention', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-powershell-targets-'))
    const workspace = await mkdtemp(join(tmpdir(), 'os-repl-powershell-output-'))
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const allowedPayload =
        `Copy-Item "$env:OPEN_SCIENCE_RUNTIME_DIR\\source.txt" ${JSON.stringify(join(workspace, 'report.txt'))}; ` +
        `Write-Output $env:OPEN_SCIENCE_RUNTIME_DIR; ` +
        `Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; ` +
        `New-Item ${JSON.stringify(join(workspace, 'report-created.txt'))}`
      const allowed = await send(
        `try { require('node:child_process').execFileSync('powershell.exe', ` +
          `['-NoProfile', '-Command', ${JSON.stringify(allowedPayload)}]) } ` +
          `catch (error) { if (String(error).includes('manage_packages')) throw error }; 'allowed'`
      )
      expect(allowed.error).toBeNull()
      expect(allowed.result).toBe('allowed')

      const blocked = await send(
        `require('node:child_process').execFileSync('powershell.exe', ` +
          `['-NoProfile', '-Command', ` +
          `${JSON.stringify(`Set-Content "$env:OPEN_SCIENCE_RUNTIME_DIR\\blocked.txt" x`)}])`
      )
      expect(blocked.error).toMatch(/manage_packages/)
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(['sync', 'promise'] as const)(
    'blocks %s hard-link aliases sourced from the managed runtime',
    async (variant) => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-hard-link-runtime-'))
      const workspace = await mkdtemp(join(tmpdir(), 'os-repl-hard-link-output-'))
      const source = join(runtimeRoot, 'protected.txt')
      const alias = join(workspace, 'alias.txt')
      await writeFile(source, 'protected')
      const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
      try {
        const operation =
          variant === 'sync'
            ? `fs.linkSync(${JSON.stringify(source)}, ${JSON.stringify(alias)}); fs.writeFileSync(${JSON.stringify(alias)}, 'changed')`
            : `await fs.promises.link(${JSON.stringify(source)}, ${JSON.stringify(alias)}); await fs.promises.writeFile(${JSON.stringify(alias)}, 'changed')`
        const result = await send(`const fs = require('node:fs'); ${operation}`)

        expect(result.error).toMatch(/manage_packages/)
        expect(await readFile(source, 'utf8')).toBe('protected')
        expect(existsSync(alias)).toBe(false)
      } finally {
        child.kill()
        await rm(runtimeRoot, { recursive: true, force: true })
        await rm(workspace, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('blocks symlink aliases sourced from the managed runtime', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'os-repl-symlink-'))
    const runtimeRoot = join(parent, 'runtime')
    const workspace = join(parent, 'workspace')
    await mkdir(runtimeRoot)
    await mkdir(workspace)
    const source = join(runtimeRoot, 'protected.txt')
    const alias = join(workspace, 'alias.txt')
    const relativeSource = relative(workspace, source)
    await writeFile(source, 'protected')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const result = await send(
        `require('node:fs').symlinkSync(${JSON.stringify(relativeSource)}, ${JSON.stringify(alias)})`
      )

      expect(result.error).toMatch(/manage_packages/)
      expect(existsSync(alias)).toBe(false)
    } finally {
      child.kill()
      await rm(parent, { recursive: true, force: true })
    }
  }, 60_000)

  it('blocks managed-runtime writes routed through a temporary variable', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-runtime-guard-'))
    const blockedPath = join(runtimeRoot, 'blocked.txt')
    const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
    try {
      const result = await send(
        `const target = process.env.OPEN_SCIENCE_RUNTIME_DIR + '/blocked.txt'; ` +
          `require('node:fs').writeFileSync(target, 'changed')`
      )
      expect(result.error).toMatch(/manage_packages/)
      expect(existsSync(blockedPath)).toBe(false)
    } finally {
      child.kill()
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    `require('node:fs').mkdtempSync(process.env.OPEN_SCIENCE_RUNTIME_DIR + '/sync-')`,
    `await require('node:fs').promises.mkdtemp(process.env.OPEN_SCIENCE_RUNTIME_DIR + '/promise-')`,
    `await new Promise((resolve, reject) => require('node:fs').mkdtemp(` +
      `process.env.OPEN_SCIENCE_RUNTIME_DIR + '/callback-', ` +
      `(error, value) => error ? reject(error) : resolve(value)))`
  ])(
    'blocks managed-runtime temporary directory creation at runtime',
    async (source) => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-repl-mkdtemp-guard-'))
      const { child, send } = startLoop({ OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot })
      try {
        const result = await send(source)
        expect(result.error).toMatch(/manage_packages/)
        expect(await readdir(runtimeRoot)).toEqual([])
      } finally {
        child.kill()
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    },
    60_000
  )
})

gate('repl_loop.js host.compute', () => {
  let server: Server
  let endpoint: string
  // Last computeCall params the stub received, so tests can assert the JS shim's wire payload.
  let received: { method?: string; params?: Record<string, unknown> } = {}
  // Next response the stub returns: { status, body } lets a case drive success and structured-error paths.
  let next: { status: number; body: unknown } = { status: 200, body: { result: null } }

  beforeAll(async () => {
    const { createServer } = await import('node:http')
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received = body ? JSON.parse(body) : {}
        res
          .writeHead(next.status, { 'content-type': 'application/json' })
          .end(JSON.stringify(next.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    endpoint = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('host.compute.list() posts op=list and returns the parsed result', async () => {
    next = {
      status: 200,
      body: { result: [{ provider_id: 'ssh:biowulf', display_name: 'biowulf' }] }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const r = await send('return (await host.compute.list())[0].provider_id')
      expect(r.error).toBeNull()
      expect(r.result).toContain('ssh:biowulf')
      expect(received.method).toBe('computeCall')
      expect(received.params?.op).toBe('list')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().call_command() posts op=call_command with defaults and returns the ExecResult', async () => {
    next = {
      status: 200,
      body: { result: { exit_code: 0, stdout: 'hi', stderr: '', truncated: false } }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:biowulf'); const res = await c.call_command('echo hi', 'probe'); return res.stdout"
      )
      expect(r.error).toBeNull()
      expect(r.result).toContain('hi')
      expect(received.params?.op).toBe('call_command')
      expect(received.params?.provider_id).toBe('ssh:biowulf')
      expect(received.params?.cmd).toBe('echo hi')
      expect(received.params?.intent).toBe('probe')
      // login_shell defaults to true; timeout_seconds omitted -> the service applies its own default.
      expect(received.params?.login_shell).toBe(true)
      expect(received.params?.timeout_seconds).toBeUndefined()
    } finally {
      child.kill()
    }
  }, 60_000)

  it('maps a structured compute error onto the thrown Error (error_code / retry_after_user_action)', async () => {
    // The RPC layer re-serializes ComputeService's structured error as a JSON string in `error`.
    next = {
      status: 500,
      body: {
        error: JSON.stringify({
          error_code: 'host_unreachable',
          message: 'SSH connect failed',
          retry_after_user_action: true
        })
      }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:x');\n" +
          'try { await c.call_command("id", "probe") }\n' +
          'catch (e) { return JSON.stringify({ code: e.error_code, retry: e.retry_after_user_action, msg: e.message }) }'
      )
      expect(r.error).toBeNull()
      const parsed = JSON.parse(r.result ?? '')
      expect(parsed.code).toBe('host_unreachable')
      expect(parsed.retry).toBe(true)
      expect(parsed.msg).toContain('SSH connect failed')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('details() posts op=details with mode/text/old_text and returns the result', async () => {
    next = { status: 200, body: { result: { doc: 'the doc', isSkeleton: false } } }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      // read: only mode is forwarded.
      const read = await send(
        "return (await host.compute.details('ssh:biowulf', { mode: 'read' })).doc"
      )
      expect(read.error).toBeNull()
      expect(read.result).toContain('the doc')
      expect(received.params?.op).toBe('details')
      expect(received.params?.provider_id).toBe('ssh:biowulf')
      expect(received.params?.mode).toBe('read')

      // replace: text + old_text are forwarded (snake_case matches the RPC contract).
      next = { status: 200, body: { result: { ok: true } } }
      const replace = await send(
        "await host.compute.details('ssh:biowulf', { mode: 'replace', text: 'new', old_text: 'old' }); return 'done'"
      )
      expect(replace.error).toBeNull()
      expect(received.params?.mode).toBe('replace')
      expect(received.params?.text).toBe('new')
      expect(received.params?.old_text).toBe('old')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('threads session/project identity from the spawn env into the call_command payload', async () => {
    next = {
      status: 200,
      body: { result: { exit_code: 0, stdout: '', stderr: '', truncated: false } }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42',
      OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME: 'my-project'
    })
    try {
      const r = await send(
        "await host.compute.create('ssh:biowulf').call_command('id', 'probe'); return 'ok'"
      )
      expect(r.error).toBeNull()
      expect(received.params?.session_id).toBe('session-42')
      expect(received.params?.project_id).toBe('my-project')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('removes the session/project identity from process.env so sandbox code cannot read it', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42',
      OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME: 'my-project'
    })
    try {
      const r = await send(
        'return JSON.stringify([process.env.OPEN_SCIENCE_NOTEBOOK_SESSION_ID, process.env.OPEN_SCIENCE_NOTEBOOK_PROJECT_NAME])'
      )
      expect(r.error).toBeNull()
      expect(JSON.parse(r.result ?? '')).toEqual([null, null])
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().set_concurrency_limit(k) posts op=set_concurrency_limit with session_id and limit', async () => {
    next = { status: 200, body: { result: null } }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:biowulf'); await c.set_concurrency_limit(5); return 'ok'"
      )
      expect(r.error).toBeNull()
      expect(r.result).toContain('ok')
      expect(received.params?.op).toBe('set_concurrency_limit')
      expect(received.params?.session_id).toBe('session-42')
      expect(received.params?.limit).toBe(5)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().set_concurrency_limit() validates that k is a positive integer', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      // Negative number should throw
      const r1 = await send(
        "const c = host.compute.create('ssh:biowulf'); try { await c.set_concurrency_limit(-1); return 'bad' } catch (e) { return e.message }"
      )
      expect(r1.result).toContain('positive integer')

      // Zero should throw
      const r2 = await send(
        "const c2 = host.compute.create('ssh:biowulf'); try { await c2.set_concurrency_limit(0); return 'bad' } catch (e) { return e.message }"
      )
      expect(r2.result).toContain('positive integer')

      // Float should throw
      const r3 = await send(
        "const c3 = host.compute.create('ssh:biowulf'); try { await c3.set_concurrency_limit(2.5); return 'bad' } catch (e) { return e.message }"
      )
      expect(r3.result).toContain('positive integer')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('create().status() posts op=concurrency_status and returns session status dict', async () => {
    next = {
      status: 200,
      body: {
        result: {
          session_limit: 10,
          active_count: 3,
          queued_count: 1,
          provider_ceilings: { 'ssh:biowulf': 50, 'ssh:cluster-a': 10 }
        }
      }
    }
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok',
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'session-42'
    })
    try {
      const r = await send(
        "const c = host.compute.create('ssh:biowulf'); const s = await c.status(); return JSON.stringify(s)"
      )
      expect(r.error).toBeNull()
      const parsed = JSON.parse(r.result ?? '')
      expect(parsed.session_limit).toBe(10)
      expect(parsed.active_count).toBe(3)
      expect(parsed.queued_count).toBe(1)
      expect(parsed.provider_ceilings).toEqual({ 'ssh:biowulf': 50, 'ssh:cluster-a': 10 })
      expect(received.params?.op).toBe('concurrency_status')
      expect(received.params?.session_id).toBe('session-42')
    } finally {
      child.kill()
    }
  }, 60_000)
})

gate('repl_loop.js host.mcp', () => {
  let server: Server
  let endpoint: string

  beforeAll(async () => {
    // Minimal stub RPC endpoint returning a fixed dict for any mcpCall, mirroring
    // host-mcp.integration.test.ts's stub.
    const { createServer } = await import('node:http')
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { ok: true } }))
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    endpoint = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
  })

  it('runs top-level await host.mcp and returns the stub result', async () => {
    const { child, send } = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const r = await send("return await host.mcp('chemistry', 'm', { cids: [1] })")
      expect(r.error).toBeNull()
      expect(r.result).toContain('true')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('echoes a trailing bare expression like a REPL (no explicit return needed)', async () => {
    const { child, send } = startLoop({})
    try {
      // Trailing expression on its own line after other statements (the common agent pattern).
      const a = await send('const r = { hits: 3 };\nglobalThis.saved = r;\nr;')
      expect(a.error).toBeNull()
      expect(a.result).toBe('{"hits":3}')

      // Also on a single line with ';'-separated statements, and with top-level await.
      const b = await send('const x = await Promise.resolve(41); x + 1')
      expect(b.result).toBe('42')

      // A statement/declaration tail is not echoed and must not error (safe fallback).
      const c = await send('let z = 5;')
      expect(c.error).toBeNull()
      expect(c.result).toBeNull()
    } finally {
      child.kill()
    }
  }, 60_000)
})
