// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderView } from '../../../../shared/settings'
import type { ChatSession } from '@/stores/session-store'

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderView[],
  setAgentConfiguration: vi.fn(),
  endpoints: ['anthropic']
}))
vi.mock('@/stores/settings-store', () => ({
  selectFrameworkApiEndpoints: () => mocks.endpoints,
  selectVisionRelayAvailable: () => false,
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      providers: mocks.providers,
      activeProviderId: 'fallback',
      activeModel: 'model',
      reasoningEffort: 'low',
      agentFrameworkId: 'claude-code'
    })
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ setAgentConfiguration: mocks.setAgentConfiguration })
}))
import { useWorkspaceSessionAgentConfiguration } from './workspace-session-agent-configuration-controller'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
const provider = (id: string): ProviderView => ({
  id,
  name: id,
  type: 'custom',
  model: 'model',
  models: ['model'],
  apiEndpoints: ['anthropic'],
  supportsImageInput: false,
  hasKey: true,
  needsKey: false
})
const original = { providerId: 'original', model: 'model', reasoningEffort: 'high' as const }
const fallback = { providerId: 'fallback', model: 'model', reasoningEffort: 'low' as const }
const mount = (
  contentLoaded = true
): {
  render: () => void
  result: () => ReturnType<typeof useWorkspaceSessionAgentConfiguration>
} => {
  let session = { id: 'session-1', contentLoaded, agentConfiguration: original } as ChatSession
  let result: ReturnType<typeof useWorkspaceSessionAgentConfiguration>
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  const Harness = (): null => {
    result = useWorkspaceSessionAgentConfiguration(session)
    return null
  }
  const render = (): void => act(() => root.render(createElement(Harness)))
  mocks.setAgentConfiguration.mockImplementation((_id, configuration) => {
    session = { ...session, agentConfiguration: configuration }
  })
  render()
  return { render, result: () => result! }
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  mocks.setAgentConfiguration.mockReset()
})
describe('saved Session model availability', () => {
  it.each(['removed provider', 'targeted network failure'])(
    'preserves the saved preference across %s and recovery',
    (failure) => {
      mocks.providers = [provider('original'), provider('fallback')]
      const hook = mount()
      expect(hook.result().activeAgentConfiguration).toEqual(original)
      expect(mocks.setAgentConfiguration).not.toHaveBeenCalled()
      mocks.providers =
        failure === 'removed provider'
          ? [provider('fallback')]
          : [
              {
                ...provider('original'),
                lastValidationFailure: {
                  at: 1,
                  category: 'network',
                  target: { model: 'model', endpoint: 'anthropic' }
                }
              },
              provider('fallback')
            ]
      hook.render()
      expect.soft(mocks.setAgentConfiguration).not.toHaveBeenCalled()
      expect.soft(hook.result().agentConfigurationUnavailable).toBe(true)
      expect.soft(hook.result().activeAgentConfiguration).toEqual(original)
      hook.render()
      mocks.providers = [provider('original'), provider('fallback')]
      hook.render()
      expect(hook.result().activeAgentConfiguration).toEqual(original)
    }
  )
  it('does not write before content loads', () => {
    mocks.providers = [provider('fallback')]
    mount(false)
    expect(mocks.setAgentConfiguration).not.toHaveBeenCalled()
  })
  it('recovers a missing provider only after the user explicitly selects a replacement', () => {
    mocks.providers = [provider('fallback')]
    const hook = mount()
    expect(hook.result().agentConfigurationUnavailable).toBe(true)
    expect(hook.result().activeAgentConfiguration).toEqual(original)
    expect(mocks.setAgentConfiguration).not.toHaveBeenCalled()
    act(() => hook.result().changeAgentConfiguration(fallback))
    expect(mocks.setAgentConfiguration).toHaveBeenCalledWith('session-1', fallback)
    hook.render()
    expect(hook.result().activeAgentConfiguration).toEqual(fallback)
    expect(hook.result().agentConfigurationUnavailable).toBe(false)
  })
})
