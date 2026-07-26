// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'

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

describe('ReasoningEffortSelect', () => {
  it('marks the current level as the checked segment', async () => {
    useSettingsStore.setState({ reasoningEffort: 'high' })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    const checked = container.querySelector('[role="radio"][aria-checked="true"]')
    expect(checked?.textContent).toBe('High')
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(6)
  })

  it('calls the store action with the picked level', async () => {
    const setReasoningEffort = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ reasoningEffort: 'default', setReasoningEffort })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    const maxSegment = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((button) => button.textContent === 'Max')
    act(() => {
      maxSegment?.click()
    })

    expect(setReasoningEffort).toHaveBeenCalledWith('max')
  })

  it('shows only the active model three effort levels plus the separate default choice', async () => {
    useSettingsStore.setState({
      activeProviderId: 'stepfun',
      activeModel: 'step-3.7-flash',
      providers: [
        {
          id: 'stepfun',
          type: 'official',
          name: 'StepFun',
          vendorId: 'stepfun',
          models: ['step-3.7-flash'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['Default', 'Low', 'Medium', 'High'])
  })

  it('uses an official provider catalog default when no active model override is stored', async () => {
    useSettingsStore.setState({
      activeProviderId: 'openai',
      activeModel: undefined,
      providers: [
        {
          id: 'openai',
          type: 'official',
          name: 'OpenAI',
          vendorId: 'openai',
          models: ['gpt-5.6-sol', 'gpt-5.5'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['Default', 'Low', 'Medium', 'High', 'XHigh', 'Ultra'])
  })

  it('shows the documented thinking switch for MiniMax-M3', async () => {
    useSettingsStore.setState({
      activeProviderId: 'minimax',
      activeModel: 'MiniMax-M3',
      providers: [
        {
          id: 'minimax',
          type: 'official',
          name: 'MiniMax',
          vendorId: 'minimax',
          models: ['MiniMax-M3'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['Default', 'None', 'High'])
  })

  it('stores the highest five-slot intent when the model top choice covers multiple slots', async () => {
    const setReasoningEffort = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      activeProviderId: 'stepfun',
      activeModel: 'step-3.7-flash',
      reasoningEffort: 'medium',
      setReasoningEffort,
      providers: [
        {
          id: 'stepfun',
          type: 'official',
          name: 'StepFun',
          vendorId: 'stepfun',
          models: ['step-3.7-flash'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    const highSegment = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((button) => button.textContent === 'High')
    act(() => highSegment?.click())

    expect(setReasoningEffort).toHaveBeenCalledWith('max')
  })

  it('uses the saved effort preset for a custom model', async () => {
    useSettingsStore.setState({
      activeProviderId: 'custom',
      activeModel: 'mimo-v2.5',
      providers: [
        {
          id: 'custom',
          type: 'custom',
          name: 'Custom MiMo',
          model: 'mimo-v2.5',
          models: ['mimo-v2.5'],
          supportsImageInput: false,
          reasoningEffortPreset: 'none-high',
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['Default', 'None', 'High'])
  })

  it('uses the OpenAI model profile for a Codex subscription', async () => {
    useSettingsStore.setState({
      activeProviderId: 'builtin-codex-subscription',
      activeModel: 'gpt-5.6-sol',
      providers: [
        {
          id: 'builtin-codex-subscription',
          type: 'codex-isolated',
          name: 'Codex subscription',
          models: ['gpt-5.6-sol'],
          supportsImageInput: true,
          hasKey: false,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['Default', 'Low', 'Medium', 'High', 'XHigh', 'Ultra'])
  })

  it('shows only Default when a Codex subscription delegates model selection to the runtime', async () => {
    useSettingsStore.setState({
      activeProviderId: 'builtin-codex-subscription',
      activeModel: undefined,
      providers: [
        {
          id: 'builtin-codex-subscription',
          type: 'codex-isolated',
          name: 'Codex subscription',
          models: ['gpt-5.6-sol'],
          supportsImageInput: true,
          hasKey: false,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(1)
    expect(container.querySelector('[role="radio"]')?.textContent).toBe('Default')
  })

  it('uses the Anthropic model profile for a Claude subscription', async () => {
    useSettingsStore.setState({
      activeProviderId: 'builtin-claude-isolated',
      activeModel: 'claude-haiku-4-5-20251001',
      providers: [
        {
          id: 'builtin-claude-isolated',
          type: 'claude-isolated',
          name: 'Claude subscription',
          models: ['claude-haiku-4-5-20251001'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(1)
    expect(container.querySelector('[role="radio"]')?.textContent).toBe('Default')
  })

  it('shows only Default when a Claude subscription delegates model selection to the CLI', async () => {
    useSettingsStore.setState({
      activeProviderId: 'builtin-claude-shared',
      activeModel: undefined,
      providers: [
        {
          id: 'builtin-claude-shared',
          type: 'claude-shared',
          name: 'Claude subscription',
          models: [],
          supportsImageInput: true,
          hasKey: false,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(1)
    expect(container.querySelector('[role="radio"]')?.textContent).toBe('Default')
  })

  it('defaults an unconfigured custom model to five choices', async () => {
    useSettingsStore.setState({
      activeProviderId: 'custom',
      activeModel: 'model-a',
      providers: [
        {
          id: 'custom',
          type: 'custom',
          name: 'Legacy custom model',
          model: 'model-a',
          models: ['model-a'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['Default', 'Low', 'Medium', 'High', 'XHigh', 'Max'])
  })

  it('refreshes from static profiles when the selected provider and model change', async () => {
    useSettingsStore.setState({
      activeProviderId: 'stepfun',
      activeModel: 'step-3.7-flash',
      providers: [
        {
          id: 'stepfun',
          type: 'official',
          name: 'StepFun',
          vendorId: 'stepfun',
          models: ['step-3.7-flash'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        },
        {
          id: 'openrouter',
          type: 'official',
          name: 'OpenRouter',
          vendorId: 'openrouter',
          models: ['deepseek/deepseek-v4-pro'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4)

    act(() => {
      useSettingsStore.setState({
        activeProviderId: 'openrouter',
        activeModel: 'deepseek/deepseek-v4-pro'
      })
    })

    expect(
      Array.from(container.querySelectorAll('[role="radio"]')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['Default', 'None', 'High', 'XHigh'])
  })

  it('shows only Default when a custom model explicitly disables effort', async () => {
    useSettingsStore.setState({
      activeProviderId: 'custom',
      activeModel: 'model-a',
      providers: [
        {
          id: 'custom',
          type: 'custom',
          name: 'No effort model',
          model: 'model-a',
          models: ['model-a'],
          supportsImageInput: false,
          reasoningEffortPreset: 'unsupported',
          hasKey: true,
          needsKey: false
        }
      ]
    })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(1)
    expect(container.querySelector('[role="radio"]')?.textContent).toBe('Default')
  })
})
