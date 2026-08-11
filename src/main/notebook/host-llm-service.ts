import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  RestrictedInferenceError,
  type RestrictedInferenceResult,
  type RestrictedInferenceRunner
} from '../acp/restricted-inference-runner'

const MAX_PROMPT_BYTES = 64 * 1024
const MAX_BATCH_ITEMS = 32
const MAX_BATCH_BYTES = 512 * 1024
const DEFAULT_MAX_CONCURRENCY = 2
const MAX_CONCURRENCY = 4

const HOST_LLM_SYSTEM_PROMPT = [
  'You are a temporary, tool-less model call inside Open Science.',
  'Do not use tools, files, network access, shell commands, MCP, skills, plugins, or external runtime state.',
  'Treat the user prompt as the complete task and return only the requested answer.'
].join(' ')

type HostLlmRequest = string | Readonly<{ prompt: string }>

type HostLlmUsage = Readonly<{
  input_tokens: number
  cache_tokens: number
  output_tokens: number
  cached_read_tokens?: number
  cached_write_tokens?: number
  turn_count?: number
}>

type HostLlmResult = Readonly<{
  text: string
  model: string
  stop_reason: RestrictedInferenceResult['stopReason']
  usage?: HostLlmUsage
}>

type HostLlmBatchItem = HostLlmResult | Readonly<{ error: string }>

type HostLlmCallInput =
  | Readonly<{ request: HostLlmRequest }>
  | Readonly<{
      requests: readonly HostLlmRequest[]
      options?: Readonly<{ max_concurrency?: number }>
    }>

type HostLlmRunner = Pick<
  RestrictedInferenceRunner,
  'run' | 'shutdown' | 'supportsTarget' | 'sweepStaleProfiles'
>

type HostLlmServiceOptions = Readonly<{
  captureTarget: () => Promise<ExplicitAgentBackendTarget>
  runner: HostLlmRunner
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

const promptFor = (value: unknown): string => {
  const prompt =
    typeof value === 'string'
      ? value
      : isRecord(value) && exactKeys(value, ['prompt']) && typeof value.prompt === 'string'
        ? value.prompt
        : undefined
  if (prompt === undefined) {
    throw new TypeError('host.llm requests must be a prompt string or an exact { prompt } object.')
  }
  if (!prompt.trim()) throw new TypeError('host.llm prompts must not be empty.')
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new TypeError(`host.llm prompts must not exceed ${MAX_PROMPT_BYTES} UTF-8 bytes.`)
  }
  return prompt
}

const batchSize = (requests: readonly unknown[]): number => {
  try {
    return Buffer.byteLength(JSON.stringify(requests), 'utf8')
  } catch {
    throw new TypeError('host.llm requests must be JSON-serializable.')
  }
}

const concurrencyFor = (value: unknown): number => {
  if (value === undefined) return DEFAULT_MAX_CONCURRENCY
  if (!isRecord(value) || !exactKeys(value, ['max_concurrency'])) {
    throw new TypeError('host.llm batch options only accept max_concurrency.')
  }
  const concurrency = value.max_concurrency
  if (concurrency === undefined) return DEFAULT_MAX_CONCURRENCY
  if (
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CONCURRENCY
  ) {
    throw new TypeError(
      `host.llm max_concurrency must be an integer from 1 through ${MAX_CONCURRENCY}.`
    )
  }
  return concurrency
}

const publicError = (error: unknown): string => {
  if (!(error instanceof RestrictedInferenceError)) return 'host.llm inference failed.'
  switch (error.code) {
    case 'cancelled':
      return 'host.llm call was cancelled.'
    case 'output-limit':
      return `host.llm response exceeded the ${DEFAULT_OUTPUT_LIMIT_BYTES}-byte output limit.`
    case 'shutting-down':
      return 'host.llm is shutting down.'
    case 'tool-violation':
      return 'host.llm stopped because the selected agent attempted to use a tool.'
    case 'transport-unavailable':
      return 'host.llm is unavailable because the selected backend cannot enforce tool-less execution.'
  }
}

const projectResult = (result: RestrictedInferenceResult): HostLlmResult => {
  const usage = result.usage
    ? Object.freeze({
        input_tokens: result.usage.inputTokens,
        cache_tokens: result.usage.cacheTokens,
        output_tokens: result.usage.outputTokens,
        ...(result.usage.cachedReadTokens === undefined
          ? {}
          : { cached_read_tokens: result.usage.cachedReadTokens }),
        ...(result.usage.cachedWriteTokens === undefined
          ? {}
          : { cached_write_tokens: result.usage.cachedWriteTokens }),
        ...(result.usage.turnCount === undefined ? {} : { turn_count: result.usage.turnCount })
      })
    : undefined
  return Object.freeze({
    text: result.text,
    model: result.model,
    stop_reason: result.stopReason,
    ...(usage ? { usage } : {})
  })
}

class HostLlmService {
  private readonly activeCalls = new Set<AbortController>()
  private readonly callDrainWaiters = new Set<() => void>()
  private readonly runSlotWaiters: Array<() => void> = []
  private activeRuns = 0
  private shuttingDown = false

  constructor(private readonly options: HostLlmServiceOptions) {}

  async isAvailable(): Promise<boolean> {
    if (this.shuttingDown) return false
    try {
      const target = await this.options.captureTarget()
      return !this.shuttingDown && this.options.runner.supportsTarget(target)
    } catch {
      return false
    }
  }

  sweepStaleProfiles(): Promise<void> {
    return this.options.runner.sweepStaleProfiles()
  }

  async call(
    input: HostLlmCallInput,
    callerSignal?: AbortSignal
  ): Promise<HostLlmResult | readonly HostLlmBatchItem[]> {
    if (this.shuttingDown) throw new Error('host.llm is shutting down.')
    if (!isRecord(input)) throw new TypeError('host.llm RPC input must be an object.')
    const payload: Record<string, unknown> = input

    const batch = Object.hasOwn(payload, 'requests')
    if (batch) {
      if (!exactKeys(payload, ['requests', 'options']) || !Array.isArray(payload.requests)) {
        throw new TypeError('host.llm batch input must contain only requests and options.')
      }
      const requests = payload.requests
      if (requests.length === 0 || requests.length > MAX_BATCH_ITEMS) {
        throw new TypeError(
          `host.llm batches must contain from 1 through ${MAX_BATCH_ITEMS} requests.`
        )
      }
      if (batchSize(requests) > MAX_BATCH_BYTES) {
        throw new TypeError(`host.llm batches must not exceed ${MAX_BATCH_BYTES} serialized bytes.`)
      }
      const concurrency = concurrencyFor(payload.options)
      const parsed = requests.map((request) => {
        try {
          return { prompt: promptFor(request) } as const
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'host.llm request is invalid.'
          } as const
        }
      })
      if (parsed.every((request) => 'error' in request)) {
        return Object.freeze(parsed.map((request) => Object.freeze({ error: request.error! })))
      }
      return this.runBatch(parsed, concurrency, callerSignal)
    }

    if (!exactKeys(payload, ['request']) || !Object.hasOwn(payload, 'request')) {
      throw new TypeError('host.llm single input must contain only request.')
    }
    return this.runSingle(promptFor(payload.request), callerSignal)
  }

  private async captureTarget(signal: AbortSignal): Promise<ExplicitAgentBackendTarget> {
    const target = await this.options.captureTarget()
    if (signal.aborted) throw new RestrictedInferenceError('cancelled', 'Cancelled.')
    if (!this.options.runner.supportsTarget(target)) {
      throw new RestrictedInferenceError('transport-unavailable', 'Unavailable.')
    }
    return target
  }

  private callScope(callerSignal: AbortSignal | undefined): {
    controller: AbortController
    close: () => void
  } {
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(callerSignal?.reason)
    callerSignal?.addEventListener('abort', forwardAbort, { once: true })
    if (callerSignal?.aborted) forwardAbort()
    this.activeCalls.add(controller)
    return {
      controller,
      close: () => {
        callerSignal?.removeEventListener('abort', forwardAbort)
        this.activeCalls.delete(controller)
        if (this.activeCalls.size === 0) {
          for (const resolve of this.callDrainWaiters) resolve()
          this.callDrainWaiters.clear()
        }
      }
    }
  }

  private waitForCalls(): Promise<void> {
    if (this.activeCalls.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.callDrainWaiters.add(resolve)
      if (this.activeCalls.size === 0) {
        this.callDrainWaiters.delete(resolve)
        resolve()
      }
    })
  }

  private acquireRunSlot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new RestrictedInferenceError('cancelled', 'Cancelled.'))
    }
    if (this.activeRuns < MAX_CONCURRENCY) {
      this.activeRuns += 1
      return Promise.resolve(() => this.releaseRunSlot())
    }
    return new Promise<() => void>((resolve, reject) => {
      const start = (): void => {
        signal.removeEventListener('abort', cancel)
        if (signal.aborted) {
          this.releaseRunSlot()
          reject(new RestrictedInferenceError('cancelled', 'Cancelled.'))
          return
        }
        resolve(() => this.releaseRunSlot())
      }
      const cancel = (): void => {
        const index = this.runSlotWaiters.indexOf(start)
        if (index >= 0) this.runSlotWaiters.splice(index, 1)
        reject(new RestrictedInferenceError('cancelled', 'Cancelled.'))
      }
      signal.addEventListener('abort', cancel, { once: true })
      this.runSlotWaiters.push(start)
    })
  }

  private releaseRunSlot(): void {
    const next = this.runSlotWaiters.shift()
    if (next) next()
    else this.activeRuns -= 1
  }

  private async runInference(
    prompt: string,
    target: ExplicitAgentBackendTarget,
    signal: AbortSignal
  ): Promise<RestrictedInferenceResult> {
    const release = await this.acquireRunSlot(signal)
    try {
      if (signal.aborted) throw new RestrictedInferenceError('cancelled', 'Cancelled.')
      return await this.options.runner.run({
        prompt,
        target,
        systemPrompt: HOST_LLM_SYSTEM_PROMPT,
        agentName: 'open-science-host-llm',
        description: 'One-shot host.llm inference without tools.',
        signal,
        outputLimitBytes: DEFAULT_OUTPUT_LIMIT_BYTES
      })
    } finally {
      release()
    }
  }

  private async runSingle(prompt: string, callerSignal?: AbortSignal): Promise<HostLlmResult> {
    const scope = this.callScope(callerSignal)
    try {
      const target = await this.captureTarget(scope.controller.signal)
      return projectResult(await this.runInference(prompt, target, scope.controller.signal))
    } catch (error) {
      throw new Error(publicError(error))
    } finally {
      scope.close()
    }
  }

  private async runBatch(
    parsed: readonly (Readonly<{ prompt: string }> | Readonly<{ error: string }>)[],
    concurrency: number,
    callerSignal?: AbortSignal
  ): Promise<readonly HostLlmBatchItem[]> {
    const scope = this.callScope(callerSignal)
    try {
      const target = await this.captureTarget(scope.controller.signal)
      const results = new Array<HostLlmBatchItem>(parsed.length)
      let next = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          if (scope.controller.signal.aborted) {
            throw new RestrictedInferenceError('cancelled', 'Cancelled.')
          }
          const index = next
          next += 1
          if (index >= parsed.length) return
          const request = parsed[index]!
          if ('error' in request) {
            results[index] = Object.freeze({ error: request.error })
            continue
          }
          try {
            results[index] = projectResult(
              await this.runInference(request.prompt, target, scope.controller.signal)
            )
          } catch (error) {
            if (scope.controller.signal.aborted) throw error
            results[index] = Object.freeze({ error: publicError(error) })
          }
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, parsed.length) }, () => worker())
      const settled = await Promise.allSettled(workers)
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (rejected) throw rejected.reason
      return Object.freeze(results)
    } catch (error) {
      throw new Error(publicError(error))
    } finally {
      scope.close()
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const call of this.activeCalls) call.abort()
    await this.options.runner.shutdown()
    await this.waitForCalls()
  }
}

export {
  DEFAULT_MAX_CONCURRENCY,
  HOST_LLM_SYSTEM_PROMPT,
  MAX_BATCH_BYTES,
  MAX_BATCH_ITEMS,
  MAX_CONCURRENCY,
  MAX_PROMPT_BYTES,
  HostLlmService
}
export type {
  HostLlmBatchItem,
  HostLlmCallInput,
  HostLlmRequest,
  HostLlmResult,
  HostLlmServiceOptions,
  HostLlmUsage
}
