import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NotebookRuntimeService } from './runtime-service'
import { MemoryPolicyService } from './memory-policy'

let root: string | undefined
let runtime: NotebookRuntimeService | undefined
afterEach(async () => {
  await runtime?.dispose()
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

it('shares execution samples with the idle owner and retains history after pressure cleanup', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-pressure-'))
  const time = Date.now()
  const now = vi.spyOn(Date, 'now').mockReturnValue(time)
  let availableBytes = 50
  let busy = true
  let exporting = false
  let live = false
  const identity = {}
  const isSessionBusy = vi.fn(() => busy)
  const policy = new MemoryPolicyService({
    now: Date.now,
    adapter: {
      platform: 'win32',
      sample: async () => ({
        platform: 'win32',
        source: 'test-system',
        executionScope: 'windows:host',
        facts: { availableBytes, totalBytes: 100, committedBytes: 50, commitLimitBytes: 100 }
      })
    }
  })
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: policy,
    isSessionBusy,
    isSessionExporting: () => exporting,
    executorFactory: () => ({
      execute: async (request) => {
        live = true
        return {
          status: 'completed',
          stdout: 'saved result',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }
      },
      idleProcesses: () =>
        live
          ? [
              {
                identity,
                executionDomain: 'host',
                processKey: 'repl',
                release: async () => {
                  live = false
                  return true
                }
              }
            ]
          : [],
      shutdown: async () => ({ reaped: true })
    })
  })
  await runtime.executeControl({ sessionId: 'one', workspaceCwd: root, code: 'console.log(1)' })
  const beforeIdle = isSessionBusy.mock.calls.length
  busy = false
  runtime.noteSessionActivity('one')
  await vi.waitFor(() => expect(isSessionBusy.mock.calls.length).toBeGreaterThan(beforeIdle))
  now.mockReturnValue(time + 5 * 60_000)
  availableBytes = 5
  exporting = true
  await policy.getState({ force: true })
  runtime.noteSessionActivity('other-session')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(live).toBe(true)
  exporting = false
  runtime.noteSessionActivity('other-session')
  await vi.waitFor(() => expect(live).toBe(false))
  const history = await runtime.state({ sessionId: 'one', workspaceCwd: root })
  expect(history.runs[0]).toMatchObject({ status: 'completed', text: { stdout: 'saved result' } })
  expect(history.environments).toContainEqual({
    processKey: 'repl',
    kind: 'repl',
    status: 'terminated'
  })
})

it('ends a rejected call without waiting for pressure cleanup or retrying after recovery', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-pressure-rejection-'))
  const time = Date.now()
  const now = vi.spyOn(Date, 'now').mockReturnValue(time)
  let availableBytes = 50
  let live = true
  let cleanupStarted = false
  const cleanup = Promise.withResolvers<void>()
  const execute = vi.fn()
  const isSessionBusy = vi.fn(() => false)
  const identity = {}
  const policy = new MemoryPolicyService({
    now: Date.now,
    adapter: {
      platform: 'win32',
      sample: async () => ({
        platform: 'win32',
        source: 'test-system',
        executionScope: 'windows:host',
        facts: { availableBytes, totalBytes: 100, committedBytes: 50, commitLimitBytes: 100 }
      })
    }
  })
  runtime = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: policy,
    isSessionBusy,
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) }),
    shellProcess: {
      execute: vi.fn(),
      resources: () =>
        live
          ? [
              {
                identity,
                projectId: 'project',
                sessionId: 'idle',
                group: 'shell',
                phase: 'idle',
                startedAt: time,
                release: async () => {
                  cleanupStarted = true
                  await cleanup.promise
                  live = false
                  return { reaped: true }
                }
              }
            ]
          : [],
      idleProcesses: () =>
        live
          ? [
              {
                identity,
                projectId: 'project',
                sessionId: 'idle',
                group: 'shell',
                executionDomain: 'host',
                lastUsedAt: time,
                release: async () => {
                  cleanupStarted = true
                  await cleanup.promise
                  live = false
                  return true
                }
              }
            ]
          : []
    }
  })
  try {
    runtime.noteSessionActivity('idle')
    await vi.waitFor(() => expect(isSessionBusy).toHaveBeenCalled())
    now.mockReturnValue(time + 5 * 60_000)
    availableBytes = 5
    await policy.getState({ force: true })
    await vi.waitFor(() => expect(cleanupStarted).toBe(true))
    await expect(
      runtime.executeControl({ sessionId: 'caller', workspaceCwd: root, code: 'sideEffect()' })
    ).rejects.toMatchObject({
      code: 'NOTEBOOK_MEMORY_PRESSURE',
      recovery: { execution: 'not-started' }
    })
    expect(live).toBe(true)
    availableBytes = 50
    await policy.getState({ force: true })
    cleanup.resolve()
    await vi.waitFor(() => expect(live).toBe(false))
    expect(execute).not.toHaveBeenCalled()
  } finally {
    cleanup.resolve()
  }
})
