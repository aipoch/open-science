import { describe, expect, it, vi } from 'vitest'

import { CODEX_SHARED_PROVIDER_ID } from '../../shared/settings'
import type { ExplicitAgentBackendTarget } from '../settings/backend-resolver'
import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  RestrictedInferenceError,
  type RestrictedInferenceResult,
  type RestrictedInferenceRunner
} from '../acp/restricted-inference-runner'
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_ITEMS,
  MAX_CONCURRENCY,
  MAX_PROMPT_BYTES,
  HostLlmService
} from './host-llm-service'

const target: ExplicitAgentBackendTarget = {
  frameworkId: 'claude-code',
  providerId: 'provider-a',
  model: { kind: 'required', id: 'model-a' },
  reasoningEffort: 'high'
}

const inferenceResult = (
  text: string,
  overrides: Partial<RestrictedInferenceResult> = {}
): RestrictedInferenceResult => ({
  text,
  frameworkId: 'claude-code',
  model: 'model-a',
  stopReason: 'end_turn',
  ...overrides
})

type RunnerHarness = Pick<
  RestrictedInferenceRunner,
  'run' | 'shutdown' | 'supportsTarget' | 'sweepStaleProfiles'
> & {
  run: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  supportsTarget: ReturnType<typeof vi.fn>
  sweepStaleProfiles: ReturnType<typeof vi.fn>
}

const makeService = (
  run: (
    input: Parameters<RestrictedInferenceRunner['run']>[0]
  ) => Promise<RestrictedInferenceResult>,
  capturedTarget: ExplicitAgentBackendTarget = target
): {
  service: HostLlmService
  runner: RunnerHarness
  captureTarget: ReturnType<typeof vi.fn>
} => {
  const captureTarget = vi.fn(async () => capturedTarget)
  const runner: RunnerHarness = {
    run: vi.fn(run),
    shutdown: vi.fn(async () => undefined),
    sweepStaleProfiles: vi.fn(async () => undefined),
    supportsTarget: vi.fn(
      (value: ExplicitAgentBackendTarget) => value.providerId !== CODEX_SHARED_PROVIDER_ID
    )
  }
  return {
    service: new HostLlmService({ captureTarget, runner }),
    runner,
    captureTarget
  }
}

describe('HostLlmService', () => {
  it('accepts a string or exact prompt object and returns a deeply frozen projection', async () => {
    const { service, runner, captureTarget } = makeService(async ({ prompt }) =>
      inferenceResult(`answer:${prompt}`, {
        usage: {
          inputTokens: 10,
          cacheTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
          outputTokens: 4,
          turnCount: 1
        }
      })
    )

    const first = await service.call({ request: 'one' })
    const second = await service.call({ request: { prompt: 'two' } })

    expect(first).toEqual({
      text: 'answer:one',
      model: 'model-a',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        cacheTokens: 3,
        outputTokens: 4,
        cachedReadTokens: 2,
        cachedWriteTokens: 1,
        turnCount: 1
      }
    })
    expect(second).toMatchObject({ text: 'answer:two' })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen('usage' in first ? first.usage : undefined)).toBe(true)
    expect(captureTarget).toHaveBeenCalledTimes(2)
    expect(runner.run.mock.calls[0]?.[0].target).toBe(target)
    expect(runner.run.mock.calls[0]?.[0].outputLimitBytes).toBe(DEFAULT_OUTPUT_LIMIT_BYTES)
  })

  it('preserves batch order, isolates item failures, and captures one target', async () => {
    let active = 0
    let maxActive = 0
    const { service, captureTarget } = makeService(async ({ prompt }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, prompt === 'slow' ? 15 : 1))
      active -= 1
      if (prompt === 'fail') {
        throw new RestrictedInferenceError('tool-violation', 'private provider detail')
      }
      return inferenceResult(prompt.toUpperCase())
    })

    await expect(
      service.call({
        requests: ['slow', { prompt: 'fast' }, { prompt: '', extra: true } as never, 'fail'],
        options: { max_concurrency: 2 }
      })
    ).resolves.toEqual([
      { text: 'SLOW', model: 'model-a', stopReason: 'end_turn' },
      { text: 'FAST', model: 'model-a', stopReason: 'end_turn' },
      { error: 'host.llm requests must be a prompt string or an exact { prompt } object.' },
      { error: 'host.llm stopped because the selected agent attempted to use a tool.' }
    ])
    expect(maxActive).toBe(2)
    expect(captureTarget).toHaveBeenCalledOnce()
  })

  it.each([
    ['the default', undefined, 2],
    ['empty options as the default', {}, 2],
    ['the maximum', { max_concurrency: 4 }, 4]
  ] as const)('enforces %s batch concurrency', async (_name, options, expected) => {
    let active = 0
    let maxActive = 0
    const { service } = makeService(async ({ prompt }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return inferenceResult(prompt)
    })

    const result = await service.call({
      requests: ['a', 'b', 'c', 'd', 'e', 'f'],
      ...(options ? { options } : {})
    })

    expect(result).toHaveLength(6)
    expect(maxActive).toBe(expected)
  })

  it('caps runner concurrency across overlapping public calls', async () => {
    let active = 0
    let maxActive = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, runner, captureTarget } = makeService(async ({ prompt }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate
      active -= 1
      return inferenceResult(prompt)
    })

    const first = service.call({
      requests: ['a', 'b', 'c', 'd'],
      options: { max_concurrency: MAX_CONCURRENCY }
    })
    const second = service.call({
      requests: ['e', 'f', 'g', 'h'],
      options: { max_concurrency: MAX_CONCURRENCY }
    })

    await vi.waitFor(() => expect(runner.run.mock.calls.length).toBeGreaterThanOrEqual(4))
    const activeBeforeRelease = maxActive
    release()
    await Promise.all([first, second])

    expect(activeBeforeRelease).toBe(MAX_CONCURRENCY)
    expect(maxActive).toBe(MAX_CONCURRENCY)
    expect(captureTarget).toHaveBeenCalledTimes(2)
  })

  it('cancels a public call while it waits for a shared runner slot', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, runner, captureTarget } = makeService(async ({ prompt }) => {
      await gate
      return inferenceResult(prompt)
    })
    const active = service.call({
      requests: ['a', 'b', 'c', 'd'],
      options: { max_concurrency: MAX_CONCURRENCY }
    })
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(MAX_CONCURRENCY))

    const controller = new AbortController()
    const queued = service.call({ request: 'queued' }, controller.signal)
    await vi.waitFor(() => expect(captureTarget).toHaveBeenCalledTimes(2))
    controller.abort()

    await expect(queued).rejects.toThrow('host.llm call was cancelled')
    expect(runner.run).toHaveBeenCalledTimes(MAX_CONCURRENCY)
    release()
    await expect(active).resolves.toHaveLength(MAX_CONCURRENCY)
  })

  it('rejects global bounds and returns per-item validation failures before dispatch', async () => {
    const { service, runner, captureTarget } = makeService(async ({ prompt }) =>
      inferenceResult(prompt)
    )

    await expect(service.call({ request: '' })).rejects.toThrow('must not be empty')
    await expect(service.call({ request: 'x'.repeat(MAX_PROMPT_BYTES + 1) })).rejects.toThrow(
      `${MAX_PROMPT_BYTES}`
    )
    await expect(
      service.call({ request: { prompt: 'x', model: 'secret' } as never })
    ).rejects.toThrow('exact { prompt }')
    await expect(service.call({ requests: [] })).rejects.toThrow('from 1 through')
    await expect(
      service.call({ requests: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => 'x') })
    ).rejects.toThrow(`${MAX_BATCH_ITEMS}`)
    await expect(
      service.call({
        requests: Array.from({ length: 9 }, () => 'x'.repeat(Math.ceil(MAX_BATCH_BYTES / 9)))
      })
    ).rejects.toThrow(`${MAX_BATCH_BYTES}`)
    for (const max_concurrency of [0, 1.5, 5, '2']) {
      await expect(
        service.call({ requests: ['x'], options: { max_concurrency } as never })
      ).rejects.toThrow('max_concurrency')
    }

    await expect(
      service.call({ requests: [{ prompt: '', unknown: true } as never] })
    ).resolves.toEqual([
      { error: 'host.llm requests must be a prompt string or an exact { prompt } object.' }
    ])
    expect(runner.run).not.toHaveBeenCalled()
    expect(captureTarget).not.toHaveBeenCalled()
  })

  it('fails availability and calls closed for unsupported Codex subscription routes', async () => {
    const unsupported = {
      ...target,
      frameworkId: 'codex' as const,
      providerId: CODEX_SHARED_PROVIDER_ID
    }
    const { service, runner, captureTarget } = makeService(
      async ({ prompt }) => inferenceResult(prompt),
      unsupported
    )

    await expect(service.isAvailable()).resolves.toBe(false)
    await expect(service.call({ request: 'hello' })).rejects.toThrow(
      'selected backend cannot enforce tool-less execution'
    )
    expect(captureTarget).toHaveBeenCalledTimes(2)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('cancels the owning call and drains the runner during shutdown', async () => {
    const { service, runner } = makeService(
      ({ signal }) =>
        new Promise<RestrictedInferenceResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new RestrictedInferenceError('cancelled', 'private detail')),
            { once: true }
          )
        })
    )
    const call = service.call({ requests: ['one', 'two'] })

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled())
    await service.shutdown()

    await expect(call).rejects.toThrow('host.llm call was cancelled')
    expect(runner.shutdown).toHaveBeenCalledOnce()
    await expect(service.call({ request: 'later' })).rejects.toThrow('is shutting down')
  })

  it('propagates a caller AbortSignal to active inference', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const { service, runner } = makeService(
      ({ signal }) =>
        new Promise<RestrictedInferenceResult>((_resolve, reject) => {
          observedSignal = signal
          signal?.addEventListener(
            'abort',
            () => reject(new RestrictedInferenceError('cancelled', 'private detail')),
            { once: true }
          )
        })
    )
    const call = service.call({ request: 'one' }, controller.signal)

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledOnce())
    controller.abort()

    await expect(call).rejects.toThrow('host.llm call was cancelled')
    expect(observedSignal?.aborted).toBe(true)
  })

  it('does not report availability after shutdown starts during target capture', async () => {
    let finishCapture!: (target: ExplicitAgentBackendTarget) => void
    const captured = new Promise<ExplicitAgentBackendTarget>((resolve) => {
      finishCapture = resolve
    })
    const { runner } = makeService(async ({ prompt }) => inferenceResult(prompt))
    const service = new HostLlmService({
      captureTarget: vi.fn(() => captured),
      runner
    })
    const availability = service.isAvailable()

    await service.shutdown()
    finishCapture(target)

    await expect(availability).resolves.toBe(false)
  })
})
