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
  supportsImageInput: false,
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
  },
  {
    id: 'codex',
    displayName: 'Codex',
    supportsSkills: true,
    supportedApiTypes: ['responses']
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
      providers: [provider({ id: 'p1', apiEndpoints: ['openai'] })],
      activeProviderId: undefined
    })
    render()

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders nothing when the active provider is compatible with the framework', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', apiEndpoints: ['anthropic'] })],
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
      providers: [provider({ id: 'p1', name: 'DeepSeek', apiEndpoints: ['openai'] })],
      activeProviderId: 'p1'
    })
    render()

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Claude Code')
    expect(alert?.textContent).toContain('DeepSeek')
  })

  it('does not warn for a bridge-compatible Chat Completions provider under Codex', () => {
    // A Chat Completions provider is usable through the Codex Responses bridge, and a custom provider's
    // model is always bridge-supported (static registry check, not a runtime probe), so no alert shows.
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      agentFrameworks: FRAMEWORKS,
      providers: [
        provider({ id: 'p1', name: 'DeepSeek', apiEndpoints: ['openai'], models: ['m'] })
      ],
      activeProviderId: 'p1',
      activeModel: 'm'
    })
    render()

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('clears the warning after switching to a compatible framework', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', apiEndpoints: ['openai'] })],
      activeProviderId: 'p1'
    })
    render()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    // OpenCode drives the OpenAI endpoint, so the mismatch resolves.
    act(() => useSettingsStore.setState({ agentFrameworkId: 'opencode' }))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
