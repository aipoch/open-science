import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookShellProcessAdapter } from './shell-process'
import {
  createNotebookExecutionAdmission,
  NotebookExecutionAdmissionError
} from './execution-admission'
import type { NotebookProcessSandbox } from './process-sandbox'
import { MemoryPolicyService, type MemoryPolicySample } from './memory-policy'

const sandbox = (hooks: { wrap?: () => void; begin?: () => void }): NotebookProcessSandbox => ({
  wrap: async (invocation) => {
    hooks.wrap?.()
    return {
      ...invocation,
      annotateStderr: (stderr) => stderr,
      beginExecution: () => {
        hooks.begin?.()
        return () => undefined
      },
      cleanup: async (_reason, outcome) => ({
        processesTerminated: outcome.processesTerminated,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    }
  }
})

const executors: NotebookKernelExecutor[] = []
const roots: string[] = []
const shells: NotebookShellProcessAdapter[] = []
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.shutdown()
  for (const shell of shells.splice(0)) await shell.shutdown()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('refuses a new interpreter at the real creation boundary without creating a live namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-admission-'))
  roots.push(root)
  let pressured = false
  const executor = new NotebookKernelExecutor({
    processSandbox: sandbox({
      wrap: () => {
        pressured = true
      }
    })
  })
  executors.push(executor)
  const result = await executor.execute({
    projectId: 'project',
    sessionId: 'one',
    kind: 'repl',
    code: 'globalThis.saved = 1',
    cwd: root,
    notebookSessionRoot: root,
    dataRoot: root,
    runtimeRoot: root,
    executionAdmission: {
      prepare: async () => undefined,
      assertCurrent: (boundary) => {
        if (boundary === 'create' && pressured)
          throw new NotebookExecutionAdmissionError(
            'NOTEBOOK_MEMORY_PRESSURE',
            'Execution was not started.'
          )
      }
    }
  })
  expect(result).toMatchObject({
    status: 'failed',
    kernelDispatched: false,
    recovery: { execution: 'not-started' }
  })
  expect(executor.idleProcesses()).toEqual([])
})

it('refuses dispatch on a reused interpreter and preserves its existing variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-admission-'))
  roots.push(root)
  let pressured = false
  let pressureOnBegin = false
  const executor = new NotebookKernelExecutor({
    processSandbox: sandbox({
      begin: () => {
        if (pressureOnBegin) pressured = true
      }
    })
  })
  executors.push(executor)
  const request = {
    projectId: 'project',
    sessionId: 'one',
    kind: 'repl' as const,
    cwd: root,
    notebookSessionRoot: root,
    dataRoot: root,
    runtimeRoot: root
  }
  const initial = await executor.execute({ ...request, code: 'globalThis.saved = 41' })
  expect(initial.status, initial.stderr || initial.traceback).toBe('completed')
  pressureOnBegin = true
  const result = await executor.execute({
    ...request,
    code: 'globalThis.saved = 0',
    executionAdmission: {
      prepare: async () => undefined,
      assertCurrent: (boundary) => {
        if (boundary === 'dispatch' && pressured)
          throw new NotebookExecutionAdmissionError(
            'NOTEBOOK_MEMORY_PRESSURE',
            'Execution was not started.'
          )
      }
    }
  })
  expect(result).toMatchObject({ status: 'failed', kernelDispatched: false })
  const retained = await executor.execute({ ...request, code: 'console.log(globalThis.saved)' })
  expect(retained.stdout.trim()).toBe('41')
})

it('refuses a delayed healthy sample before dispatch on a reused interpreter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-sample-admission-'))
  roots.push(root)
  const executor = new NotebookKernelExecutor({ processSandbox: sandbox({}) })
  executors.push(executor)
  const request = {
    projectId: 'project',
    sessionId: 'one',
    kind: 'repl' as const,
    cwd: root,
    notebookSessionRoot: root,
    dataRoot: root,
    runtimeRoot: root
  }
  expect((await executor.execute({ ...request, code: 'globalThis.saved = 41' })).status).toBe(
    'completed'
  )
  let now = 1000
  let wall = 10_000
  const started = Promise.withResolvers<void>()
  const deferred = Promise.withResolvers<MemoryPolicySample>()
  const policy = new MemoryPolicyService({
    adapter: {
      platform: 'linux',
      sample: async () => {
        started.resolve()
        return deferred.promise
      }
    },
    now: () => now,
    wallNow: () => wall
  })
  try {
    const waiting = executor.execute({
      ...request,
      code: 'globalThis.saved = 0',
      executionAdmission: createNotebookExecutionAdmission({ policy: async () => policy })
    })
    await started.promise
    now += 3000
    wall += 3000
    deferred.resolve({
      platform: 'linux',
      source: 'test',
      executionScope: 'linux:host',
      facts: { availableBytes: 800, totalBytes: 1000, overcommitMode: 0 }
    })

    await expect(waiting).resolves.toMatchObject({
      status: 'failed',
      kernelDispatched: false,
      recovery: { execution: 'not-started' }
    })
    const retained = await executor.execute({ ...request, code: 'console.log(globalThis.saved)' })
    expect(retained.stdout.trim()).toBe('41')
  } finally {
    policy.dispose()
  }
})

it.skipIf(process.platform === 'win32')(
  'preserves a reused Shell namespace when final dispatch is refused',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-shell-admission-'))
    roots.push(root)
    let pressured = false
    let pressureOnBegin = false
    const shell = new NotebookShellProcessAdapter(
      process.platform,
      sandbox({
        begin: () => {
          if (pressureOnBegin) pressured = true
        }
      })
    )
    shells.push(shell)
    const request = {
      projectId: 'project',
      sessionId: 'one',
      cwd: root,
      handoffDir: root,
      runtimeRoot: root
    }
    expect(await shell.execute({ ...request, command: 'saved=41' })).toMatchObject({ exitCode: 0 })
    pressureOnBegin = true
    const result = await shell.execute({
      ...request,
      command: 'saved=0',
      executionAdmission: {
        prepare: async () => undefined,
        assertCurrent: (boundary) => {
          if (boundary === 'dispatch' && pressured)
            throw new NotebookExecutionAdmissionError(
              'NOTEBOOK_MEMORY_PRESSURE',
              'Execution was not started.'
            )
        }
      }
    })
    expect(result).toMatchObject({ exitCode: 1, recovery: { execution: 'not-started' } })
    expect((await shell.execute({ ...request, command: 'printf %s "$saved"' })).stdout).toBe('41')
  }
)
