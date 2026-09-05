import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  kernelExecutableReadRoot,
  NotebookKernelExecutor,
  type KernelProcessKind
} from './kernel-executor'
import { framePythonRequest } from './kernel-protocol'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  rScriptBin
} from './runtime-paths'
import { TimeoutController } from './timeout-controller'
import type { NotebookProcessSandbox } from './process-sandbox'
import { NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES, NOTEBOOK_TEXT_LIMIT_BYTES } from './content-limits'
import type { NotebookExecutionRequest, NotebookExecutionResult } from './runtime-service'
import { NotebookHelperModuleHost } from './helper-module-host'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'

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

describe('NotebookKernelExecutor request arbitration', () => {
  it('does not arm the timeout after cancellation wins during synchronous dispatch', async () => {
    vi.useFakeTimers()
    try {
      const cancellation = new AbortController()
      const kill = vi.fn((signal: NodeJS.Signals) => {
        void signal
        return true
      })
      const proc = {
        kind: 'python',
        env: DEFAULT_PY_ENV,
        key: `python:${DEFAULT_PY_ENV}`,
        alive: true,
        interpreterIdentity: '',
        child: {
          kill,
          stdin: {
            write: () => {
              cancellation.abort()
              return true
            }
          }
        }
      } as unknown as RequestArbitrationProc
      const internals = executorRequestInternals(new NotebookKernelExecutor({ platform: 'linux' }))
      const request = internals.sendRequest(
        proc,
        'request-1',
        {
          code: 'slow()',
          cwd: '/workspace',
          notebookSessionRoot: '/workspace/notebook',
          dataRoot: '/workspace/notebook/data',
          runtimeRoot: '/runtime',
          timeoutMs: 10,
          signal: cancellation.signal
        },
        () => undefined
      )

      vi.advanceTimersByTime(10)
      internals.settlePendingResponse(proc, proc.pending, {
        reqId: 'request-1',
        stdout: '',
        stderr: '',
        error: null,
        errorLine: null,
        result: null,
        cwd: '/workspace',
        figures: []
      })

      await expect(request).resolves.toMatchObject({ cancelled: true, timedOut: false })
      expect(kill.mock.calls.filter(([signal]) => signal === 'SIGINT')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
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
const posixGate = describe.skipIf(process.platform === 'win32' || !python3)
const rExecutable = ['/usr/local/bin/R', '/opt/homebrew/bin/R'].find(existsSync)
const rScriptExecutable = ['/usr/local/bin/Rscript', '/opt/homebrew/bin/Rscript'].find(existsSync)

// Symlinks an env's python interpreter to the system python3 under a runtime root, so the strict
// resolver (env interpreter only -- no system-PATH fallback) finds it and spawns the fake loop.
const stubEnvPython = async (
  runtimeRootDir: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> => {
  const bin = pythonBin(envPrefix(runtimeRootDir, name, platform), platform)
  await mkdir(dirname(bin), { recursive: true })
  await symlink(python3 as string, bin)
}

const stubEnvR = async (runtimeRootDir: string, name: string): Promise<void> => {
  const prefix = envPrefix(runtimeRootDir, name)
  await mkdir(dirname(rBin(prefix)), { recursive: true })
  await symlink(rExecutable as string, rBin(prefix))
  await symlink(rScriptExecutable as string, rScriptBin(prefix))
}

// Makes a temp cwd AND stubs its default-python env interpreter, so a default-env execute() passes the
// readiness gate and spawns the fake loop under an on-disk env interpreter (never a system python).
const makeDefaultEnvCwd = async (
  prefix: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await stubEnvPython(join(dir, 'runtime'), DEFAULT_PY_ENV, platform)
  return dir
}

type EnsureProc = (
  key: string,
  kind: KernelProcessKind,
  env: string,
  request: NotebookExecutionRequest
) => Promise<ProcStateLike>
type ExecutorInternals = { procs: Map<string, ProcStateLike>; ensureProc: EnsureProc }
type ProcStateLike = {
  child: ChildProcessWithoutNullStreams
  env: string
  pending?: { timeout?: TimeoutController }
}
type RequestArbitrationProc = {
  pending?: unknown
}
type RequestArbitrationInternals = {
  sendRequest: (
    proc: RequestArbitrationProc,
    reqId: string,
    request: NotebookExecutionRequest,
    onDispatch: () => void
  ) => Promise<{ cancelled: boolean; timedOut: boolean }>
  settlePendingResponse: (
    proc: RequestArbitrationProc,
    pending: unknown,
    response: {
      reqId: string
      stdout: string
      stderr: string
      error: string | null
      errorLine: number | null
      result: string | null
      cwd: string
      figures: []
    }
  ) => void
}
const executorRequestInternals = (executor: NotebookKernelExecutor): RequestArbitrationInternals =>
  executor as unknown as RequestArbitrationInternals
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

const abortOnNextStdinWrite = (
  child: ChildProcessWithoutNullStreams,
  cancellation: AbortController
): void => {
  const originalWrite = child.stdin.write
  const write = originalWrite.bind(child.stdin)
  let abortOnWrite = true
  child.stdin.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void
  ) => {
    const result =
      typeof encoding === 'function'
        ? write(chunk, encoding)
        : encoding === undefined
          ? write(chunk, cb)
          : write(chunk, encoding, cb)
    if (abortOnWrite) {
      abortOnWrite = false
      child.stdin.write = originalWrite
      cancellation.abort()
    }
    return result
  }) as typeof child.stdin.write
}

let cwdDir: string | undefined

const makeExecutor = (): NotebookKernelExecutor =>
  new NotebookKernelExecutor({ pythonBin: python3, pythonLoopPath: FIXTURE, platform: 'linux' })

const baseRequest = (
  cwd: string
): {
  cwd: string
  notebookSessionRoot: string
  inputRoot: string
  dataRoot: string
  runtimeRoot: string
} => ({
  cwd,
  notebookSessionRoot: join(cwd, 'nb'),
  inputRoot: join(cwd, 'inputs'),
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
  it('wraps persistent kernel startup with the shared process sandbox', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-network-sandbox-')
    const request = baseRequest(cwdDir)
    const requestController = new AbortController()
    const cleanup = vi.fn()
    const endExecution = vi.fn()
    const beginExecution = vi.fn(() => endExecution)
    const annotateStderr = vi.fn(
      (stderr: string) => `${stderr}<sandbox_violations>blocked</sandbox_violations>`
    )
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: { OPEN_SCIENCE_SANDBOX_TEST: 'wrapped' },
        beginExecution,
        annotateStderr,
        cleanup
      }))
    }
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: FIXTURE,
      platform: 'linux',
      processSandbox
    })

    try {
      await expect(
        executor.execute({
          ...request,
          code: 'wrapped',
          sessionId: 'session-1',
          projectId: 'project-1',
          signal: requestController.signal
        })
      ).resolves.toMatchObject({
        status: 'completed',
        stdout: 'wrapped',
        stderr: '<sandbox_violations>blocked</sandbox_violations>'
      })
      await expect(
        executor.execute({
          ...request,
          code: 'wrapped again',
          sessionId: 'session-1',
          projectId: 'project-1'
        })
      ).resolves.toMatchObject({ status: 'completed', stdout: 'wrapped again' })
      expect(processSandbox.wrap).toHaveBeenCalledOnce()
      expect(processSandbox.wrap).toHaveBeenCalledWith(
        expect.objectContaining({
          filesystem: expect.objectContaining({
            readOnlyRoots: expect.arrayContaining([
              request.runtimeRoot,
              request.inputRoot,
              FIXTURE
            ]),
            readWriteRoots: expect.arrayContaining([join(request.runtimeRoot, 'cache', 'notebook')])
          })
        })
      )
      const [sandboxInvocation] = vi.mocked(processSandbox.wrap).mock.calls[0]
      expect(sandboxInvocation).not.toHaveProperty('signal')
      expect(sandboxInvocation.filesystem.readWriteRoots).not.toContain(request.dataRoot)
      expect(sandboxInvocation.filesystem.deniedWriteRoots).not.toContain(request.runtimeRoot)
      expect(beginExecution).toHaveBeenCalledTimes(2)
      expect(endExecution).toHaveBeenCalledTimes(2)
      expect(annotateStderr).toHaveBeenCalled()
    } finally {
      await executor.shutdown()
    }
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('inspects only an already-live kernel and forwards the private-variable option', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-namespace-')
    const executor = makeExecutor()
    try {
      await expect(
        executor.inspectNamespace({
          language: 'python',
          environment: DEFAULT_PY_ENV
        })
      ).resolves.toEqual({ status: 'unavailable' })
      expect(procFor(executor, 'python')).toBeUndefined()

      await executor.execute({ ...baseRequest(cwdDir), code: 'activate' })
      await expect(
        executor.inspectNamespace({
          language: 'python',
          environment: DEFAULT_PY_ENV,
          includePrivate: true
        })
      ).resolves.toEqual({
        status: 'available',
        variableCount: 2,
        variablesTruncated: false,
        variables: [
          { name: 'answer', type: 'int', sizeBytes: 28, preview: '42' },
          { name: '_private', type: 'str', preview: "'hidden'", private: true }
        ]
      })
    } finally {
      await executor.shutdown()
    }
  })

  it('drops a kernel when namespace inspection exceeds its hard timeout', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-namespace-timeout-')
    const hangingFixture = join(cwdDir, 'fake_loop_namespace_hang.py')
    const fixtureSource = await readFile(FIXTURE, 'utf8')
    const hangingFixtureSource = fixtureSource.replace(
      'if os.environ.get("OPEN_SCIENCE_FAKE_NAMESPACE_HANG") == "1":',
      'if True:'
    )
    expect(hangingFixtureSource).not.toBe(fixtureSource)
    await writeFile(hangingFixture, hangingFixtureSource)
    const onTerminated = vi.fn()
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: hangingFixture,
      platform: 'linux',
      namespaceInspectionTimeoutMs: 25,
      onTerminated
    })
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'activate' })

      await expect(
        executor.inspectNamespace({ language: 'python', environment: DEFAULT_PY_ENV })
      ).rejects.toThrow('namespace inspection timed out after 25ms')
      expect(procFor(executor, 'python')).toBeUndefined()
      expect(onTerminated).toHaveBeenCalledWith('python', DEFAULT_PY_ENV)
    } finally {
      await executor.shutdown()
    }
  })

  it('runs a cell, echoes stdout, and reports the working directory', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-exec-')
    const executor = makeExecutor()
    try {
      const result = await executor.execute({ ...baseRequest(cwdDir), code: 'hello' })
      expect(result.status).toBe('completed')
      expect(result.kernelDispatched).toBe(true)
      expect(result.stdout).toBe('hello')
      // The loop reports its resolved cwd (macOS maps /var -> /private/var).
      expect(result.cwdAfter).toBe(realpathSync(cwdDir))
      expect(result.outputs).toContainEqual({ type: 'stream', name: 'stdout', text: 'hello' })
    } finally {
      await executor.shutdown()
    }
  })

  it('reports the exit code and stderr when a kernel exits before replying', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-startup-exit-'))
    const crashingLoop = join(cwdDir, 'crashing_loop.py')
    await writeFile(
      crashingLoop,
      [
        'import sys',
        'sys.stderr.write("PowerShell FileSystem provider initialization failed.\\n")',
        'sys.stderr.flush()',
        'raise SystemExit(23)'
      ].join('\n')
    )
    const executor = new NotebookKernelExecutor({ pythonLoopPath: crashingLoop })

    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: 'import numpy',
        resolvedInterpreter: { command: python3 as string }
      })

      expect(result).toMatchObject({ status: 'failed' })
      expect(result.stderr).toContain('Notebook kernel process exited with exit code 23.')
      expect(result.stderr).toContain('PowerShell FileSystem provider initialization failed.')
    } finally {
      await executor.shutdown()
    }
  })

  it('annotates crash stderr before releasing its sandbox context', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-startup-sandbox-exit-'))
    const crashingLoop = join(cwdDir, 'crashing_sandbox_loop.py')
    await writeFile(
      crashingLoop,
      [
        'import sys',
        'sys.stderr.write("Permission denied: C:/hidden/credentials.txt\\n")',
        'sys.stderr.flush()',
        'raise SystemExit(25)'
      ].join('\n')
    )
    let cleaned = false
    const cleanup = vi.fn(() => {
      cleaned = true
    })
    const annotateStderr = vi.fn((stderr: string) =>
      cleaned ? stderr : `${stderr}<sandbox_violations>hidden path</sandbox_violations>`
    )
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        beginExecution: () => () => undefined,
        annotateStderr,
        cleanup
      }))
    }
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: crashingLoop,
      processSandbox
    })

    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: 'kernel exits in sandbox',
        sessionId: 'session-1',
        projectId: 'project-1',
        resolvedInterpreter: { command: python3 as string }
      })

      expect(result).toMatchObject({ status: 'failed' })
      expect(result.stderr).toContain('<sandbox_violations>hidden path</sandbox_violations>')
      expect(annotateStderr).toHaveBeenCalled()
    } finally {
      await executor.shutdown()
    }
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('settles when a dead kernel descendant keeps its stdio pipes open', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-descendant-stdio-'))
    const releaseFile = join(cwdDir, 'release-descendant')
    const finishedFile = join(cwdDir, 'descendant-finished')
    const descendantCode = [
      'import os, time',
      `release_file = ${JSON.stringify(releaseFile)}`,
      `finished_file = ${JSON.stringify(finishedFile)}`,
      'while not os.path.exists(release_file): time.sleep(0.01)',
      `os.chdir(${JSON.stringify(tmpdir())})`,
      'with open(finished_file, "w", encoding="utf-8") as marker: marker.write("done")'
    ].join('\n')
    const crashingLoop = join(cwdDir, 'crashing_loop_with_descendant.py')
    await writeFile(
      crashingLoop,
      [
        'import subprocess, sys',
        `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(descendantCode)}], stdout=sys.stdout, stderr=sys.stderr, close_fds=False)`,
        'raise SystemExit(24)'
      ].join('\n')
    )
    const executor = new NotebookKernelExecutor({ pythonLoopPath: crashingLoop })
    const execution = executor.execute({
      ...baseRequest(cwdDir),
      code: 'kernel exits',
      resolvedInterpreter: { command: python3 as string }
    })

    try {
      const settledBeforeDescendant = await Promise.race([
        execution.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500))
      ])

      expect(settledBeforeDescendant).toBe(true)
      await expect(execution).resolves.toMatchObject({ status: 'failed' })
    } finally {
      await writeFile(releaseFile, 'release')
      await execution
      await executor.shutdown()
      for (let attempt = 0; attempt < 200 && !existsSync(finishedFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  })

  it('drops a kernel whose stdout exceeds the bounded protocol line', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-protocol-line-limit-')
    const terminated: string[] = []
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: FIXTURE,
      platform: 'linux',
      onTerminated: (kind) => terminated.push(kind)
    })
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: `__OVERSIZED_LINE__:${NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES + 1}`
      })

      expect(result.status).toBe('failed')
      expect(result.stderr).toContain(
        `exceeded the ${NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES}-byte transport limit`
      )
      expect(terminated).toEqual(['python'])
      expect(procFor(executor, 'python')).toBeUndefined()

      await expect(
        executor.execute({ ...baseRequest(cwdDir), code: 'after-oversized-line' })
      ).resolves.toMatchObject({ status: 'completed', stdout: 'after-oversized-line' })
    } finally {
      await executor.shutdown()
    }
  })

  it('settles execution when protocol overflow drops the kernel before request dispatch', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-pre-dispatch-protocol-overflow-')
    const executor = makeExecutor()
    const internals = executor as unknown as ExecutorInternals
    const ensureProc = internals.ensureProc.bind(executor)
    let injectOverflow = true
    internals.ensureProc = async (...args) => {
      const proc = await ensureProc(...args)
      if (!injectOverflow) return proc

      injectOverflow = false
      proc.child.stdin.write(
        framePythonRequest(
          'pre-dispatch-overflow',
          `__OVERSIZED_LINE__:${NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES + 1}`
        )
      )
      await vi.waitFor(() => expect(procFor(executor, 'python')).toBeUndefined())
      return proc
    }

    try {
      await expect(
        executor.execute({ ...baseRequest(cwdDir), code: 'must-not-dispatch' })
      ).resolves.toMatchObject({
        status: 'failed',
        kernelDispatched: false,
        stderr: expect.stringContaining(
          `exceeded the ${NOTEBOOK_PROTOCOL_LINE_LIMIT_BYTES}-byte transport limit`
        )
      })
      await expect(
        executor.execute({ ...baseRequest(cwdDir), code: 'after-pre-dispatch-overflow' })
      ).resolves.toMatchObject({ status: 'completed', stdout: 'after-pre-dispatch-overflow' })
    } finally {
      await executor.shutdown()
    }
  })

  it('records cancellation before kernel dispatch', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-pre-dispatch-cancel-')
    const executor = makeExecutor()
    const cancellation = new AbortController()
    cancellation.abort()
    try {
      await expect(
        executor.execute({
          ...baseRequest(cwdDir),
          code: 'never-runs',
          signal: cancellation.signal
        })
      ).resolves.toMatchObject({ status: 'cancelled', kernelDispatched: false })
    } finally {
      await executor.shutdown()
    }
  })

  it('does not record dispatch when writing the kernel request throws', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-write-failure-')
    const executor = makeExecutor()
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams
      vi.spyOn(child.stdin, 'write').mockImplementationOnce(() => {
        throw new Error('kernel pipe is closed')
      })

      await expect(
        executor.execute({ ...baseRequest(cwdDir), code: 'never-runs' })
      ).resolves.toMatchObject({ status: 'failed', kernelDispatched: false })
      await expect(
        executor.execute({ ...baseRequest(cwdDir), code: 'after-failure' })
      ).resolves.toMatchObject({ status: 'completed', kernelDispatched: true })
    } finally {
      await executor.shutdown()
    }
  })

  it('records files created by a data-kernel cell as trusted working files', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-working-file-')
    const dataRoot = join(cwdDir, 'nb', 'data')
    await mkdir(dataRoot, { recursive: true })
    const executor = makeExecutor()
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        cwd: dataRoot,
        code: '__WRITE_FILE__'
      })

      expect(result.status).toBe('completed')
      expect(result.workingFiles).toEqual([
        expect.objectContaining({
          path: resolve(dataRoot, 'generated.csv'),
          relativePath: 'data/generated.csv',
          kind: 'other',
          size: 8
        })
      ])
    } finally {
      await executor.shutdown()
    }
  })

  it('records files created by a data-kernel cell in the shared handoff directory', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-handoff-working-file-')
    const sessionRoot = join(cwdDir, 'nb')
    const dataRoot = join(sessionRoot, 'data')
    const handoffRoot = join(sessionRoot, 'handoff')
    await Promise.all([
      mkdir(dataRoot, { recursive: true }),
      mkdir(handoffRoot, { recursive: true })
    ])
    const executor = makeExecutor()
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        cwd: dataRoot,
        code: '__WRITE_HANDOFF_FILE__'
      })

      expect(result.status).toBe('completed')
      expect(result.workingFiles).toEqual([
        expect.objectContaining({
          path: resolve(handoffRoot, 'generated.csv'),
          relativePath: 'handoff/generated.csv',
          kind: 'other',
          size: 8
        })
      ])
    } finally {
      await executor.shutdown()
    }
  })

  it('records overwritten outputs without claiming unchanged data files', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-overwritten-file-')
    const dataRoot = join(cwdDir, 'nb', 'data')
    await mkdir(dataRoot, { recursive: true })
    await Promise.all([
      writeFile(join(dataRoot, 'generated.csv'), 'x,y\n1,2\n'),
      writeFile(join(dataRoot, 'input.csv'), 'sample,value\na,1\n')
    ])
    const executor = makeExecutor()
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        cwd: dataRoot,
        code: '__OVERWRITE_FILE__'
      })

      expect(result.workingFiles).toEqual([
        expect.objectContaining({
          path: resolve(dataRoot, 'generated.csv'),
          relativePath: 'data/generated.csv',
          size: 8
        })
      ])
    } finally {
      await executor.shutdown()
    }
  })

  it('fails closed instead of cross-attributing files from overlapping kernels', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-overlapping-files-')
    await stubEnvPython(join(cwdDir, 'runtime'), 'analysis')
    const dataRoot = join(cwdDir, 'nb', 'data')
    await mkdir(dataRoot, { recursive: true })
    const executor = makeExecutor()
    try {
      const [first, second] = await Promise.all([
        executor.execute({
          ...baseRequest(cwdDir),
          cwd: dataRoot,
          code: '__WRITE_DELAYED_A__'
        }),
        executor.execute({
          ...baseRequest(cwdDir),
          cwd: dataRoot,
          environment: 'analysis',
          code: '__WRITE_DELAYED_B__'
        })
      ])

      expect(first.status).toBe('completed')
      expect(second.status).toBe('completed')
      expect(first.workingFiles).toEqual([])
      expect(second.workingFiles).toEqual([])
    } finally {
      await executor.shutdown()
    }
  })

  it('runs a registry-resolved interpreter with NO managed env on disk (BYO seam)', async () => {
    // No stubEnvPython here: the managed default-python bin does not exist. A resolvedInterpreter
    // (as the Runtime Registry supplies for an external/overlay interpreter) must bypass the managed
    // readiness gate and spawn that interpreter directly — proving the executor is no longer hard-
    // bound to the app conda prefix.
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-resolved-'))
    const executor = makeExecutor()
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: 'hello',
        resolvedInterpreter: { command: python3 as string }
      })
      expect(result.status).toBe('completed')
      expect(result.stdout).toBe('hello')
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

  it('replaces the kernel when the runtime changes (managed -> external), never reusing the old process', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-switch-')
    const executor = makeExecutor()
    try {
      // 1) Managed default run (no resolvedInterpreter): proc keyed python:default-python.
      await executor.execute({ ...baseRequest(cwdDir), code: 'a' })
      const managed = procFor(executor, 'python')?.child
      expect(managed).toBeDefined()

      // 2) Switch the default env to an external (BYO) interpreter. The interpreter identity differs, so
      // ensureProc must DROP the managed kernel and spawn a fresh one under the SAME (kind, env) key —
      // never reuse the managed process (which would run the cell with the previous interpreter + stale
      // in-memory state). Exactly one proc per (kind, env) so the (kind, env)-keyed status stays correct.
      await executor.execute({
        ...baseRequest(cwdDir),
        code: 'b',
        resolvedInterpreter: { command: python3 as string }
      })
      const procs = (executor as unknown as ExecutorInternals).procs
      expect(procs.size).toBe(1) // old proc dropped, not left alongside
      const current = procFor(executor, 'python')?.child
      expect(current).toBeDefined()
      expect(current).not.toBe(managed) // a fresh process, not the reused managed kernel
    } finally {
      await executor.shutdown()
    }
  })

  it('replaces a resolved kernel when only its conda activation prefix changes', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-r-prefix-switch-'))
    const executor = makeExecutor()
    const request = {
      ...baseRequest(cwdDir),
      resolvedInterpreter: {
        command: python3 as string,
        condaPrefix: 'C:\\conda\\envs\\analysis-a'
      }
    }
    try {
      await executor.execute({ ...request, code: 'a' })
      const first = procFor(executor, 'python')?.child
      expect(first).toBeDefined()

      await executor.execute({
        ...request,
        code: 'b',
        resolvedInterpreter: {
          ...request.resolvedInterpreter,
          condaPrefix: 'C:\\conda\\envs\\analysis-b'
        }
      })

      const procs = (executor as unknown as ExecutorInternals).procs
      expect(procs.size).toBe(1)
      expect(procFor(executor, 'python')?.child).not.toBe(first)
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

  it('cancels a long run with SIGINT and preserves the kernel process', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-cancel-')
    const executor = makeExecutor()
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams
      const killSpy = vi.spyOn(child, 'kill')
      const cancellation = new AbortController()

      const run = executor.execute({
        ...baseRequest(cwdDir),
        code: '__SLEEP__',
        signal: cancellation.signal
      })
      await vi.waitFor(() => expect(procFor(executor, 'python')?.pending).toBeDefined())
      cancellation.abort()

      await expect(run).resolves.toMatchObject({ status: 'cancelled' })
      expect(killSpy).toHaveBeenCalledWith('SIGINT')
      expect(killSpy).not.toHaveBeenCalledWith('SIGKILL')

      const next = await executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(next.status).toBe('completed')
      expect(procFor(executor, 'python')?.child).toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('consumes a late R interrupt before two queued cells and preserves the namespace', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-r-cancel-ack-'))
    const executor = new NotebookKernelExecutor({
      rLoopPath: FIXTURE,
      platform: 'linux'
    })
    const request = {
      ...baseRequest(cwdDir),
      language: 'r' as const,
      resolvedInterpreter: { command: python3 as string }
    }
    try {
      await expect(
        executor.execute({ ...request, code: '__SET_NAMESPACE__' })
      ).resolves.toMatchObject({ status: 'completed' })
      await expect(
        executor.execute({ ...request, code: '__MASK_SYS_SLEEP__' })
      ).resolves.toMatchObject({ status: 'completed' })
      const child = procFor(executor, 'r')?.child as ChildProcessWithoutNullStreams
      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => true)
      const cancellation = new AbortController()
      const cancelled = executor.execute({
        ...request,
        code: '__CANCEL_RESPONSE_BEFORE_ACK__',
        signal: cancellation.signal
      })
      await vi.waitFor(() => expect(procFor(executor, 'r')?.pending).toBeDefined())

      cancellation.abort()

      await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' })
      expect(killSpy).toHaveBeenCalledWith('SIGINT')

      const first = await executor.execute({ ...request, code: '__CHECK_NAMESPACE__' })
      const second = await executor.execute({ ...request, code: '__CHECK_NAMESPACE__' })
      expect([first.status, second.status]).toEqual(['completed', 'completed'])
      expect(procFor(executor, 'r')?.child).toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('accepts a successful R interrupt probe after user code catches the interrupt', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-r-caught-interrupt-'))
    const executor = new NotebookKernelExecutor({
      rLoopPath: FIXTURE,
      platform: 'linux'
    })
    const request = {
      ...baseRequest(cwdDir),
      language: 'r' as const,
      resolvedInterpreter: { command: python3 as string }
    }
    try {
      await expect(
        executor.execute({ ...request, code: '__SET_NAMESPACE__' })
      ).resolves.toMatchObject({ status: 'completed' })
      const child = procFor(executor, 'r')?.child as ChildProcessWithoutNullStreams
      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => true)
      const cancellation = new AbortController()
      const cancelled = executor.execute({
        ...request,
        code: '__CANCEL_CAUGHT_INTERRUPT__',
        signal: cancellation.signal
      })
      await vi.waitFor(() => expect(procFor(executor, 'r')?.pending).toBeDefined())

      cancellation.abort()

      await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' })
      expect(killSpy).toHaveBeenCalledWith('SIGINT')
      await expect(
        executor.execute({ ...request, code: '__CHECK_NAMESPACE__' })
      ).resolves.toMatchObject({ status: 'completed' })
      expect(procFor(executor, 'r')?.child).toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('consumes a late R timeout interrupt before reusing the preserved namespace', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-r-timeout-ack-'))
    const executor = new NotebookKernelExecutor({
      rLoopPath: FIXTURE,
      platform: 'linux'
    })
    const request = {
      ...baseRequest(cwdDir),
      language: 'r' as const,
      resolvedInterpreter: { command: python3 as string }
    }
    try {
      await expect(
        executor.execute({ ...request, code: '__SET_NAMESPACE__' })
      ).resolves.toMatchObject({ status: 'completed' })
      const child = procFor(executor, 'r')?.child as ChildProcessWithoutNullStreams
      const killSpy = vi.spyOn(child, 'kill').mockImplementation(() => true)

      await expect(
        executor.execute({
          ...request,
          code: '__CANCEL_RESPONSE_BEFORE_ACK__',
          timeoutMs: 20
        })
      ).resolves.toMatchObject({ status: 'timeout' })
      expect(killSpy).toHaveBeenCalledWith('SIGINT')

      const first = await executor.execute({ ...request, code: '__CHECK_NAMESPACE__' })
      const second = await executor.execute({ ...request, code: '__CHECK_NAMESPACE__' })
      expect([first.status, second.status]).toEqual(['completed', 'completed'])
      expect(procFor(executor, 'r')?.child).toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('drops and respawns the kernel when Windows cancellation cannot preserve it', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-windows-cancel-', 'win32')
    const terminated: Array<['python' | 'r' | 'repl', string]> = []
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: FIXTURE,
      platform: 'win32',
      onTerminated: (kind, env) => terminated.push([kind, env])
    })
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child
      const cancellation = new AbortController()
      const run = executor.execute({
        ...baseRequest(cwdDir),
        code: '__SLEEP__',
        signal: cancellation.signal
      })
      await vi.waitFor(() => expect(procFor(executor, 'python')?.pending).toBeDefined())

      cancellation.abort()

      await expect(run).resolves.toMatchObject({ status: 'cancelled', traceback: '' })
      expect(procFor(executor, 'python')).toBeUndefined()
      expect(terminated).toEqual([['python', DEFAULT_PY_ENV]])

      const next = await executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(next.status).toBe('completed')
      expect(procFor(executor, 'python')?.child).not.toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('drops a POSIX kernel that does not acknowledge cancellation within the grace period', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-posix-cancel-grace-')
    const terminated: Array<['python' | 'r' | 'repl', string]> = []
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: FIXTURE,
      platform: 'linux',
      cancellationGraceMs: 50,
      onTerminated: (kind, env) => terminated.push([kind, env])
    })
    try {
      await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      const child = procFor(executor, 'python')?.child
      const cancellation = new AbortController()
      const run = executor.execute({
        ...baseRequest(cwdDir),
        code: '__IGNORE_SIGINT__',
        signal: cancellation.signal
      })
      await vi.waitFor(() => expect(procFor(executor, 'python')?.pending).toBeDefined())

      cancellation.abort()

      await expect(run).resolves.toMatchObject({ status: 'cancelled', traceback: '' })
      expect(procFor(executor, 'python')).toBeUndefined()
      expect(terminated).toEqual([['python', DEFAULT_PY_ENV]])

      const next = await executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(next.status).toBe('completed')
      expect(procFor(executor, 'python')?.child).not.toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('does not arm an execution timeout when a data-kernel request omits timeoutMs', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-unbounded-')
    const executor = makeExecutor()
    try {
      const resultPromise = executor.execute({ ...baseRequest(cwdDir), code: '__SLEEP__' })
      await vi.waitFor(() => expect(procFor(executor, 'python')?.pending).toBeDefined())

      expect(procFor(executor, 'python')?.pending?.timeout).toBeUndefined()
      await executor.shutdown()
      await expect(resultPromise).resolves.toMatchObject({ status: 'failed' })
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
      // Soft interrupt is a direct SIGINT to the loop; the hard kill is routed through
      // terminateProcessTree (which enumerates descendants before killing), so it no longer shows up
      // as a direct child.kill('SIGKILL'). What matters is the wedged loop is gone and actually dead.
      expect(killSpy).toHaveBeenCalledWith('SIGINT')
      expect(procFor(executor, 'python')).toBeUndefined() // dropped from the map
      // terminateProcessTree escalates SIGTERM -> SIGKILL over its grace windows, so allow a few seconds.
      await vi.waitFor(
        () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
        { timeout: 8000, interval: 100 }
      )

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
      platform: 'linux',
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
      platform: 'linux',
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

posixGate('NotebookKernelExecutor (real Python loop mutation policy)', () => {
  it('injects a registered helper on a private frame before the unchanged producer frame', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'registered-test-helper'
          ? {
              id,
              language: 'python',
              source: [
                'import math as private_math',
                'PRIVATE_CONSTANT = 40',
                'def private_helper(value):',
                '    return private_math.floor(value)',
                'def public_add(value):',
                '    return PRIVATE_CONSTANT + private_helper(value)'
              ].join('\n'),
              exports: ['public_add']
            }
          : undefined
    })
    const helperModules = (
      await helperHost.plan(
        { id: 'test-epoch', processKey: 'python:default-python' },
        await helperHost.preflight('python', ['registered-test-helper'])
      )
    ).injections

    try {
      await executor.execute({ ...request, code: 'warmup_value = 1', language: 'python' })
      const child = procFor(executor, 'python')?.child as ChildProcessWithoutNullStreams
      const originalWrite = child.stdin.write.bind(child.stdin)
      const frames: string[] = []
      child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        frames.push(String(chunk))
        return originalWrite(chunk, ...(args as []))
      }) as typeof child.stdin.write

      const producerCode = [
        'producer_state = public_add(2.9)',
        'print(producer_state)',
        "private_names = ['private_math', 'PRIVATE_CONSTANT', 'private_helper', '__os_private', '__os_names', '__os_missing', '__os_target', '__os_target_globals', '__os_collisions', '__os_staged']",
        'print(all(name not in globals() for name in private_names))'
      ].join('\n')
      const result = await executor.execute({
        ...request,
        code: producerCode,
        language: 'python',
        helperModules
      })
      const persisted = await executor.execute({
        ...request,
        code: 'print(producer_state)',
        language: 'python'
      })

      expect(result).toMatchObject({ status: 'completed', stdout: '42\nTrue\n' })
      expect(persisted).toMatchObject({ status: 'completed', stdout: '42\n' })
      expect(frames).toHaveLength(3)
      expect(JSON.parse(frames[0] ?? '{}')).not.toMatchObject({ code: producerCode })
      expect(JSON.parse(frames[1] ?? '{}')).toMatchObject({ code: producerCode })
    } finally {
      await executor.shutdown()
    }
  })

  it('protects the registered generation parent while injected exports remain usable', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-protected-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const generationRoot = join(cwdDir, 'registered', 'generation-1')
    const sourcePath = join(generationRoot, 'kernel.py')
    const source = 'def protected_answer():\n    return 42'
    await mkdir(generationRoot, { recursive: true })
    await writeFile(sourcePath, source)
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) => ({
        id,
        language: 'python',
        source,
        exports: ['protected_answer'],
        registeredGeneration: 'generation-1',
        generationRoot
      })
    })
    const ownership = { id: 'protected-epoch', processKey: 'python:default-python' }
    const plan = await helperHost.plan(
      ownership,
      await helperHost.preflight('python', ['protected-helper'])
    )
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })

    try {
      await executor.execute({
        ...request,
        language: 'python',
        code: 'kernel_warmed_before_helper = True'
      })
      const blocked = await executor.execute({
        ...request,
        language: 'python',
        helperModules: plan.injections,
        protectedDirs: [...plan.protectedGenerationRoots],
        code: `open(${JSON.stringify(sourcePath)}).read()`
      })
      helperHost.commitInitialized(ownership, blocked.helperModulesInitialized ?? [])
      const helperFreePlan = await helperHost.plan(
        ownership,
        await helperHost.preflight('python', undefined, ownership)
      )
      const attack = await executor.execute({
        ...request,
        language: 'python',
        protectedDirs: [...helperFreePlan.protectedGenerationRoots],
        code: [
          'import __main__',
          'normal_persistent_global = 41',
          'policy_factory_visible = "_install_protected_paths_policy" in globals()',
          'policy_updater_visible = hasattr(__main__, "_extend_protected_dirs")',
          'try:',
          '    _protected_dirs.clear()',
          'except Exception:',
          '    pass',
          'globals()["_protected_dirs"] = []',
          'globals()["_extend_protected_dirs"] = lambda entries: None',
          'setattr(__main__, "_protected_dirs", [])',
          'setattr(__main__, "_extend_protected_dirs", lambda entries: None)',
          'for candidate_name in ("_protected_paths_audit", "_install_protected_paths_policy", "_extend_protected_dirs"):',
          '    candidate = globals().get(candidate_name, getattr(__main__, candidate_name, None))',
          '    for reflected in (getattr(candidate, "__defaults__", None) or ()):',
          '        if hasattr(reflected, "clear"):',
          '            reflected.clear()',
          '    for cell in (getattr(candidate, "__closure__", None) or ()):',
          '        reflected = cell.cell_contents',
          '        if hasattr(reflected, "clear"):',
          '            reflected.clear()',
          'print(policy_factory_visible, policy_updater_visible)'
        ].join('\n')
      })
      const attempts = [
        `open(${JSON.stringify(sourcePath)}).read()`,
        [
          'import importlib.util',
          `spec = importlib.util.spec_from_file_location("protected_kernel", ${JSON.stringify(sourcePath)})`,
          'module = importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(module)'
        ].join('\n'),
        `import shutil; shutil.copyfile(${JSON.stringify(sourcePath)}, ${JSON.stringify(join(cwdDir, 'copied.py'))})`
      ]
      const blockedFollowups: NotebookExecutionResult[] = []
      for (const code of attempts) {
        blockedFollowups.push(
          await executor.execute({
            ...request,
            language: 'python',
            protectedDirs: [...helperFreePlan.protectedGenerationRoots],
            code
          })
        )
      }
      const usable = await executor.execute({
        ...request,
        language: 'python',
        protectedDirs: [...helperFreePlan.protectedGenerationRoots],
        code: 'print(protected_answer())'
      })

      expect(blocked).toMatchObject({
        status: 'failed',
        helperModulesInitialized: ['protected-helper']
      })
      expect(blocked.traceback).toContain('Access to protected application files is not allowed')
      expect(blocked.traceback).not.toContain(source)
      expect(helperFreePlan.protectedGenerationRoots).toEqual([generationRoot])
      expect(attack).toMatchObject({ status: 'completed', stdout: 'False False\n' })
      expect(blockedFollowups).toHaveLength(3)
      for (const followup of blockedFollowups) {
        expect(followup.status).toBe('failed')
        expect(followup.traceback).toContain('Access to protected application files is not allowed')
        expect(followup.traceback).not.toContain(source)
      }
      expect(usable).toMatchObject({ status: 'completed', stdout: '42\n' })
      const persistent = await executor.execute({
        ...request,
        language: 'python',
        protectedDirs: [...helperFreePlan.protectedGenerationRoots],
        code: 'print(normal_persistent_global + 1)'
      })
      expect(persistent).toMatchObject({ status: 'completed', stdout: '42\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('fails helper initialization atomically without dispatching the producer sentinel', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-failure-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) => ({
        id,
        language: 'python',
        source: 'def staged_export():\n    return 42',
        exports: ['staged_export', 'missing_export']
      })
    })
    const helperModules = (
      await helperHost.plan(
        { id: 'test-epoch', processKey: 'python:default-python' },
        await helperHost.preflight('python', ['registered-test-helper'])
      )
    ).injections
    const sentinel = join(cwdDir, 'producer-sentinel.txt')

    try {
      const result = await executor.execute({
        ...request,
        language: 'python',
        helperModules,
        code: `open(${JSON.stringify(sentinel)}, "w").write("ran")`
      })
      const healthy = await executor.execute({
        ...request,
        language: 'python',
        code: `print("staged_export" in globals(), "missing_export" in globals())`
      })

      expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
      expect(result.traceback).toMatch(/HELPER_MISSING_EXPORT.*registered-test-helper/s)
      expect(result.traceback).not.toContain('missing_export')
      expect(existsSync(sentinel)).toBe(false)
      expect(healthy).toMatchObject({ status: 'completed', stdout: 'False False\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('preserves a sanitized missing dependency diagnostic without dispatching producer code', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-missing-dependency-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) => ({
        id,
        language: 'python',
        source: [
          'import open_science_definitely_missing_dependency',
          'def dependency_export():',
          '    return 42'
        ].join('\n'),
        exports: ['dependency_export']
      })
    })
    const plan = await helperHost.plan(
      { id: 'missing-dependency-epoch', processKey: 'python:default-python' },
      await helperHost.preflight('python', ['dependency-helper'])
    )
    const sentinel = join(cwdDir, 'missing-dependency-producer-sentinel.txt')

    try {
      const result = await executor.execute({
        ...request,
        language: 'python',
        helperModules: plan.injections,
        code: `open(${JSON.stringify(sentinel)}, "w").write("ran")`
      })
      const globals = await executor.execute({
        ...request,
        language: 'python',
        code: 'print("dependency_export" in globals())'
      })

      expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
      expect(result.traceback).toContain(
        'Python ModuleNotFoundError: No module named "open_science_definitely_missing_dependency".'
      )
      expect(result.traceback).toContain('inspect_packages')
      expect(result.traceback).toContain('manage_packages')
      expect(result.traceback).not.toContain('def dependency_export')
      expect(result.helperModulesInitialized).toBeUndefined()
      expect(existsSync(sentinel)).toBe(false)
      expect(globals).toMatchObject({ status: 'completed', stdout: 'False\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('fails closed when an initialization exception carries an unsafe module name and secrets', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-sanitized-error-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })
    const secret = 'helper-secret-token-123'
    const protectedPath = '/private/registered/generation/kernel.py'
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) => ({
        id,
        language: 'python',
        source: `raise ModuleNotFoundError(${JSON.stringify(`${secret} at ${protectedPath}`)}, name=${JSON.stringify(protectedPath)})\ndef never_published():\n    return 1`,
        exports: ['never_published']
      })
    })
    const plan = await helperHost.plan(
      { id: 'sanitized-error-epoch', processKey: 'python:default-python' },
      await helperHost.preflight('python', ['sanitized-helper'])
    )

    try {
      const result = await executor.execute({
        ...request,
        language: 'python',
        helperModules: plan.injections,
        code: 'never_published()'
      })
      const globals = await executor.execute({
        ...request,
        language: 'python',
        code: 'print("never_published" in globals())'
      })

      expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
      expect(result.traceback).toMatch(/HELPER_INITIALIZATION_FAILED.*sanitized-helper/)
      expect(result.traceback).toContain('Python ModuleNotFoundError.')
      expect(result.traceback).not.toContain('No module named')
      expect(result.traceback).not.toContain(secret)
      expect(result.traceback).not.toContain(protectedPath)
      expect(result.traceback).not.toContain('never_published')
      expect(result.helperModulesInitialized).toBeUndefined()
      expect(globals).toMatchObject({ status: 'completed', stdout: 'False\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('rolls back every staged export when a later helper is missing an export', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-plan-failure-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'first-helper'
          ? {
              id,
              language: 'python',
              source: 'def first_export():\n    return 1',
              exports: ['first_export']
            }
          : id === 'later-helper'
            ? {
                id,
                language: 'python',
                source: 'def sibling_export():\n    return 2',
                exports: ['sibling_export', 'missing_export']
              }
            : undefined
    })
    const plan = await helperHost.plan(
      { id: 'plan-failure-epoch', processKey: 'python:default-python' },
      await helperHost.preflight('python', ['first-helper', 'later-helper'])
    )
    const sentinel = join(cwdDir, 'plan-failure-producer-sentinel.txt')

    try {
      const result = await executor.execute({
        ...request,
        language: 'python',
        helperModules: plan.injections,
        code: `open(${JSON.stringify(sentinel)}, "w").write("ran")`
      })
      const globals = await executor.execute({
        ...request,
        language: 'python',
        code: `print([name for name in ["first_export", "sibling_export", "missing_export"] if name in globals()])`
      })

      expect(result).toMatchObject({
        status: 'failed',
        kernelDispatched: false
      })
      expect(result.traceback).toMatch(/HELPER_MISSING_EXPORT.*later-helper/)
      expect(result.helperModulesInitialized).toBeUndefined()
      expect(existsSync(sentinel)).toBe(false)
      expect(globals).toMatchObject({ status: 'completed', stdout: '[]\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('validates a later helper collision before executing any helper or producer code', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-plan-collision-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })
    const helperSentinel = join(cwdDir, 'plan-collision-helper-sentinel.txt')
    const producerSentinel = join(cwdDir, 'plan-collision-producer-sentinel.txt')
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'first-helper'
          ? {
              id,
              language: 'python',
              source: [
                `open(${JSON.stringify(helperSentinel)}, "w").write("ran")`,
                'def first_export():',
                '    return 1'
              ].join('\n'),
              exports: ['first_export']
            }
          : id === 'later-helper'
            ? {
                id,
                language: 'python',
                source: 'def occupied_export():\n    return 2',
                exports: ['occupied_export']
              }
            : undefined
    })
    const plan = await helperHost.plan(
      { id: 'plan-collision-epoch', processKey: 'python:default-python' },
      await helperHost.preflight('python', ['first-helper', 'later-helper'])
    )

    try {
      await executor.execute({ ...request, language: 'python', code: 'occupied_export = 7' })
      const result = await executor.execute({
        ...request,
        language: 'python',
        helperModules: plan.injections,
        code: `open(${JSON.stringify(producerSentinel)}, "w").write("ran")`
      })
      const globals = await executor.execute({
        ...request,
        language: 'python',
        code: 'print(occupied_export, "first_export" in globals())'
      })

      expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
      expect(result.traceback).toMatch(/HELPER_EXPORT_COLLISION.*later-helper/)
      expect(result.helperModulesInitialized).toBeUndefined()
      expect(existsSync(helperSentinel)).toBe(false)
      expect(existsSync(producerSentinel)).toBe(false)
      expect(globals).toMatchObject({ status: 'completed', stdout: '7 False\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('rejects an initial global collision without publishing sibling exports or producer code', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-helper-collision-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })
    const helperHost = new NotebookHelperModuleHost({
      resolve: async (id) => ({
        id,
        language: 'python',
        source: [
          'def sibling_export():',
          '    return 42',
          'def collision_export():',
          '    return 99'
        ].join('\n'),
        exports: ['sibling_export', 'collision_export']
      })
    })
    const plan = await helperHost.plan(
      { id: 'collision-epoch', processKey: 'python:default-python' },
      await helperHost.preflight('python', ['collision-helper'])
    )
    const sentinel = join(cwdDir, 'collision-producer-sentinel.txt')

    try {
      await executor.execute({ ...request, language: 'python', code: 'collision_export = 7' })
      const result = await executor.execute({
        ...request,
        language: 'python',
        helperModules: plan.injections,
        code: `open(${JSON.stringify(sentinel)}, "w").write("ran")`
      })
      const healthy = await executor.execute({
        ...request,
        language: 'python',
        code: 'print(collision_export, "sibling_export" in globals())'
      })

      expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
      expect(result.traceback).toMatch(/HELPER_EXPORT_COLLISION.*collision-helper/)
      expect(existsSync(sentinel)).toBe(false)
      expect(healthy).toMatchObject({ status: 'completed', stdout: '7 False\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('bounds producer output before it crosses the loop protocol', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-output-limit-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code: `print("x" * ${NOTEBOOK_TEXT_LIMIT_BYTES + 1024})`,
        language: 'python'
      })
      expect(result.status).toBe('completed')
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(
        NOTEBOOK_TEXT_LIMIT_BYTES
      )
      expect(result.truncated).toBe(true)
    } finally {
      await executor.shutdown()
    }
  })

  it('retains an exception diagnostic after stdout fills the normal output budget', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-diagnostic-reserve-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code: `print("x" * ${NOTEBOOK_TEXT_LIMIT_BYTES + 1024})\nraise RuntimeError("diagnostic survives")`,
        language: 'python'
      })
      expect(result.status).toBe('failed')
      expect(result.traceback).toContain('RuntimeError: diagnostic survives')
      expect(
        Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.traceback, 'utf8')
      ).toBeLessThanOrEqual(NOTEBOOK_TEXT_LIMIT_BYTES)
      expect(result.truncated).toBe(true)
    } finally {
      await executor.shutdown()
    }
  })

  it('cancels a run without clearing the persistent Python namespace', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-cancel-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })

    try {
      await expect(
        executor.execute({ ...request, code: 'preserved_after_cancel = 41', language: 'python' })
      ).resolves.toMatchObject({ status: 'completed' })
      const child = procFor(executor, 'python')?.child
      const cancellation = new AbortController()
      const run = executor.execute({
        ...request,
        code: 'import time\ntime.sleep(30)',
        language: 'python',
        signal: cancellation.signal
      })
      await vi.waitFor(() => expect(procFor(executor, 'python')?.pending).toBeDefined())
      cancellation.abort()

      await expect(run).resolves.toMatchObject({ status: 'cancelled', traceback: '' })
      const next = await executor.execute({
        ...request,
        code: 'print(preserved_after_cancel + 1)',
        language: 'python'
      })
      expect(next).toMatchObject({ status: 'completed', stdout: '42\n' })
      expect(procFor(executor, 'python')?.child).toBe(child)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)

  it('blocks dynamically assembled venv and pip subprocess entry points', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-python-loop-package-guard-'))
    const request = baseRequest(cwdDir)
    await stubEnvPython(request.runtimeRoot, DEFAULT_PY_ENV)
    await symlink(request.runtimeRoot, join(cwdDir, 'runtime-link'))
    const truncatePath = join(request.runtimeRoot, 'truncate-target.txt')
    await writeFile(truncatePath, 'unchanged', 'utf8')
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py'),
      platform: 'linux'
    })

    try {
      const echoResult = await executor.execute({
        ...request,
        code:
          `import subprocess\n` +
          `completed = subprocess.run(["echo", "pip install pandas"], stdout=subprocess.PIPE, text=True, check=True)\n` +
          `print(completed.stdout.strip())`,
        language: 'python'
      })
      expect(echoResult.status).toBe('completed')
      expect(echoResult.stdout).toContain('pip install pandas')

      const venvResult = await executor.execute({
        ...request,
        code: `getattr(__import__("ve" + "nv"), "create")("blocked-env")`,
        language: 'python'
      })
      expect(venvResult.status).toBe('failed')
      expect(venvResult.traceback).toMatch(/manage_packages/)
      expect(existsSync(join(cwdDir, 'blocked-env'))).toBe(false)

      const pipInspectionResult = await executor.execute({
        ...request,
        code:
          `import subprocess, sys\n` +
          `subprocess.run([sys.executable, "-m", "p" + "ip", "li" + "st", "--help"])`,
        language: 'python'
      })
      expect(pipInspectionResult.status).toBe('completed')

      const pipResult = await executor.execute({
        ...request,
        code:
          `import subprocess, sys\n` +
          `subprocess.run([sys.executable, "-m", "p" + "ip", "in" + "stall", "--help"])`,
        language: 'python'
      })
      expect(pipResult.status).toBe('failed')
      expect(pipResult.traceback).toMatch(/manage_packages/)

      const rInstallerResult = await executor.execute({
        ...request,
        code:
          `import subprocess\n` +
          `runner = "R" + "script"\n` +
          `operation = "install" + ".packages('dplyr')"\n` +
          `subprocess.run([runner, "-e", operation])`,
        language: 'python'
      })
      expect(rInstallerResult.status).toBe('failed')
      expect(rInstallerResult.traceback).toMatch(/manage_packages/)

      const ensurepipResult = await executor.execute({
        ...request,
        code: `getattr(__import__("ensure" + "pip"), "boot" + "strap")()`,
        language: 'python'
      })
      expect(ensurepipResult.status).toBe('failed')
      expect(ensurepipResult.traceback).toMatch(/manage_packages/)

      const inProcessPipResult = await executor.execute({
        ...request,
        code:
          `entry = getattr(__import__("pip._internal", fromlist=["main"]), "main")\n` +
          `entry(["in" + "stall", "pandas"])`,
        language: 'python'
      })
      expect(inProcessPipResult.status).toBe('failed')
      expect(inProcessPipResult.traceback).toMatch(/manage_packages/)

      const pipCommandFactoryResult = await executor.execute({
        ...request,
        code:
          `commands = __import__("pip._internal.commands", fromlist=["create_command"])\n` +
          `command = commands.create_command("in" + "stall")\n` +
          `command.main(["--help"])`,
        language: 'python'
      })
      expect(pipCommandFactoryResult.status).toBe('failed')
      expect(pipCommandFactoryResult.traceback).toMatch(/manage_packages/)

      const symlinkWriteResult = await executor.execute({
        ...request,
        code: `open("runtime-link/blocked-from-link.txt", "w").write("changed")`,
        language: 'python'
      })
      expect(symlinkWriteResult.status).toBe('failed')
      expect(symlinkWriteResult.traceback).toMatch(/manage_packages/)
      expect(existsSync(join(request.runtimeRoot, 'blocked-from-link.txt'))).toBe(false)

      const truncateResult = await executor.execute({
        ...request,
        code: `import os\n` + `getattr(os, "trun" + "cate")(${JSON.stringify(truncatePath)}, 0)`,
        language: 'python'
      })
      expect(truncateResult.status).toBe('failed')
      expect(truncateResult.traceback).toMatch(/manage_packages/)
      expect(await readFile(truncatePath, 'utf8')).toBe('unchanged')

      const descriptorPath = join(request.runtimeRoot, 'descriptor-mode-python.txt')
      await writeFile(descriptorPath, 'unchanged', 'utf8')
      await chmod(descriptorPath, 0o700)
      const descriptorResult = await executor.execute({
        ...request,
        code:
          `import os\n` +
          `descriptor = os.open(${JSON.stringify(descriptorPath)}, os.O_RDONLY)\n` +
          `try:\n` +
          `    os.fchmod(descriptor, 0o600)\n` +
          `finally:\n` +
          `    os.close(descriptor)`,
        language: 'python'
      })
      expect(descriptorResult.status).toBe('failed')
      expect(descriptorResult.traceback).toMatch(/manage_packages/)
      expect((await stat(descriptorPath)).mode & 0o777).toBe(0o700)

      const posixSpawnPath = join(request.runtimeRoot, 'blocked-from-posix-spawn.txt')
      const posixSpawnResult = await executor.execute({
        ...request,
        code:
          `import os\n` +
          `os.posix_spawn('/bin/sh', ['sh', '-c', ` +
          `'touch "$OPEN_SCIENCE_RUNTIME_DIR/blocked-from-posix-spawn.txt"'], os.environ)`,
        language: 'python'
      })
      expect(posixSpawnResult.status).toBe('failed')
      expect(posixSpawnResult.traceback).toMatch(/manage_packages/)
      expect(existsSync(posixSpawnPath)).toBe(false)
    } finally {
      await executor.shutdown()
    }
  })
})

describe.skipIf(!rExecutable || !rScriptExecutable)('NotebookKernelExecutor (real R loop)', () => {
  it('bounds R output before it crosses the loop protocol', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-output-limit-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code: `cat(strrep("x", ${NOTEBOOK_TEXT_LIMIT_BYTES + 1024}))`,
        language: 'r'
      })
      expect(result.status).toBe('completed')
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(
        NOTEBOOK_TEXT_LIMIT_BYTES
      )
      expect(result.truncated).toBe(true)
    } finally {
      await executor.shutdown()
    }
  })

  it('keeps the R protocol aligned when user code removes the primary output sink', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-sink-guard-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const guarded = await executor.execute({
        ...request,
        code: '{ base::sink(NULL); sink(NULL); cat("still captured") }',
        language: 'r'
      })
      expect(guarded.status).toBe('completed')
      expect(guarded.stdout).toContain('still captured')

      const next = await executor.execute({ ...request, code: '40 + 2', language: 'r' })
      expect(next.status).toBe('completed')
      expect(next.stdout).toContain('42')
    } finally {
      await executor.shutdown()
    }
  })

  it('retains an R error after stdout fills the normal output budget', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-diagnostic-reserve-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code: `cat(strrep("x", ${NOTEBOOK_TEXT_LIMIT_BYTES + 1024})); stop("diagnostic survives")`,
        language: 'r'
      })
      expect(result.status).toBe('failed')
      expect(result.traceback).toContain('diagnostic survives')
      expect(
        Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.traceback, 'utf8')
      ).toBeLessThanOrEqual(NOTEBOOK_TEXT_LIMIT_BYTES)
      expect(result.truncated).toBe(true)
    } finally {
      await executor.shutdown()
    }
  })

  // Windows maps SIGINT to process termination, so cancellation cannot keep this namespace.
  it.skipIf(process.platform === 'win32')(
    'cancels a run without clearing the persistent R namespace',
    async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-cancel-'))
      const request = baseRequest(cwdDir)
      await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
      const executor = new NotebookKernelExecutor({
        rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
        platform: 'linux'
      })

      try {
        await expect(
          executor.execute({ ...request, code: 'preserved_after_cancel <- 41', language: 'r' })
        ).resolves.toMatchObject({ status: 'completed' })
        const child = procFor(executor, 'r')?.child as ChildProcessWithoutNullStreams
        const cancellation = new AbortController()
        // Abort in the same turn as the request write so SIGINT can land while the loop is still
        // reading the framed request. Waiting until Sys.sleep starts hides the read-path crash.
        abortOnNextStdinWrite(child, cancellation)
        const run = executor.execute({
          ...request,
          code: 'Sys.sleep(30)',
          language: 'r',
          signal: cancellation.signal
        })

        await expect(run).resolves.toMatchObject({ status: 'cancelled', traceback: '' })
        const next = await executor.execute({
          ...request,
          code: 'cat(preserved_after_cancel + 1)',
          language: 'r'
        })
        expect(next).toMatchObject({ status: 'completed', stdout: '42', traceback: '' })
        expect(procFor(executor, 'r')?.child).toBe(child)
      } finally {
        await executor.shutdown()
      }
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')(
    'does not let user R code poison cancellation interrupt state',
    async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-interrupt-poison-'))
      const request = baseRequest(cwdDir)
      await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
      const executor = new NotebookKernelExecutor({
        rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
        platform: 'linux'
      })

      try {
        await expect(
          executor.execute({
            ...request,
            code:
              'interrupt_during_read <- TRUE; during_read <- TRUE; ' +
              'getwd <- function(...) 1; preserved_after_cancel <- 41',
            language: 'r'
          })
        ).resolves.toMatchObject({ status: 'completed' })
        const child = procFor(executor, 'r')?.child as ChildProcessWithoutNullStreams
        const cancellation = new AbortController()
        abortOnNextStdinWrite(child, cancellation)
        await expect(
          executor.execute({
            ...request,
            code: 'Sys.sleep(30)',
            language: 'r',
            signal: cancellation.signal
          })
        ).resolves.toMatchObject({ status: 'cancelled', traceback: '' })
        const next = await executor.execute({
          ...request,
          code: 'cat(preserved_after_cancel + 1)',
          language: 'r'
        })
        expect(next).toMatchObject({ status: 'completed', stdout: '42', traceback: '' })
        expect(procFor(executor, 'r')?.child).toBe(child)
      } finally {
        await executor.shutdown()
      }
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')(
    'preserves a fully read R request when SIGINT lands before dispatch',
    async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-frame-cancel-'))
      const request = baseRequest(cwdDir)
      await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
      const sourcePath = join(__dirname, '../../../resources/notebook/r_loop.R')
      const loopPath = join(cwdDir, 'r_loop.R')
      const frameDecoded = 'code <- if (n > 0L) rawToChar(acc, multiple = FALSE) else ""'
      const marker = '__OPEN_SCIENCE_R_FRAME_DECODED__'
      const loop = await readFile(sourcePath, 'utf8')
      expect(loop).toContain(frameDecoded)
      await writeFile(
        loopPath,
        loop.replace(
          frameDecoded,
          `${frameDecoded}\n      if (identical(code, "Sys.sleep(30)")) {\n        cat("${marker}\\n")\n        flush(stdout())\n        Sys.sleep(0.5)\n      }`
        )
      )
      const executor = new NotebookKernelExecutor({ rLoopPath: loopPath, platform: 'linux' })

      try {
        await expect(
          executor.execute({ ...request, code: 'preserved_after_cancel <- 41', language: 'r' })
        ).resolves.toMatchObject({ status: 'completed' })
        const child = procFor(executor, 'r')?.child as ChildProcessWithoutNullStreams
        const frameDecodedByR = new Promise<void>((resolve) => {
          const onData = (chunk: Buffer): void => {
            if (!chunk.toString().includes(marker)) return
            child.stdout.off('data', onData)
            resolve()
          }
          child.stdout.on('data', onData)
        })
        const cancellation = new AbortController()
        const run = executor.execute({
          ...request,
          code: 'Sys.sleep(30)',
          language: 'r',
          signal: cancellation.signal
        })

        await frameDecodedByR
        cancellation.abort()
        await expect(run).resolves.toMatchObject({ status: 'cancelled', traceback: '' })
        const next = await executor.execute({
          ...request,
          code: 'cat(preserved_after_cancel + 1)',
          language: 'r'
        })
        expect(next).toMatchObject({ status: 'completed', stdout: '42', traceback: '' })
        expect(procFor(executor, 'r')?.child).toBe(child)
      } finally {
        await executor.shutdown()
      }
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')(
    'preserves the R namespace across an in-eval cancel and 50 dispatch cancels',
    async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-cancel-stress-'))
      const request = baseRequest(cwdDir)
      await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
      const executor = new NotebookKernelExecutor({
        rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
        platform: 'linux'
      })

      try {
        await expect(
          executor.execute({ ...request, code: 'preserved_after_cancel <- 41', language: 'r' })
        ).resolves.toMatchObject({ status: 'completed' })
        const child = procFor(executor, 'r')?.child as ChildProcessWithoutNullStreams

        const inEval = new AbortController()
        const sleeping = executor.execute({
          ...request,
          code: 'Sys.sleep(30)',
          language: 'r',
          signal: inEval.signal
        })
        await vi.waitFor(() => expect(procFor(executor, 'r')?.pending).toBeDefined())
        await new Promise((resolve) => setTimeout(resolve, 150))
        inEval.abort()
        await expect(sleeping).resolves.toMatchObject({ status: 'cancelled', traceback: '' })

        for (let i = 0; i < 50; i++) {
          const cancellation = new AbortController()
          abortOnNextStdinWrite(child, cancellation)
          const result = await executor.execute({
            ...request,
            code: 'Sys.sleep(1)',
            language: 'r',
            signal: cancellation.signal
          })
          expect(result, `dispatch cancellation ${i + 1}`).toMatchObject({
            status: 'cancelled',
            traceback: ''
          })
        }

        const next = await executor.execute({
          ...request,
          code: 'cat(preserved_after_cancel + 1)',
          language: 'r'
        })
        expect(next).toMatchObject({ status: 'completed', stdout: '42', traceback: '' })
        expect(procFor(executor, 'r')?.child).toBe(child)
      } finally {
        await executor.shutdown()
      }
    },
    60_000
  )

  it('does not preload optional plotting packages for non-plotting cells', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-lazy-graphics-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })
    try {
      await expect(
        executor.execute({ ...request, code: 'cat("ragg" %in% loadedNamespaces())', language: 'r' })
      ).resolves.toMatchObject({ status: 'completed', stdout: 'FALSE' })
    } finally {
      await executor.shutdown()
    }
  })

  it.each([
    {
      name: 'base graphics through a PNG device',
      fileName: 'base-only.png',
      code: (path: string) =>
        'if (!isTRUE(capabilities("png"))) stop("png unavailable"); ' +
        `grDevices::png(${JSON.stringify(path)}); graphics::plot(1:3); grDevices::dev.off()`,
      unavailable: /png unavailable/u,
      verifySignature: (bytes: Buffer) => expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
    },
    {
      name: 'ggplot2 through ggsave to TIFF',
      fileName: 'ggsave-only.tiff',
      code: (path: string) =>
        'if (!requireNamespace("ggplot2", quietly = TRUE)) stop("ggplot2 unavailable"); ' +
        'if (!isTRUE(capabilities("tiff"))) stop("tiff unavailable"); ' +
        'p <- ggplot2::ggplot(data.frame(x = 1:3, y = 1:3), ggplot2::aes(x, y)) + ' +
        'ggplot2::geom_point(); ' +
        `ggplot2::ggsave(${JSON.stringify(path)}, plot = p, device = "tiff")`,
      unavailable: /ggplot2 unavailable|tiff unavailable/u,
      verifySignature: (bytes: Buffer) =>
        expect(bytes.subarray(0, 2).toString('ascii')).toMatch(/^(II|MM)$/u)
    },
    {
      name: 'ragg through a TIFF device',
      fileName: 'ragg-only.tiff',
      code: (path: string) =>
        'if (!requireNamespace("ragg", quietly = TRUE)) stop("ragg unavailable"); ' +
        `ragg::agg_tiff(${JSON.stringify(path)}); graphics::plot(1:3); grDevices::dev.off()`,
      unavailable: /ragg unavailable/u,
      verifySignature: (bytes: Buffer) =>
        expect(bytes.subarray(0, 2).toString('ascii')).toMatch(/^(II|MM)$/u)
    },
    {
      name: 'grid graphics through a PDF device',
      fileName: 'grid-only.pdf',
      code: (path: string) =>
        `grDevices::pdf(${JSON.stringify(path)}); ` +
        'grid::grid.newpage(); grid::grid.rect(); grDevices::dev.off()',
      unavailable: undefined,
      verifySignature: (bytes: Buffer) =>
        expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    },
    {
      name: 'lattice through a PNG device',
      fileName: 'lattice-only.png',
      code: (path: string) =>
        'if (!requireNamespace("lattice", quietly = TRUE)) stop("lattice unavailable"); ' +
        'if (!isTRUE(capabilities("png"))) stop("png unavailable"); ' +
        'p <- lattice::xyplot(y ~ x, data = data.frame(x = 1:3, y = 1:3)); ' +
        `grDevices::png(${JSON.stringify(path)}, width = 800, height = 600); ` +
        'print(p); grDevices::dev.off()',
      unavailable: /lattice unavailable|png unavailable/u,
      verifySignature: (bytes: Buffer) => expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
    }
  ])('records $name as a working file and captured PNG', async (savedCase) => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-saved-image-'))
    const request = baseRequest(cwdDir)
    await mkdir(request.dataRoot, { recursive: true })
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const savedPath = join(request.dataRoot, savedCase.fileName)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code: savedCase.code(savedPath),
        language: 'r'
      })

      if (savedCase.unavailable?.test(result.traceback)) return

      expect(result.status).toBe('completed')
      expect(
        result.outputs.filter(
          (output) => output.type === 'display' && typeof output.data['image/png'] === 'string'
        )
      ).toHaveLength(1)
      expect(result.workingFiles).toEqual([
        expect.objectContaining({
          path: savedPath,
          relativePath: `data/${savedCase.fileName}`,
          size: expect.any(Number)
        })
      ])
      savedCase.verifySignature(await readFile(savedPath))
    } finally {
      await executor.shutdown()
    }
  })

  it('records and captures every saved image when one R run mixes graphics systems', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-mixed-saved-images-'))
    const request = baseRequest(cwdDir)
    await mkdir(request.dataRoot, { recursive: true })
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const paths = {
      base: join(request.dataRoot, '01-base.png'),
      ggplot: join(request.dataRoot, '02-ggplot.tiff'),
      grid: join(request.dataRoot, '03-grid.pdf'),
      lattice: join(request.dataRoot, '04-lattice.png')
    }
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code: [
          'if (!requireNamespace("ggplot2", quietly = TRUE)) stop("ggplot2 unavailable")',
          'if (!requireNamespace("lattice", quietly = TRUE)) stop("lattice unavailable")',
          'if (!isTRUE(capabilities("png"))) stop("png unavailable")',
          'if (!isTRUE(capabilities("tiff"))) stop("tiff unavailable")',
          `grDevices::png(${JSON.stringify(paths.base)}); graphics::plot(1:3); grDevices::dev.off()`,
          'gg <- ggplot2::ggplot(data.frame(x = 1:3, y = 1:3), ggplot2::aes(x, y)) + ggplot2::geom_point()',
          `ggplot2::ggsave(${JSON.stringify(paths.ggplot)}, plot = gg, device = "tiff")`,
          `grDevices::pdf(${JSON.stringify(paths.grid)}); grid::grid.newpage(); grid::grid.circle(); grDevices::dev.off()`,
          'trellis <- lattice::xyplot(y ~ x, data = data.frame(x = 1:3, y = 1:3))',
          `grDevices::png(${JSON.stringify(paths.lattice)}, width = 800, height = 600); print(trellis); grDevices::dev.off()`
        ].join('; '),
        language: 'r'
      })

      if (
        /ggplot2 unavailable|lattice unavailable|png unavailable|tiff unavailable/u.test(
          result.traceback
        )
      ) {
        return
      }

      const workingFiles = result.workingFiles ?? []
      expect(result.status).toBe('completed')
      expect(
        result.outputs.filter(
          (output) => output.type === 'display' && typeof output.data['image/png'] === 'string'
        )
      ).toHaveLength(4)
      expect(workingFiles).toHaveLength(4)
      expect(workingFiles.map((file) => file.path)).toEqual(
        expect.arrayContaining(Object.values(paths))
      )
      expect(workingFiles.every((file) => (file.size ?? 0) > 0)).toBe(true)
    } finally {
      await executor.shutdown()
    }
  })

  it('rejects a package installer even when the main-process guard is bypassed', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-package-guard-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const echoResult = await executor.execute({
        ...request,
        code: 'output <- system2("echo", "pip install pandas", stdout=TRUE); cat(output)',
        language: 'r'
      })
      expect(echoResult.status).toBe('completed')
      expect(echoResult.stdout).toContain('pip install pandas')

      const result = await executor.execute({
        ...request,
        code: 'utils::install.packages("dplyr")',
        language: 'r'
      })

      expect(result.status).toBe('failed')
      expect(result.traceback).toMatch(/manage_packages/)
    } finally {
      await executor.shutdown()
    }
  })

  it('keeps installer aliases blocked after user code shadows the policy helper names', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-package-alias-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const shadow = await executor.execute({
        ...request,
        code:
          'package_mutation_call_name <- function(expr) NULL; ' +
          'is_package_mutation_name <- function(name) FALSE',
        language: 'r'
      })
      expect(shadow.status).toBe('completed')

      const alias = await executor.execute({
        ...request,
        code: 'installer <- utils::install.packages',
        language: 'r'
      })
      expect(alias.status).toBe('failed')
      expect(alias.traceback).toMatch(/manage_packages/)
    } finally {
      await executor.shutdown()
    }
  })

  it('blocks a dynamically assembled lookup of the canonical R installer', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-package-dynamic-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code:
          'installer <- get(paste0("install", ".packages"), envir=asNamespace("utils")); ' +
          'installer("dplyr")',
        language: 'r'
      })
      expect(result.status).toBe('failed')
      expect(result.traceback).toMatch(/manage_packages/)
    } finally {
      await executor.shutdown()
    }
  })

  it('blocks the internal R system primitive from bypassing the persistent process guard', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-internal-system-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const blockedPath = join(request.runtimeRoot, 'blocked-internal-system.txt')
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code:
          `target <- ${JSON.stringify(blockedPath)}; ` +
          'command <- paste("touch", shQuote(target)); ' +
          '.Internal(system(command, FALSE, 0L, TRUE))',
        language: 'r'
      })

      expect(result.status).toBe('failed')
      expect(result.traceback).toMatch(/manage_packages/)
      expect(existsSync(blockedPath)).toBe(false)

      const descriptorPath = join(request.runtimeRoot, 'descriptor-mode-r.txt')
      await writeFile(descriptorPath, 'unchanged', 'utf8')
      await chmod(descriptorPath, 0o700)
      const descriptorResult = await executor.execute({
        ...request,
        code: `Sys.chmod(${JSON.stringify(descriptorPath)}, mode="0600")`,
        language: 'r'
      })
      expect(descriptorResult.status).toBe('failed')
      expect(descriptorResult.traceback).toMatch(/manage_packages/)
      expect((await stat(descriptorPath)).mode & 0o777).toBe(0o700)
    } finally {
      await executor.shutdown()
    }
  })

  it('blocks managed-runtime writes routed through a temporary R variable', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-runtime-guard-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const blockedPath = join(request.runtimeRoot, 'blocked-r.txt')
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const result = await executor.execute({
        ...request,
        code:
          'target <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "blocked-r.txt"); ' +
          'writeLines("changed", target)',
        language: 'r'
      })
      expect(result.status).toBe('failed')
      expect(result.traceback).toMatch(/manage_packages/)
      expect(existsSync(blockedPath)).toBe(false)

      const childPath = join(request.runtimeRoot, 'blocked-r-child.txt')
      const childResult = await executor.execute({
        ...request,
        code:
          'target <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "blocked-r-child.txt"); ' +
          'system(paste("touch", shQuote(target)))',
        language: 'r'
      })
      expect(childResult.status).toBe('failed')
      expect(childResult.traceback).toMatch(/manage_packages/)
      expect(existsSync(childPath)).toBe(false)

      const packageCommandResult = await executor.execute({
        ...request,
        code:
          'installer <- paste0("p", "ip"); operation <- paste0("in", "stall"); ' +
          'system2(installer, c(operation, "dplyr"))',
        language: 'r'
      })
      expect(packageCommandResult.status).toBe('failed')
      expect(packageCommandResult.traceback).toMatch(/manage_packages/)
    } finally {
      await executor.shutdown()
    }
  })

  it('blocks additional base R write and process APIs from reaching the managed runtime', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-r-loop-runtime-apis-'))
    const request = baseRequest(cwdDir)
    await stubEnvR(request.runtimeRoot, DEFAULT_R_ENV)
    const sourcePath = join(cwdDir, 'source.txt')
    await writeFile(sourcePath, 'source', 'utf8')
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R'),
      platform: 'linux'
    })

    try {
      const cases = [
        {
          name: 'file.append',
          path: join(request.runtimeRoot, 'blocked-file-append.txt'),
          code:
            'target <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "blocked-file-append.txt"); ' +
            `file.append(target, ${JSON.stringify(sourcePath)})`
        },
        {
          name: 'file.copy',
          path: join(request.runtimeRoot, 'blocked-file-copy.txt'),
          code:
            'target <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "blocked-file-copy.txt"); ' +
            `file.copy(${JSON.stringify(sourcePath)}, target, overwrite=TRUE)`
        },
        {
          name: 'download.file',
          path: join(request.runtimeRoot, 'blocked-download.txt'),
          code:
            'target <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "blocked-download.txt"); ' +
            'download.file("https://example.invalid/report", target)'
        },
        {
          name: 'fifo',
          path: join(request.runtimeRoot, 'blocked-fifo'),
          code:
            'target <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "blocked-fifo"); ' +
            'fifo(target, open="w", blocking=FALSE)'
        },
        {
          name: 'pipe',
          path: join(request.runtimeRoot, 'blocked-pipe.txt'),
          code:
            'target <- file.path(Sys.getenv("OPEN_SCIENCE_RUNTIME_DIR"), "blocked-pipe.txt"); ' +
            'pipe(paste("touch", shQuote(target)), open="r")'
        }
      ]

      for (const testCase of cases) {
        const result = await executor.execute({ ...request, code: testCase.code, language: 'r' })
        expect(result.status, testCase.name).toBe('failed')
        expect(result.traceback, testCase.name).toMatch(/manage_packages/)
        expect(existsSync(testCase.path), testCase.name).toBe(false)
      }
    } finally {
      await executor.shutdown()
    }
  })
})

gate('NotebookKernelExecutor idle-timeout shutdown', () => {
  it('drops an idle proc when the idle timer fires, and respawns fresh on the next execute', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-idle-')
    const h = makeTimerHarness()
    const idleShutdowns: string[] = []
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      platform: 'linux',
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
      platform: 'linux',
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
      platform: 'linux',
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
      await vi.waitFor(
        () => expect(internals.procs.get(procKeyFor('python'))?.pending).toBeDefined(),
        { timeout: 1_000, interval: 10 }
      )
      const proc = internals.procs.get(procKeyFor('python'))

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

  it('arms NO idle timer by default, so the kernel namespace persists across a pause', async () => {
    cwdDir = await makeDefaultEnvCwd('os-kernel-idle-off-')
    const h = makeTimerHarness()
    // No idleTimeoutMs and no OPEN_SCIENCE_KERNEL_IDLE_MS → idle reclaim is disabled (the default).
    const executor = new NotebookKernelExecutor({
      pythonBin: python3,
      pythonLoopPath: FIXTURE,
      platform: 'linux',
      scheduleIdleTimer: h.schedule,
      cancelIdleTimer: h.cancel
    })
    try {
      const first = await executor.execute({ ...baseRequest(cwdDir), code: 'warm' })
      expect(first.status).toBe('completed')
      // Idle after the request, but with idle reclaim off no timer is armed and the proc stays alive.
      expect(h.timers.size).toBe(0)
      const child = procFor(executor, 'python')?.child
      expect(child).toBeDefined()
      // The next cell reuses the SAME process (namespace intact) rather than a fresh respawn — even a
      // fired timer couldn't drop it, because none was ever scheduled.
      const second = await executor.execute({ ...baseRequest(cwdDir), code: 'again' })
      expect(second.status).toBe('completed')
      expect(procFor(executor, 'python')?.child).toBe(child)
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
      platform: 'linux',
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
      platform: 'linux',
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
    mcpRpcSocketPath?: string
    mcpRpcToken?: string
  },
  figuresDir: string
) => NodeJS.ProcessEnv

describe('NotebookKernelExecutor spawn env', () => {
  it('grants the complete macOS app bundle to the Electron-backed repl kernel', () => {
    const executable = '/Applications/Open Science.app/Contents/MacOS/Open Science'

    expect(kernelExecutableReadRoot(executable, 'repl', 'darwin')).toBe(
      '/Applications/Open Science.app'
    )
    expect(kernelExecutableReadRoot(executable, 'python', 'darwin')).toBe(
      '/Applications/Open Science.app/Contents/MacOS'
    )
  })

  it('injects OPEN_SCIENCE_HANDOFF_DIR under the notebook session root for every kernel language', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    const request = { ...baseRequest('/tmp/os-handoff-test'), code: 'x' }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)

    const expected = join(request.notebookSessionRoot, 'handoff')
    expect(buildEnv('python', request, '/tmp/figs').OPEN_SCIENCE_HANDOFF_DIR).toBe(expected)
    expect(buildEnv('r', request, '/tmp/figs').OPEN_SCIENCE_HANDOFF_DIR).toBe(expected)
    expect(buildEnv('repl', request, '/tmp/figs').OPEN_SCIENCE_HANDOFF_DIR).toBe(expected)
  })

  it('projects cache-only Data Storage paths for every kernel language', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    const request = { ...baseRequest('/tmp/os-cache-env'), code: 'x' }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)
    const cacheRoot = join(request.runtimeRoot, 'cache', 'notebook')

    for (const kind of ['python', 'r', 'repl'] as const) {
      expect(buildEnv(kind, request, '/tmp/figs')).toMatchObject({
        OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
        PIP_CACHE_DIR: join(cacheRoot, 'pip'),
        UV_CACHE_DIR: join(cacheRoot, 'uv'),
        HF_HUB_CACHE: join(cacheRoot, 'huggingface', 'hub'),
        HF_XET_CACHE: join(cacheRoot, 'huggingface', 'xet'),
        HF_ASSETS_CACHE: join(cacheRoot, 'huggingface', 'assets'),
        TORCH_HOME: join(cacheRoot, 'torch')
      })
    }
  })

  it('gives non-Linux repl kernels ELECTRON_RUN_AS_NODE plus the connector RPC endpoint/token', () => {
    const executor = new NotebookKernelExecutor({
      replLoopPath: '/tmp/repl_loop.js',
      platform: 'win32'
    })
    const request = {
      ...baseRequest('/tmp/os-repl-env'),
      code: 'x',
      mcpRpcEndpoint: 'http://127.0.0.1:9/x',
      mcpRpcSocketPath: '\\\\.\\pipe\\open-science-notebook',
      mcpRpcToken: 'tok'
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)

    const replEnv = buildEnv('repl', request, '/tmp/figs')
    expect(replEnv.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(replEnv.OPEN_SCIENCE_MCP_RPC_ENDPOINT).toBe('http://127.0.0.1:9/x')
    expect(replEnv.OPEN_SCIENCE_MCP_RPC_SOCKET_PATH).toBe('\\\\.\\pipe\\open-science-notebook')
    expect(replEnv.OPEN_SCIENCE_MCP_RPC_TOKEN).toBe('tok')
  })

  it('routes the Linux repl RPC token through inherited fd 3 instead of the environment', () => {
    const executor = new NotebookKernelExecutor({
      replLoopPath: '/tmp/repl_loop.js',
      platform: 'linux'
    })
    const request = {
      ...baseRequest('/tmp/os-repl-env'),
      code: 'x',
      mcpRpcEndpoint: 'http://127.0.0.1:9/x',
      mcpRpcToken: 'tok'
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)

    const replEnv = buildEnv('repl', request, '/tmp/figs')
    expect(replEnv.OPEN_SCIENCE_MCP_RPC_TOKEN).toBeUndefined()
    expect(replEnv.OPEN_SCIENCE_MCP_RPC_TOKEN_FD).toBe('3')
  })

  it('withholds the connector RPC env from python/r data kernels (host.mcp is repl-only)', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    const request = {
      ...baseRequest('/tmp/os-repl-env'),
      code: 'x',
      mcpRpcEndpoint: 'http://127.0.0.1:9/x',
      mcpRpcSocketPath: '\\\\.\\pipe\\open-science-notebook',
      mcpRpcToken: 'tok'
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)

    for (const kind of ['python', 'r'] as const) {
      const env = buildEnv(kind, request, '/tmp/figs')
      // Defense-in-depth: even if a data request carried the RPC connection, the data kernel never
      // receives it, so python/r have no outbound connector (host.mcp) access.
      expect(env.OPEN_SCIENCE_MCP_RPC_ENDPOINT).toBeUndefined()
      expect(env.OPEN_SCIENCE_MCP_RPC_SOCKET_PATH).toBeUndefined()
      expect(env.OPEN_SCIENCE_MCP_RPC_TOKEN).toBeUndefined()
      // Only the repl kernel runs the app binary as plain Node.
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
  })

  it('activates the complete Windows conda PATH before spawning a named managed R kernel', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE, platform: 'win32' })
    const request = {
      ...baseRequest('/tmp/os-r-windows-path'),
      code: 'x',
      environment: 'r-stats'
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)
    const prefix = envPrefix(request.runtimeRoot, 'r-stats')

    expect(buildEnv('r', request, '/tmp/figs').PATH?.split(';').slice(0, 6)).toEqual([
      win32.normalize(prefix),
      win32.join(prefix, 'Library', 'mingw-w64', 'bin'),
      win32.join(prefix, 'Library', 'usr', 'bin'),
      win32.join(prefix, 'Library', 'bin'),
      win32.join(prefix, 'Scripts'),
      win32.join(prefix, 'bin')
    ])
  })

  it('does not contaminate an external Windows R interpreter with managed conda DLL paths', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE, platform: 'win32' })
    const request = {
      ...baseRequest('/tmp/os-r-external-path'),
      code: 'x',
      resolvedInterpreter: { command: 'C:\\ExternalR\\bin\\Rscript.exe' }
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)
    const env = buildEnv('r', request, '/tmp/figs')

    expect(env.OPEN_SCIENCE_R_ENV_PREFIX).toBeUndefined()
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('activates an external Windows conda R interpreter with its own DLL paths', () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE, platform: 'win32' })
    const prefix = 'C:\\Users\\HM\\miniforge3\\envs\\analysis'
    const request = {
      ...baseRequest('/tmp/os-r-external-conda-path'),
      code: 'x',
      resolvedInterpreter: {
        command: `${prefix}\\Lib\\R\\bin\\Rscript.exe`,
        condaPrefix: prefix
      }
    }
    const buildEnv = (executor as unknown as { buildEnv: BuildEnvFn }).buildEnv.bind(executor)
    const env = buildEnv('r', request, '/tmp/figs')

    expect(env.OPEN_SCIENCE_R_ENV_PREFIX).toBe(prefix)
    expect(env.PATH?.split(';').slice(0, 6)).toEqual([
      win32.normalize(prefix),
      win32.join(prefix, 'Library', 'mingw-w64', 'bin'),
      win32.join(prefix, 'Library', 'usr', 'bin'),
      win32.join(prefix, 'Library', 'bin'),
      win32.join(prefix, 'Scripts'),
      win32.join(prefix, 'bin')
    ])
  })
})

// -- shutdown() reaped guarantee vs. in-flight teardowns (the Windows update-install gate). ----------

type PendingTeardownsInternals = {
  pendingTeardowns: Map<string, Promise<{ reaped: boolean }>>
}

describe('NotebookKernelExecutor shutdown reaping', () => {
  it('awaits an outstanding pending teardown and reports reaped:false while its tree is still dying', async () => {
    // A hard-timeout/idle drop moved its tree kill into pendingTeardowns and removed the proc from the
    // map, so shutdown()'s per-proc loop never sees it. shutdown() must still await that teardown: the
    // update-install gate relies on reaped:true meaning EVERY interpreter file handle was released.
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    const internals = executor as unknown as PendingTeardownsInternals

    let settle!: (result: { reaped: boolean }) => void
    const teardown = new Promise<{ reaped: boolean }>((resolve) => {
      settle = resolve
    })
    internals.pendingTeardowns.set('python:default-python', teardown)

    // shutdown() must not resolve while the old tree is still being reaped.
    let resolved = false
    const shutdownPromise = executor.shutdown().then((result) => {
      resolved = true
      return result
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(resolved).toBe(false)

    // The old tree could not be cleanly reaped (a lingering handle): shutdown must report reaped:false.
    settle({ reaped: false })
    const result = await shutdownPromise
    expect(resolved).toBe(true)
    expect(result.reaped).toBe(false)
  })

  it('reports reaped:true only once every pending teardown reaped its whole tree', async () => {
    const executor = new NotebookKernelExecutor({ pythonLoopPath: FIXTURE })
    const internals = executor as unknown as PendingTeardownsInternals
    internals.pendingTeardowns.set('python:default-python', Promise.resolve({ reaped: true }))

    const result = await executor.shutdown()
    expect(result.reaped).toBe(true)
  })
})

// -- Repl kind end-to-end against the real repl_loop.js under the test's node (process.execPath). ----

const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

describe('NotebookKernelExecutor repl kind (real repl_loop.js)', () => {
  it('starts the Linux repl with an fd-only RPC token', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-rpc-fd-'))
    const token = 'kernel-fd-only-token'
    const executor = new NotebookKernelExecutor({ replLoopPath: REPL_LOOP, platform: 'linux' })
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code:
          `const fs = require('node:fs'); ` +
          `return JSON.stringify({ ` +
          `envTokenPresent: Object.hasOwn(process.env, 'OPEN_SCIENCE_MCP_RPC_TOKEN'), ` +
          `procContainsToken: process.platform === 'linux' && fs.readFileSync('/proc/self/environ').includes(${JSON.stringify(token)}) })`,
        kind: 'repl',
        mcpRpcToken: token
      })
      expect(result.status).toBe('completed')
      expect(result.outputs).toContainEqual({
        type: 'display',
        data: {
          'text/plain': JSON.stringify({ envTokenPresent: false, procContainsToken: false })
        }
      })
    } finally {
      await executor.shutdown()
    }
  })

  it('executes a control-plane repl cell without a managed runtime root', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-no-runtime-'))
    const executor = new NotebookKernelExecutor({ replLoopPath: REPL_LOOP, platform: 'linux' })
    try {
      const result = await executor.execute({
        code: 'return 1',
        cwd: cwdDir,
        kind: 'repl',
        notebookSessionRoot: '',
        dataRoot: '',
        runtimeRoot: ''
      })
      expect(result.status).toBe('completed')
      expect(result.outputs).toContainEqual({
        type: 'display',
        data: { 'text/plain': '1' }
      })
    } finally {
      await executor.shutdown()
    }
  })

  it.runIf(
    process.platform === 'darwin' ||
      (process.platform === 'win32' && process.env.OPEN_SCIENCE_WINDOWS_APP_CONTAINER_TEST === '1')
  )(
    'executes the repl loop through the production network sandbox',
    async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-sandbox-'))
      const inputRoot = `${cwdDir}-inputs`
      const inputPath = join(inputRoot, 'content')
      const replLoopPath = join(inputRoot, 'repl_loop.js')
      await mkdir(inputRoot, { recursive: true })
      await writeFile(inputPath, 'verified input')
      await writeFile(replLoopPath, await readFile(REPL_LOOP))
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: resolve(
          import.meta.dirname,
          '../../../packages/notebook-network-sandbox/vendor'
        ),
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision: async () => 'deny'
      })
      const executor = new NotebookKernelExecutor({
        replLoopPath,
        processSandbox: owner
      })

      try {
        const result = await executor.execute({
          ...baseRequest(cwdDir),
          inputRoot,
          code:
            `const fs = require('node:fs'); const value = fs.readFileSync(${JSON.stringify(inputPath)}, 'utf8'); ` +
            `let writeDenied = false; try { fs.writeFileSync(${JSON.stringify(inputPath)}, 'changed') } catch { writeDenied = true } ` +
            'return { value, writeDenied }',
          kind: 'repl',
          sessionId: 'sandbox-repl-session',
          projectId: 'sandbox-repl-project'
        })
        expect(result.status, result.stderr || result.traceback).toBe('completed')
        expect(result.outputs).toContainEqual({
          type: 'display',
          data: {
            'text/plain': JSON.stringify({ value: 'verified input', writeDenied: true })
          }
        })
      } finally {
        await executor.shutdown()
        await owner.dispose()
        await rm(inputRoot, { recursive: true, force: true })
      }
    },
    20_000
  )

  it('bounds control output before it crosses the loop protocol', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-output-limit-'))
    const executor = new NotebookKernelExecutor({ replLoopPath: REPL_LOOP, platform: 'linux' })
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: `console.log("x".repeat(${NOTEBOOK_TEXT_LIMIT_BYTES + 1024}))`,
        kind: 'repl'
      })
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(
        NOTEBOOK_TEXT_LIMIT_BYTES
      )
      expect(result.truncated).toBe(true)
    } finally {
      await executor.shutdown()
    }
  })

  it('retains a control error after stdout fills the normal output budget', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-diagnostic-reserve-'))
    const executor = new NotebookKernelExecutor({ replLoopPath: REPL_LOOP, platform: 'linux' })
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: `console.log("x".repeat(${NOTEBOOK_TEXT_LIMIT_BYTES + 1024})); throw new Error("diagnostic survives")`,
        kind: 'repl'
      })
      expect(result.status).toBe('failed')
      expect(result.traceback).toContain('Error: diagnostic survives')
      expect(
        Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.traceback, 'utf8')
      ).toBeLessThanOrEqual(NOTEBOOK_TEXT_LIMIT_BYTES)
      expect(result.truncated).toBe(true)
    } finally {
      await executor.shutdown()
    }
  })

  it('spawns the repl loop via process.execPath and returns the mapped return value', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-'))
    const executor = new NotebookKernelExecutor({ replLoopPath: REPL_LOOP, platform: 'linux' })
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

  it('preserves the Windows repl main module without widening sandbox access', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-windows-main-'))
    const cleanup = vi.fn()
    const wrap = vi.fn<NotebookProcessSandbox['wrap']>(async (invocation) => ({
      executable: invocation.executable,
      args: invocation.args,
      env: invocation.env,
      beginExecution: () => () => undefined,
      annotateStderr: (stderr) => stderr,
      cleanup
    }))
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      platform: 'win32',
      processSandbox: { wrap }
    })

    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: 'return 1',
        kind: 'repl',
        sessionId: 'session-1',
        projectId: 'project-1'
      })

      expect(result.status, result.stderr || result.traceback).toBe('completed')
      expect(wrap).toHaveBeenCalledWith(
        expect.objectContaining({ args: ['--preserve-symlinks-main', REPL_LOOP] })
      )
    } finally {
      await executor.shutdown()
    }
  })

  it.runIf(process.platform === 'win32')(
    'cancels by terminating and lazily respawning the kernel on Windows',
    async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-windows-cancel-'))
      const terminated: Array<['python' | 'r' | 'repl', string]> = []
      const executor = new NotebookKernelExecutor({
        replLoopPath: REPL_LOOP,
        onTerminated: (kind, env) => terminated.push([kind, env])
      })
      try {
        await executor.execute({ ...baseRequest(cwdDir), code: 'return 1', kind: 'repl' })
        const child = procFor(executor, 'repl')?.child
        const cancellation = new AbortController()
        const run = executor.execute({
          ...baseRequest(cwdDir),
          code: 'await new Promise(() => {})',
          kind: 'repl',
          signal: cancellation.signal
        })
        await vi.waitFor(() => expect(procFor(executor, 'repl')?.pending).toBeDefined())
        cancellation.abort()

        await expect(run).resolves.toMatchObject({ status: 'cancelled', traceback: '' })
        expect(terminated).toEqual([['repl', '']])
        const next = await executor.execute({
          ...baseRequest(cwdDir),
          code: 'return 2',
          kind: 'repl'
        })
        expect(next.status).toBe('completed')
        expect(procFor(executor, 'repl')?.child).not.toBe(child)
      } finally {
        await executor.shutdown()
      }
    },
    15_000
  )

  it.skipIf(process.platform === 'win32')(
    'allows read-only child argv but blocks descriptor permission changes in the managed runtime',
    async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'os-kernel-repl-runtime-guard-'))
      const request = baseRequest(cwdDir)
      const descriptorPath = join(request.runtimeRoot, 'descriptor-mode-node.txt')
      await mkdir(request.runtimeRoot, { recursive: true })
      await writeFile(descriptorPath, 'unchanged', 'utf8')
      await chmod(descriptorPath, 0o700)
      const executor = new NotebookKernelExecutor({ replLoopPath: REPL_LOOP, platform: 'linux' })
      try {
        const echoResult = await executor.execute({
          ...request,
          code:
            `const { execFileSync } = require('node:child_process'); ` +
            `return execFileSync('echo', ['pip install pandas'], { encoding: 'utf8' }).trim()`,
          kind: 'repl'
        })
        expect(echoResult.status, echoResult.traceback).toBe('completed')
        expect(echoResult.outputs).toContainEqual({
          type: 'display',
          data: { 'text/plain': 'pip install pandas' }
        })

        const descriptorResult = await executor.execute({
          ...request,
          code:
            `const fs = require('node:fs'); ` +
            `const fd = fs.openSync(${JSON.stringify(descriptorPath)}, 'r'); ` +
            `try { fs.fchmodSync(fd, 0o600) } finally { fs.closeSync(fd) }`,
          kind: 'repl'
        })
        expect(descriptorResult.status).toBe('failed')
        expect(descriptorResult.traceback).toMatch(/manage_packages/)
        expect((await stat(descriptorPath)).mode & 0o777).toBe(0o700)
      } finally {
        await executor.shutdown()
      }
    }
  )
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
