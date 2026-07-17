import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookKernelExecutor } from './kernel-executor'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV, envPrefix, pythonBin } from './runtime-paths'
import { TimeoutController } from './timeout-controller'

// -- TimeoutController: pure state machine, driven with fake timers + a signal recorder. ------------

// Fake scheduler: timers only fire when the test explicitly fires them, so the arm -> soft -> hard
// transitions are deterministic without real time.
const makeTimerHarness = (): {
  timers: Map<number, () => void>
  schedule: (fn: () => void) => number
  cancel: (handle: unknown) => void
  fireOldest: () => void
} => {
  const timers = new Map<number, () => void>()
  let nextId = 1
  const schedule = (fn: () => void): number => {
    const id = nextId++
    timers.set(id, fn)
    return id
  }
  const cancel = (handle: unknown): void => {
    timers.delete(handle as number)
  }
  const fireOldest = (): void => {
    const [id] = timers.keys()
    const fn = timers.get(id)
    timers.delete(id)
    fn?.()
  }
  return { timers, schedule, cancel, fireOldest }
}

describe('TimeoutController', () => {
  it('soft timeout sends SIGINT, marks timedOut, and arms the hard timer', () => {
    const h = makeTimerHarness()
    const signals: NodeJS.Signals[] = []
    let hardCalls = 0
    const controller = new TimeoutController({
      kill: (signal) => signals.push(signal),
      onHardTimeout: () => (hardCalls += 1),
      schedule: h.schedule,
      cancel: h.cancel,
      hardGraceMs: 50
    })

    controller.arm(100)
    expect(controller.timedOut).toBe(false)
    expect(h.timers.size).toBe(1)

    h.fireOldest() // soft timeout
    expect(signals).toEqual(['SIGINT'])
    expect(controller.timedOut).toBe(true)
    expect(hardCalls).toBe(0)
    expect(h.timers.size).toBe(1) // hard timer now armed
  })

  it('hard timeout sends SIGKILL and invokes onHardTimeout', () => {
    const h = makeTimerHarness()
    const signals: NodeJS.Signals[] = []
    let hardCalls = 0
    const controller = new TimeoutController({
      kill: (signal) => signals.push(signal),
      onHardTimeout: () => (hardCalls += 1),
      schedule: h.schedule,
      cancel: h.cancel,
      hardGraceMs: 50
    })

    controller.arm(100)
    h.fireOldest() // soft -> SIGINT + arm hard
    h.fireOldest() // hard -> SIGKILL

    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
    expect(hardCalls).toBe(1)
  })

  it('a response before the soft timeout fires no signals', () => {
    const h = makeTimerHarness()
    const signals: NodeJS.Signals[] = []
    const controller = new TimeoutController({
      kill: (signal) => signals.push(signal),
      onHardTimeout: () => {},
      schedule: h.schedule,
      cancel: h.cancel
    })

    controller.arm(100)
    controller.disarm() // response arrived

    expect(signals).toEqual([])
    expect(controller.timedOut).toBe(false)
    expect(h.timers.size).toBe(0)
  })

  it('a response after the soft timeout still reports timedOut and never SIGKILLs', () => {
    const h = makeTimerHarness()
    const signals: NodeJS.Signals[] = []
    const controller = new TimeoutController({
      kill: (signal) => signals.push(signal),
      onHardTimeout: () => {},
      schedule: h.schedule,
      cancel: h.cancel,
      hardGraceMs: 50
    })

    controller.arm(100)
    h.fireOldest() // soft -> SIGINT, hard armed
    controller.disarm() // late response arrives before hard fires

    expect(signals).toEqual(['SIGINT'])
    expect(controller.timedOut).toBe(true)
    expect(h.timers.size).toBe(0) // hard timer cancelled
  })
})

// -- Driver against a fake python loop, gated on a resolvable system python3. ------------------------

const FIXTURE = join(__dirname, '../../../test/fixtures/fake_loop.py')

// First on-disk python3 wins; the driver tests skip entirely when none is present.
const resolvePython3 = (): string | undefined =>
  [
    process.env.OPEN_SCIENCE_TEST_PY_ENV,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3'
  ].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate))

const python3 = resolvePython3()
const gate = python3 ? describe : describe.skip

// Symlinks an env's python interpreter to the system python3 under a runtime root, so the strict
// resolver (env interpreter only -- no system-PATH fallback) finds it and spawns the fake loop.
const stubEnvPython = async (runtimeRootDir: string, name: string): Promise<void> => {
  const bin = pythonBin(envPrefix(runtimeRootDir, name))
  await mkdir(dirname(bin), { recursive: true })
  await symlink(python3 as string, bin)
}

// Makes a temp cwd AND stubs its default-python env interpreter, so a default-env execute() passes the
// readiness gate and spawns the fake loop under an on-disk env interpreter (never a system python).
const makeDefaultEnvCwd = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await stubEnvPython(join(dir, 'runtime'), DEFAULT_PY_ENV)
  return dir
}

type ExecutorInternals = { procs: Map<string, ProcStateLike> }
type ProcStateLike = { child: ChildProcessWithoutNullStreams; env: string }
// Composite process key: 'repl' for the control kernel, `${kind}:${env}` for data kernels. `env`
// defaults to the language's default env so existing single-env call sites need no change.
const procKeyFor = (kind: 'python' | 'r' | 'repl', env?: string): string =>
  kind === 'repl' ? 'repl' : `${kind}:${env ?? (kind === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV)}`
const procFor = (
  executor: NotebookKernelExecutor,
  kind: 'python' | 'r' | 'repl',
  env?: string
): ProcStateLike | undefined =>
  (executor as unknown as ExecutorInternals).procs.get(procKeyFor(kind, env))

let cwdDir: string | undefined

const makeExecutor = (): NotebookKernelExecutor =>
  new NotebookKernelExecutor({ pythonBin: python3, pythonLoopPath: FIXTURE })

const baseRequest = (
  cwd: string
): {
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
} => ({
  cwd,
  notebookSessionRoot: join(cwd, 'nb'),
  dataRoot: join(cwd, 'nb', 'data'),
  runtimeRoot: join(cwd, 'runtime')
})

afterEach(async () => {
  if (cwdDir) {
    await rm(cwdDir, { recursive: true, force: true })
    cwdDir = undefined
  }
})

gate('NotebookKernelExecutor (fake loop)', () => {
  it('runs a cell, echoes stdout, and reports the working directory', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-exec-')
    const executor = makeExecutor()
    try {
      const result = await executor.execute({ ...baseRequest(cwdDir), code: 'hello' })
      expect(result.status).toBe('completed')
      expect(result.stdout).toBe('hello')
      // The loop reports its resolved cwd (macOS maps /var -> /private/var).
      expect(result.cwdAfter).toBe(realpathSync(cwdDir))
      expect(result.outputs).toContainEqual({ type: 'stream', name: 'stdout', text: 'hello' })
    } finally {
      await executor.shutdown()
    }
  })

  it('reuses the same loop process across executes of the same language', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-reuse-')
    const executor = makeExecutor()
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'a' })
      const first = procFor(executor, 'python')?.child
      await executor.execute({ ...baseRequest(cwdDir), code: 'b' })
      const second = procFor(executor, 'python')?.child
      expect(first).toBeDefined()
      expect(second).toBe(first) // not respawned
    } finally {
      await executor.shutdown()
    }
  })

  it('soft-interrupts a long run with SIGINT and reports a timeout', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-soft-')
    const executor = makeExecutor()
    try {
      // Warm the loop, then watch the exact SIGINT the soft timeout delivers.
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams
      const killSpy = vi.spyOn(child, 'kill')

      const timed = await executor.execute({
        ...baseRequest(cwdDir),
        code: '__SLEEP__',
        timeoutMs: 100
      })
      expect(timed.status).toBe('timeout')
      expect(killSpy).toHaveBeenCalledWith('SIGINT')
      expect(killSpy).not.toHaveBeenCalledWith('SIGKILL')

      // The loop caught the interrupt and survives: the same process serves the next run.
      const next = await executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(next.status).toBe('completed')
      expect(procFor(executor, 'python')?.child).toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('shutdown terminates a loop that only soft-timed-out (child.killed but still alive)', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-shutdown-soft-')
    const executor = makeExecutor()
    await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
    const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams

    const timed = await executor.execute({
      ...baseRequest(cwdDir),
      code: '__SLEEP__',
      timeoutMs: 100
    })
    expect(timed.status).toBe('timeout')
    // Node marks child.killed once the soft-timeout SIGINT is sent, even though the loop caught it
    // and is still alive (proven by reuse in the previous test) -- the process itself has not exited.
    expect(child.killed).toBe(true)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()

    await executor.shutdown()

    // A killChild that early-returns on the stale child.killed flag would never actually terminate
    // this still-running process. It must be genuinely gone once shutdown() resolves.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  }, 15_000)

  it('hard-kills a loop that ignores SIGINT, then respawns on the next execute', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-hard-')
    const executor = makeExecutor()
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams
      const killSpy = vi.spyOn(child, 'kill')

      const timed = await executor.execute({
        ...baseRequest(cwdDir),
        code: '__IGNORE_SIGINT__',
        timeoutMs: 100
      })
      expect(timed.status).toBe('timeout')
      expect(killSpy).toHaveBeenCalledWith('SIGINT')
      expect(killSpy).toHaveBeenCalledWith('SIGKILL')
      expect(procFor(executor, 'python')).toBeUndefined() // dropped from the map

      // The next execute respawns a fresh loop.
      const next = await executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(next.status).toBe('completed')
      const respawned = procFor(executor, 'python')?.child
      expect(respawned).toBeDefined()
      expect(respawned).not.toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('reads a captured figure file into a base64 display output and unlinks it', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-fig-')
    const executor = makeExecutor()
    try {
      const result = await executor.execute({ ...baseRequest(cwdDir), code: '__FIGURE__' })
      expect(result.status).toBe('completed')
      const display = result.outputs.find((output) => output.type === 'display')
      expect(display).toBeDefined()
      const data = (display as { data: Record<string, string> }).data
      expect(Object.keys(data)).toContain('image/png')
      // Base64 of a real PNG: decodes back to the PNG magic bytes.
      expect(Buffer.from(data['image/png'], 'base64').subarray(1, 4).toString('ascii')).toBe('PNG')
      // The figures dir is emptied after the read (unlinked).
      const figuresDir = (executor as unknown as { figuresDir?: string }).figuresDir
      expect(figuresDir).toBeDefined()
      expect(existsSync(join(figuresDir as string, 'fake.png'))).toBe(false)
    } finally {
      await executor.shutdown()
    }
  })

  it('fires onTerminated when a hard-timeout drops a wedged loop (G3)', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-hard-term-')
    const terminated: string[] = []
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      onTerminated: (kind) => terminated.push(kind)
    })
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const timed = await executor.execute({
        ...baseRequest(cwdDir),
        code: '__IGNORE_SIGINT__',
        timeoutMs: 100
      })
      expect(timed.status).toBe('timeout')
      // The hard-kill drop surfaces a 'terminated' kernel status, exactly once for the python kind.
      expect(terminated).toEqual(['python'])
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('fires onTerminated when a live loop crashes (unexpected exit), but not on shutdown (G3)', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-crash-term-')
    const terminated: string[] = []
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      onTerminated: (kind) => terminated.push(kind)
    })
    await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
    const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams

    // Kill the still-live loop out from under the executor to simulate a crash; its exit handler must
    // surface a single 'terminated' for the python kind.
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited

    expect(terminated).toEqual(['python'])
    expect(procFor(executor, 'python')).toBeUndefined() // dropped from the map

    // An intentional teardown is not a termination: shutdown() must not add another onTerminated.
    await executor.shutdown()
    expect(terminated).toEqual(['python'])
  }, 15_000)
})

gate('NotebookKernelExecutor idle-timeout shutdown', () => {
  it('drops an idle proc when the idle timer fires, and respawns fresh on the next execute', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-idle-')
    const h = makeTimerHarness()
    const idleShutdowns: string[] = []
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      idleTimeoutMs: 1_000,
      scheduleIdleTimer: h.schedule,
      cancelIdleTimer: h.cancel,
      onIdleShutdown: (kind) => idleShutdowns.push(kind)
    })
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams
      // The proc went idle after the request completed: exactly one idle timer is now armed.
      expect(h.timers.size).toBe(1)

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      h.fireOldest() // simulate the idle window elapsing
      await exited

      expect(procFor(executor, 'python')).toBeUndefined() // dropped from the map
      expect(idleShutdowns).toEqual(['python'])

      // The next execute lazily respawns a brand-new process (namespace cleared).
      const next = await executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(next.status).toBe('completed')
      const respawned = procFor(executor, 'python')?.child
      expect(respawned).toBeDefined()
      expect(respawned).not.toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('disarms the idle timer at the start of the next request, so it can never fire mid-request', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-idle-disarm-')
    const h = makeTimerHarness()
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      idleTimeoutMs: 1_000,
      scheduleIdleTimer: h.schedule,
      cancelIdleTimer: h.cancel
    })
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      expect(h.timers.size).toBe(1) // armed once idle after the first request

      // ensureProc()/execute() disarm the timer synchronously before the first await, so it is gone
      // the instant the next request starts -- well before the (slow, real) loop round-trip settles.
      const pending = executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(h.timers.size).toBe(0)

      const result = await pending
      expect(result.status).toBe('completed')
      expect(h.timers.size).toBe(1) // re-armed once idle again
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('never idle-shuts-down a proc that is mid-request when the timer fires', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-idle-inflight-')
    const h = makeTimerHarness()
    const idleShutdowns: string[] = []
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      idleTimeoutMs: 1_000,
      scheduleIdleTimer: h.schedule,
      cancelIdleTimer: h.cancel,
      onIdleShutdown: (kind) => idleShutdowns.push(kind)
    })
    const internals = executor as unknown as {
      procs: Map<string, { pending?: unknown }>
      handleIdleTimeout: (proc: unknown) => void
    }
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child

      // __SLEEP__ blocks the child for real, so proc.pending is deterministically still set while we
      // inspect it -- no race against how fast a real response could come back over the pipe.
      const runPromise = executor.execute({
        ...baseRequest(cwdDir),
        code: '__SLEEP__',
        timeoutMs: 300
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const proc = internals.procs.get(procKeyFor('python'))
      expect(proc?.pending).toBeDefined()

      // Directly invoke the idle-fire handler as if a stale timer raced past the disarm point:
      // handleIdleTimeout's own `pending` guard must refuse to drop a proc that is mid-request.
      internals.handleIdleTimeout(proc)

      expect(idleShutdowns).toEqual([])
      expect(procFor(executor, 'python')?.child).toBe(child)

      await runPromise
    } finally {
      await executor.shutdown()
    }
  }, 15_000)
})

// -- Named environments: per-(kind, env) process keying. --------------------------------------------

gate('NotebookKernelExecutor named environments', () => {
  it('routes an omitted environment to the default env key (backward compat)', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-default-env-')
    const executor = makeExecutor()
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'x' })
      const internals = executor as unknown as { procs: Map<string, ProcStateLike> }
      // The default python run keys under `python:default-python`, not the bare kind.
      expect(internals.procs.has(procKeyFor('python'))).toBe(true)
      expect(procFor(executor, 'python')?.env).toBe(DEFAULT_PY_ENV)
    } finally {
      await executor.shutdown()
    }
  })

  it('keeps a named env and the default env as two coexisting procs with independent idle timers', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-coexist-')
    const req = baseRequest(cwdDir)
    await stubEnvPython(req.runtimeRoot, 'my-analysis')
    const h = makeTimerHarness()
    const idleShutdowns: Array<[string, string]> = []
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      idleTimeoutMs: 1_000,
      scheduleIdleTimer: h.schedule,
      cancelIdleTimer: h.cancel,
      onIdleShutdown: (kind, env) => idleShutdowns.push([kind, env])
    })
    try {
      await executor.execute({ ...req, code: 'a' }) // default-python
      await executor.execute({ ...req, code: 'b', environment: 'my-analysis' }) // named env

      const def = procFor(executor, 'python')
      const named = procFor(executor, 'python', 'my-analysis')
      expect(def).toBeDefined()
      expect(named).toBeDefined()
      // Two distinct processes/namespaces coexist in the map.
      expect(def?.child).not.toBe(named?.child)
      const internals = executor as unknown as { procs: Map<string, ProcStateLike> }
      expect(internals.procs.size).toBe(2)
      // Each idle proc armed its own timer, dropped independently.
      expect(h.timers.size).toBe(2)

      h.fireOldest() // default-python idle window elapses first (armed first)
      h.fireOldest() // named env idle window elapses next
      expect(idleShutdowns).toEqual([
        ['python', DEFAULT_PY_ENV],
        ['python', 'my-analysis']
      ])
      expect(procFor(executor, 'python')).toBeUndefined()
      expect(procFor(executor, 'python', 'my-analysis')).toBeUndefined()
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('fires onTerminated with the resolved env when a named-env loop crashes', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-named-term-'))
    const req = baseRequest(cwdDir)
    await stubEnvPython(req.runtimeRoot, 'my-analysis')
    const terminated: Array<[string, string]> = []
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      onTerminated: (kind, env) => terminated.push([kind, env])
    })
    await executor.execute({ ...req, code: 'warm', environment: 'my-analysis' })
    const child = procFor(executor, 'python', 'my-analysis')
      ?.child as ChildProcessWithoutNullStreams

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited

    expect(terminated).toEqual([['python', 'my-analysis']])
    expect(procFor(executor, 'python', 'my-analysis')).toBeUndefined()
    await executor.shutdown()
  }, 15_000)
})

// -- Spawn env: no spawn, no python3 required; exercises the private env builder directly. -----------

type BuildEnvFn = (
  kind: 'python' | 'r' | 'repl',
  request: ReturnType<typeof baseRequest> & {
    code: string
    mcpRpcEndpoint?: string
    mcpRpcToken?: string
  },
  figuresDir: string
) => NodeJS.ProcessEnv

describe('NotebookKernelExecutor spawn env', () => {
  it('injects OPEN_SCIENCE_HANDOFF_DIR under the notebook session root for every kernel language', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    const request = { ...baseRequest('/tmp/os-handoff-test'), code: 'x' }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)

    const expected = join(request.notebookSessionRoot, 'handoff')
    expect(buildEnv('python', request, '/tmp/figs').OPEN_SCIENCE_HANDOFF_DIR).toBe(expected)
    expect(buildEnv('r', request, '/tmp/figs').OPEN_SCIENCE_HANDOFF_DIR).toBe(expected)
    expect(buildEnv('repl', request, '/tmp/figs').OPEN_SCIENCE_HANDOFF_DIR).toBe(expected)
  })

  it('gives the repl kernel ELECTRON_RUN_AS_NODE plus the connector RPC endpoint/token', () => {
    const executor = new NotebookKernelExecutor({ replLoopPath: '/tmp/repl_loop.js' })
    const request = {
      ...baseRequest('/tmp/os-repl-env'),
      code: 'x',
      mcpRpcEndpoint: 'http://127.0.0.1:9/x',
      mcpRpcToken: 'tok'
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)

    const replEnv = buildEnv('repl', request, '/tmp/figs')
    expect(replEnv.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(replEnv.OPEN_SCIENCE_MCP_RPC_ENDPOINT).toBe('http://127.0.0.1:9/x')
    expect(replEnv.OPEN_SCIENCE_MCP_RPC_TOKEN).toBe('tok')
  })

  it('withholds the connector RPC env from python/r data kernels (host.mcp is repl-only)', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    const request = {
      ...baseRequest('/tmp/os-repl-env'),
      code: 'x',
      mcpRpcEndpoint: 'http://127.0.0.1:9/x',
      mcpRpcToken: 'tok'
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)

    for (const kind of ['python', 'r'] as const) {
      const env = buildEnv(kind, request, '/tmp/figs')
      // Defense-in-depth: even if a data request carried the RPC connection, the data kernel never
      // receives it, so python/r have no outbound connector (host.mcp) access.
      expect(env.OPEN_SCIENCE_MCP_RPC_ENDPOINT).toBeUndefined()
      expect(env.OPEN_SCIENCE_MCP_RPC_TOKEN).toBeUndefined()
      // Only the repl kernel runs the app binary as plain Node.
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
  })
})

// -- Repl kind end-to-end against the real repl_loop.js under the test's node (process.execPath). ----

const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

describe('NotebookKernelExecutor repl kind (real repl_loop.js)', () => {
  it('spawns the repl loop via process.execPath and returns the mapped return value', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-'))
    const executor = new NotebookKernelExecutor({ replLoopPath: REPL_LOOP })
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: 'console.log("hi"); return 1 + 1',
        kind: 'repl'
      })
      expect(result.status).toBe('completed')
      expect(result.stdout).toBe('hi\n')
      // The awaited IIFE return value surfaces as a text/plain display output (mapLoopOutputs).
      expect(result.outputs).toContainEqual({ type: 'display', data: { 'text/plain': '2' } })

      // The control kernel runs the app binary (here: the test node) with the repl loop as its arg.
      const child = procFor(executor, 'repl')?.child as ChildProcessWithoutNullStreams & {
        spawnfile: string
        spawnargs: string[]
      }
      expect(child.spawnfile).toBe(process.execPath)
      expect(child.spawnargs).toContain(REPL_LOOP)
    } finally {
      await executor.shutdown()
    }
  })
})

// -- Readiness gate: no spawn, no python3 required. -------------------------------------------------

describe('NotebookKernelExecutor readiness gate', () => {
  it('fails clearly when R is requested but no rEnvPrefix is configured', async () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    try {
      const result = await executor.execute({
        ...baseRequest('/tmp'),
        code: 'x',
        language: 'r'
      })
      expect(result.status).toBe('failed')
      expect(result.stderr).toMatch(/r environment.*still being prepared/i)
    } finally {
      await executor.shutdown()
    }
  })

  it('fails clearly when the default env interpreter is absent (no system-python fallback)', async () => {
    // baseRequest('/tmp') points at a runtime root with no provisioned default-python interpreter.
    // The strict resolver has no system-PATH fallback, so this must surface the readiness error
    // rather than spawn a system python.
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    try {
      const result = await executor.execute({ ...baseRequest('/tmp'), code: 'x' })
      expect(result.status).toBe('failed')
      expect(result.stderr).toMatch(/python environment.*still being prepared/i)
    } finally {
      await executor.shutdown()
    }
  })

  it('rejects a named env whose interpreter is absent, naming the env', async () => {
    const executor = new NotebookKernelExecutor({ pythonBin: python3, pythonLoopPath: FIXTURE })
    try {
      const result = await executor.execute({
        ...baseRequest('/tmp'),
        code: 'x',
        environment: 'ghost-env'
      })
      expect(result.status).toBe('failed')
      // A missing NAMED env tells the agent to create it explicitly (defaults auto-provision instead).
      expect(result.stderr).toMatch(/environment "ghost-env" does not exist.*manage_environments/i)
    } finally {
      await executor.shutdown()
    }
  })
})
