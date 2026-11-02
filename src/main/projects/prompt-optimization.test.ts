import { describe, expect, it, vi } from 'vitest'
import { PromptOptimizationService } from './prompt-optimization'
import { resolveValidatedSessionAgentTarget } from '../acp/session-agent-target'
import type { SettingsSnapshot } from '../../shared/settings'
import type { RestrictedInferenceRunInput } from '../acp/restricted-inference-contract'

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
      id === 'deleted' ? null : { optimizationPrompt: id === 'custom' ? 'Keep it concise.' : '' },
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
