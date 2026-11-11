import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestrictedInferenceRunnerOptions } from '../acp/restricted-inference-runner'
import { ProviderAcpValidator } from './provider-acp-validation'

const fake = vi.hoisted(() => ({
  run: vi.fn(),
  shutdown: vi.fn(),
  options: undefined as unknown
}))
vi.mock('../acp/restricted-inference-runner', () => ({
  RestrictedInferenceRunner: class {
    constructor(options: unknown) {
      fake.options = options
    }
    run = fake.run
    sweepStaleProfiles = async (): Promise<void> => undefined
    shutdown = fake.shutdown
  }
}))
vi.mock('../runtime-metadata', () => ({ runtimeMetadata: () => ({ version: 'test' }) }))

const provider = {
  type: 'custom' as const,
  model: 'model',
  key: 'candidate-secret',
  baseUrl: 'https://gateway.example'
}
const settings: import('./types').StoredSettings = {
  version: 2,
  providers: [],
  agentFrameworkId: 'claude-code' as const
}

beforeEach(() => {
  vi.resetAllMocks()
  fake.shutdown.mockResolvedValue(undefined)
})

describe('ProviderAcpValidator', () => {
  it.each([
    { text: 'OK', stopReason: 'end_turn', ok: true },
    { text: 'authentication error', stopReason: 'end_turn', ok: false },
    { text: '', stopReason: 'end_turn', ok: false },
    { text: 'OK', stopReason: 'cancelled', ok: false }
  ])(
    'requires a completed inference acknowledgement: $text / $stopReason',
    async ({ text, stopReason, ok }) => {
      const resolve = vi.fn(async () => ({ modelRoute: 'claude-anthropic' as const }))
      const validator = new ProviderAcpValidator('/unused', resolve as never)
      fake.run.mockImplementation(async (input) => {
        const options = fake.options as RestrictedInferenceRunnerOptions
        expect(options).toMatchObject({ taskOnly: true, preserveModelRoute: true })
        await options.resolveTarget(input.target, {
          storageRoot: '/disposable',
          systemPromptAppends: [],
          includeSkillAndConnectorContext: false
        })
        return { text, stopReason }
      })
      const result = await validator.validate(provider, settings)
      expect(result.ok).toBe(ok)
      if (ok)
        expect(result.testedTarget).toEqual({
          model: 'model',
          frameworkId: 'claude-code',
          route: 'claude-anthropic'
        })
      expect(resolve).toHaveBeenCalledWith(provider, settings, '/disposable')
      expect(fake.run).toHaveBeenCalledTimes(1)
      expect(fake.shutdown).toHaveBeenCalledTimes(1)
    }
  )

  it('redacts candidate credentials from native errors', async () => {
    fake.run.mockRejectedValue(new Error('rejected candidate-secret'))
    const validator = new ProviderAcpValidator('/unused', vi.fn())
    expect(await validator.validate(provider, settings)).toMatchObject({
      ok: false,
      message: 'rejected [redacted]'
    })
    expect(fake.shutdown).toHaveBeenCalledOnce()
  })

  it('aborts the native attempt at its deadline and stops accepting work after disposal', async () => {
    vi.useFakeTimers()
    try {
      fake.run.mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
      )
      const validator = new ProviderAcpValidator('/unused', vi.fn())
      const pending = validator.validate(provider, settings)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await pending).toMatchObject({ ok: false, category: 'timeout' })
      expect(fake.shutdown).toHaveBeenCalledOnce()
      await validator.dispose()
      expect((await validator.validate(provider, settings)).ok).toBe(false)
      expect(fake.run).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
