// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { SubagentModelSelect } from './SubagentModelSelect'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined

describe('SubagentModelSelect', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportsSkills: true,
          supportedApiTypes: ['openai']
        }
      ],
      setSubagentModel: vi.fn(async () => undefined)
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('presents inherited model and disabled inherited effort through accessible controls', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<SubagentModelSelect />))

    const model = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Subagent model Model"]'
    )
    const effort = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Subagent model Reasoning effort"]'
    )
    expect(model?.textContent).toContain('Same as main model')
    expect(effort?.textContent).toContain('Same as main model')
    expect(effort?.disabled).toBe(true)
    expect(document.body.querySelector('[data-slot="settings-row"]')).not.toBeNull()
    expect(document.body.querySelectorAll('[data-slot="settings-field"]')).toHaveLength(2)
    act(() => root.unmount())
  })

  it('keeps an unavailable fixed reference visible without silently falling back', () => {
    useSettingsStore.setState({
      subagentModel: {
        mode: 'fixed',
        providerId: 'removed-provider',
        model: 'removed-model',
        reasoningEffort: 'high'
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<SubagentModelSelect />))

    const model = document.body.querySelector('[aria-label="Subagent model Model"]')?.textContent
    expect(model).toContain('removed-provider')
    expect(model).toContain('Unavailable')
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Subagent model Reasoning effort"]'
      )?.disabled
    ).toBe(true)
    act(() => root.unmount())
  })

  it('selects a fixed compound identity with Default effort through pointer interaction', () => {
    const setSubagentModel = vi.fn(async () => undefined)
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-b',
          type: 'custom',
          name: 'Provider B',
          apiEndpoints: ['openai'],
          model: 'model-b',
          models: ['model-b'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      setSubagentModel
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<SubagentModelSelect />))
    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Subagent model Model"]'
    )
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (candidate) => candidate.textContent?.includes('model-b')
    )
    act(() => {
      option?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(setSubagentModel).toHaveBeenCalledWith({
      mode: 'fixed',
      providerId: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'default'
    })
    act(() => root.unmount())
  })

  it('projects the selected concrete effort to the nearest strength on a new model', () => {
    const setSubagentModel = vi.fn(async () => undefined)
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-a',
          type: 'custom',
          name: 'Provider A',
          apiEndpoints: ['openai'],
          model: 'model-a',
          models: ['model-a'],
          reasoningEffortPreset: 'low-medium-high',
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        },
        {
          id: 'provider-b',
          type: 'custom',
          name: 'Provider B',
          apiEndpoints: ['openai'],
          model: 'model-b',
          models: ['model-b'],
          reasoningEffortPreset: 'standard-5',
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      subagentModel: {
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'max'
      },
      setSubagentModel
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<SubagentModelSelect />))
    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Subagent model Model"]'
    )
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (candidate) => candidate.textContent?.includes('model-b')
    )
    act(() => {
      option?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(setSubagentModel).toHaveBeenCalledWith({
      mode: 'fixed',
      providerId: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'high'
    })
    act(() => root.unmount())
  })

  it('keeps a repeated-slot concrete effort visibly selected', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-a',
          type: 'custom',
          name: 'Provider A',
          apiEndpoints: ['openai'],
          model: 'model-a',
          models: ['model-a'],
          reasoningEffortPreset: 'none-high',
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      subagentModel: {
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'high'
      }
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<SubagentModelSelect />))

    expect(
      document.body.querySelector('[aria-label="Subagent model Reasoning effort"]')?.textContent
    ).toContain('High')
    act(() => root.unmount())
  })
})
