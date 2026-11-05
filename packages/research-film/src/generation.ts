import { researchFilmResources } from './resources.js'
import type { ResearchVideoStep } from './progress.js'
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { availableParallelism, totalmem } from 'node:os'
import type { SpeechSynthesizer } from './narration.js'

export type ResearchVideoGenerationInput = {
  speechConcurrency?: 1 | 2
  specPath: string
  provenance?: Record<string, unknown>
  modelDirectory: string
  engineDirectory: string
  outputDirectory: string
}
export type ResearchVideoGenerationResult = {
  playerPath: string
  sourcePath: string
  duration: number
  preparationMs: number
}
export type ResearchVideoWorkerInput = ResearchVideoGenerationInput & { temporaryDirectory: string }
export type ResearchVideoSpeechInput = {
  kind: 'speech'
  modelDirectory: string
  runtimeDirectory: string
  threads: number
}
export type ResearchVideoSpeechResult = {
  kind: 'speech-result'
  lane: number
  audio: Awaited<ReturnType<SpeechSynthesizer['synthesize']>>
}
export type ResearchVideoSpeechDuration = {
  kind: 'speech-duration'
  lane: number
  duration: number
}
export type ResearchVideoWorkerMessage =
  | { kind: 'synthesize' | 'measure-duration'; lane: number; text: string }
  | ResearchVideoSpeechResult
  | ResearchVideoSpeechDuration
  | { kind: 'result'; result: ResearchVideoGenerationResult }
  | { kind: 'error'; message: string }
  | { kind: 'phase'; phase: 'voice' | 'build' }
  | { kind: 'progress'; progress: ResearchVideoStep }

/** The caller owns source authorization and Artifact publication; this owner only generates files. */
export const createResearchVideoGenerator = (options: {
  temporaryRoot: string
  createWorker?: (options: WorkerOptions) => Worker
}) => {
  const { temporaryRoot } = options
  const createWorker =
    options.createWorker ??
    ((options: WorkerOptions) => new Worker(researchFilmResources().workerPath, options))
  let active = false
  const generate = async (
    input: ResearchVideoGenerationInput,
    signal: AbortSignal,
    onProgress?: (progress: ResearchVideoStep) => void
  ): Promise<ResearchVideoGenerationResult> => {
    signal.throwIfAborted()
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'research-video-'))
    let worker: Worker | undefined
    let stopping = false
    const speechWorkers = new Map<number, Worker>()
    const speechRequests = new Map<Worker, { done: Promise<void>; finish: () => void }>()
    const finishSpeechRequest = (speech: Worker): void => {
      speechRequests.get(speech)?.finish()
      speechRequests.delete(speech)
    }
    const speechConcurrency =
      input.speechConcurrency ??
      (availableParallelism() >= 4 && totalmem() >= 16 * 1024 ** 3 ? 2 : 1)
    let removeAbortListener = (): void => {}
    try {
      signal.throwIfAborted()
      worker = createWorker({
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
        workerData: {
          ...input,
          speechConcurrency,
          outputDirectory: join(temporaryDirectory, 'output'),
          temporaryDirectory
        } satisfies ResearchVideoWorkerInput
      })
      const result = await new Promise<ResearchVideoGenerationResult>((resolve, reject) => {
        const abort = (): void => reject(signal.reason)
        const exit = (): void =>
          reject(new Error('Research video worker stopped before completion'))
        const error = (failure: Error): void => reject(failure)
        const message = (value: ResearchVideoWorkerMessage): void => {
          if (stopping || signal.aborted) return
          if (value.kind === 'synthesize' || value.kind === 'measure-duration') {
            try {
              if (
                !Number.isInteger(value.lane) ||
                value.lane < 0 ||
                value.lane >= speechConcurrency
              )
                throw new Error('Invalid speech worker lane')
              let speech = speechWorkers.get(value.lane)
              if (!speech) {
                speech = createWorker({
                  execArgv: [],
                  resourceLimits: { maxOldGenerationSizeMb: 1024 },
                  workerData: {
                    kind: 'speech',
                    modelDirectory: input.modelDirectory,
                    runtimeDirectory: join(temporaryDirectory, `runtime-${value.lane}`),
                    threads: Math.max(
                      1,
                      Math.floor(Math.min(4, availableParallelism()) / speechConcurrency)
                    )
                  } satisfies ResearchVideoSpeechInput
                })
                speechWorkers.set(value.lane, speech)
                const ownedSpeech = speech
                speech.on('message', (reply: ResearchVideoWorkerMessage) => {
                  if (['error', 'speech-result', 'speech-duration'].includes(reply.kind))
                    finishSpeechRequest(ownedSpeech)
                  if (stopping || signal.aborted) return
                  if (reply.kind === 'error') reject(new Error(reply.message))
                  else if (reply.kind === 'speech-result' || reply.kind === 'speech-duration') {
                    try {
                      if (reply.kind === 'speech-result')
                        worker!.postMessage(reply, [reply.audio.samples.buffer as ArrayBuffer])
                      else worker!.postMessage(reply)
                    } catch (error) {
                      reject(error)
                    }
                  }
                })
                speech.once('error', (failure) => {
                  finishSpeechRequest(ownedSpeech)
                  error(failure)
                })
                speech.once('exit', () => {
                  finishSpeechRequest(ownedSpeech)
                  exit()
                })
              }
              if (speechRequests.has(speech)) throw new Error('Speech worker already busy')
              let finish!: () => void
              const done = new Promise<void>((resolve) => {
                finish = resolve
              })
              speechRequests.set(speech, { done, finish })
              try {
                speech.postMessage(value)
              } catch (failure) {
                finishSpeechRequest(speech)
                throw failure
              }
            } catch (error) {
              reject(error)
            }
          } else if (value.kind === 'result') resolve(value.result)
          else if (value.kind === 'error') reject(new Error(value.message))
          else if (value.kind === 'phase' || value.kind === 'progress') {
            try {
              onProgress?.(value.kind === 'phase' ? { phase: value.phase } : value.progress)
            } catch (error) {
              reject(error)
            }
          }
        }
        worker!.on('message', message)
        worker!.once('error', error)
        worker!.once('exit', exit)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        removeAbortListener = () => signal.removeEventListener('abort', abort)
      })
      signal.throwIfAborted()
      await mkdir(input.outputDirectory, { recursive: false })
      try {
        const playerPath = join(input.outputDirectory, 'player.html')
        const sourcePath = join(input.outputDirectory, 'sources.zip')
        await copyFile(result.playerPath, playerPath, 1)
        signal.throwIfAborted()
        await copyFile(result.sourcePath, sourcePath, 1)
        signal.throwIfAborted()
        return { ...result, playerPath, sourcePath }
      } catch (error) {
        await rm(input.outputDirectory, { recursive: true, force: true })
        throw error
      }
    } finally {
      stopping = true
      removeAbortListener()
      // Terminating a worker inside native ONNX execution can abort the entire host process.
      await Promise.all([
        worker?.terminate(),
        ...[...speechWorkers.values()].map(async (speech) => {
          await speechRequests.get(speech)?.done
          await speech.terminate()
        })
      ])
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  return async (
    input: ResearchVideoGenerationInput,
    signal: AbortSignal,
    onProgress?: (progress: ResearchVideoStep) => void
  ): Promise<ResearchVideoGenerationResult> => {
    if (active) throw new Error('Another research explanation is being generated.')
    active = true
    try {
      return await generate(input, signal, onProgress)
    } finally {
      active = false
    }
  }
}

export async function generateResearchVideoInWorker(
  input: ResearchVideoWorkerInput,
  progress: (progress: ResearchVideoStep) => void,
  synthesizers: SpeechSynthesizer[]
): Promise<ResearchVideoGenerationResult> {
  const { prepareVideoNarration } = await import('./narration.js')
  const { buildResearchVideoPlayer } = await import('./build-player.js')
  const { freezeResearchVideoSource } = await import('./freeze-source.js')
  const specPath = await freezeResearchVideoSource(
    input.specPath,
    join(input.temporaryDirectory, 'source'),
    new AbortController().signal
  )
  const spec = JSON.parse(await readFile(specPath, 'utf8'))
  progress({ phase: 'loading' })
  const voiceDirectory = join(input.temporaryDirectory, 'voice')
  const { mix } = await prepareVideoNarration({
    spec,
    synthesizer: synthesizers[0],
    additionalSynthesizer: synthesizers[1],
    onProgress: progress,
    outputDirectory: voiceDirectory,
    signal: new AbortController().signal
  })
  const mixPath = join(input.temporaryDirectory, 'mix.wav')
  await writeFile(mixPath, mix, { flag: 'wx' })
  progress({ phase: 'build' })
  return buildResearchVideoPlayer({ ...input, specPath, voiceDirectory, mixPath })
}
