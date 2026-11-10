import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptOptimizationService } from './prompt-optimization'
import { resolveValidatedSessionAgentTarget } from '../acp/session-agent-target'
import type { SettingsSnapshot } from '../../shared/settings'
import type { RestrictedInferenceRunInput } from '../acp/restricted-inference-contract'

const log = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => log
}))
beforeEach(() => vi.clearAllMocks())

const agentConfiguration = {
  providerId: 'test',
  model: 'test',
  reasoningEffort: 'default' as const
}
const settings = {
  agentFrameworkId: 'opencode',
  reasoningEffort: 'default',
  agentFrameworks: [{ id: 'opencode', supportedApiTypes: ['chat-completions'] }],
  activeProviderId: 'global',
  activeModel: 'global-model',
  providers: ['test', 'session', 'global'].map((id) => ({
    id,
    name: id,
    type: 'custom',
    apiEndpoints: ['chat-completions'],
    baseUrl: 'https://example.test/v1',
    model: id === 'test' ? id : `${id}-model`,
    models: [id === 'test' ? id : `${id}-model`],
    hasKey: true,
    needsKey: false
  }))
} as SettingsSnapshot

const setup = (
  generate: (input: RestrictedInferenceRunInput) => Promise<string>,
  timeoutMs = 20
): PromptOptimizationService => {
  const runner = {
    run: async (input: RestrictedInferenceRunInput) => ({
      text: await generate(input),
      stopReason: 'end_turn' as const,
      frameworkId: 'opencode' as const,
      model: 'test'
    })
  }
  return new PromptOptimizationService({
    getProject: async (id: string) =>
      id === 'deleted'
        ? null
        : { id, optimizationPrompt: id === 'custom' ? 'Keep it concise.' : '' },
    resolveTarget: async (source) => resolveValidatedSessionAgentTarget(source, settings),
    runner,
    timeoutMs
  })
}

describe('prompt optimization', () => {
  it('aborts only the matching request and permits a retry before the old runner settles', async () => {
    let signal: AbortSignal | undefined
    let finish!: (text: string) => void
    const service = setup(async (input) => {
      if (input.prompt === 'Retry') return 'Fresh'
      signal = input.signal
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    }, 10000)
    const requestId = crypto.randomUUID()
    const pending = service.optimize({
      projectId: 'default',
      requestId,
      input: 'Help',
      agentConfiguration
    })
    const cancelled = expect(pending).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1 })
    service.cancel({ projectId: 'default', requestId: crypto.randomUUID() })
    expect(signal!.aborted).toBe(false)
    service.cancel({ projectId: 'default', requestId })
    expect(signal!.aborted).toBe(true)
    await cancelled
    await expect(
      service.optimize({
        projectId: 'default',
        requestId: crypto.randomUUID(),
        input: 'Retry',
        agentConfiguration
      })
    ).resolves.toEqual({ text: 'Fresh' })
    finish('Late')
  })
  it('uses the validated composer provider and model instead of the global selection', async () => {
    const service = setup(async ({ target: actual }) => {
      expect(actual).toEqual({
        frameworkId: 'opencode',
        providerId: 'session',
        model: { kind: 'required', id: 'session-model' },
        reasoningEffort: 'high'
      })
      return 'Improved'
    })
    await expect(
      service.optimize({
        projectId: 'default',
        input: 'Help',
        agentConfiguration: {
          providerId: 'session',
          model: 'session-model',
          reasoningEffort: 'high'
        }
      })
    ).resolves.toEqual({ text: 'Improved' })
  })
  it.each([
    { providerId: 'deleted', model: 'session-model' },
    { providerId: 'session', model: 'missing-model' }
  ])('rejects an unavailable composer target: %j', async (selection) => {
    const generate = vi.fn(async () => 'Must not run')
    await expect(
      setup(generate).optimize({
        projectId: 'default',
        input: 'Help',
        agentConfiguration: { ...selection, reasoningEffort: 'default' }
      })
    ).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })

  it('uses only the selected project template and preserves protected scientific text', async () => {
    const seen: RestrictedInferenceRunInput[] = []
    const service = setup(async (input) => {
      seen.push(input)
      return `Clarify: ${input.prompt}`
    })
    const input = 'Review DOI 10.1234/Example and `print(1)` with $x^2$.'
    expect(await service.optimize({ agentConfiguration, projectId: 'custom', input })).toEqual({
      text: `Clarify: ${input}`
    })
    expect(seen[0].systemPrompt).toContain('Keep it concise.')
    expect(seen[0].prompt).not.toContain('print(1)')
    await service.optimize({ agentConfiguration, projectId: 'default', input: 'Plan a study' })
    expect(seen[1].systemPrompt).not.toContain('Keep it concise.')
  })
  it('protects complete fenced blocks including embedded delimiters and longer fences', async () => {
    const generate = vi.fn(async (input: RestrictedInferenceRunInput) => {
      expect(input.prompt).not.toContain('alpha')
      expect(input.prompt).not.toContain('marker')
      return input.prompt
    })
    const service = setup(generate)
    for (const input of [
      'Explain:\n```python\nmarker = "```"\nalpha = 0.05\n```',
      'Explain:\n````markdown\n```python\nalpha = 0.05\n```\n````',
      'Explain:\n~~~python\nmarker = "~~~"\nalpha = 0.05\n~~~',
      'Explain:\n```python\nalpha = 0.05',
      'Explain ``alpha`marker``.',
      '> ```python\n> marker = "```"\n> alpha = 0.05\n> ```',
      'Explain:\n\n    alpha = 0.05\n    marker = 1',
      '- Code:\n\n  ```python\n  alpha = 0.05\n  ```',
      'Explain:\r\n```python\r\nalpha = 0.05\r\n```'
    ]) {
      expect(await service.optimize({ agentConfiguration, projectId: 'default', input })).toEqual({
        text: input
      })
    }
  })
  it('rejects empty output, missing protected spans, and unavailable projects', async () => {
    await expect(
      setup(async () => '  ').optimize({ agentConfiguration, projectId: 'default', input: 'Help' })
    ).rejects.toThrow()
    await expect(
      setup(async () => 'changed').optimize({
        agentConfiguration,
        projectId: 'default',
        input: 'Use `print(1)`'
      })
    ).rejects.toThrow()
    await expect(
      setup(async () => 'text').optimize({
        agentConfiguration,
        projectId: 'deleted',
        input: 'Help'
      })
    ).rejects.toThrow()
  })
  it('bounds stalled requests and rejects duplicate in-flight requests', async () => {
    const service = setup(() => new Promise(() => {}))
    const first = service.optimize({ agentConfiguration, projectId: 'default', input: 'Help' })
    await expect(
      service.optimize({ agentConfiguration, projectId: 'default', input: 'Help' })
    ).rejects.toThrow()
    await expect(first).rejects.toThrow(/timed out/i)
  })
  it('does not send empty or excessive input to the model', async () => {
    const generate = vi.fn(async () => 'result')
    const service = setup(generate)
    await expect(
      service.optimize({ agentConfiguration, projectId: 'default', input: '  ' })
    ).rejects.toThrow()
    await expect(
      service.optimize({ agentConfiguration, projectId: 'default', input: 'x'.repeat(16001) })
    ).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('prompt optimization diagnostics', () => {
  const request = {
    agentConfiguration,
    projectId: 'default',
    requestId: 'c97c4cec-dea9-4f2e-9e38-a85616338f83',
    input: 'Private draft'
  }
  it('keeps success compact and interaction details at debug level', async () => {
    const service = setup(async () => 'Private output')
    await service.optimize(request)
    service.recordEvent({ action: 'edit' })
    expect(log.info).toHaveBeenCalledExactlyOnceWith('succeeded', {
      requestId: request.requestId,
      durationMs: expect.any(Number)
    })
    expect(log.debug).toHaveBeenCalledWith('requested', { requestId: request.requestId })
    expect(log.debug).toHaveBeenCalledWith('interaction', { action: 'edit' })
    expect(log.warn).not.toHaveBeenCalled()
  })
  it('logs inference category without provider messages, stack, or request contents', async () => {
    const service = setup(async () => {
      throw Object.assign(new Error('Private draft Bearer secret'), { code: 'ECONNRESET' })
    })
    await expect(service.optimize(request)).rejects.toThrow('Your draft was kept')
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('failed', {
      requestId: request.requestId,
      stage: 'inference',
      errorCategory: 'network',
      durationMs: expect.any(Number)
    })
    expect(
      JSON.stringify([log.info.mock.calls, log.debug.mock.calls, log.warn.mock.calls])
    ).not.toMatch(/Private|secret|Bearer|ECONNRESET/)
  })
  it.each([
    ['project', { projectId: 'deleted' }, 'unused', 'Help'],
    [
      'target',
      { agentConfiguration: { ...agentConfiguration, providerId: 'deleted' } },
      'unused',
      'Help'
    ],
    ['protected-content', {}, 'Changed', 'Use `private()`'],
    ['output', {}, '', 'Help']
  ] as const)('identifies failures at %s', async (stage, overrides, output, input) => {
    await expect(
      setup(async () => output).optimize({ ...request, ...overrides, input })
    ).rejects.toThrow()
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      'failed',
      expect.objectContaining({
        requestId: request.requestId,
        stage
      })
    )
  })
  it('logs timeout once and does not log a late success', async () => {
    let finish!: (text: string) => void
    const service = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await expect(service.optimize(request)).rejects.toThrow('timed out')
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('failed', {
      requestId: request.requestId,
      stage: 'inference',
      errorCategory: 'timeout',
      durationMs: expect.any(Number)
    })
    finish('Late')
    await Promise.resolve()
    expect(log.info).not.toHaveBeenCalled()
  })
  it('keeps deliberate cancellation out of warning logs', async () => {
    const service = setup(() => new Promise(() => {}))
    const pending = service.optimize(request)
    service.cancel({ projectId: request.projectId, requestId: request.requestId })
    await expect(pending).rejects.toThrow('cancelled')
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.debug).toHaveBeenCalledWith('cancelled', { requestId: request.requestId })
  })
  it('logs invalid requests without logging their values', async () => {
    await expect(
      setup(async () => 'unused').optimize({ ...request, requestId: 'secret' })
    ).rejects.toThrow()
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('rejected', {
      requestId: expect.any(String),
      reason: 'invalid-request'
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret')
  })
  it('identifies preparation failures before inference starts', async () => {
    await expect(
      setup(async () => 'unused').optimize(request, async () => {
        throw new Error('private preparation details')
      })
    ).rejects.toThrow('Your draft was kept')
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('failed', {
      requestId: request.requestId,
      stage: 'prepare',
      errorCategory: 'error',
      durationMs: expect.any(Number)
    })
  })
  it('keeps duplicate requests concise without logging them as inference failures', async () => {
    const service = setup(() => new Promise(() => {}), 10000)
    const pending = service.optimize(request)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await expect(service.optimize(request)).rejects.toThrow('already running')
    service.cancel({ projectId: request.projectId, requestId: request.requestId })
    await rejected
    expect(log.debug).toHaveBeenCalledWith('rejected', {
      requestId: request.requestId,
      reason: 'already-running'
    })
    expect(log.warn).not.toHaveBeenCalled()
  })
  it('reports renderer validation failure with safe fields only', () => {
    setup(async () => 'unused').recordEvent({
      action: 'failed',
      requestId: request.requestId,
      stage: 'references'
    })
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('renderer result rejected', {
      requestId: request.requestId,
      stage: 'references'
    })
  })
})
