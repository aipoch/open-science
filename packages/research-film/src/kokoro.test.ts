import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  read: vi.fn(),
  graph: vi.fn(),
  create: vi.fn(),
  run: vi.fn(),
  audio: vi.fn(),
  weights: vi.fn(),
  tokenizer: vi.fn(),
  generate: vi.fn(),
  env: { allowRemoteModels: true, allowLocalModels: false }
}))
vi.mock('./runtime.js', () => ({ prepareNarrationRuntime: state.prepare }))
vi.mock('node:fs/promises', () => ({ readFile: state.read }))
vi.mock('./kokoro-duration.js', () => ({
  createKokoroDurationModel: state.graph,
  KOKORO_DURATION_OUTPUT: 'duration'
}))

import { createKokoroNarrator } from './kokoro.js'

beforeEach(() => {
  vi.clearAllMocks()
  state.read.mockResolvedValue(Buffer.from('installed model'))
  state.graph.mockReturnValue(Buffer.from('derived model'))
  state.run.mockResolvedValue({
    duration: { type: 'int64', data: new BigInt64Array([2n, 4n, 2n]), dims: [3] }
  })
  state.create.mockResolvedValue({ run: state.run })
  state.weights.mockResolvedValue('full-model')
  state.tokenizer.mockResolvedValue('shared-tokenizer')
  state.audio.mockResolvedValue({ audio: new Float32Array(2400), sampling_rate: 24000 })
  const modules = {
    'kokoro-js': {
      KokoroTTS: class {
        constructor(
          private readonly weights: unknown,
          private readonly tokenizer: unknown
        ) {}
        async generate(text: string, options: unknown): Promise<unknown> {
          state.generate(text, options, this.tokenizer)
          if (typeof this.weights !== 'function') return state.audio(text)
          const result = await this.weights({
            input_ids: { type: 'int64', data: new BigInt64Array([0n, 1n, 0n]), dims: [1, 3] },
            style: { type: 'float32', data: new Float32Array(256), dims: [1, 256] },
            speed: { type: 'float32', data: new Float32Array([1]), dims: [1] }
          })
          return { audio: result.waveform.data, sampling_rate: 24000 }
        }
      }
    },
    '@huggingface/transformers': {
      env: state.env,
      AutoTokenizer: { from_pretrained: state.tokenizer },
      StyleTextToSpeech2Model: { from_pretrained: state.weights }
    },
    'onnxruntime-node': {
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: unknown,
          readonly dims: readonly number[]
        ) {}
      },
      InferenceSession: { create: state.create }
    }
  }
  state.prepare.mockResolvedValue((name: keyof typeof modules) => modules[name])
})

describe('Kokoro duration adapter', () => {
  it('drains native initialization before reporting a tokenizer failure', async () => {
    let finish!: (value: string) => void
    state.weights.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    state.tokenizer.mockRejectedValueOnce(new Error('tokenizer failed'))
    const settled = vi.fn()
    const result = createKokoroNarrator('models', 'runtime').catch((error) => {
      settled()
      return error
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    finish('full-model')
    expect(await result).toEqual(new Error('tokenizer failed'))
    expect(settled).toHaveBeenCalledOnce()
  })

  it('loads the duration graph only on demand and reuses the existing voice preparation', async () => {
    const narrator = await createKokoroNarrator('models', 'runtime', 2)
    expect((await narrator.synthesize('Heat leaves.')).samples).toHaveLength(2400)
    expect(state.read).not.toHaveBeenCalled()
    expect(state.create).not.toHaveBeenCalled()
    expect(await narrator.measureDuration!('Heat')).toBe(0.2)
    expect(await narrator.measureDuration!('Heat leaves')).toBe(0.2)
    expect(state.read).toHaveBeenCalledOnce()
    expect(state.graph).toHaveBeenCalledWith(Buffer.from('installed model'))
    expect(state.create).toHaveBeenCalledExactlyOnceWith(Buffer.from('derived model'), {
      intraOpNumThreads: 2,
      interOpNumThreads: 1
    })
    expect(state.run).toHaveBeenCalledTimes(2)
    expect(state.audio).toHaveBeenCalledExactlyOnceWith('Heat leaves.')
    expect(
      state.generate.mock.calls.every(
        ([, options, tokenizer]) =>
          JSON.stringify(options) === JSON.stringify({ voice: 'af_heart', speed: 1 }) &&
          tokenizer === 'shared-tokenizer'
      )
    ).toBe(true)
    expect(state.env).toEqual({ allowRemoteModels: false, allowLocalModels: true })
  })

  it('uses full synthesis for an unrecognized model without changing its audio', async () => {
    state.graph.mockReturnValue(undefined)
    const narrator = await createKokoroNarrator('models', 'runtime')
    expect(await narrator.measureDuration!('one')).toBe(0.1)
    expect(await narrator.measureDuration!('two')).toBe(0.1)
    expect(state.read).toHaveBeenCalledOnce()
    expect(state.create).not.toHaveBeenCalled()
    expect(state.audio.mock.calls).toEqual([['one'], ['two']])
  })

  it.each([
    { type: 'float32', data: new Float32Array([2, 4, 2]) },
    { type: 'int64', data: new BigInt64Array([2n]) },
    { type: 'int64', data: new BigInt64Array([2n, 0n, 2n]) },
    { type: 'int64', data: new BigInt64Array([2n, -1n, 2n]) },
    { type: 'int64', data: new BigInt64Array([2n, 12000n, 2n]) }
  ])('rejects invalid duration tensors', async (tensor) => {
    state.run.mockResolvedValue({ duration: tensor })
    const narrator = await createKokoroNarrator('models', 'runtime')
    await expect(narrator.measureDuration!('Heat')).rejects.toThrow('Invalid Kokoro duration')
  })

  it('propagates graph integrity and session failures to the existing worker owner', async () => {
    state.graph.mockImplementationOnce(() => {
      throw new Error('integrity')
    })
    const first = await createKokoroNarrator('models', 'runtime')
    await expect(first.measureDuration!('Heat')).rejects.toThrow('integrity')
    state.create.mockRejectedValueOnce(new Error('session failed'))
    const second = await createKokoroNarrator('models', 'runtime')
    await expect(second.measureDuration!('Heat')).rejects.toThrow('session failed')
  })
})
