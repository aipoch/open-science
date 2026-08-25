// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'

const mocks = vi.hoisted(() => ({
  setAgentConfiguration: vi.fn(),
  resolvedConfiguration: {
    providerId: 'provider-1',
    model: 'model-1',
    reasoningEffort: 'low' as const
  }
}))

vi.mock('../../../../shared/configured-model-catalog', () => ({
  buildConfiguredModelCatalog: () => []
}))

vi.mock('@/lib/acp/session-agent-configuration', () => ({
  isConfigurationSelectable: () => true,
  resolveSelectableConfiguration: () => mocks.resolvedConfiguration,
  resolveSessionAgentConfiguration: () => ({
    status: 'ready',
    configuration: mocks.resolvedConfiguration,
    changed: true
  })
}))

vi.mock('@/stores/settings-store', () => ({
  selectFrameworkApiEndpoints: () => [],
  selectVisionRelayAvailable: () => false,
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeProviderId: 'provider-1',
      activeModel: 'model-1',
      reasoningEffort: 'low',
      providers: [],
      claudeSubscriptionProviderId: undefined,
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

const renderConfigurationHook = (session: ChatSession): void => {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  const HookHarness = (): null => {
    useWorkspaceSessionAgentConfiguration(session)
    return null
  }

  act(() => root.render(createElement(HookHarness)))
}

afterEach(() => {
  mocks.setAgentConfiguration.mockReset()
  for (const root of roots.splice(0)) act(() => root.unmount())
})

describe('useWorkspaceSessionAgentConfiguration', () => {
  it('does not persist a resolved configuration before lazy Session content loads', () => {
    renderConfigurationHook({
      id: 'session-1',
      contentLoaded: false
    } as ChatSession)

    expect(mocks.setAgentConfiguration).not.toHaveBeenCalled()
  })

  it('persists a changed resolved configuration after Session content loads', () => {
    renderConfigurationHook({ id: 'session-1' } as ChatSession)

    expect(mocks.setAgentConfiguration).toHaveBeenCalledWith(
      'session-1',
      mocks.resolvedConfiguration,
      { preserveUpdatedAt: true }
    )
  })
})
