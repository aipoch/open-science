import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { framePythonNamespaceRequest } from './kernel-protocol'

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
  environment: {
    runtime_version: string
    packages: Array<{ name: string; version_status: string; loaded_state: string }>
  }
  namespace?: {
    variable_count: number
    variables_truncated: boolean
    variables: Array<{
      name: string
      type: string
      size_bytes?: number
      shape?: string
      preview: string
      preview_truncated?: boolean
      is_private?: boolean
    }>
  }
}

// Minimal one-shot client over the loop's stdio protocol for the test.
const startLoop = (
  python: string,
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<LoopResponse>
  inspect: (includePrivate?: boolean) => Promise<LoopResponse>
} => {
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
  const inspect = (includePrivate = false): Promise<LoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(framePythonNamespaceRequest(reqId, includePrivate))
    })
  return { child, send, inspect }
}

gate('python_loop.py', () => {
  it('returns fresh bounded user variables while filtering bootstrap and private names', async () => {
    const { child, send, inspect } = startLoop(pyBin as string, {})
    try {
      await send(
        "x = 41; label = '活跃变量'; _private = 'hidden'; sys = 1; json = 'user json'; " +
          "items = list(range(10000)); blob = b'x' * 2000000; " +
          "Explosive = type('Explosive', (), {'__repr__': lambda self: (_ for _ in ()).throw(RuntimeError('no repr'))}); explosive = Explosive(); mixed = [explosive]; globals()[0] = 'non-string key'"
      )
      const first = await inspect()
      expect(first.namespace?.variables.map(({ name }) => name)).toEqual([
        'Explosive',
        'blob',
        'explosive',
        'items',
        'json',
        'label',
        'mixed',
        'sys',
        'x'
      ])
      expect(first.namespace?.variables.find(({ name }) => name === 'blob')).toMatchObject({
        size_bytes: 2_000_033,
        preview: expect.stringMatching(/^b'/)
      })
      expect(first.namespace?.variables.find(({ name }) => name === 'sys')?.preview).toBe('1')
      expect(first.namespace?.variables.find(({ name }) => name === 'json')?.preview).toBe(
        "'user json'"
      )
      expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(256 * 1024)

      await send("x = 42; del label; added = {'ok': True}")
      const refreshed = await inspect(true)
      expect(refreshed.namespace?.variables.map(({ name }) => name)).toEqual([
        'Explosive',
        '_private',
        'added',
        'blob',
        'explosive',
        'items',
        'json',
        'mixed',
        'sys',
        'x'
      ])
      expect(refreshed.namespace?.variables.find(({ name }) => name === 'mixed')?.preview).toBe(
        'list [1]'
      )
      expect(refreshed.namespace?.variables.find(({ name }) => name === 'x')?.preview).toBe('42')
      expect(refreshed.namespace?.variables.find(({ name }) => name === '_private')).toMatchObject({
        is_private: true
      })
    } finally {
      child.kill()
    }
  }, 60_000)

  it('keeps the final JSON response within budget for non-ASCII names and previews', async () => {
    const { child, send, inspect } = startLoop(pyBin as string, {})
    try {
      await send("globals().update({f'变量{i}': '汉' * 1000 for i in range(500)})")
      const response = await inspect()

      expect(response.namespace?.variables_truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(256 * 1024)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('executes non-ASCII source sent over the stdin protocol', async () => {
    const { child, send } = startLoop(pyBin as string, {})
    try {
      const response = await send('\n# Select 8–10 representative candidate factors\nprint(1)')

      expect(response.error).toBeNull()
      expect(response.stdout).toBe('1\n')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('keeps state across requests, echoes trailing expr, captures stdout, reports errors', async () => {
    const { child, send } = startLoop(pyBin as string, {})
    try {
      const a = await send('x = 41')
      expect(a.error).toBeNull()
      expect(a.environment.runtime_version).toMatch(/^3\./)
      expect(a.environment.packages).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'sys', loaded_state: 'loaded' })])
      )

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

  it('captures a saved matplotlib figure exactly once as a content-addressed PNG', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-'))
    const savedPath = join(figuresDir, 'saved.png')
    const { child, send } = startLoop(pyBin as string, {
      MPLBACKEND: 'Agg',
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt; ' +
          `plt.plot([1,2,3]); plt.savefig(${JSON.stringify(savedPath)})`
      )
      expect(r.error).toBeNull()
      expect(existsSync(savedPath)).toBe(true)
      expect(r.figures).toHaveLength(1)
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

  it('allows reading pyvenv.cfg metadata but still blocks writing it', async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-python-runtime-guard-'))
    const workspace = mkdtempSync(join(tmpdir(), 'os-python-pyvenv-read-'))
    const configPath = join(workspace, 'pyvenv.cfg')
    writeFileSync(configPath, 'home = /usr/bin\n')
    const { child, send } = startLoop(pyBin as string, {
      OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot
    })
    try {
      const read = await send(
        `print(open(${JSON.stringify(configPath)}, 'r', encoding='utf-8').read(), end='')`
      )
      expect(read.error).toBeNull()
      expect(read.stdout).toBe('home = /usr/bin\n')

      const write = await send(`open(${JSON.stringify(configPath)}, 'w').write('changed')`)
      expect(write.error).toMatch(/manage_packages/)
      expect(readFileSync(configPath, 'utf8')).toBe('home = /usr/bin\n')
    } finally {
      child.kill()
      rmSync(runtimeRoot, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')(
    'uses subprocess write targets so copy-out and workspace writes remain allowed',
    async () => {
      const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-python-child-runtime-'))
      const workspace = mkdtempSync(join(tmpdir(), 'os-python-child-output-'))
      const source = join(runtimeRoot, 'source.txt')
      const copied = join(workspace, 'copied.txt')
      const outputDir = join(workspace, 'created')
      writeFileSync(source, 'runtime input')
      const { child, send } = startLoop(pyBin as string, {
        OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot
      })
      try {
        const copyOut = await send(
          `import subprocess; subprocess.run(["cp", ${JSON.stringify(source)}, ${JSON.stringify(copied)}], check=True)`
        )
        expect(copyOut.error).toBeNull()
        expect(readFileSync(copied, 'utf8')).toBe('runtime input')

        const workspaceWrite = await send(
          `subprocess.run(["sh", "-c", ` +
            `${JSON.stringify(`printf '%s' "$OPEN_SCIENCE_RUNTIME_DIR" >/dev/null; mkdir ${JSON.stringify(outputDir)}`)}], check=True)`
        )
        expect(workspaceWrite.error).toBeNull()
        expect(existsSync(outputDir)).toBe(true)

        const blocked = await send(
          `subprocess.run(["cp", ${JSON.stringify(copied)}, ` +
            `${JSON.stringify(join(runtimeRoot, 'blocked.txt'))}], check=True)`
        )
        expect(blocked.error).toMatch(/manage_packages/)
      } finally {
        child.kill()
        rmSync(runtimeRoot, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
      }
    },
    60_000
  )
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
