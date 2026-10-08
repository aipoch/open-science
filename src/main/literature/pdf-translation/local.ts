import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { LOCAL_MODEL_NOT_INSTALLED } from '../../../shared/local-models'
import { PdfTranslationError } from '../../../shared/pdf-translation'
import type { LocalModelOwner, LocalModelUse } from '../../local-models/owner'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../../process-tree'

export type PdfTranslationLocalTarget = Readonly<{ modelId: string; revision: string }>
type LocalRequest = {
  target: PdfTranslationLocalTarget
  systemPrompt: string
  prompt: string
  signal: AbortSignal
  outputLimitBytes: number
}
type LocalResult = {
  text: string
  stopReason: 'end_turn' | 'max_tokens'
  usage: { inputTokens: number; outputTokens: number; cacheTokens: number }
}
export type PdfTranslationLocalRuntime = {
  acquireTarget(): Promise<PdfTranslationLocalTarget>
  run(request: LocalRequest): Promise<LocalResult>
  release(target: PdfTranslationLocalTarget): Promise<void>
  shutdown(): Promise<void>
}
const RUNTIME = 'transformers-4-2-0-ort-web-1-26-0-dev-20260416-b7804b056c-wasm-v1'
const TIMEOUT_MS = 180_000

// One CPU worker across documents bounds resident model memory. Target leases protect model files
// until verified child termination, including cancellation and application shutdown.
export const createPdfTranslationLocalRuntime = (
  resources: string,
  models: LocalModelOwner
): PdfTranslationLocalRuntime => {
  const targets = new Map<PdfTranslationLocalTarget, LocalModelUse>()
  let child: ChildProcessWithoutNullStreams | undefined
  let queue = Promise.resolve()
  let closed = false
  let active: AbortController | undefined
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (!child) return Promise.resolve()
    stopping ??= (async () => {
      const current = child!
      const result = await terminateProcessTree(current, 'SIGKILL')
      if (!result.reaped) throw new Error('Local translation worker termination is unconfirmed.')
      if (child === current) child = undefined
    })().finally(() => {
      stopping = undefined
    })
    return stopping
  }
  const execute = async (request: LocalRequest): Promise<LocalResult> => {
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
    if (child && (child.exitCode !== null || child.signalCode !== null)) await stop()
    if (!child) {
      child = spawn(process.execPath, [join(resources, 'worker.mjs')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
      if (process.platform !== 'win32') registerOwnedPosixProcessGroup(child)
      // Diagnostics must not retain PDF text. Request failures are returned through the protocol.
      child.stderr.on('data', () => undefined)
      child.on('error', () => undefined)
      child.stdin.on('error', () => undefined)
    }
    const current = child
    const controller = new AbortController()
    active = controller
    const signal = AbortSignal.any([request.signal, controller.signal])
    const id = randomUUID()
    try {
      return await new Promise<LocalResult>((resolve, reject) => {
        let output = Buffer.alloc(0)
        const finish = (error?: Error, value?: LocalResult): void => {
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
            finish(undefined, { ...result, usage: { ...result.usage, cacheTokens: 0 } })
          } catch (error) {
            finish(
              error instanceof Error ? error : new Error('Invalid local translation response.')
            )
          }
        }
        const timer = setTimeout(
          () => finish(new PdfTranslationError('timeout', 'Local translation timed out.')),
          TIMEOUT_MS
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
            directory: dirname(use.assets[0].path),
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
    }
  }
  return {
    async acquireTarget() {
      if (closed) throw new Error('Local translation runtime is closed.')
      const use = await models.acquireUse().catch((error: unknown) => {
        if (error instanceof Error && error.message === LOCAL_MODEL_NOT_INSTALLED)
          throw new PdfTranslationError(
            'unsupported-model',
            'Install the local translation model first.'
          )
        throw error
      })
      if (closed) {
        use.release()
        throw new Error('Local translation runtime is closed.')
      }
      const target = Object.freeze({
        modelId: 'qwen3-0.6b-q8',
        revision: `${use.revision}:${RUNTIME}`
      })
      targets.set(target, use)
      return target
    },
    run(request) {
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
      return new Promise<LocalResult>((resolve, reject) => {
        abortQueued = () => reject(request.signal.reason)
        request.signal.addEventListener('abort', abortQueued, { once: true })
        void result
          .then(resolve, reject)
          .finally(() => request.signal.removeEventListener('abort', abortQueued))
        if (request.signal.aborted) abortQueued()
      })
    },
    async release(target) {
      const use = targets.get(target)
      if (!use) return
      if (targets.size > 1) {
        targets.delete(target)
        use.release()
        return
      }
      // Teardown participates in the same queue as inference. A new target acquired while this
      // release waits either keeps the worker alive or starts only after teardown has completed.
      const cleanup = queue.then(async () => {
        const currentUse = targets.get(target)
        if (!currentUse) return
        if (targets.size === 1) await stop()
        targets.delete(target)
        currentUse.release()
      })
      queue = cleanup.then(
        () => undefined,
        () => undefined
      )
      await cleanup
    },
    async shutdown() {
      closed = true
      active?.abort()
      await queue
      await stop()
      for (const use of targets.values()) use.release()
      targets.clear()
    }
  }
}
