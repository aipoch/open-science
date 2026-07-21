import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
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
