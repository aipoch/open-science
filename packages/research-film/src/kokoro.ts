import { prepareNarrationRuntime } from './runtime.js'
import type { SpeechSynthesizer } from './narration.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createKokoroDurationModel, KOKORO_DURATION_OUTPUT } from './kokoro-duration.js'

type RuntimeTensor = {
  type: string
  data: Float32Array | BigInt64Array
  dims: readonly number[]
}

/** Load only a host-provisioned model in an owned worker. */
export async function createKokoroNarrator(
  modelDirectory: string,
  runtimeDirectory: string,
  threads?: number
): Promise<SpeechSynthesizer> {
  const requireRuntime = await prepareNarrationRuntime(modelDirectory, runtimeDirectory)
  const { KokoroTTS } = requireRuntime('kokoro-js') as {
    KokoroTTS: new (
      weights: unknown,
      tokenizer: unknown
    ) => {
      generate(
        text: string,
        options: { voice: string; speed: number }
      ): Promise<{ audio: Float32Array; sampling_rate: number }>
    }
  }
  const { env, AutoTokenizer, StyleTextToSpeech2Model } = requireRuntime(
    '@huggingface/transformers'
  ) as {
    env: { allowRemoteModels: boolean; allowLocalModels: boolean }
    AutoTokenizer: { from_pretrained(directory: string): Promise<unknown> }
    StyleTextToSpeech2Model: {
      from_pretrained(
        directory: string,
        options: {
          dtype: string
          device: string
          subfolder: string
          session_options?: { intraOpNumThreads: number; interOpNumThreads: number }
        }
      ): Promise<unknown>
    }
  }
  env.allowRemoteModels = false
  env.allowLocalModels = true
  // Drain native model loading even if tokenizer loading fails before it finishes.
  const loaded = await Promise.allSettled([
    StyleTextToSpeech2Model.from_pretrained(modelDirectory, {
      dtype: 'q8',
      device: 'cpu',
      subfolder: '',
      ...(threads ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {})
    }),
    AutoTokenizer.from_pretrained(modelDirectory)
  ])
  const failure = loaded.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  const [weights, tokenizer] = loaded.map((result) =>
    result.status === 'fulfilled' ? result.value : undefined
  )
  const model = new KokoroTTS(weights, tokenizer)
  let durationModel: Promise<((text: string) => Promise<number>) | undefined> | undefined
  const loadDurationModel = async (): Promise<((text: string) => Promise<number>) | undefined> => {
    const bytes = createKokoroDurationModel(
      await readFile(join(modelDirectory, 'model_quantized.onnx'))
    )
    if (!bytes) return undefined
    const { Tensor, InferenceSession } = requireRuntime('onnxruntime-node') as {
      Tensor: new (
        type: string,
        data: RuntimeTensor['data'],
        dims: readonly number[]
      ) => RuntimeTensor
      InferenceSession: {
        create(
          bytes: Buffer,
          options: { intraOpNumThreads?: number; interOpNumThreads: number }
        ): Promise<{
          run(inputs: Record<string, RuntimeTensor>): Promise<Record<string, RuntimeTensor>>
        }>
      }
    }
    // This second, decoder-free session is lazy and terminates with the owning speech worker.
    const session = await InferenceSession.create(bytes, {
      ...(threads ? { intraOpNumThreads: threads } : {}),
      interOpNumThreads: 1
    })
    let duration = 0
    const predictor = new KokoroTTS(async (feeds: Record<string, RuntimeTensor>) => {
      const inputs = Object.fromEntries(
        Object.entries(feeds).map(([key, tensor]) => [
          key,
          new Tensor(tensor.type, tensor.data, tensor.dims)
        ])
      )
      const result = await session.run(inputs)
      const frames = result[KOKORO_DURATION_OUTPUT]
      if (!frames || frames.type !== 'int64' || frames.data.length !== feeds.input_ids.data.length)
        throw new Error('Invalid Kokoro duration output')
      let total = 0
      for (const frame of frames.data) {
        const value = Number(frame)
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new Error('Invalid Kokoro duration frame')
        total += value
      }
      // The pinned decoder emits exactly 600 samples at 24 kHz per predicted frame.
      duration = total / 40
      if (!Number.isFinite(duration) || duration <= 0 || duration > 300)
        throw new Error('Invalid Kokoro duration')
      return { waveform: { data: new Float32Array(1) } }
    }, tokenizer)
    return async (text) => {
      await predictor.generate(text, { voice: 'af_heart', speed: 1 })
      return duration
    }
  }
  return {
    identity: 'kokoro-js-1.2.1/af_heart/q8/speed-1',
    async measureDuration(text) {
      const measure = await (durationModel ??= loadDurationModel())
      if (measure) return measure(text)
      const audio = await model.generate(text, { voice: 'af_heart', speed: 1 })
      return audio.audio.length / audio.sampling_rate
    },
    async synthesize(text) {
      const audio = await model.generate(text, { voice: 'af_heart', speed: 1 })
      return { samples: audio.audio, sampleRate: audio.sampling_rate }
    }
  }
}
