// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentFrameworkView, ProviderView } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ModelFrameworkCompatibilityAlert } from './ModelFrameworkCompatibilityAlert'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState(createInitialSettingsState())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const provider = (overrides: Partial<ProviderView>): ProviderView => ({
  id: 'p',
  type: 'custom',
  name: 'Gateway',
  models: ['m'],
  hasKey: true,
  needsKey: false,
  ...overrides
})

const FRAMEWORKS: AgentFrameworkView[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    supportsSkills: true,
    supportedApiTypes: ['anthropic']
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    supportsSkills: true,
    supportedApiTypes: ['anthropic', 'openai']
  }
]

const render = (): void => {
  act(() => root.render(<ModelFrameworkCompatibilityAlert />))
}

describe('ModelFrameworkCompatibilityAlert', () => {
  it('renders nothing when no provider is active', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', apiType: 'openai' })],
      activeProviderId: undefined
    })
    render()

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders nothing when the active provider is compatible with the framework', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', apiType: 'anthropic' })],
      activeProviderId: 'p1'
    })
    render()

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('warns when the active model is incompatible with the selected framework', () => {
    // Claude Code (anthropic-only) with an active OpenAI-only provider — the screenshot case.
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', name: 'DeepSeek', apiType: 'openai' })],
      activeProviderId: 'p1'
    })
    render()

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Claude Code')
    expect(alert?.textContent).toContain('DeepSeek')
  })

  it('warns when a Local Claude provider is active under a non-Claude framework', () => {
    // A claude-default provider is Claude-only regardless of endpoint, so OpenCode can't use it.
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: FRAMEWORKS,
      providers: [
        provider({ id: 'p1', name: 'Local Claude', type: 'claude-default', apiType: 'anthropic' })
      ],
      activeProviderId: 'p1'
    })
    render()

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('OpenCode')
  })

  it('clears the warning after switching to a compatible framework', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', apiType: 'openai' })],
      activeProviderId: 'p1'
    })
    render()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    // OpenCode drives the OpenAI endpoint, so the mismatch resolves.
    act(() => useSettingsStore.setState({ agentFrameworkId: 'opencode' }))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
