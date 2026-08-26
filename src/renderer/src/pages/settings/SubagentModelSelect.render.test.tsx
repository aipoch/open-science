// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import {
  ReviewerModelSelect,
  SessionDetailsModelSelect,
  SubagentModelSelect,
  VisionModelSelect
} from './SubagentModelSelect'

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
    expect(document.body.querySelector('[data-slot="settings-row"]')?.className).toContain(
      'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'
    )
    expect(document.body.querySelector('[data-slot="settings-row"]')?.className).not.toContain(
      'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'
    )
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

describe('ReviewerModelSelect', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      setReviewerModel: vi.fn(async () => undefined)
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('presents Follow main model as the default Reviewer policy', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<ReviewerModelSelect />))

    expect(
      document.body.querySelector('[aria-label="Reviewer model Model"]')?.textContent
    ).toContain('Follow main model')
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Reviewer model Reasoning effort"]'
      )?.disabled
    ).toBe(true)
    act(() => root.unmount())
  })
})

describe('SessionDetailsModelSelect', () => {
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
      activeProviderId: 'provider-a',
      activeModel: 'model-a',
      providers: [
        {
          id: 'provider-a',
          type: 'custom',
          name: 'Provider A',
          apiEndpoints: ['openai'],
          model: 'model-a',
          models: ['model-a'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ],
      setSessionDetailsModel: vi.fn(async () => undefined)
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('defaults to inherited model with an independently enabled Low effort', () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    act(() => root.render(<SessionDetailsModelSelect />))

    expect(
      document.body.querySelector('[aria-label="Session details model Model"]')?.textContent
    ).toContain('Same as main model')
    const effort = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Session details model Reasoning effort"]'
    )
    expect(effort?.textContent).toContain('Low')
    expect(effort?.disabled).toBe(false)
    act(() => root.unmount())
  })

  it('shows Not supported and disables effort without disabling the inherited model', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'provider-a',
          type: 'custom',
          name: 'Provider A',
          apiEndpoints: ['openai'],
          model: 'model-a',
          models: ['model-a'],
          reasoningEffortPreset: 'unsupported',
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    act(() => root.render(<SessionDetailsModelSelect />))

    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Session details model Model"]')
        ?.disabled
    ).toBe(false)
    const effort = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Session details model Reasoning effort"]'
    )
    expect(effort?.textContent).toContain('Not supported')
    expect(effort?.disabled).toBe(true)
    act(() => root.unmount())
  })

  it('disables effort when automatic generation is Not configured', () => {
    useSettingsStore.setState({ sessionDetailsModel: { mode: 'disabled' } })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    act(() => root.render(<SessionDetailsModelSelect />))

    expect(
      document.body.querySelector('[aria-label="Session details model Model"]')?.textContent
    ).toContain('Not configured')
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Session details model Reasoning effort"]'
      )?.disabled
    ).toBe(true)
    act(() => root.unmount())
  })
})

describe('VisionModelSelect', () => {
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
      providers: [
        {
          id: 'text-provider',
          type: 'custom',
          name: 'Text Provider',
          apiEndpoints: ['openai'],
          model: 'text-model',
          models: ['text-model'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        },
        {
          id: 'vision-provider',
          type: 'custom',
          name: 'Vision Provider',
          apiEndpoints: ['openai'],
          model: 'vision-model',
          models: ['vision-model'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ],
      setVisionModel: vi.fn(async () => undefined)
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('offers only image-capable configured models and saves an independent selection', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<VisionModelSelect />))

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Vision model Model"]'
    )
    expect(trigger?.textContent).toContain('Not configured')
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const options = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
    expect(options.some((candidate) => candidate.textContent?.includes('text-model'))).toBe(false)
    const visionOption = options.find((candidate) =>
      candidate.textContent?.includes('vision-model')
    )
    act(() => {
      visionOption?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      visionOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useSettingsStore.getState().setVisionModel).toHaveBeenCalledWith({
      providerId: 'vision-provider',
      model: 'vision-model',
      reasoningEffort: 'default'
    })
    act(() => root.unmount())
  })

  it('offers an image-capable Codex subscription model', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportsSkills: true,
          supportedApiTypes: ['responses']
        }
      ],
      providers: [
        {
          id: 'builtin-codex-isolated',
          type: 'codex-isolated',
          name: 'Codex subscription',
          apiEndpoints: ['responses'],
          models: ['gpt-5.6-sol'],
          supportsImageInput: true,
          hasKey: false,
          needsKey: false
        }
      ]
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<VisionModelSelect />))

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Vision model Model"]'
    )
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).some((candidate) =>
        candidate.textContent?.includes('gpt-5.6-sol')
      )
    ).toBe(true)
    act(() => root.unmount())
  })
})
