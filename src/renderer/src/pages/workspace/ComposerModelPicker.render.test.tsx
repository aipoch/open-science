// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderView } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ComposerModelPicker } from './ComposerModelPicker'
import { incompatibilityReason } from './composer-model-picker-utils'

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

const render = (): void => {
  act(() => root.render(<ComposerModelPicker />))
}

describe('ComposerModelPicker', () => {
  it('renders nothing when there is a single selectable option', () => {
    useSettingsStore.setState({ providers: [provider({ id: 'p1', models: ['only'] })] })
    render()

    expect(container.querySelector('[aria-label="Select model"]')).toBeNull()
    expect(container.querySelector('[aria-label="No model available — open settings"]')).toBeNull()
  })

  it('warns (does not hide) when the only provider is incompatible with the framework', () => {
    // Claude Code (anthropic-only) + a lone OpenAI-only provider: the picker must not silently vanish.
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      providers: [provider({ id: 'p1', apiType: 'openai', models: ['gpt-x'] })]
    })
    render()

    expect(container.querySelector('[aria-label="Select model"]')).toBeNull()
    const warning = container.querySelector('[aria-label="No compatible model — open settings"]')
    expect(warning).not.toBeNull()
    expect(warning?.textContent).toContain('No compatible model')
  })

  it('warns and opens settings when no model is configured', () => {
    const openSettings = vi.fn()
    useSettingsStore.setState({ providers: [], openSettings })
    render()

    // No picker, but a warning affordance the user can click to fix the missing model.
    expect(container.querySelector('[aria-label="Select model"]')).toBeNull()
    const warning = container.querySelector<HTMLButtonElement>(
      '[aria-label="No model available — open settings"]'
    )
    expect(warning).not.toBeNull()
    expect(warning?.textContent).toContain('No model available')

    act(() => warning?.click())
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('warns when the only provider has failed validation', () => {
    useSettingsStore.setState({
      providers: [
        provider({
          id: 'broken',
          models: ['m'],
          lastValidationFailure: { at: 1, category: 'auth', message: 'bad key' }
        })
      ]
    })
    render()

    expect(
      container.querySelector('[aria-label="No model available — open settings"]')
    ).not.toBeNull()
  })

  it('explains an endpoint mismatch by route, not by vendor name', () => {
    const reason = incompatibilityReason(
      { apiType: 'openai', type: 'custom', name: 'OpenAI Gateway' },
      'Claude Code',
      ['anthropic']
    )

    expect(reason).toContain('OpenAI Gateway')
    expect(reason).toContain('Claude Code')
    expect(reason).toContain('/v1/messages')
    expect(reason).toContain('/v1/chat/completions')
  })

  it('explains a local Claude provider is only usable by Claude Code', () => {
    const reason = incompatibilityReason(
      { apiType: 'anthropic', type: 'claude-default', name: 'Local Claude' },
      'OpenCode',
      ['anthropic', 'openai']
    )

    expect(reason).toContain('local Claude sign-in')
    expect(reason).toContain('only Claude Code can run')
  })

  it('shows the active model label when multiple options exist', () => {
    useSettingsStore.setState({
      providers: [
        provider({
          id: 'off',
          type: 'official',
          vendorId: 'zhipu',
          name: 'GLM',
          models: ['glm-5.2', 'glm-4.7']
        })
      ],
      activeProviderId: 'off',
      activeModel: 'glm-4.7'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('glm-4.7')
    expect(trigger?.getAttribute('data-slot')).toBe('button')
    expect(trigger?.getAttribute('data-variant')).toBe('ghost')
  })

  it('offers one trigger across providers and reflects a custom provider label', () => {
    useSettingsStore.setState({
      providers: [
        provider({ id: 'c', name: 'Gateway', model: 'my-model', models: ['my-model'] }),
        provider({ id: 'local', type: 'claude-default', name: 'Local', models: [] })
      ],
      activeProviderId: 'c',
      activeModel: 'my-model'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger?.textContent).toContain('my-model')
  })
})
