import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ModelIdentity } from '../models/types'
import type { ProviderTokenUsage } from '../protocols/usage'
import { QWEN3_LOCAL_TEXT_GENERATION_MODEL } from '../providers/local-model'

export type LocalTextInput = Readonly<{
  prompt: string
  systemPrompt?: string
  signal?: AbortSignal
  outputLimitBytes?: number
}>
export type LocalTextResult = Readonly<{
  text: string
  stopReason: 'end_turn' | 'max_tokens'
  usage: ProviderTokenUsage
}>
export type LocalTextModel = ModelIdentity<'text-generation'> &
  Readonly<{
    generate(input: LocalTextInput): Promise<LocalTextResult>
    dispose(): Promise<void>
  }>
/** Override only when the application manages child processes and must confirm their termination. */
export type LocalProcessOwner = Readonly<{
  launch(workerPath: string): ChildProcessWithoutNullStreams
  terminate(child: ChildProcessWithoutNullStreams): Promise<void>
}>
export type LocalTextRuntime = Readonly<{
  createModel(options: { directory: string }): LocalTextModel
  dispose(): Promise<void>
}>
export class LocalModelError extends Error {
  constructor(
    readonly code: 'timeout',
    message: string
  ) {
    super(message)
  }
}
type LocalExecution = Required<LocalTextInput> & { target: LocalTextModel }
const defaultProcessOwner: LocalProcessOwner = {
  launch: (path) =>
    spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  async terminate(child) {
    // A failed Node spawn has no PID and emits error/close, never exit. There is nothing to reap.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        child.removeListener('exit', exited)
        child.removeListener('error', failed)
      }
      const exited = (): void => {
        cleanup()
        resolve()
      }
      const failed = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const timer = setTimeout(
        () => failed(new Error('Local model worker termination is unconfirmed.')),
        5000
      )
      child.once('exit', exited)
      child.once('error', failed)
      try {
        child.kill('SIGKILL')
      } catch (error) {
        failed(error instanceof Error ? error : new Error('Local model termination failed.'))
      }
    })
  }
}

/** One worker and queue per runtime. Each model handle retains its directory until disposal succeeds. */
export function createLocalTextRuntime(
  options: { process?: LocalProcessOwner; timeoutMs?: number } = {}
): LocalTextRuntime {
  const processOwner = options.process ?? defaultProcessOwner
  const timeoutMs = options.timeoutMs ?? 180_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError('Invalid local model timeout.')
  const targets = new Map<LocalTextModel, string>()
  let child: ChildProcessWithoutNullStreams | undefined
  let workerDirectory: string | undefined
  let activeTarget: LocalTextModel | undefined
  let queue = Promise.resolve()
  let closed = false
  let active: AbortController | undefined
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (!child) return Promise.resolve()
    stopping ??= (async () => {
      const current = child!
      await processOwner.terminate(current)
      if (child === current) child = undefined
    })().finally(() => {
      stopping = undefined
    })
    return stopping
  }
  const execute = async (request: LocalExecution): Promise<LocalTextResult> => {
    request.signal.throwIfAborted()
    const use = targets.get(request.target)
    if (closed || !use) throw new Error('Local translation target is no longer available.')
    if (
      !Number.isSafeInteger(request.outputLimitBytes) ||
      request.outputLimitBytes < 1 ||
      request.outputLimitBytes > 1024 * 1024 ||
      Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.prompt) > 64 * 1024
    )
      throw new Error('Local translation request exceeds its limits.')
    if (child && (child.exitCode !== null || child.signalCode !== null || workerDirectory !== use))
      await stop()
    request.signal.throwIfAborted()
    if (closed || !targets.has(request.target)) throw new Error('Local model runtime is closed.')
    if (!child) {
      child = processOwner.launch(require.resolve('../../resources/local-worker.mjs'))
      workerDirectory = use
      // Diagnostics must not retain PDF text. Request failures are returned through the protocol.
      child.stderr.on('data', () => undefined)
      child.on('error', () => undefined)
      child.stdin.on('error', () => undefined)
    }
    const current = child
    const controller = new AbortController()
    active = controller
    activeTarget = request.target
    const signal = AbortSignal.any([request.signal, controller.signal])
    const id = randomUUID()
    try {
      return await new Promise<LocalTextResult>((resolve, reject) => {
        let output = Buffer.alloc(0)
        const finish = (error?: Error, value?: LocalTextResult): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          current.stdout.removeListener('data', data)
          current.removeListener('error', errorHandler)
          current.removeListener('exit', exit)
          current.stdin.removeListener('error', errorHandler)
          if (error) reject(error)
          else resolve(value!)
        }
        const abort = (): void =>
          finish(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException('Aborted', 'AbortError')
          )
        const errorHandler = (error: Error): void => finish(error)
        const exit = (code: number | null, signal: string | null): void =>
          finish(new Error(`Local translation worker exited (${signal ?? code ?? 'unknown'}).`))
        const data = (chunk: Buffer): void => {
          output = Buffer.concat([output, chunk])
          if (output.length > request.outputLimitBytes + 4096) {
            finish(new Error('Local translation output limit exceeded.'))
            return
          }
          if (!output.includes(10)) return
          try {
            const result = JSON.parse(output.toString('utf8'))
            if (result.id !== id || result.error)
              throw new Error('Local translation inference failed.')
            if (
              typeof result.text !== 'string' ||
              Buffer.byteLength(result.text) > request.outputLimitBytes ||
              !['end_turn', 'max_tokens'].includes(result.stopReason) ||
              !Number.isSafeInteger(result.usage?.inputTokens) ||
              result.usage.inputTokens < 0 ||
              !Number.isSafeInteger(result.usage?.outputTokens) ||
              result.usage.outputTokens < 0
            )
              throw new Error('Invalid local translation response.')
            finish(undefined, {
              text: result.text,
              stopReason: result.stopReason,
              usage: { ...result.usage, cacheTokens: 0 }
            })
          } catch (error) {
            finish(
              error instanceof Error ? error : new Error('Invalid local translation response.')
            )
          }
        }
        const timer = setTimeout(
          () => finish(new LocalModelError('timeout', 'Local model timed out.')),
          timeoutMs
        )
        current.stdout.on('data', data)
        current.once('error', errorHandler)
        current.once('exit', exit)
        current.stdin.once('error', errorHandler)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
        current.stdin.write(
          JSON.stringify({
            id,
            directory: use,
            systemPrompt: request.systemPrompt,
            prompt: request.prompt,
            outputLimitBytes: request.outputLimitBytes
          }) + '\n'
        )
      })
    } catch (error) {
      await stop()
      throw error
    } finally {
      active = undefined
      activeTarget = undefined
    }
  }
  const run = (request: LocalExecution): Promise<LocalTextResult> => {
    // Cancel a queued document immediately without interrupting another document's inference.
    let abortQueued: () => void = () => undefined
    const result = queue.then(() => {
      request.signal.removeEventListener('abort', abortQueued)
      return execute(request)
    })
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return new Promise<LocalTextResult>((resolve, reject) => {
      abortQueued = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abortQueued, { once: true })
      void result
        .then(resolve, reject)
        .finally(() => request.signal.removeEventListener('abort', abortQueued))
      if (request.signal.aborted) abortQueued()
    })
  }
  const release = async (target: LocalTextModel): Promise<void> => {
    const use = targets.get(target)
    if (!use) return
    const keepsDirectory = (): boolean =>
      [...targets].some(([other, directory]) => other !== target && directory === use)
    if (activeTarget !== target && (workerDirectory !== use || keepsDirectory())) {
      targets.delete(target)
      return
    }
    // Teardown participates in the same queue as inference. A new target acquired while this
    // release waits either keeps the worker alive or starts only after teardown has completed.
    const cleanup = queue.then(async () => {
      const currentUse = targets.get(target)
      if (!currentUse) return
      // Another directory's handle cannot retain this worker's mapped model files.
      if (workerDirectory === use && !keepsDirectory()) await stop()
      targets.delete(target)
    })
    queue = cleanup.then(
      () => undefined,
      () => undefined
    )
    await cleanup
  }
  return {
    createModel({ directory }) {
      if (closed) throw new Error('Local model runtime is closed.')
      if (!isAbsolute(directory)) throw new TypeError('Local model directory must be absolute.')
      const model: LocalTextModel = Object.freeze({
        providerId: 'local',
        modelId: QWEN3_LOCAL_TEXT_GENERATION_MODEL.id,
        capability: 'text-generation' as const,
        generate(input: LocalTextInput) {
          return run({
            ...input,
            target: model,
            systemPrompt: input.systemPrompt ?? '',
            signal: input.signal ?? new AbortController().signal,
            outputLimitBytes: input.outputLimitBytes ?? 1024 * 1024
          })
        },
        dispose: () => release(model)
      })
      targets.set(model, directory)
      return model
    },
    async dispose() {
      closed = true
      active?.abort()
      await queue
      await stop()
      targets.clear()
    }
  }
}
