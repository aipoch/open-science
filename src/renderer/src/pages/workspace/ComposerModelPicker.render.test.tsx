// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderView } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ComposerModelPicker } from './ComposerModelPicker'

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
