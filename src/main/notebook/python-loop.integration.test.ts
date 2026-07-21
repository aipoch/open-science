import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Run with: RUN_KERNEL=1 OPEN_SCIENCE_TEST_PY_ENV=/path/to/env/bin/python \
//   npx vitest run src/main/notebook/python-loop.integration.test.ts
const pyBin = process.env.OPEN_SCIENCE_TEST_PY_ENV
const gate = process.env.RUN_KERNEL && pyBin ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/python_loop.py')

// One wire response from python_loop.py, mirroring kernel-protocol's KernelLoopResponse but with
// the raw snake_case field names as they appear on the wire.
type LoopResponse = {
  req_id: string
  stdout: string
  stderr: string
  error: string | null
  result: string | null
  cwd: string
  figures: { mime: string; path: string }[]
}

// Minimal one-shot client over the loop's stdio protocol for the test.
const startLoop = (
  python: string,
  env: NodeJS.ProcessEnv
): { child: ChildProcessWithoutNullStreams; send: (code: string) => Promise<LoopResponse> } => {
  const child = spawn(python, [LOOP], { env: { ...process.env, ...env } })
  const rl = createInterface({ input: child.stdout })
  const waiters = new Map<string, (v: LoopResponse) => void>()
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line) as LoopResponse
      const w = waiters.get(msg.req_id)
      if (w) {
        waiters.delete(msg.req_id)
        w(msg)
      }
    } catch {
      /* non-JSON loop noise ignored in the test */
    }
  })
  const send = (code: string): Promise<LoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(`${JSON.stringify({ req_id: reqId, code })}\n`)
    })
  return { child, send }
}

gate('python_loop.py', () => {
  it('keeps state across requests, echoes trailing expr, captures stdout, reports errors', async () => {
    const { child, send } = startLoop(pyBin as string, {})
    try {
      const a = await send('x = 41')
      expect(a.error).toBeNull()

      // State survives across requests; a trailing bare expression echoes as a repr result.
      const b = await send('x + 1')
      expect(b.error).toBeNull()
      expect(b.result).toBe('42')

      // stdout is captured per-request.
      const c = await send('print("hi")')
      expect(c.stdout).toContain('hi')

      // Errors come back as a traceback string, not a thrown exception.
      const d = await send('raise ValueError("boom")')
      expect(d.error).toContain('ValueError: boom')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('captures a matplotlib figure as a content-addressed PNG', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-'))
    const { child, send } = startLoop(pyBin as string, {
      MPLBACKEND: 'Agg',
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt; plt.plot([1,2,3])'
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
      const fig = r.figures[0]
      expect(existsSync(fig.path)).toBe(true)
      const bytes = readFileSync(fig.path)
      // PNG magic bytes.
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('\x89PNG'.slice(0, 4))
      expect(bytes[0]).toBe(0x89)
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)
})

gate('python_loop.py data-kernel isolation', () => {
  it('exposes no host symbol even when the connector RPC env is present', async () => {
    // The data kernel must have NO outbound connector access: host.mcp lives only in the control-plane
    // repl kernel. Even with the RPC endpoint/token set in the environment, the python namespace must
    // not expose a `host` symbol, and referencing it must raise NameError.
    const { child, send } = startLoop(pyBin as string, {
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: 'http://127.0.0.1:9/x',
      OPEN_SCIENCE_MCP_RPC_TOKEN: 'tok'
    })
    try {
      const a = await send("print('host' in dir())")
      expect(a.error).toBeNull()
      expect(a.stdout.trim()).toBe('False')

      const b = await send("print('host' in globals())")
      expect(b.error).toBeNull()
      expect(b.stdout.trim()).toBe('False')

      // Actually touching host is a hard NameError, not a silent no-op.
      const c = await send('host.mcp("x", "y")')
      expect(c.error).toContain("name 'host' is not defined")
    } finally {
      child.kill()
    }
  }, 60_000)
})
