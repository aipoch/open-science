import { describe, expect, it, vi } from 'vitest'

import type { NotebookCell } from '../../shared/notebook'

import { createRootNotebookLane } from './lane-identity'
import { NotebookSessionAggregate } from './session-aggregate'

describe('NotebookSessionAggregate', () => {
  it('keeps a stable kernel epoch until that process is terminated', async () => {
    const terminate = vi.fn(async () => undefined)
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectId: 'default-project',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
      executorGeneration: Symbol('executor-1'),
      executor: {
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        terminate
      }
    })

    const first = session.kernelEpochId('python:default-python')
    expect(session.kernelEpochId('python:default-python')).toBe(first)

    const managed = session.kernelEpoch('python:default-python', false, '')
    expect(session.kernelEpoch('python:default-python', false, '')).toBe(managed)
    expect(session.kernelEpoch('python:default-python', false, '/usr/bin/python3')).not.toBe(
      managed
    )

    await session.terminateExecutor('python', 'default-python')

    expect(terminate).toHaveBeenCalledWith('python', 'default-python')
    expect(session.kernelEpochId('python:default-python')).not.toBe(first)
  })

  it('serializes execution for one process while allowing another process to run', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectId: 'default-project',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
      executorGeneration: Symbol('executor-1'),
      executor: {
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    })

    const first = session.enqueueExecution('python:default-python', async () => {
      started.push('first')
      await firstGate
      return 'first-result'
    })
    const second = session.enqueueExecution('python:default-python', async () => {
      started.push('second')
      return 'second-result'
    })
    const other = session.enqueueExecution('r:default-r', async () => {
      started.push('other')
      return 'other-result'
    })

    expect(session.hasPendingExecution('python:default-python')).toBe(true)
    expect(session.hasPendingExecution('r:default-r')).toBe(true)

    await expect(other).resolves.toBe('other-result')
    expect(session.hasPendingExecution('r:default-r')).toBe(false)
    expect(started).toEqual(['first', 'other'])

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first-result', 'second-result'])
    expect(session.hasPendingExecution('python:default-python')).toBe(false)
    expect(started).toEqual(['first', 'other', 'second'])
  })

  it('settles an aborted queued execution without waiting for the active process', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectId: 'default-project',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
      executorGeneration: Symbol('executor-1'),
      executor: {
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    })
    const first = session.enqueueExecution('python:default-python', async () => {
      await firstGate
      return 'first-result'
    })
    const cancellation = new AbortController()
    const queuedTask = vi.fn(async () => 'queued-result')
    const queued = session.enqueueExecution(
      'python:default-python',
      queuedTask,
      cancellation.signal
    )

    cancellation.abort()

    await expect(queued).rejects.toBe(cancellation.signal.reason)
    expect(queuedTask).not.toHaveBeenCalled()
    releaseFirst()
    await expect(first).resolves.toBe('first-result')
    await session.drainExecution('python:default-python')
    expect(queuedTask).not.toHaveBeenCalled()
  })

  it('tracks concurrent kernel runs and lets only the latest starter publish cwd', () => {
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectId: 'default-project',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
      executorGeneration: Symbol('executor-1'),
      executor: {
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    })
    for (const [cellId, language] of [
      ['cell-python', 'python'],
      ['cell-r', 'r']
    ] as const) {
      session.beginCellWrite({
        cellId,
        language,
        writeId: `write-${cellId}`,
        source: 'agent',
        startedAt: 1
      })
      session.finishCellWrite(cellId, `write-${cellId}`)
    }

    session.markCellRunning('cell-python', 'run-python-1', 1)
    session.markCellRunning('cell-r', 'run-r-1', 2)
    session.completeCellRun('cell-python', 'completed', '/workspace/python-first')

    expect(session.hasActiveRun()).toBe(true)
    expect(session.snapshot()).toMatchObject({
      activeRunId: 'run-r-1',
      cwd: '/workspace/data'
    })

    session.completeCellRun('cell-r', 'completed', '/workspace/r-latest')
    expect(session.hasActiveRun()).toBe(false)
    expect(session.cwd).toBe('/workspace/r-latest')

    session.markCellRunning('cell-python', 'run-python-2', 3)
    session.markCellRunning('cell-r', 'run-r-2', 4)
    session.completeCellRun('cell-r', 'completed', '/workspace/r-newer')
    session.completeCellRun('cell-python', 'completed', '/workspace/python-stale')

    expect(session.hasActiveRun()).toBe(false)
    expect(session.cwd).toBe('/workspace/r-newer')
  })

  it('returns snapshots that cannot mutate owned cell or kernel state', () => {
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectId: 'default-project',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
      executorGeneration: Symbol('executor-1'),
      executor: {
        execute: async () => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: '/workspace/data',
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    })
    session.beginCellWrite({
      cellId: 'cell-1',
      language: 'python',
      writeId: 'write-1',
      source: 'agent',
      startedAt: 1
    })
    session.appendCellCode('cell-1', 'write-1', 'original')
    session.finishCellWrite('cell-1', 'write-1')
    session.setKernelStatus('python:default-python', 'idle')

    const snapshot = session.snapshot()
    ;(snapshot.cells as NotebookCell[])[0].code = 'mutated'
    ;(snapshot.kernelStatuses as Array<[string, (typeof snapshot.kernelStatuses)[number][1]]>).push(
      ['r:default-r', 'running']
    )

    expect(session.snapshot()).toMatchObject({
      cells: [{ id: 'cell-1', code: 'original', status: 'idle' }],
      kernelStatuses: [['python:default-python', 'idle']]
    })

    for (const status of ['completed', 'failed', 'timeout', 'interrupted', 'cancelled'] as const) {
      session.markCellRunning('cell-1', `run-${status}`, 1)
      session.completeCellRun('cell-1', status, '/workspace/data')
      expect(session.cellView('cell-1').status).toBe(status)
    }
  })
})
