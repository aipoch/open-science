import { describe, expect, it } from 'vitest'

import type { NotebookCell } from '../../shared/notebook'

import { createRootNotebookLane } from './lane-identity'
import { NotebookSessionAggregate } from './session-aggregate'

describe('NotebookSessionAggregate', () => {
  it('serializes execution for one process while allowing another process to run', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectName: 'default-project',
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

    await expect(other).resolves.toBe('other-result')
    expect(started).toEqual(['first', 'other'])

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first-result', 'second-result'])
    expect(started).toEqual(['first', 'other', 'second'])
  })

  it('returns snapshots that cannot mutate owned cell or kernel state', () => {
    const session = new NotebookSessionAggregate({
      sessionId: 'session-1',
      projectName: 'default-project',
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
  })
})
