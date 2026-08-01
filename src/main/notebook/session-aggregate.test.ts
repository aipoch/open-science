import { describe, expect, it } from 'vitest'

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
      cwd: '/workspace/data',
      notebookSessionRoot: '/workspace',
      dataRoot: '/workspace/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/workspace/run.json',
      executionCount: 0,
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
})
