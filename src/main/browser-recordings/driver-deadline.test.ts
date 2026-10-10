import { afterEach, expect, it, vi } from 'vitest'
import { recordingDeadline } from './driver-deadline'
import { createWebmEncoder } from './webm-encoder'
import { startElectronSurfaceRecording } from './electron-surface-driver'
import { createTaskCallerContext } from '../caller-context'

afterEach(() => vi.useRealTimers())

it('bounds a project renderer which stops answering without blocking cleanup', async () => {
  vi.useFakeTimers()
  const pending = recordingDeadline(new Promise<never>(() => undefined), 20)
  const rejection = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(20)
  await rejection
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves actual renderer rejection and releases its deadline', async () => {
  vi.useFakeTimers()
  await expect(recordingDeadline(Promise.reject(new Error('renderer gone')))).rejects.toThrow(
    'renderer gone'
  )
  expect(vi.getTimerCount()).toBe(0)
  await expect(recordingDeadline(Promise.resolve('finished'))).resolves.toBe('finished')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { width: 0, height: 720, frameRate: 10 },
  { width: 8192, height: 8192, frameRate: 10 },
  { width: 1280, height: 720, frameRate: 61 },
  { width: 1280, height: 720, frameRate: 10, maxSegmentBytes: 17 * 1024 * 1024 }
])('rejects unsafe encoder allocations before creating a helper: %j', async (options) => {
  await expect(createWebmEncoder(options)).rejects.toThrow('Invalid browser recording')
})

it('rejects an agent request without an exact admitted desktop source before loading Electron', async () => {
  await expect(
    startElectronSurfaceRecording({
      caller: createTaskCallerContext(),
      viewerOrigin: 'http://viewer.localhost:1234',
      projectOrigin: 'http://rv.localhost:1235',
      signal: new AbortController().signal,
      onSegment: async () => undefined,
      onEvent: () => undefined,
      onGap: () => undefined
    })
  ).rejects.toThrow('current Electron surface')
})
