import { createNotebookCellPreview } from '../../shared/notebook-process-monitor'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookProcessMonitor, type MonitoredInterpreter } from './process-monitor'

const children: ReturnType<typeof spawn>[] = []
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    })
  )
})

function resource(overrides: Partial<MonitoredInterpreter> = {}): MonitoredInterpreter {
  return {
    identity: {},
    processKey: 'python:default-python',
    kind: 'python',
    sessionId: 's1',
    projectId: 'p1',
    lane: 'root',
    startedAt: Date.now(),
    status: 'idle',
    terminate: vi.fn(async () => {}),
    ...overrides
  }
}

describe('Notebook process monitor prototype', () => {
  it('samples real host metrics and an owned child without spawning an interpreter on refresh', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    children.push(child)
    await once(child, 'spawn')
    const item = resource({ pid: child.pid })
    const monitor = new NotebookProcessMonitor(() => [item])
    const snapshot = await monitor.snapshot()
    expect(snapshot.host.memoryTotalBytes).toBeGreaterThan(0)
    expect(snapshot.host.cpuCount).toBeGreaterThan(0)
    expect(snapshot.instances[0].pid).toBe(child.pid)
    if (process.platform !== 'win32') {
      expect(snapshot.processMetricsAvailable).toBe(true)
      expect(snapshot.instances[0].processes.some((sample) => sample.pid === child.pid)).toBe(true)
      expect(snapshot.instances[0].memoryBytes).toBeGreaterThan(0)
    }
    const exited = once(child, 'exit')
    item.terminate = async () => {
      child.kill()
      await exited
    }
    await monitor.terminate(snapshot.instances[0].id)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('refuses a stale instance ID after its owner was replaced, even with the same PID', async () => {
    let item = resource({ pid: 12345 })
    const monitor = new NotebookProcessMonitor(() => [item])
    const id = (await monitor.snapshot()).instances[0].id
    item = resource({ pid: 12345 })
    await expect(monitor.terminate(id)).rejects.toThrow('no longer exists')
    expect(item.terminate).not.toHaveBeenCalled()
    await expect(monitor.terminate('12345')).rejects.toThrow('no longer exists')
  })

  it('deduplicates simultaneous termination and retains resources when cleanup fails', async () => {
    const stopped = Promise.withResolvers<void>()
    const item = resource({ status: 'cleanup-failed', terminate: vi.fn(() => stopped.promise) })
    const monitor = new NotebookProcessMonitor(() => [item])
    const id = (await monitor.snapshot()).instances[0].id
    const first = monitor.terminate(id)
    const second = monitor.terminate(id)
    expect(first).toBe(second)
    expect(item.terminate).toHaveBeenCalledOnce()
    const failure = expect(first).rejects.toThrow('not reaped')
    stopped.reject(new Error('not reaped'))
    await failure
    expect((await monitor.snapshot()).instances[0].status).toBe('cleanup-failed')
  })
})

describe('session termination feedback', () => {
  it('stops selected session instances, records partial failures and preserves other sessions', async () => {
    const first = resource()
    const second = resource({
      terminate: vi.fn(async () => {
        throw new Error('busy')
      })
    })
    const other = resource({ sessionId: 's2' })
    const monitor = new NotebookProcessMonitor(() => [first, second, other])
    const snapshot = await monitor.snapshot()
    await expect(
      monitor.terminateRequest({
        ids: snapshot.instances.slice(0, 2).map((item) => item.id),
        projectId: 'p1',
        sessionId: 's1',
        comment: 'Too much memory; use chunks'
      })
    ).rejects.toThrow('Some kernel cleanup')
    expect(first.terminate).toHaveBeenCalledOnce()
    expect(second.terminate).toHaveBeenCalledOnce()
    expect(other.terminate).not.toHaveBeenCalled()
    expect(
      monitor.manualTerminations('p1', 's1').map((event) => [event.status, event.comment])
    ).toEqual([
      ['stopped', 'Too much memory; use chunks'],
      ['cleanup-failed', 'Too much memory; use chunks']
    ])
    expect(monitor.manualTerminations('p2', 's1')).toEqual([])
  })

  it('validates the complete group before stopping anything and rejects oversized comments', async () => {
    const first = resource()
    const other = resource({ sessionId: 's2' })
    const monitor = new NotebookProcessMonitor(() => [first, other])
    const snapshot = await monitor.snapshot()
    await expect(
      monitor.terminateRequest({
        ids: snapshot.instances.map((item) => item.id),
        projectId: 'p1',
        sessionId: 's1'
      })
    ).rejects.toThrow('does not belong')
    await expect(
      monitor.terminateRequest({
        id: snapshot.instances[0].id,
        projectId: 'p1',
        sessionId: 's1',
        comment: 'x'.repeat(2001)
      })
    ).rejects.toThrow('comment')
    expect(first.terminate).not.toHaveBeenCalled()
    expect(monitor.manualTerminations('p1', 's1')).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'measures interval CPU consumption for a real busy process',
    async () => {
      const child = spawn(process.execPath, ['-e', 'while (true) { Math.sqrt(Math.random()) }'], {
        stdio: 'ignore'
      })
      children.push(child)
      await once(child, 'spawn')
      const monitor = new NotebookProcessMonitor(() => [resourceInstance])
      const resourceInstance = resource({ pid: child.pid })
      expect((await monitor.snapshot()).instances[0].cpuCores).toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 1400))
      const sample = (await monitor.snapshot()).instances[0]
      expect(sample.cpuCores).toBeGreaterThan(0)
      expect(sample.memoryBytes).toBeGreaterThan(0)
    }
  )
})

it('bounds cell previews and preserves R source through monitoring', async () => {
  const source = 'x <- rnorm(100)\n'.repeat(3000)
  const preview = createNotebookCellPreview(source)
  expect(preview.code).toHaveLength(32_000)
  expect(preview.truncated).toBe(true)
  const monitor = new NotebookProcessMonitor(() => [resource({ kind: 'r', lastCell: preview })])
  expect((await monitor.snapshot()).instances[0].lastCell).toEqual(preview)
})

it('validates the owner scope for single-kernel stops as well as session stops', async () => {
  const item = resource()
  const monitor = new NotebookProcessMonitor(() => [item])
  const id = (await monitor.snapshot()).instances[0].id
  await expect(monitor.terminateRequest({ id, projectId: 'p2', sessionId: 's1' })).rejects.toThrow(
    'does not belong'
  )
  await expect(monitor.terminateRequest({ id, projectId: 'p1', sessionId: 's2' })).rejects.toThrow(
    'does not belong'
  )
  expect(item.terminate).not.toHaveBeenCalled()
})

it('keeps new instances out of a captured Stop all selection and permits retry after partial failure', async () => {
  const first = resource()
  let fails = true
  const second = resource({
    terminate: vi.fn(async () => {
      if (fails) throw new Error('cleanup incomplete')
    })
  })
  const items = [first, second]
  const monitor = new NotebookProcessMonitor(() => items)
  const ids = (await monitor.snapshot()).instances.map((item) => item.id)
  const later = resource()
  items.push(later)
  await expect(monitor.terminateRequest({ ids, projectId: 'p1', sessionId: 's1' })).rejects.toThrow(
    'Some kernel cleanup'
  )
  fails = false
  await monitor.terminateRequest({ id: ids[1], projectId: 'p1', sessionId: 's1' })
  expect(first.terminate).toHaveBeenCalledOnce()
  expect(second.terminate).toHaveBeenCalledTimes(2)
  expect(later.terminate).not.toHaveBeenCalled()
  expect(monitor.manualTerminations('p1', 's1').at(-1)?.status).toBe('stopped')
})
