import { expect, it } from 'vitest'
import {
  isPdfTranslationApiProvider,
  pdfTranslationAgentModels,
  pdfTranslationApiModels
} from './pdf-translation-models'
import { CODEX_ISOLATED_PROVIDER_ID, type ProviderView } from './settings'

const provider: ProviderView = {
  id: 'api',
  name: 'API',
  type: 'custom',
  baseUrl: 'https://example.test',
  apiEndpoints: ['openai'],
  models: ['one', 'two'],
  hasKey: true,
  needsKey: false,
  supportsImageInput: false
}

it('keeps Agent compatibility reasons and rejects native Codex subscriptions for translation', () => {
  const options = pdfTranslationAgentModels({
    providers: [
      provider,
      {
        ...provider,
        id: CODEX_ISOLATED_PROVIDER_ID,
        type: 'codex-isolated',
        apiEndpoints: ['responses'],
        models: ['gpt-5.4']
      }
    ],
    frameworkId: 'codex',
    frameworkEndpoints: ['responses']
  })
  const subscription = options.find((entry) => entry.providerId === CODEX_ISOLATED_PROVIDER_ID)!
  expect(subscription.selectable).toBe(false)
  expect(subscription.subscriptionUnsupported).toBe(true)
})

it.each([
  'claude-shared',
  'claude-isolated',
  'codex-shared',
  'codex-isolated',
  'xai-subscription'
] as const)('excludes %s subscriptions even when they advertise API endpoints', (type) => {
  expect(pdfTranslationApiModels([{ ...provider, type }])).toEqual([])
})
it.each([
  'bailianplan',
  'glmcodingplan',
  'kimiforcode',
  'stepplan',
  'tencentcodingplan',
  'tencenttokenplan',
  'opencode-go'
] as const)('excludes %s from both the picker and resolved direct targets', (vendorId) => {
  expect(pdfTranslationApiModels([{ ...provider, type: 'official', vendorId }])).toEqual([])
  expect(isPdfTranslationApiProvider({ type: 'custom', vendorId })).toBe(false)
})
it('keeps configured API models distinct and excludes missing credentials or failed models', () => {
  const entries = pdfTranslationApiModels([
    provider,
    {
      ...provider,
      id: 'second',
      lastValidationFailure: {
        category: 'model-not-found',
        at: 1,
        target: { model: 'one', endpoint: 'openai' }
      }
    },
    { ...provider, id: 'no-key', hasKey: false },
    { ...provider, id: 'undecryptable', needsKey: true },
    { ...provider, id: 'empty', models: [] }
  ])
  expect(entries.map(({ providerId, model }) => [providerId, model])).toEqual([
    ['api', 'one'],
    ['api', 'two'],
    ['second', 'two']
  ])
  expect(new Set(entries.map(({ key }) => key)).size).toBe(3)
})
it('keeps keyless loopback APIs available', () => {
  expect(
    pdfTranslationApiModels([{ ...provider, baseUrl: 'http://127.0.0.1:11434', hasKey: false }])
  ).toHaveLength(2)
})
