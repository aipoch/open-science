import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NotebookRuntimeService } from './runtime-service'
import type { MemoryPolicyObservation } from './memory-policy'
import type { NotebookExecutionRequest } from './execution-contract'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import {
  NotebookExecutionIntent,
  withNotebookExecutionIntent,
  withNotebookUserOperation
} from './execution-intent'

it('requires the current grant in the same branch ancestry before inheriting a missing origin', () => {
  const intent = new NotebookExecutionIntent({
    projectId: 'p',
    sessionId: 's',
    messageBranchId: 'a',
    promptMessageId: 'grant'
  })
  expect(intent.forDescendant({ messageBranchId: 'a', messageAncestry: ['grant', 'next'] })).toBe(
    intent
  )
  for (const context of [
    undefined,
    { messageBranchId: 'b', messageAncestry: ['grant'] },
    { messageBranchId: 'a', messageAncestry: ['old'] }
  ]) {
    expect(intent.forDescendant(context).refusalId).toBeDefined()
  }
  expect(intent.refusalId).toBeUndefined()
})

let root: string | undefined
let runtime: NotebookRuntimeService | undefined
afterEach(async () => {
  await runtime?.shutdownAll()
  if (root) await rm(root, { recursive: true, force: true })
})

it('forces a fresh check for a prepared user continuation but not for an inherited Agent intent', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-user-retry-admission-'))
  const onMemoryPolicyChanged = vi.fn()
  const submissions: Array<{ signal: AbortSignal; force: boolean }> = []
  const getState = vi.fn(async (request?: { signal?: AbortSignal; force?: boolean }) => {
    if (request?.signal) submissions.push({ signal: request.signal, force: request.force === true })
    return {
      status: 'healthy' as const,
      reason: { code: 'healthy' },
      source: 'test-os',
      executionScope: 'test:host'
    }
  })
  const currentState = vi.fn<() => MemoryPolicyObservation>(() => ({
    status: 'healthy',
    reason: { code: 'healthy' },
    source: 'test-os',
    executionScope: 'test:host'
  }))
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    callbacks: { onMemoryPolicyChanged },
    memoryPolicy: {
      getState,
      currentState
    }
  })
  const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  const intent = runtime.createExecutionIntent(scope)
  intent.prepareUserExecution(() => undefined)
  intent.commitUserExecution()
  await runtime.executeControl(
    withNotebookExecutionIntent({ ...scope, code: 'globalThis.continued = 1' }, intent)
  )
  await runtime.executeControl(
    withNotebookExecutionIntent({ ...scope, code: 'globalThis.agent = 2' }, intent)
  )

  const first = submissions[0]
  const last = submissions.at(-1)
  expect(first?.force).toBe(true)
  expect(last?.force).toBe(false)
  expect(last?.signal).not.toBe(first?.signal)
  expect(
    submissions.filter(({ signal }) => signal === first?.signal).every(({ force }) => force)
  ).toBe(true)
  expect(
    submissions.filter(({ signal }) => signal === last?.signal).every(({ force }) => !force)
  ).toBe(true)
  expect(
    submissions
      .filter(({ signal }) => signal !== first?.signal && signal !== last?.signal)
      .every(({ force }) => !force)
  ).toBe(true)
  onMemoryPolicyChanged.mockClear()
  currentState.mockReturnValue({
    status: 'pressured',
    reason: { code: 'mac-memory-warning' },
    source: 'darwin-sysctl-dispatch',
    executionScope: 'darwin:host',
    facts: { pressureLevel: 'warning' }
  })
  await runtime.shutdownAll()
  await vi.waitFor(() =>
    expect(onMemoryPolicyChanged).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pressured', facts: { pressureLevel: 'warning' } }),
      false
    )
  )
})

it('recovers a failed sample for one prepared continuation without forcing the next Agent request', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-user-retry-recovery-'))
  const submissions: Array<{ signal: AbortSignal; force: boolean }> = []
  let sampledAt = 0
  const memoryPolicy = {
    getState: async (request?: { signal?: AbortSignal; force?: boolean }) => {
      if (!request?.signal)
        return {
          status: 'healthy' as const,
          reason: { code: 'healthy' },
          source: 'test-os',
          executionScope: 'test:host'
        }
      submissions.push({ signal: request.signal, force: request.force === true })
      if (request.force) sampledAt = 1000
      return sampledAt
        ? {
            status: 'healthy' as const,
            reason: { code: 'healthy' },
            source: 'test-os',
            executionScope: 'test:host',
            sampledAt
          }
        : {
            status: 'unavailable' as const,
            reason: { code: 'sample-failed', retryAfterMs: 30_000 },
            source: 'test-os',
            executionScope: 'test:host'
          }
    },
    currentState: () => ({
      status: sampledAt ? ('healthy' as const) : ('unavailable' as const),
      reason: { code: sampledAt ? 'healthy' : 'sample-failed' },
      source: 'test-os',
      executionScope: 'test:host',
      sampledAt: sampledAt || undefined
    })
  }
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy
  })
  const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  await expect(
    runtime.executeControl(
      withNotebookExecutionIntent(
        { ...scope, code: 'globalThis.rejected = true' },
        runtime.createExecutionIntent(scope)
      )
    )
  ).rejects.toMatchObject({ code: 'NOTEBOOK_MEMORY_UNAVAILABLE' })
  const intent = runtime.createExecutionIntent(scope)
  intent.prepareUserExecution(() => undefined)
  intent.commitUserExecution()
  await expect(
    runtime.executeControl(
      withNotebookExecutionIntent({ ...scope, code: 'globalThis.recovered = 1' }, intent)
    )
  ).resolves.toMatchObject({ status: 'completed' })
  await expect(
    runtime.executeControl(
      withNotebookExecutionIntent({ ...scope, code: 'globalThis.agent = 2' }, intent)
    )
  ).resolves.toMatchObject({ status: 'completed' })
  const first = submissions.find(({ force }) => force)
  const last = submissions.at(-1)
  expect(first).toBeDefined()
  expect(last?.force).toBe(false)
  expect(last?.signal).not.toBe(first?.signal)
  expect(
    submissions.filter(({ signal }) => signal === first?.signal).every(({ force }) => force)
  ).toBe(true)
  expect(
    submissions.filter(({ signal }) => signal === last?.signal).every(({ force }) => !force)
  ).toBe(true)
  expect(
    submissions
      .filter(({ signal }) => signal !== first?.signal && signal !== last?.signal)
      .every(({ force }) => !force)
  ).toBe(true)
})

it('keeps ordinary and abandoned preparations from granting a forced sample', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-no-user-recheck-'))
  const policy = healthyNotebookMemoryPolicy()
  const getState = vi.fn(policy.getState)
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: { ...policy, getState }
  })
  const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  const intent = runtime.createExecutionIntent(scope)
  intent.prepareUserExecution()
  intent.commitUserExecution()
  await runtime.executeControl(withNotebookExecutionIntent({ ...scope, code: '1' }, intent))
  expect(getState.mock.calls.some(([request]) => request?.force)).toBe(false)

  const abandoned = runtime.createExecutionIntent(scope)
  abandoned.prepareUserExecution(() => undefined)
  abandoned.abandonUserExecution()
  expect(abandoned.consumeUserMemoryRecheck()).toBeUndefined()
  expect(() => abandoned.assertExecutable()).toThrow('Execution was not started')
})

it('checks the trusted continuation lease again after asynchronous sampling', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-expired-user-recheck-'))
  let current = true
  const policy = healthyNotebookMemoryPolicy()
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: {
      ...policy,
      getState: async (request) => {
        if (request?.force) current = false
        return policy.getState(request)
      }
    }
  })
  const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  const intent = runtime.createExecutionIntent(scope)
  intent.prepareUserExecution(() => {
    if (!current) throw new Error('Human execution lease expired')
  })
  intent.commitUserExecution()
  await expect(
    runtime.executeControl(withNotebookExecutionIntent({ ...scope, code: '1' }, intent))
  ).rejects.toThrow('Human execution lease expired')
  expect((await runtime.state(scope)).runs).toEqual([])
})

it('forces terminal sampling only with the Main-owned user marker and preserves the live kernel', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-terminal-user-recheck-'))
  const policy = healthyNotebookMemoryPolicy()
  const getState = vi.fn(policy.getState)
  const identity = {}
  const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: request.cwd,
    outputs: []
  }))
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: { ...policy, getState },
    executorFactory: () => ({
      execute,
      shutdown: async () => ({ reaped: true }),
      idleProcesses: () => [
        { identity, processKey: 'python:default-python', release: async () => true }
      ]
    })
  })
  const request = {
    sessionId: 'session',
    workspaceCwd: root,
    source: 'user' as const,
    language: 'python' as const,
    code: '1'
  }
  expect((await runtime.execute(request)).status).toBe('completed')
  getState.mockClear()
  const terminal = { ...request, inputKind: 'terminal' as const }
  expect((await runtime.execute(terminal)).status).toBe('completed')
  expect(getState.mock.calls.some(([options]) => options?.force)).toBe(false)
  getState.mockClear()
  const assertCurrent = vi.fn()
  expect(
    (await runtime.execute(withNotebookUserOperation(terminal, { assertCurrent }))).status
  ).toBe('completed')
  expect(getState.mock.calls.some(([options]) => options?.force)).toBe(true)
  expect(assertCurrent).toHaveBeenCalled()
  expect(execute).toHaveBeenCalledTimes(3)
})

it('rejects pressure before accepting a REPL execution while history remains readable', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
  const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: request.cwd,
    outputs: []
  }))
  const state = {
    status: 'pressured' as const,
    reason: { code: 'pressure-warning' },
    source: 'test-os',
    executionScope: 'test:host'
  }
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: { getState: async () => state, currentState: () => state },
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) })
  })
  await expect(
    runtime.executeControl({ sessionId: 'one', workspaceCwd: root, code: '1' })
  ).rejects.toMatchObject({
    code: 'NOTEBOOK_MEMORY_PRESSURE',
    recovery: { execution: 'not-started' }
  })
  expect(execute).not.toHaveBeenCalled()
  const history = await runtime.state({ sessionId: 'one', workspaceCwd: root })
  expect(history.runs).toEqual([])
})

it.each(['repl', 'python', 'r', 'shell'] as const)(
  'records a compatible not-started failure after submission for %s',
  async (surface) => {
    root = await mkdtemp(join(tmpdir(), 'runtime-admission-'))
    const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
      status: 'completed' as const,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: []
    }))
    const healthy = {
      status: 'healthy' as const,
      reason: { code: 'healthy' },
      source: 'test-os',
      executionScope: 'test:host'
    }
    const pressured = {
      ...healthy,
      status: 'pressured' as const,
      reason: { code: 'pressure-warning' }
    }
    runtime = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: {
        getState: async () => healthy,
        currentState: vi.fn().mockReturnValueOnce(healthy).mockReturnValue(pressured)
      },
      executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
      shellProcess: {
        execute: async () => {
          throw new Error('Refused Shell must not be dispatched')
        }
      }
    })
    const request = { sessionId: 'one', workspaceCwd: root }
    const result =
      surface === 'repl'
        ? await runtime.executeControl({ ...request, code: 'globalThis.saved = 1' })
        : surface === 'shell'
          ? await runtime.executeShell({ ...request, command: 'saved=1' })
          : await runtime.execute({ ...request, language: surface, source: 'user', code: '1' })
    expect(result).toMatchObject({
      recovery: { execution: 'not-started' },
      ...(surface === 'shell' ? { exitCode: 1 } : { status: 'failed' })
    })
    expect(execute).not.toHaveBeenCalled()
    const state = await runtime.state(request)
    expect(state.runs[0]).toMatchObject({
      status: 'failed',
      kernelDispatched: false,
      executionStarted: false,
      recovery: { execution: 'not-started' }
    })
    expect(state.environments.some((environment) => environment.status === 'running')).toBe(false)
  }
)

it.each(['python', 'repl', 'shell'] as const)(
  'keeps background %s admission independent of the transport after its receipt',
  async (surface) => {
    root = await mkdtemp(join(tmpdir(), 'runtime-background-admission-'))
    let approve!: (approved: boolean) => void
    const approval = new Promise<boolean>((resolve) => {
      approve = resolve
    })
    const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
      status: 'completed' as const,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: []
    }))
    const shell = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    runtime = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
      shellProcess: { execute: shell }
    })
    runtime.setExecutionApproval(async () => approval)
    const transport = new AbortController()
    const request = { sessionId: 'one', workspaceCwd: root, background: true }
    const receipt =
      surface === 'repl'
        ? await runtime.executeControlBackground({ ...request, code: '1' }, transport.signal)
        : surface === 'shell'
          ? await runtime.executeShellBackground(
              { ...request, command: 'echo 1' },
              transport.signal
            )
          : await runtime.executeBackground(
              { ...request, language: 'python', code: '1' },
              transport.signal
            )
    transport.abort(new Error('Transport disconnected after receipt'))
    approve(true)
    await runtime.waitForBackgroundRun(receipt.runId)
    const state = await runtime.getBackgroundRun({ ...request, runId: receipt.runId })
    expect(state.run.status).toBe('completed')
    expect(surface === 'shell' ? shell : execute).toHaveBeenCalledOnce()
  }
)

it('freezes the terminal live process before asynchronous admission and keeps legacy cell execution available', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-terminal-admission-'))
  let identity = {}
  const policy = healthyNotebookMemoryPolicy()
  const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
    status: 'completed' as const,
    stdout: '',
    stderr: '',
    traceback: '',
    cwdAfter: request.cwd,
    outputs: []
  }))
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: policy,
    executorFactory: () => ({
      execute,
      shutdown: async () => ({ reaped: true }),
      idleProcesses: () => [
        { identity, processKey: 'python:default-python', release: async () => true }
      ]
    })
  })
  const request = {
    sessionId: 'one',
    workspaceCwd: root,
    source: 'user' as const,
    language: 'python' as const,
    code: '1'
  }
  // Missing inputKind is the historical cell contract, which may start a kernel.
  expect((await runtime.execute(request)).status).toBe('completed')
  const before = execute.mock.calls.length
  const original = policy.getState
  policy.getState = async (options) => {
    identity = {}
    return original(options)
  }
  await expect(runtime.execute({ ...request, inputKind: 'terminal' })).rejects.toMatchObject({
    code: 'NOTEBOOK_TERMINAL_KERNEL_UNAVAILABLE',
    recovery: { execution: 'not-started' }
  })
  expect(execute.mock.calls.length).toBe(before)
})

it.each([{}, { kernel: 'repl' as const }])(
  'preserves a live namespace and editing state when restart is refused: %j',
  async (target) => {
    root = await mkdtemp(join(tmpdir(), 'runtime-restart-admission-'))
    const policy = healthyNotebookMemoryPolicy()
    const restart = vi.fn(async () => undefined)
    runtime = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: policy,
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        restart,
        terminate: restart
      })
    })
    const request = { sessionId: 'one', workspaceCwd: root }
    await runtime.executeControl({ ...request, code: '1' })
    const before = await runtime.state(request)
    policy.getState = async () => ({
      status: 'unavailable',
      source: 'test-os',
      executionScope: 'test:host',
      reason: { code: 'sample-failed' }
    })
    await expect(runtime.restart({ ...request, ...target })).rejects.toMatchObject({
      code: 'NOTEBOOK_MEMORY_UNAVAILABLE'
    })
    expect(restart).not.toHaveBeenCalled()
    expect(await runtime.state(request)).toEqual(before)
  }
)
