import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WindowsResourceSample } from '@aipoch/process-tree-native'
import { ResourceLogStore } from './store'
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
  now = () => 1000
): Promise<{
  recorder: ResourceRecorder
  store: ResourceLogStore
  read: () => Promise<ReturnType<typeof JSON.parse>[]>
}> => {
  const path = await mkdtemp(join(tmpdir(), 'resource-recorder-'))
  paths.push(path)
  const store = new ResourceLogStore({ directory: path })
  const recorder = new ResourceRecorder({ runId: 'run-1', store, native, now, timers: false })
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
