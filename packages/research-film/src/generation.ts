import { researchFilmResources } from './resources.js'
import type { ResearchVideoStep } from './progress.js'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { availableParallelism, totalmem } from 'node:os'
import type { SpeechSynthesizer } from './narration.js'
import {
  forkSpeechProcess,
  ownSpeechProcess,
  ResearchVideoSpeechCleanupError
} from './speech-client.js'

export { ResearchVideoSpeechCleanupError } from './speech-client.js'

export type ResearchVideoGenerationInput = {
  retainNarration?: boolean
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
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'phase'; phase: 'voice' | 'build' }
  | { kind: 'progress'; progress: ResearchVideoStep }

/** Worker identity survives the boundary without adding research content to diagnostic logs. */
export class ResearchVideoWorkerError extends Error {
  constructor(
    error: unknown,
    readonly workerRole: 'generation' | 'speech',
    readonly lane?: number,
    readonly exitCode?: number
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

export type ResearchVideoGenerate = (
  input: ResearchVideoGenerationInput,
  signal: AbortSignal,
  onProgress?: (progress: ResearchVideoStep) => void
) => Promise<ResearchVideoGenerationResult>

export class ResearchVideoBuildCleanupError extends Error {
  constructor(readonly exited: Promise<void>) {
    super('Film build worker did not confirm shutdown. Wait for it to exit before trying again.')
  }
}

const GENERATION_IDLE_TIMEOUT_MS = 4 * 60_000

/** The caller owns source authorization and Artifact publication; this owner only generates files. */
export const createResearchVideoGenerator = (options: {
  temporaryRoot: string
  createWorker?: (options: WorkerOptions) => Worker
  createSpeechProcess?: () => ChildProcess
}): ResearchVideoGenerate & { assertReady: () => void } => {
  const { temporaryRoot } = options
  const createWorker =
    options.createWorker ??
    ((options: WorkerOptions) => new Worker(researchFilmResources().workerPath, options))
  let active = false
  let pendingExit: ResearchVideoSpeechCleanupError | ResearchVideoBuildCleanupError | undefined
  const assertReady = (): void => {
    if (pendingExit) throw pendingExit
    if (active) throw new Error('Another research explanation is being generated.')
  }
  const generate = async (
    input: ResearchVideoGenerationInput,
    signal: AbortSignal,
    onProgress?: (progress: ResearchVideoStep) => void
  ): Promise<ResearchVideoGenerationResult> => {
    signal.throwIfAborted()
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'research-video-'))
    let worker: Worker | undefined
    let stopping = false
    let speech: ReturnType<typeof ownSpeechProcess> | undefined
    const speechConcurrency =
      input.speechConcurrency ??
      (availableParallelism() >= 4 && totalmem() >= 16 * 1024 ** 3 ? 2 : 1)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener = (): void => {}
    const buildExit = Promise.withResolvers<void>()
    const stopBuild = async (): Promise<void> => {
      if (!worker) return
      // Node resolves terminate() only after the worker exits. Keep the exit listener in
      // case requesting termination fails and the worker eventually exits on its own.
      void worker.terminate().then(
        () => buildExit.resolve(),
        () => {}
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          buildExit.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ResearchVideoBuildCleanupError(buildExit.promise)),
              5000
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    const removeScratch = (): Promise<void> =>
      rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 })
    const cleanup = async (): Promise<void> => {
      const [build, narration] = await Promise.allSettled([stopBuild(), speech?.stop()])
      const narrationError: unknown = narration.status === 'rejected' ? narration.reason : undefined
      const buildError: unknown = build.status === 'rejected' ? build.reason : undefined
      const exit =
        buildError instanceof ResearchVideoBuildCleanupError
          ? new ResearchVideoBuildCleanupError(
              Promise.all([
                buildError.exited,
                narrationError instanceof ResearchVideoSpeechCleanupError
                  ? narrationError.exited
                  : undefined
              ]).then(() => {})
            )
          : narrationError instanceof ResearchVideoSpeechCleanupError
            ? narrationError
            : undefined
      if (exit) {
        pendingExit = exit
        void exit.exited.then(() => {
          pendingExit = undefined
          void removeScratch().catch(() => {})
        })
        throw exit
      }
      if (narrationError) throw narrationError
      if (buildError) throw buildError
      await removeScratch()
    }
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
        const armIdleDeadline = (phase: string): void => {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            const error = Object.assign(new Error(`Film ${phase} timed out without progress.`), {
              code: 'ETIMEDOUT'
            })
            reject(new ResearchVideoWorkerError(error, 'generation'))
          }, GENERATION_IDLE_TIMEOUT_MS)
        }
        const abort = (): void => reject(signal.reason)
        const exit = (code: number): void =>
          reject(
            new ResearchVideoWorkerError(
              new Error('Research video worker stopped before completion'),
              'generation',
              undefined,
              code
            )
          )
        const error = (failure: Error): void =>
          reject(new ResearchVideoWorkerError(failure, 'generation'))
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
              armIdleDeadline('narration preparation')
              speech ??= ownSpeechProcess(
                (options.createSpeechProcess ?? forkSpeechProcess)(),
                (reply) => {
                  if (stopping || signal.aborted) return
                  armIdleDeadline('narration preparation')
                  if (reply.kind === 'speech-result')
                    worker!.postMessage(reply, [reply.audio.samples.buffer as ArrayBuffer])
                  else worker!.postMessage(reply)
                },
                (error, lane, exitCode) =>
                  reject(new ResearchVideoWorkerError(error, 'speech', lane, exitCode))
              )
              speech.send({
                ...value,
                input: {
                  kind: 'speech',
                  modelDirectory: input.modelDirectory,
                  runtimeDirectory: join(temporaryDirectory, `runtime-${value.lane}`),
                  threads: Math.max(
                    1,
                    Math.floor(Math.min(4, availableParallelism()) / speechConcurrency)
                  )
                }
              })
            } catch (error) {
              reject(error)
            }
          } else if (value.kind === 'result') resolve(value.result)
          else if (value.kind === 'error')
            reject(
              new ResearchVideoWorkerError(
                Object.assign(new Error(value.message), { code: value.code }),
                'generation'
              )
            )
          else if (value.kind === 'phase' || value.kind === 'progress') {
            try {
              const progress = value.kind === 'phase' ? { phase: value.phase } : value.progress
              armIdleDeadline(progress.phase)
              // Narration no longer owns work once the build starts.
              if (progress.phase === 'build') void speech?.stop().catch(reject)
              onProgress?.(progress)
            } catch (error) {
              reject(error)
            }
          }
        }
        armIdleDeadline('preparation')
        worker!.on('message', message)
        worker!.once('error', error)
        worker!.once('exit', (code) => {
          buildExit.resolve()
          exit(code)
        })
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        removeAbortListener = () => signal.removeEventListener('abort', abort)
      })
      clearTimeout(idleTimer)
      // Confirm narration exit before copying output into the caller's persistent job.
      await speech?.stop()
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
      clearTimeout(idleTimer)
      removeAbortListener()
      await cleanup()
    }
  }

  const run: ResearchVideoGenerate = async (input, signal, onProgress) => {
    assertReady()
    active = true
    try {
      return await generate(input, signal, onProgress)
    } finally {
      active = false
    }
  }
  return Object.assign(run, { assertReady })
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
  const speech = input.retainNarration
    ? join(dirname(input.specPath), 'speech')
    : input.temporaryDirectory
  const voiceDirectory = join(speech, 'voice')
  const mixPath = join(speech, 'mix.wav')
  const marker = join(speech, 'complete.json')
  const inputKey = createHash('sha256')
    .update(JSON.stringify([1, spec, input.provenance?.modelRevision]))
    .digest('hex')
  // Check the bytes once before using a previous run's speech/timing files.
  const signature = async (): Promise<string> => {
    const hash = createHash('sha256').update(inputKey)
    if (!(await lstat(voiceDirectory)).isDirectory()) throw new Error('Invalid narration directory')
    const names = await readdir(voiceDirectory)
    if (names.length > 256) throw new Error('Too many narration files')
    let bytes = 0
    for (const name of ['mix.wav', ...names.sort().map((name) => 'voice/' + name)]) {
      const path = join(speech, name)
      const stat = await lstat(path)
      bytes += stat.size
      if (!stat.isFile() || bytes > 200 * 1024 * 1024)
        throw new Error('Invalid narration checkpoint')
      hash.update(JSON.stringify([name, stat.size])).update(await readFile(path))
    }
    return hash.digest('hex')
  }
  let ready = false
  if (input.retainNarration) {
    const stat = await lstat(speech).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
    if (stat?.isDirectory()) {
      try {
        const receipt = await lstat(marker)
        ready =
          receipt.isFile() &&
          receipt.size === 64 &&
          (await readFile(marker, 'utf8')) === (await signature())
      } catch {
        /* An interrupted or incomplete cache is rebuilt below. */
      }
    }
    if (!ready) {
      await rm(speech, { recursive: true, force: true })
      await mkdir(speech, { mode: 0o700 })
    }
  }
  if (!ready) {
    const { mix } = await prepareVideoNarration({
      spec,
      synthesizer: synthesizers[0],
      additionalSynthesizer: synthesizers[1],
      onProgress: progress,
      outputDirectory: voiceDirectory,
      signal: new AbortController().signal
    })
    await writeFile(mixPath, mix, { flag: 'wx' })
    if (input.retainNarration)
      await writeFile(marker, await signature(), { flag: 'wx', mode: 0o600 })
  }
  progress({ phase: 'build' })
  return buildResearchVideoPlayer({ ...input, specPath, voiceDirectory, mixPath })
}
