import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ on: vi.fn(), post: vi.fn(), narrator: vi.fn() }))
vi.mock('node:worker_threads', () => ({
  parentPort: { on: mocks.on, postMessage: mocks.post },
  workerData: { kind: 'speech', modelDirectory: 'models', runtimeDirectory: 'runtime', threads: 2 }
}))
vi.mock('./kokoro.js', () => ({ createKokoroNarrator: mocks.narrator }))
vi.mock('./generation.js', () => ({ generateResearchVideoInWorker: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

it('uses the duration-only adapter and sends only a scalar for a probe', async () => {
  const measureDuration = vi.fn(async () => 0.2),
    synthesize = vi.fn()
  mocks.narrator.mockResolvedValue({ measureDuration, synthesize })
  await import('./generation-worker.js')
  mocks.on.mock.calls[0][1]({ kind: 'measure-duration', lane: 1, text: 'Heat' })
  await vi.waitFor(() =>
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
      kind: 'speech-duration',
      lane: 1,
      duration: 0.2
    })
  )
  expect(measureDuration).toHaveBeenCalledExactlyOnceWith('Heat')
  expect(synthesize).not.toHaveBeenCalled()
})

it('retains full-audio fallback when an adapter has no duration method', async () => {
  const synthesize = vi.fn(async () => ({ samples: new Float32Array(2400), sampleRate: 24000 }))
  mocks.narrator.mockResolvedValue({ synthesize })
  await import('./generation-worker.js')
  mocks.on.mock.calls[0][1]({ kind: 'measure-duration', lane: 0, text: 'Heat' })
  await vi.waitFor(() =>
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
      kind: 'speech-duration',
      lane: 0,
      duration: 0.1
    })
  )
})

it('still transfers the original PCM for final audio requests', async () => {
  const audio = { samples: new Float32Array(2400), sampleRate: 24000 }
  const measureDuration = vi.fn(),
    synthesize = vi.fn(async () => audio)
  mocks.narrator.mockResolvedValue({ measureDuration, synthesize })
  await import('./generation-worker.js')
  mocks.on.mock.calls[0][1]({ kind: 'synthesize', lane: 0, text: 'Heat' })
  await vi.waitFor(() =>
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({ kind: 'speech-result', lane: 0, audio }, [
      audio.samples.buffer
    ])
  )
  expect(measureDuration).not.toHaveBeenCalled()
})

it('reports predictor failure to the owner instead of hanging the pending probe', async () => {
  mocks.narrator.mockResolvedValue({
    measureDuration: vi.fn(async () => {
      throw new Error('predictor failed')
    }),
    synthesize: vi.fn()
  })
  await import('./generation-worker.js')
  mocks.on.mock.calls[0][1]({ kind: 'measure-duration', lane: 0, text: 'Heat' })
  await vi.waitFor(() =>
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
      kind: 'error',
      message: 'predictor failed'
    })
  )
})
