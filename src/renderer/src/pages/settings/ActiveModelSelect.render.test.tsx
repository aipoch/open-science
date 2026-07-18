// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentFrameworkView, ProviderView } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ActiveModelSelect } from './ActiveModelSelect'

// Radix Select calls pointer-capture and scroll APIs jsdom does not implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

let container: HTMLDivElement
let root: Root

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

const provider = (overrides: Partial<ProviderView>): ProviderView => ({
  id: 'p',
  type: 'custom',
  name: 'Gateway',
  models: ['m'],
  hasKey: true,
  needsKey: false,
  ...overrides
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState(createInitialSettingsState())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const render = (): void => {
  act(() => root.render(<ActiveModelSelect />))
}

// Open the Select trigger and click an option by its visible text (portalled to body).
const openSelect = (): void => {
  const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Active model"]')
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const optionByText = (text: string): HTMLElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((candidate) =>
    candidate.textContent?.includes(text)
  )

const clickOption = (text: string): void => {
  const item = optionByText(text)
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ActiveModelSelect', () => {
  it('renders nothing when no provider exposes a model', () => {
    useSettingsStore.setState({ providers: [] })
    render()

    expect(container.querySelector('[aria-label="Active model"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('shows the active model and its source provider in the trigger', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', name: 'Gateway', models: ['claude-sonnet-4-5'] })],
      activeProviderId: 'p1',
      activeModel: 'claude-sonnet-4-5'
    })
    render()

    const trigger = container.querySelector('[aria-label="Active model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('claude-sonnet-4-5')
    expect(trigger?.textContent).toContain('Gateway')
  })

  it('shows the placeholder when no model is active', () => {
    useSettingsStore.setState({
      providers: [provider({ id: 'p1', models: ['m1'] })],
      activeProviderId: undefined,
      activeModel: undefined
    })
    render()

    expect(container.querySelector('[aria-label="Active model"]')?.textContent).toContain(
      'Select a model'
    )
  })

  it('calls setActiveProvider with the picked provider and model', () => {
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', name: 'Gateway', apiType: 'anthropic', models: ['m1'] })],
      setActiveProvider
    })
    render()

    openSelect()
    clickOption('m1')

    expect(setActiveProvider).toHaveBeenCalledWith('p1', 'm1')
  })

  it('marks a provider that cannot drive the current framework as not usable and disables its models', () => {
    // Claude Code speaks Anthropic only, so an OpenAI-only provider is incompatible.
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: FRAMEWORKS,
      providers: [
        provider({ id: 'p1', name: 'DeepSeek', apiType: 'openai', models: ['deepseek-chat'] })
      ],
      setActiveProvider: vi.fn().mockResolvedValue(undefined)
    })
    render()

    openSelect()

    expect(document.body.textContent).toContain('not usable with this framework')
    const option = optionByText('deepseek-chat')
    expect(option).toBeDefined()
    expect(option?.getAttribute('data-disabled')).not.toBeNull()
    expect(option?.getAttribute('aria-disabled')).toBe('true')
  })

  it('leaves a compatible provider selectable and unlabelled', () => {
    // OpenCode drives both endpoints, so the OpenAI provider is compatible.
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: FRAMEWORKS,
      providers: [provider({ id: 'p1', name: 'DeepSeek', apiType: 'openai', models: ['ds-1'] })],
      setActiveProvider: vi.fn().mockResolvedValue(undefined)
    })
    render()

    openSelect()

    expect(document.body.textContent).not.toContain('not usable with this framework')
    const option = optionByText('ds-1')
    expect(option?.getAttribute('data-disabled')).toBeNull()
  })

  it('groups each provider under its own name and lists every catalog model', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: FRAMEWORKS,
      providers: [
        provider({ id: 'p1', name: 'Anthropic', apiType: 'anthropic', models: ['opus', 'sonnet'] }),
        provider({ id: 'p2', name: 'OpenAI', apiType: 'openai', models: ['gpt'] })
      ],
      setActiveProvider: vi.fn().mockResolvedValue(undefined)
    })
    render()

    openSelect()

    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
    expect(options).toHaveLength(3)
    expect(document.body.textContent).toContain('Anthropic')
    expect(document.body.textContent).toContain('OpenAI')
    expect(optionByText('opus')).toBeDefined()
    expect(optionByText('sonnet')).toBeDefined()
    expect(optionByText('gpt')).toBeDefined()
  })
})
