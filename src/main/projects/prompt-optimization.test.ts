import { describe, expect, it, vi } from 'vitest'
import { PromptOptimizationService } from './prompt-optimization'
import type { RestrictedInferenceRunInput } from '../acp/restricted-inference-contract'

const target = {
  frameworkId: 'opencode' as const,
  providerId: 'test',
  model: { kind: 'required' as const, id: 'test' },
  reasoningEffort: 'default' as const
}
const setup = (
  generate: (input: RestrictedInferenceRunInput) => Promise<string>
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
    captureTarget: async () => target,
    runner,
    timeoutMs: 20
  })
}

describe('prompt optimization', () => {
  it('uses only the selected project template and preserves protected scientific text', async () => {
    const seen: RestrictedInferenceRunInput[] = []
    const service = setup(async (input) => {
      seen.push(input)
      return `Clarify: ${input.prompt}`
    })
    const input = 'Review DOI 10.1234/Example and `print(1)` with $x^2$.'
    expect(await service.optimize({ projectId: 'custom', input })).toEqual({
      text: `Clarify: ${input}`
    })
    expect(seen[0].systemPrompt).toContain('Keep it concise.')
    expect(seen[0].prompt).not.toContain('print(1)')
    await service.optimize({ projectId: 'default', input: 'Plan a study' })
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
      expect(await service.optimize({ projectId: 'default', input })).toEqual({ text: input })
    }
  })
  it('rejects empty output, missing protected spans, and unavailable projects', async () => {
    await expect(
      setup(async () => '  ').optimize({ projectId: 'default', input: 'Help' })
    ).rejects.toThrow()
    await expect(
      setup(async () => 'changed').optimize({ projectId: 'default', input: 'Use `print(1)`' })
    ).rejects.toThrow()
    await expect(
      setup(async () => 'text').optimize({ projectId: 'deleted', input: 'Help' })
    ).rejects.toThrow()
  })
  it('bounds stalled requests and rejects duplicate in-flight requests', async () => {
    const service = setup(() => new Promise(() => {}))
    const first = service.optimize({ projectId: 'default', input: 'Help' })
    await expect(service.optimize({ projectId: 'default', input: 'Help' })).rejects.toThrow()
    await expect(first).rejects.toThrow(/timed out/i)
  })
  it('does not send empty or excessive input to the model', async () => {
    const generate = vi.fn(async () => 'result')
    const service = setup(generate)
    await expect(service.optimize({ projectId: 'default', input: '  ' })).rejects.toThrow()
    await expect(
      service.optimize({ projectId: 'default', input: 'x'.repeat(16001) })
    ).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })
})
