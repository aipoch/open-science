import { expect, it, vi } from 'vitest'
import { ProviderTextGenerationService, providerTextGenerationTargetKey } from './text-generation'
const target = {
  providerId: 'provider',
  model: 'science-model',
  provider: {
    type: 'custom' as const,
    baseUrl: 'https://provider.example',
    model: 'science-model',
    apiEndpoints: ['chat-completions' as const],
    key: 'private-key'
  }
}
const request = {
  target,
  systemPrompt: 'Translate faithfully.',
  prompt: '{"source":"Cell"}',
  signal: new AbortController().signal,
  maxOutputTokens: 8192,
  outputLimitBytes: 262144
}
const completion = { choices: [{ finish_reason: 'stop', message: { content: '细胞' } }] }

it('requires credentials for official providers even on a local endpoint', async () => {
  const fetchImpl = vi.fn(async () => Response.json(completion))
  const service = new ProviderTextGenerationService(fetchImpl)
  await expect(
    service.run({
      ...request,
      target: {
        ...target,
        provider: {
          ...target.provider,
          type: 'official',
          key: undefined,
          baseUrl: 'http://127.0.0.1:1234'
        }
      }
    })
  ).rejects.toThrow('[provider-text-generation:unsupported-target]')
  expect(fetchImpl).not.toHaveBeenCalled()
})
it('uses only declared API endpoints and supports keyless local gateways', async () => {
  const fetchImpl = vi.fn(async () => Response.json(completion))
  const runner = new ProviderTextGenerationService(fetchImpl)
  expect(
    // @ts-expect-error Runtime validation also rejects unsupported callers without TypeScript.
    runner.supportsTarget({ ...target, provider: { ...target.provider, type: 'claude-shared' } })
  ).toBe(false)
  expect(
    runner.supportsTarget({
      ...target,
      provider: { ...target.provider, apiEndpoints: [] }
    })
  ).toBe(false)
  expect(
    runner.supportsTarget({ ...target, provider: { ...target.provider, key: undefined } })
  ).toBe(false)
  await runner.run({
    ...request,
    target: {
      ...target,
      provider: {
        ...target.provider,
        baseUrl: 'http://127.0.0.1:1234',
        key: undefined
      }
    }
  })
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(new Headers(init.headers).has('authorization')).toBe(false)
  expect(new Headers(init.headers).has('x-api-key')).toBe(false)
})
it('uses the OpenAI completion limit, respects model caps and preserves existing dual-protocol priority', async () => {
  const fetchImpl = vi.fn(async () => Response.json(completion))
  await new ProviderTextGenerationService(fetchImpl).run({
    ...request,
    target: {
      ...target,
      reasoningEffort: 'low',
      provider: {
        ...target.provider,
        vendorId: 'openai',
        apiEndpoints: ['responses', 'messages', 'chat-completions'],
        maxOutputTokens: 4000
      }
    }
  })
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toContain('/chat/completions')
  expect(JSON.parse(String(init.body))).toMatchObject({
    reasoning_effort: 'low',
    max_completion_tokens: 4000
  })
  expect(JSON.parse(String(init.body))).not.toHaveProperty('max_tokens')
})
it('preserves pre-extraction target identities and omitted/default reasoning equivalence', () => {
  expect(providerTextGenerationTargetKey(target)).toBe(
    'a61dc22d3ec5edeba53fe947db15dad880b1adf2eed1616f791ada8939024741'
  )
  expect(providerTextGenerationTargetKey({ ...target, reasoningEffort: 'default' })).toBe(
    providerTextGenerationTargetKey(target)
  )
  expect(providerTextGenerationTargetKey({ ...target, reasoningEffort: 'low' })).toBe(
    '1e990939637586026c128f7ed5beea3b12e0f73942dff8f3b1e3cf588a73ebec'
  )
})
