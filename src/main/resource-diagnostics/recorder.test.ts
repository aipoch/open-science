import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WindowsResourceSample } from '@aipoch/process-tree-native'
import { ResourceLogStore } from './store'
import { ResourceActivity } from './activity'
import {
  ResourceRecorder,
  installResourceRecorder,
  observeResourceProcess,
  resourceFacts
} from './recorder'

const paths: string[] = []
const recorders: ResourceRecorder[] = []
const sample = (processes: WindowsResourceSample['processes'] = []): WindowsResourceSample => ({
  supported: true,
  complete: true,
  startedAt: 100,
  endedAt: 101,
  system: { committedBytes: 10, commitLimitBytes: 20, availableBytes: 30 },
  processes
})
const setup = async (
  native: ConstructorParameters<typeof ResourceRecorder>[0]['native'],
  now = () => 1000,
  scheduling: Pick<
    ConstructorParameters<typeof ResourceRecorder>[0],
    'monotonicNow' | 'yieldToLoop' | 'activity' | 'timers'
  > = {}
): Promise<{
  recorder: ResourceRecorder
  store: ResourceLogStore
  read: () => Promise<ReturnType<typeof JSON.parse>[]>
}> => {
  const path = await mkdtemp(join(tmpdir(), 'resource-recorder-'))
  paths.push(path)
  const store = new ResourceLogStore({ directory: path })
  const recorder = new ResourceRecorder({
    runId: 'run-1',
    store,
    native,
    now,
    timers: false,
    ...scheduling
  })
  recorders.push(recorder)
  installResourceRecorder(recorder)
  const read = async (): Promise<ReturnType<typeof JSON.parse>[]> => {
    await store.flush()
    return (
      await Promise.all(
        (await readdir(path))
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => readFile(join(path, name), 'utf8'))
      )
    )
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  return { recorder, read, store }
}

afterEach(async () => {
  installResourceRecorder(undefined)
  vi.useRealTimers()
  for (const recorder of recorders.splice(0)) await recorder.close(false)
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('resource correlation recorder', () => {
  it('releases only its process listeners across recording stop/start cycles', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 10 }) as ChildProcess
    const ownerExit = vi.fn()
    const ownerError = vi.fn()
    child.on('exit', ownerExit)
    child.on('error', ownerError)
    for (let cycle = 0; cycle < 3; cycle++) {
      const { recorder } = await setup({
        sampleWindowsResources: vi.fn(),
        readWindowsResourceBirth: () => '100'
      })
      observeResourceProcess(child, { runtimeId: 'long-lived' }, () => true)
      expect(child.listenerCount('exit')).toBe(2)
      expect(child.listenerCount('error')).toBe(2)
      installResourceRecorder(undefined)
      await recorder.close(true)
      expect(child.listeners('exit')).toEqual([ownerExit])
      expect(child.listeners('error')).toEqual([ownerError])
    }
    child.emit('exit', 0, null)
    child.emit('error', new Error('owner handles this'))
    expect(ownerExit).toHaveBeenCalledOnce()
    expect(ownerError).toHaveBeenCalledOnce()
  })

  it('releases both diagnostic listeners after exit while retaining exit evidence', async () => {
    const { read } = await setup({
      sampleWindowsResources: vi.fn(),
      readWindowsResourceBirth: () => '100'
    })
    const child = Object.assign(new EventEmitter(), { pid: 10 }) as ChildProcess
    observeResourceProcess(child, { runtimeId: 'exited' }, () => false)
    child.emit('exit', 1, null)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect((await read()).filter((row) => row.event === 'process-exited')).toHaveLength(1)
  })

  it('releases a failed spawn on close without fabricating an exit', async () => {
    const { read } = await setup({
      sampleWindowsResources: vi.fn(),
      readWindowsResourceBirth: vi.fn()
    })
    const child = new EventEmitter() as ChildProcess
    observeResourceProcess(child, { runtimeId: 'failed-spawn' }, () => false)
    child.emit('error', new Error('spawn failed'))
    child.emit('close', -1, null)
    expect(child.eventNames()).toEqual([])
    const records = await read()
    expect(records.filter((row) => row.event === 'process-error')).toHaveLength(1)
    expect(records.filter((row) => row.event === 'process-exited')).toHaveLength(0)
  })

  it('sleeps through slow-sample backoff rather than waking at every normal interval', async () => {
    vi.useFakeTimers()
    const activity = new ResourceActivity()
    const native = {
      sampleWindowsResources: vi.fn().mockRejectedValue(new Error('busy')),
      readWindowsResourceBirth: vi.fn()
    }
    const { store } = await setup(native, Date.now, {
      activity,
      timers: true,
      monotonicNow: Date.now
    })
    await store.flush()
    activity.setDesktop({ foreground: true, suspended: false })
    await vi.advanceTimersByTimeAsync(0)
    await store.flush()
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    activity.setDesktop({ foreground: false, suspended: false })
    expect(vi.getTimerCount()).toBe(0)
    activity.setDesktop({ foreground: true, suspended: false })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(2)
    activity.setDesktop({ foreground: false, suspended: false })
    await store.flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has no idle or suspended sampling timers and resumes only for foreground or work', async () => {
    vi.useFakeTimers()
    const activity = new ResourceActivity()
    const native = {
      sampleWindowsResources: vi.fn().mockResolvedValue(sample()),
      readWindowsResourceBirth: vi.fn()
    }
    const { store } = await setup(native, Date.now, {
      activity,
      timers: true,
      monotonicNow: Date.now
    })
    await store.flush()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(native.sampleWindowsResources).not.toHaveBeenCalled()
    activity.setDesktop({ foreground: true, suspended: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    // Rapid focus edges must not defeat the normal sampling interval.
    for (let i = 0; i < 10; i++) {
      activity.setDesktop({ foreground: false, suspended: false })
      activity.setDesktop({ foreground: true, suspended: false })
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    const endWork = activity.begin()
    activity.setDesktop({ foreground: false, suspended: false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(2)
    activity.setDesktop({ foreground: false, suspended: true })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(2)
    endWork()
    activity.setDesktop({ foreground: false, suspended: false })
    await store.flush()
    expect(vi.getTimerCount()).toBe(0)
    const finish = activity.begin()
    await vi.advanceTimersByTimeAsync(0)
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(3)
    finish()
    await store.flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a single outstanding query through suspend and does not retain its delayed timer', async () => {
    vi.useFakeTimers()
    const activity = new ResourceActivity()
    const pending = Promise.withResolvers<WindowsResourceSample>()
    const native = {
      sampleWindowsResources: vi.fn().mockReturnValue(pending.promise),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, store } = await setup(native, Date.now, {
      activity,
      timers: true,
      monotonicNow: Date.now
    })
    await store.flush()
    activity.setDesktop({ foreground: true, suspended: false })
    await vi.advanceTimersByTimeAsync(0)
    const query = recorder.sample()
    activity.setDesktop({ foreground: true, suspended: true })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    activity.setDesktop({ foreground: true, suspended: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    activity.setDesktop({ foreground: false, suspended: true })
    pending.resolve(sample())
    await query
    expect(vi.getTimerCount()).toBe(0)
    activity.setDesktop({ foreground: false, suspended: false })
    await store.flush()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('yields large snapshots while keeping one query and preserving concurrent identity updates', async () => {
    const suspended = Promise.withResolvers<void>()
    const yielded = Promise.withResolvers<void>()
    const processes = Array.from({ length: 100 }, (_, i) => ({
      pid: i + 10,
      parentPid: 1,
      birth: '100'
    }))
    const native = {
      sampleWindowsResources: vi.fn().mockResolvedValue(sample(processes)),
      readWindowsResourceBirth: vi.fn()
    }
    const yieldToLoop = vi
      .fn()
      .mockImplementationOnce(() => {
        yielded.resolve()
        return suspended.promise
      })
      .mockResolvedValue(undefined)
    const { recorder, read } = await setup(native, () => 1000, {
      monotonicNow: () => 0,
      yieldToLoop
    })
    recorder.observeIdentity({ pid: 10, birth: '100', runtimeId: 'before' })
    const pending = recorder.sample()
    await Promise.race([yielded.promise, pending])
    expect(yieldToLoop).toHaveBeenCalled()
    expect(recorder.sample()).toBe(pending)
    recorder.observeIdentity({ pid: 10, birth: '100', runtimeId: 'updated' })
    recorder.observeIdentity({ pid: 900, birth: '900', runtimeId: 'new' })
    suspended.resolve()
    await pending
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    const rows = await read()
    expect(rows.filter((r) => r.event === 'process-sample')).toHaveLength(100)
    expect(rows.find((r) => r.event === 'segment-checkpoint').data.processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 10, runtimeId: 'updated' }),
        expect.objectContaining({ pid: 900, runtimeId: 'new' })
      ])
    )
  })

  it('stops expensive projections at the round budget, marks incomplete coverage, and backs off', async () => {
    let clock = 0
    let wall = 1000
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockResolvedValue(sample([{ pid: 10, parentPid: 1, birth: '100' }])),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => wall, {
      monotonicNow: () => clock,
      yieldToLoop: async () => {}
    })
    const project = vi.fn(() => {
      clock += 30
      return { status: 'idle' }
    })
    const owner = { resourceDiagnosticSnapshot: project }
    for (let i = 0; i < 10; i++) recorder.register(owner, `r-${i}`)
    recorder.observeIdentity({ pid: 10, birth: '100', runtimeId: 'kept' })
    await recorder.sample()
    expect(project).toHaveBeenCalledTimes(2)
    await recorder.sample()
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) recorder.unregister(`r-${i}`)
    clock += 30_000
    wall += 30_000
    await recorder.sample()
    const rows = await read()
    expect(rows.find((r) => r.event === 'sample-end').data).toMatchObject({
      complete: false,
      truncated: true,
      processed: 1,
      reason: 'processing-budget'
    })
    expect(rows.find((r) => r.event === 'sample-backoff').data.backoffMs).toBe(30_000)
    expect(rows.find((r) => r.event === 'sample-recovered')).toBeDefined()
    expect(rows.find((r) => r.event === 'process-sample').data.runtimeId).toBe('kept')
  })

  it('caps repeated slow native backoff, skips without polling, and resumes after recovery', async () => {
    let clock = 0
    let slow = true
    const native = {
      sampleWindowsResources: vi.fn(async () => {
        if (slow) clock += 2001
        return sample()
      }),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => clock, { monotonicNow: () => clock })
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      await recorder.sample()
      const calls = native.sampleWindowsResources.mock.calls.length
      clock += delay - 1
      await recorder.sample()
      expect(native.sampleWindowsResources).toHaveBeenCalledTimes(calls)
      clock++
    }
    slow = false
    await recorder.sample()
    clock += 10_000
    await recorder.sample()
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(8)
    const rows = await read()
    expect(rows.filter((r) => r.event === 'sample-backoff').map((r) => r.data.backoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000
    ])
    expect(rows.filter((r) => r.event === 'sample-recovered')).toHaveLength(1)
  })

  it('does not resume serialization or repopulate identities after closing during a yield', async () => {
    const suspended = Promise.withResolvers<void>()
    const yielded = Promise.withResolvers<void>()
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockResolvedValue(
          sample(
            Array.from({ length: 100 }, (_, i) => ({ pid: i + 10, parentPid: 1, birth: '100' }))
          )
        ),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => 1000, {
      monotonicNow: () => 0,
      yieldToLoop: () => {
        yielded.resolve()
        return suspended.promise
      }
    })
    const pending = recorder.sample()
    await Promise.race([yielded.promise, pending])
    await recorder.close(true)
    const before = await read()
    suspended.resolve()
    await pending
    expect(await read()).toEqual(before)
    expect(before.some((r) => r.event === 'sample-end')).toBe(false)
  })

  it('limits ancestor traversal as well as serialization, without treating partial coverage as retirement', async () => {
    let clock = 0
    const processes = Array.from({ length: 1000 }, (_, i) => ({
      pid: i + 10,
      parentPid: i + 9,
      birth: '100'
    })).reverse()
    const native = {
      sampleWindowsResources: vi.fn().mockResolvedValue(sample(processes)),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => clock, {
      monotonicNow: () => (clock += 0.01),
      yieldToLoop: async () => {}
    })
    recorder.observeIdentity({ pid: 9999, birth: '200', runtimeId: 'retained' })
    await recorder.sample()
    const rows = await read()
    const end = rows.find((r) => r.event === 'sample-end').data
    expect(end).toMatchObject({ complete: false, truncated: true, reason: 'processing-budget' })
    expect(end.processed).toBeLessThan(1000)
    expect(end.processingMs).toBeLessThan(51)
    expect(rows.find((r) => r.event === 'segment-checkpoint').data.processes).toContainEqual(
      expect.objectContaining({ pid: 9999, runtimeId: 'retained' })
    )
  })

  it('bounds wall time across yields and records a gap instead of draining a stale snapshot', async () => {
    let clock = 0
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockResolvedValue(
          sample(
            Array.from({ length: 100 }, (_, i) => ({ pid: i + 10, parentPid: 1, birth: '100' }))
          )
        ),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => clock, {
      monotonicNow: () => clock,
      yieldToLoop: async () => {
        clock += 2001
      }
    })
    await recorder.sample()
    const rows = await read()
    expect(rows.find((r) => r.event === 'sample-end').data).toMatchObject({
      reason: 'processing-deadline',
      complete: false,
      processed: 0,
      processingMs: 0
    })
    expect(rows.find((r) => r.event === 'sample-backoff').data.reason).toBe('processing-deadline')
  })

  it('rotates partial serialization coverage and recovers the remaining process joins', async () => {
    let clock = 0
    const processes = Array.from({ length: 100 }, (_, i) => ({
      pid: i + 10,
      parentPid: 1,
      birth: '100'
    }))
    const native = {
      sampleWindowsResources: vi.fn().mockResolvedValue(sample(processes)),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, store, read } = await setup(native, () => clock, {
      monotonicNow: () => clock,
      yieldToLoop: async () => {}
    })
    const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementation((line, ...args) => {
      if (line.includes('"event":"process-sample"')) clock += 1
      return append(line, ...args)
    })
    await recorder.sample()
    clock += 30_000
    await recorder.sample()
    const rows = await read()
    const samples = rows.filter((r) => r.event === 'process-sample')
    expect(new Set(samples.map((r) => r.data.pid)).size).toBe(100)
    expect(
      rows
        .filter((r) => r.event === 'sample-end')
        .every((r) => !r.data.complete && r.data.processed === 50)
    ).toBe(true)
  })

  it('retains the single-flight guard and applies backoff when the native query fails', async () => {
    let clock = 0
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockRejectedValueOnce(new Error('native failure'))
        .mockResolvedValue(sample()),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => clock, { monotonicNow: () => clock })
    await recorder.sample()
    await recorder.sample()
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    clock = 30_000
    await recorder.sample()
    const rows = await read()
    expect(rows.find((r) => r.event === 'sample-backoff').data.reason).toBe('failed')
    expect(rows.find((r) => r.event === 'sample-recovered')).toBeDefined()
  })

  it('bounds serialized bytes, preserves gap markers and rotates crowded owners alongside processes', async () => {
    let clock = 0
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockResolvedValue(
          sample(
            Array.from({ length: 100 }, (_, i) => ({ pid: i + 10, parentPid: 1, birth: '100' }))
          )
        ),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, store, read } = await setup(native, () => clock, {
      monotonicNow: () => clock,
      yieldToLoop: async () => {}
    })
    const owner = {
      resourceDiagnosticSnapshot: () => ({
        sessions: Array.from({ length: 200 }, (_, i) => ({
          sessionId: `s-${i}-${'x'.repeat(100)}`
        }))
      })
    }
    for (let i = 0; i < 30; i++) recorder.register(owner, `r-${i}`)
    await recorder.sample()
    expect(store.status.pendingBytes).toBeLessThan(330 * 1024)
    const first = await read()
    expect(first.find((r) => r.event === 'sample-end').data).toMatchObject({
      complete: false,
      reason: 'serialization-budget',
      activityTotal: 30
    })
    expect(first.find((r) => r.event === 'sample-backoff').data.reason).toBe('serialization-budget')
    expect(first.filter((r) => r.event === 'process-sample').length).toBeGreaterThan(0)
    clock += 30_000
    await recorder.sample()
    const rows = await read()
    const activity = rows
      .filter((r) => r.event === 'activity-snapshot')
      .map((r) => r.data.runtimeId)
    expect(new Set(activity).size).toBe(activity.length)
    expect(store.status.dropped).toBe(0)
  })

  it('does not charge event-loop yields to the active processing budget', async () => {
    let clock = 0
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockResolvedValue(
          sample(
            Array.from({ length: 100 }, (_, i) => ({ pid: i + 10, parentPid: 1, birth: '100' }))
          )
        ),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => clock, {
      monotonicNow: () => clock,
      yieldToLoop: async () => {
        clock += 10
      }
    })
    await recorder.sample()
    expect(clock).toBeGreaterThan(50)
    const rows = await read()
    expect(rows.find((r) => r.event === 'sample-end').data).toMatchObject({
      complete: true,
      processed: 100,
      processingMs: 0
    })
    expect(rows.some((r) => r.event === 'sample-backoff')).toBe(false)
  })

  it('stops sampled serialization under queue pressure while leaving room for its gap marker', async () => {
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockResolvedValue(sample([{ pid: 10, parentPid: 1, birth: '100' }])),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, store, read } = await setup(native, () => 1000, { monotonicNow: () => 0 })
    const owner = {
      resourceDiagnosticSnapshot: () => ({
        sessions: Array.from({ length: 256 }, () => ({ sessionId: 's'.repeat(150) }))
      })
    }
    for (let i = 0; i < 13; i++) recorder.snapshot('crowded', owner)
    expect(store.status.pendingBytes).toBeGreaterThan(512 * 1024)
    await recorder.sample()
    const rows = await read()
    expect(rows.find((r) => r.event === 'sample-end').data).toMatchObject({
      complete: false,
      processed: 0,
      reason: 'queue-pressure'
    })
    expect(rows.find((r) => r.event === 'sample-backoff').data.reason).toBe('queue-pressure')
    expect(store.status.dropped).toBe(0)
  })

  it('stops checkpoint construction at the byte budget without reading every crowded runtime', async () => {
    const { recorder, store, read } = await setup({
      sampleWindowsResources: vi.fn(),
      readWindowsResourceBirth: vi.fn()
    })
    const project = vi.fn(() => ({
      sessions: Array.from({ length: 256 }, (_, i) => ({ sessionId: `${'s'.repeat(150)}${i}` }))
    }))
    const owner = { resourceDiagnosticSnapshot: project }
    for (let i = 0; i < 256; i++) recorder.register(owner, `runtime-${i}`)
    await store.flush()
    const records = await read()
    const checkpoint = records.find((r) => r.event === 'segment-checkpoint')
    expect(checkpoint.data.truncated).toBe(true)
    expect(checkpoint.data.total).toBe(256)
    expect(Buffer.byteLength(JSON.stringify(checkpoint) + '\n')).toBeLessThanOrEqual(64 * 1024)
    expect(project.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('limits lifecycle snapshots but reserves periodic status and segment identity evidence', async () => {
    const { recorder, store, read } = await setup({
      sampleWindowsResources: vi.fn().mockResolvedValue(sample()),
      readWindowsResourceBirth: vi.fn()
    })
    const owner = {
      resourceDiagnosticSnapshot: () => ({
        sessions: Array.from({ length: 100 }, (_, i) => ({ sessionId: `s-${i}` }))
      })
    }
    recorder.register(owner, 'runtime')
    for (let i = 0; i < 100; i++) recorder.snapshot('runtime', owner, 'teardown-started')
    expect(store.status.dropped).toBeGreaterThan(0)
    await store.flush()
    await recorder.sample()
    const records = await read()
    expect(records.find((r) => r.event === 'sample-start').data.dropped).toBeGreaterThan(0)
    expect(records.find((r) => r.event === 'activity-snapshot').data.runtimeId).toBe('runtime')
    expect(records.find((r) => r.event === 'segment-checkpoint').data.snapshots[0].runtimeId).toBe(
      'runtime'
    )
  })

  it('keeps only structural metadata, rejecting payloads, credentials and paths', () => {
    expect(
      resourceFacts({
        runtimeId: 'r-1',
        sessionId: 's-1',
        prompt: 'secret',
        env: { TOKEN: 'secret' },
        projectId: 'D:\\private',
        role: 'text with spaces',
        privateBytes: Infinity,
        sessions: [{ sessionId: 's-2', command: 'secret' }]
      })
    ).toEqual({
      runtimeId: 'r-1',
      sessionId: 's-1',
      sessions: [{ sessionId: 's-2' }]
    })
  })

  it('retains exact birth identities and repeats runtime/session mapping in samples without merging epochs', async () => {
    const processes = [
      { pid: 10, parentPid: 1, birth: '134382258633725281', privateBytes: 20 },
      { pid: 11, parentPid: 10, birth: '134382258633725282', privateBytes: 30 }
    ]
    const native = {
      sampleWindowsResources: vi.fn().mockResolvedValue(sample(processes)),
      readWindowsResourceBirth: vi.fn().mockReturnValue(processes[0].birth)
    }
    const { recorder, read } = await setup(native)
    recorder.observeIdentity({
      pid: 10,
      birth: processes[0].birth,
      runtimeId: 'r-a',
      epoch: 1,
      role: 'acp'
    })
    const first = {
      resourceDiagnosticSnapshot: () => ({
        epoch: 1,
        sessions: [{ sessionId: 's-a', providerSessionId: 'provider-a' }],
        retirement: true
      })
    }
    const second = {
      resourceDiagnosticSnapshot: () => ({
        epoch: 1,
        sessions: [{ sessionId: 's-b' }],
        retirement: false
      })
    }
    recorder.register(first, 'r-a')
    recorder.register(second, 'r-b')
    await recorder.sample()
    const records = await read()
    expect(records.filter((r) => r.event === 'activity-snapshot').map((r) => r.data)).toEqual([
      {
        runtimeId: 'r-a',
        epoch: 1,
        sessions: [{ sessionId: 's-a', providerSessionId: 'provider-a' }],
        retirement: true
      },
      { runtimeId: 'r-b', epoch: 1, sessions: [{ sessionId: 's-b' }], retirement: false }
    ])
    expect(
      records.find((r) => r.event === 'process-sample' && r.data.pid === 11)?.data
    ).toMatchObject({
      runtimeId: 'r-a',
      epoch: 1,
      role: 'acp',
      pid: 11,
      birth: processes[1].birth,
      parentPid: 10
    })
    expect(records.find((r) => r.event === 'system-sample')?.data.system.committedBytes).toBe(10)
    expect(records.find((r) => r.event === 'segment-checkpoint').data.processes).toContainEqual(
      expect.objectContaining({
        pid: 11,
        birth: processes[1].birth,
        ownerPid: 10,
        ownerBirth: processes[0].birth,
        runtimeId: 'r-a'
      })
    )
  })

  it('does not transfer ownership to a recycled PID, and keeps births that arrive during a pending sample', async () => {
    let now = 1000
    const deferred = Promise.withResolvers<WindowsResourceSample>()
    const native = {
      sampleWindowsResources: vi
        .fn()
        .mockReturnValueOnce(deferred.promise)
        .mockResolvedValue(
          sample([
            { pid: 10, parentPid: 1, birth: '200' },
            { pid: 20, parentPid: 1, birth: '300' }
          ])
        ),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native, () => now)
    recorder.observeIdentity({ pid: 10, birth: '100', runtimeId: 'old' })
    const pending = recorder.sample()
    recorder.observeIdentity({ pid: 20, birth: '300', runtimeId: 'new' })
    deferred.resolve(sample([{ pid: 10, parentPid: 1, birth: '200' }]))
    await pending
    now += 30_000
    await recorder.sample()
    const records = (await read()).filter((r) => r.event === 'process-sample')
    expect(records.filter((r) => r.data.pid === 10).every((r) => !r.data.runtimeId)).toBe(true)
    expect(records.find((r) => r.data.pid === 20)?.data.runtimeId).toBe('new')
  })

  it('keeps one OS query after timeout, and shutdown does not await it or write late samples', async () => {
    const deferred = Promise.withResolvers<WindowsResourceSample>()
    const native = {
      sampleWindowsResources: vi.fn().mockReturnValue(deferred.promise),
      readWindowsResourceBirth: vi.fn()
    }
    const { recorder, read } = await setup(native)
    vi.useFakeTimers()
    const pending = recorder.sample()
    await vi.advanceTimersByTimeAsync(10_000)
    void recorder.sample()
    expect(native.sampleWindowsResources).toHaveBeenCalledTimes(1)
    await recorder.close(true)
    deferred.resolve(sample())
    await pending
    const records = await read()
    expect(records.some((r) => r.event === 'sample-delayed')).toBe(true)
    expect(records.some((r) => r.event === 'system-sample')).toBe(false)
  })

  it('seals only unexpected exits, preserving the birth-time epoch for stale exits', async () => {
    const { read } = await setup({
      sampleWindowsResources: vi.fn(),
      readWindowsResourceBirth: () => '100'
    })
    const expected = Object.assign(new EventEmitter(), { pid: 10 }) as ChildProcess
    observeResourceProcess(expected, { runtimeId: 'r-a', epoch: 1 }, () => true)
    expected.emit('exit', 1, null)
    expect((await read()).find((r) => r.event === 'process-exited')?.data.expected).toBe(true)
    const stale = Object.assign(new EventEmitter(), { pid: 11 }) as ChildProcess
    observeResourceProcess(stale, { runtimeId: 'r-a', epoch: 2 }, () => undefined)
    stale.emit('exit', 1, null)
    const unexpected = Object.assign(new EventEmitter(), { pid: 12 }) as ChildProcess
    observeResourceProcess(unexpected, { runtimeId: 'r-b', epoch: 1 }, () => false)
    unexpected.emit('exit', 1, null)
    const records = await read()
    expect(records.find((r) => r.event === 'process-exited' && r.data.pid === 11)?.data).toEqual({
      runtimeId: 'r-a',
      epoch: 2,
      pid: 11,
      birth: '100',
      code: 1,
      signal: null
    })
    expect((await readdir(paths.at(-1)!)).some((name) => name.startsWith('incident-'))).toBe(true)
  })

  it('bounds runtime observers and permits explicit retirement without retaining the runtime', async () => {
    const { recorder, read } = await setup({
      sampleWindowsResources: vi.fn().mockResolvedValue(sample()),
      readWindowsResourceBirth: vi.fn()
    })
    const owner = { resourceDiagnosticSnapshot: () => ({ status: 'idle' }) }
    for (let i = 0; i < 256; i++) expect(recorder.register(owner, `r-${i}`)).toBeDefined()
    expect(recorder.register(owner, 'overflow')).toBeUndefined()
    recorder.unregister('r-0')
    expect(recorder.register(owner, 'replacement')).toBe('replacement')
    await recorder.sample()
    const records = await read()
    expect(records.filter((r) => r.event === 'activity-snapshot')).toHaveLength(256)
    expect(records.find((r) => r.event === 'sample-start')?.data.missing).toBe(1)
  })
})
