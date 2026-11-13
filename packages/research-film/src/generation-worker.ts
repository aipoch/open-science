import { parentPort, workerData } from 'node:worker_threads'
import {
  generateResearchVideoInWorker,
  type ResearchVideoWorkerInput,
  type ResearchVideoSpeechInput,
  type ResearchVideoSpeechResult,
  type ResearchVideoSpeechDuration,
  type ResearchVideoWorkerMessage
} from './generation.js'
import { createKokoroNarrator } from './kokoro.js'
import type { SpeechSynthesizer } from './narration.js'
const send = (message: ResearchVideoWorkerMessage): void => {
  if (message.kind === 'speech-result')
    parentPort?.postMessage(message, [message.audio.samples.buffer as ArrayBuffer])
  else parentPort?.postMessage(message)
}
const fail = (error: unknown): void => {
  let code: string | undefined
  try {
    code = (error as NodeJS.ErrnoException | null)?.code
  } catch {
    // Error metadata must not prevent the failure reply.
  }
  send({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
    ...([
      'ENOENT',
      'ENOTDIR',
      'EACCES',
      'EPERM',
      'ENOSPC',
      'ENOMEM',
      'ETIMEDOUT',
      'ERR_WORKER_OUT_OF_MEMORY'
    ].includes(code ?? '')
      ? { code }
      : {})
  })
}
const input = workerData as ResearchVideoWorkerInput | ResearchVideoSpeechInput
if ('kind' in input && input.kind === 'speech') {
  const narrator = createKokoroNarrator(input.modelDirectory, input.runtimeDirectory, input.threads)
  void narrator.catch(fail)
  parentPort?.on(
    'message',
    (request: { kind: 'synthesize' | 'measure-duration'; lane: number; text: string }) => {
      void narrator
        .then(async (model) => {
          if (request.kind === 'measure-duration' && model.measureDuration) {
            send({
              kind: 'speech-duration',
              lane: request.lane,
              duration: await model.measureDuration(request.text)
            })
            return
          }
          const audio = await model.synthesize(request.text)
          if (request.kind === 'measure-duration')
            send({
              kind: 'speech-duration',
              lane: request.lane,
              duration: audio.samples.length / audio.sampleRate
            })
          else send({ kind: 'speech-result', lane: request.lane, audio })
        })
        .catch(fail)
    }
  )
} else {
  const generation = input as ResearchVideoWorkerInput
  const pending = new Map<number, (audio: ResearchVideoSpeechResult['audio']) => void>()
  const pendingDurations = new Map<number, (duration: number) => void>()
  parentPort?.on('message', (reply: ResearchVideoSpeechResult | ResearchVideoSpeechDuration) => {
    if (reply.kind === 'speech-duration') {
      const resolve = pendingDurations.get(reply.lane)
      pendingDurations.delete(reply.lane)
      resolve?.(reply.duration)
    } else {
      const resolve = pending.get(reply.lane)
      pending.delete(reply.lane)
      resolve?.(reply.audio)
    }
  })
  const synthesizers: SpeechSynthesizer[] = Array.from(
    { length: generation.speechConcurrency ?? 1 },
    (_, lane) => ({
      identity: 'kokoro-js-1.2.1/af_heart/q8/speed-1',
      measureDuration(text) {
        return new Promise((resolve) => {
          pendingDurations.set(lane, resolve)
          send({ kind: 'measure-duration', lane, text })
        })
      },
      synthesize(text) {
        return new Promise((resolve) => {
          pending.set(lane, resolve)
          send({ kind: 'synthesize', lane, text })
        })
      }
    })
  )
  void generateResearchVideoInWorker(
    generation,
    (progress) => send({ kind: 'progress', progress }),
    synthesizers
  )
    .then((result) => send({ kind: 'result', result }))
    .catch(fail)
}
