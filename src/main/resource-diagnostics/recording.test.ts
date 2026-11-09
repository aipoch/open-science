import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceRecording } from './recording'
import { ResourceActivity } from './activity'
import { ResourceLogStore } from './store'
import {
  ResourceRecorder,
  installResourceRecorder,
  registerResourceObservation,
  unregisterResourceObservation
} from './recorder'

afterEach(() => {
  vi.useRealTimers()
  installResourceRecorder(undefined)
})

it('does no work before consent, follows activity, and defaults off for the next lifetime', async () => {
  vi.useFakeTimers()
  const activity = new ResourceActivity()
  const recording = { close: vi.fn(async () => {}), settled: async () => {} }
  const create = vi.fn(async () => recording)
  const changed = vi.fn()
  const owner = new ResourceRecording(create, changed, activity)
  activity.setDesktop({ foreground: true, suspended: false })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(owner.getState()).toBe('off')
  expect(create).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(await owner.start()).toBe('recording')
  activity.setDesktop({ foreground: false, suspended: false })
  expect(changed).toHaveBeenLastCalledWith('idle')
  const end = activity.begin()
  expect(owner.getState()).toBe('recording')
  activity.setDesktop({ foreground: false, suspended: true })
  expect(changed).toHaveBeenLastCalledWith('suspended')
  await owner.stop()
  await Promise.resolve()
  expect(recording.close).toHaveBeenCalledWith(true)
  expect(owner.getState()).toBe('off')
  end()
  await owner.close(true)
  const next = new ResourceRecording(create, changed, activity)
  expect(next.getState()).toBe('off')
  await next.close(true)
})

it('serializes starts and stops and prevents overlapping native reads across recordings', async () => {
  const pending = Promise.withResolvers<void>()
  const create = vi.fn(async () => ({
    close: vi.fn(async () => {}),
    settled: () => pending.promise
  }))
  const owner = new ResourceRecording(create, vi.fn())
  await Promise.all([owner.start(), owner.start()])
  expect(create).toHaveBeenCalledOnce()
  await owner.stop()
  expect(owner.getState()).toBe('stopping')
  expect(await owner.start()).toBe('stopping')
  expect(create).toHaveBeenCalledOnce()
  // Shutdown must not wait forever for the OS; a new start remains prohibited.
  await owner.close(true)
  pending.resolve()
  await vi.waitFor(() => expect(owner.getState()).toBe('off'))
  await owner.start()
  expect(create).toHaveBeenCalledOnce()
})

it('finishes a concurrent stop after an in-progress start without leaving recording on', async () => {
  const pending = Promise.withResolvers<{
    close(clean: boolean): Promise<void>
    settled(): Promise<void>
  }>()
  const close = vi.fn(async () => {})
  const owner = new ResourceRecording(() => pending.promise, vi.fn())
  const start = owner.start()
  const stop = owner.stop()
  pending.resolve({ close, settled: async () => {} })
  await Promise.all([start, stop])
  await vi.waitFor(() => expect(owner.getState()).toBe('off'))
  expect(close).toHaveBeenCalledOnce()
  await owner.close(true)
})

it('reports failed creation and writer failure and supports deliberate retry', async () => {
  const close = vi.fn(async () => {})
  const create = vi
    .fn()
    .mockRejectedValueOnce(new Error('private path'))
    .mockResolvedValue({ close, settled: async () => {} })
  const owner = new ResourceRecording(create, vi.fn())
  expect(await owner.start()).toBe('failed')
  expect(await owner.start()).toBe('idle')
  owner.fail()
  await vi.waitFor(() => expect(owner.getState()).toBe('failed'))
  expect(close).toHaveBeenCalledWith(false)
  await owner.close(true)
})

it('keeps unsupported hosts off', async () => {
  const owner = new ResourceRecording(undefined, vi.fn())
  expect(await owner.start()).toBe('unsupported')
  await owner.close(true)
})

it('retains stopped records and captures already-existing runtime observations after opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-recording-'))
  const journal = join(root, 'journal')
  const snapshot = vi.fn(() => ({ state: 'running', sessionId: 'existing-session' }))
  const id = registerResourceObservation(
    { resourceDiagnosticSnapshot: snapshot },
    'existing-runtime'
  )!
  const native = {
    readWindowsResourceBirth: vi.fn(() => '123'),
    sampleWindowsResources: vi.fn(async () => ({
      supported: true,
      complete: true,
      startedAt: 1,
      endedAt: 2,
      processes: []
    }))
  }
  let recorder: ResourceRecorder
  const owner = new ResourceRecording(async () => {
    const store = new ResourceLogStore({ directory: journal, preserveLive: true })
    await store.flush()
    recorder = new ResourceRecorder({ runId: 'explicit', store, native, timers: false })
    installResourceRecorder(recorder)
    return {
      settled: () => recorder.settled(),
      close: async (clean) => {
        installResourceRecorder(undefined)
        await recorder.close(clean)
      }
    }
  }, vi.fn())
  try {
    expect(await readdir(root)).toEqual([])
    expect(snapshot).not.toHaveBeenCalled()
    expect(native.readWindowsResourceBirth).not.toHaveBeenCalled()
    await owner.start()
    await recorder!.sample()
    await owner.stop()
    await vi.waitFor(() => expect(owner.getState()).toBe('off'))
    const names = (await readdir(journal)).filter((name) => name.endsWith('.jsonl'))
    const before = await Promise.all(names.map((name) => readFile(join(journal, name), 'utf8')))
    expect(before.join('')).toContain('existing-runtime')
    expect(before.join('')).toContain('existing-session')
    await owner.start()
    await recorder!.sample()
    await owner.stop()
    await vi.waitFor(() => expect(owner.getState()).toBe('off'))
    expect(await Promise.all(names.map((name) => readFile(join(journal, name), 'utf8')))).toEqual(
      before
    )
    expect(
      (await readdir(journal)).filter((name) => name.endsWith('.jsonl')).length
    ).toBeGreaterThan(names.length)
  } finally {
    unregisterResourceObservation(id)
    await owner.close(true)
    await rm(root, { recursive: true, force: true })
  }
})
