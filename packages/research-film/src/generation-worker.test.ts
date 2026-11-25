import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  post: vi.fn(),
  narrator: vi.fn(),
  remoteIdentity: vi.fn(() => 'remote-http/identity'),
  workerData: {
    kind: 'speech',
    modelDirectory: 'models',
    runtimeDirectory: 'runtime',
    threads: 2
  } as Record<string, unknown>
}))
vi.mock('node:worker_threads', () => ({
  parentPort: { on: mocks.on, postMessage: mocks.post },
  get workerData() {
    return mocks.workerData
  }
}))
vi.mock('./kokoro.js', () => ({ createKokoroNarrator: mocks.narrator }))
vi.mock('./remote-speech.js', () => ({
  remoteSpeechIdentity: mocks.remoteIdentity
}))
vi.mock('./generation.js', () => ({ generateResearchVideoInWorker: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.workerData = {
    kind: 'speech',
    modelDirectory: 'models',
    runtimeDirectory: 'runtime',
    threads: 2
  }
  mocks.remoteIdentity.mockReturnValue('remote-http/identity')
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
      throw Object.assign(new Error('predictor failed'), { code: 'ENOMEM' })
    }),
    synthesize: vi.fn()
  })
  await import('./generation-worker.js')
  mocks.on.mock.calls[0][1]({ kind: 'measure-duration', lane: 0, text: 'Heat' })
  await vi.waitFor(() =>
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
      kind: 'error',
      message: 'predictor failed',
      code: 'ENOMEM'
    })
  )
})

it('stamps the remote identity on generation-side synthesizer proxies', async () => {
  const speech = {
    kind: 'remote-http',
    style: 'audio-speech',
    endpoint: 'https://api.example.com/v1/audio/speech',
    model: 'tts-1'
  }
  const generation = {
    specPath: 'video.json',
    modelDirectory: 'models',
    engineDirectory: 'engine',
    outputDirectory: 'output',
    temporaryDirectory: 'tmp',
    speechConcurrency: 1,
    speech
  }
  mocks.workerData = generation
  const { generateResearchVideoInWorker } = await import('./generation.js')
  vi.mocked(generateResearchVideoInWorker).mockResolvedValue({
    playerPath: 'player.html',
    sourcePath: 'sources.zip',
    duration: 1,
    preparationMs: 1
  })
  await import('./generation-worker.js')
  expect(mocks.remoteIdentity).toHaveBeenCalledExactlyOnceWith(speech)
  expect(generateResearchVideoInWorker).toHaveBeenCalledOnce()
  const synthesizers = vi.mocked(generateResearchVideoInWorker).mock.calls[0][2]
  expect(synthesizers[0]).toMatchObject({
    identity: 'remote-http/identity',
    proportionalTiming: true
  })
})
