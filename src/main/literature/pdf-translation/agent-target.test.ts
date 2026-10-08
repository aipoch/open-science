import { expect, it, vi } from 'vitest'
import { capturePdfTranslationAgentTarget } from './agent-target'
import type { SettingsSnapshot } from '../../../shared/settings'

const target = {
  frameworkId: 'opencode' as const,
  providerId: 'main',
  model: { kind: 'required' as const, id: 'main-model' },
  reasoningEffort: 'low' as const
}
const selected = {
  frameworkId: 'opencode' as const,
  providerId: 'chosen',
  modelId: 'chosen-model',
  reasoningEffort: 'default' as const
}
function setup(): {
  captureActiveExplicitAgentBackendTarget: ReturnType<typeof vi.fn<() => Promise<typeof target>>>
  getSettingsView: ReturnType<typeof vi.fn<() => Promise<SettingsSnapshot>>>
} {
  return {
    captureActiveExplicitAgentBackendTarget: vi.fn(async () => target),
    getSettingsView: vi.fn(
      async () =>
        ({
          agentFrameworks: [{ id: 'opencode', supportedApiTypes: ['openai'] }],
          activeProviderId: 'main',
          activeModel: 'main-model',
          providers: [
            {
              id: 'chosen',
              name: 'Chosen',
              type: 'custom',
              baseUrl: 'http://127.0.0.1:9',
              apiEndpoints: ['openai'],
              models: ['chosen-model'],
              hasKey: false,
              needsKey: false,
              supportsImageInput: false
            }
          ]
        }) as SettingsSnapshot
    )
  }
}
it('captures a selected Agent model without reading or changing the active target', async () => {
  const settings = setup()
  await expect(capturePdfTranslationAgentTarget(settings, selected)).resolves.toEqual({
    frameworkId: 'opencode',
    providerId: 'chosen',
    providerName: 'Chosen',
    model: { kind: 'required', id: 'chosen-model' },
    reasoningEffort: 'default'
  })
  expect(settings.captureActiveExplicitAgentBackendTarget).not.toHaveBeenCalled()
})
it('preserves the main-model default for existing requests', async () => {
  const settings = setup()
  await expect(capturePdfTranslationAgentTarget(settings)).resolves.toMatchObject(target)
  expect(settings.getSettingsView).toHaveBeenCalledOnce()
})
it.each([
  { ...selected, providerId: 'removed' },
  { ...selected, modelId: 'removed' },
  { ...selected, frameworkId: 'claude-code' as const }
])(
  'rejects deleted or incompatible selections instead of using the main model: %j',
  async (model) => {
    await expect(capturePdfTranslationAgentTarget(setup(), model)).rejects.toThrow(
      '[pdf-translation:unsupported-model]'
    )
  }
)

it.each(['missing-framework', 'incompatible-endpoint'] as const)(
  'rejects selection against the settings capability snapshot (%s)',
  async (fault) => {
    const settings = setup()
    const snapshot = await settings.getSettingsView()
    snapshot.agentFrameworks =
      fault === 'missing-framework'
        ? []
        : [{ ...snapshot.agentFrameworks[0], supportedApiTypes: ['anthropic'] }]
    settings.getSettingsView.mockResolvedValue(snapshot)
    await expect(capturePdfTranslationAgentTarget(settings, selected)).rejects.toThrow(
      '[pdf-translation:unsupported-model]'
    )
    expect(settings.captureActiveExplicitAgentBackendTarget).not.toHaveBeenCalled()
  }
)
