import { i18next } from '@/i18n'

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SHARED_PROVIDER_ID,
  type AgentFrameworkView,
  type ProviderView,
  type SessionAgentConfiguration
} from '../../../../shared/settings'
import {
  reasoningEffortProfile,
  resolveReasoningEffortControl
} from '../../../../shared/reasoning-effort'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ComposerModelPicker } from './ComposerModelPicker'
import { incompatibilityReason } from './composer-model-picker-utils'
import * as providerRegistry from '../../../../shared/provider-registry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Radix DropdownMenu/Tooltip mount real portals and run layout/pointer plumbing that jsdom omits.
// These shims let the genuine components open (and their portaled content mount) under jsdom so the
// test can drive the real open/hover/click behaviour instead of mocking the menu into the DOM.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
}
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      /* no-op shim for Radix layout measurement in jsdom */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
}
if (!globalThis.matchMedia) {
  ;(globalThis as { matchMedia?: unknown }).matchMedia = (): unknown => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    addListener: (): void => {},
    removeListener: (): void => {},
    dispatchEvent: (): boolean => false
  })
}

let container: HTMLDivElement
let root: Root
let onChange: ReturnType<typeof vi.fn<(configuration: SessionAgentConfiguration) => void>>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onChange = vi.fn()
  useSettingsStore.setState(createInitialSettingsState())
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  void i18next.changeLanguage('en')
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

const codexFramework: {
  agentFrameworkId: 'codex'
  agentFrameworks: AgentFrameworkView[]
} = {
  agentFrameworkId: 'codex',
  agentFrameworks: [
    {
      id: 'codex',
      displayName: 'Codex',
      supportedApiTypes: ['responses'],
      supportsSkills: true
    }
  ]
}

const render = (
  unavailable = false,
  includeAllClaudeSubscriptions = false,
  configurationOverride?: SessionAgentConfiguration
): void => {
  const state = useSettingsStore.getState()
  const configuration =
    configurationOverride ??
    (state.activeProviderId
      ? {
          providerId: state.activeProviderId,
          ...(state.activeModel ? { model: state.activeModel } : {}),
          reasoningEffort: state.reasoningEffort
        }
      : undefined)
  act(() =>
    root.render(
      <ComposerModelPicker
        configuration={configuration}
        unavailable={unavailable}
        includeAllClaudeSubscriptions={includeAllClaudeSubscriptions}
        onChange={onChange}
      />
    )
  )
}

// The repo carries no @testing-library/user-event (no @testing-library at all — every existing
// interaction test drives the DOM via raw createRoot + act). These helpers dispatch the same real
// events user-event would, against the real Radix DropdownMenu: keyboard-open the menu, native-click
// a (portaled) menu item.
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

// Radix's RovingFocusGroup defers the focus move to a macrotask (setTimeout), so a microtask
// flush isn't enough — drain real timers after each arrow key.
const flushTimers = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const openMenu = async (trigger: Element): Promise<void> => {
  // Radix DropdownMenuTrigger toggles open on Enter/Space keydown; this is the interaction jsdom
  // supports most reliably and it mounts the portaled content.
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
}

// A Radix SubTrigger opens its submenu on ArrowRight (LTR) when the keydown originates on the
// trigger itself; focusing first mirrors where roving focus would have put the user.
const openSubmenu = async (subTrigger: HTMLElement): Promise<void> => {
  act(() => {
    subTrigger.focus()
    subTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  await flushTimers()
}

const arrowKey = async (key: 'ArrowDown' | 'ArrowUp'): Promise<void> => {
  const target = (document.activeElement as Element | null) ?? document.body
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await flushTimers()
}

const menuItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))

const radioItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))

const subTriggers = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]'))

// The Model row's visible text is the current pick (provider + model), not a fixed label, so
// tests locate it via its stable test id.
const modelRowTrigger = (): HTMLElement | undefined =>
  subTriggers().find((el) => el.getAttribute('data-testid') === 'model-row')

describe('ComposerModelPicker', () => {
  it('localizes the unsupported badge in a mixed model catalog', async () => {
    await i18next.changeLanguage('zh-Hans')
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['anthropic', 'openai'],
          supportsSkills: true
        }
      ],
      providers: [
        provider({
          id: 'mixed',
          type: 'official',
          vendorId: 'opencode',
          apiEndpoints: ['openai'],
          models: ['kimi-k2.7-code', 'gpt-5.6-sol']
        })
      ],
      activeProviderId: 'mixed',
      activeModel: 'kimi-k2.7-code'
    })
    render()
    await openMenu(container.querySelector('button')!)
    await openSubmenu(modelRowTrigger()!)
    const row = menuItems().find((item) =>
      item.getAttribute('aria-label')?.includes('gpt-5.6-sol')
    )!
    expect(row.textContent).toContain('不支持')
    expect(row.textContent).not.toContain('unsupported')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    act(() => row.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('localizes the provider reason when every model is bridge-unsupported', async () => {
    // The bundled catalog currently has no bridge exclusions. Control its existing policy boundary
    // to exercise the picker branch without changing production state or the catalog model.
    vi.spyOn(providerRegistry, 'isModelBridgeSupported').mockReturnValue(false)
    await i18next.changeLanguage('zh-Hans')
    useSettingsStore.setState({
      ...codexFramework,
      providers: [
        provider({ id: 'gateway', name: 'Gateway', apiEndpoints: ['openai'], models: ['model-a'] })
      ]
    })
    render()
    await openMenu(container.querySelector('button')!)
    await openSubmenu(modelRowTrigger()!)
    const row = menuItems().find((item) => item.getAttribute('aria-disabled') === 'true')!
    expect(row.getAttribute('aria-label')).toBe(
      'Gateway 的所有模型均不支持通过 Codex Chat Completions 桥接使用。'
    )
    expect(row.title).toBe(row.getAttribute('aria-label'))
    act(() => row.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders nothing when there is a single selectable option', () => {
    useSettingsStore.setState({
      providers: [provider({ id: 'p1', models: ['only'], reasoningEffortPreset: 'unsupported' })]
    })
    render()

    expect(container.querySelector('[aria-label="Select model"]')).toBeNull()
    expect(container.querySelector('[aria-label="No model available — open settings"]')).toBeNull()
  })

  it('keeps a single-model picker visible when the model supports Session effort', async () => {
    useSettingsStore.setState({
      providers: [provider({ id: 'p1', models: ['only'], reasoningEffortPreset: 'none-high' })],
      activeProviderId: 'p1',
      activeModel: 'only'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    await openMenu(trigger!)
    expect(subTriggers().some((item) => item.textContent?.includes('Reasoning effort'))).toBe(true)
  })

  it('lists both Claude subscription Providers for an existing Session', async () => {
    useSettingsStore.setState({
      providers: [
        provider({
          id: CLAUDE_SHARED_PROVIDER_ID,
          type: 'claude-shared',
          name: 'Claude subscription',
          models: ['shared-model'],
          apiEndpoints: ['anthropic']
        }),
        provider({
          id: CLAUDE_ISOLATED_PROVIDER_ID,
          type: 'claude-isolated',
          name: 'Claude isolated',
          models: ['isolated-model'],
          apiEndpoints: ['anthropic']
        })
      ],
      activeProviderId: CLAUDE_SHARED_PROVIDER_ID,
      activeModel: 'shared-model',
      claudeSubscriptionProviderId: CLAUDE_SHARED_PROVIDER_ID
    })
    render(false, true, {
      providerId: CLAUDE_ISOLATED_PROVIDER_ID,
      model: 'isolated-model',
      reasoningEffort: 'high'
    })

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('isolated-model')
    await openMenu(trigger!)
    const modelRow = modelRowTrigger()
    expect(modelRow).toBeDefined()
    await openSubmenu(modelRow!)
    expect(document.body.textContent).toContain('Claude subscription')
    expect(document.body.textContent).toContain('Claude isolated')
  })

  it('shows the Codex provider name when the Session omits the account-owned default model', () => {
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ],
      providers: [
        provider({
          id: CODEX_SHARED_PROVIDER_ID,
          type: 'codex-shared',
          name: 'Codex subscription',
          models: ['gpt-5.4', 'gpt-5'],
          apiEndpoints: ['responses']
        })
      ],
      activeProviderId: CODEX_SHARED_PROVIDER_ID
    })
    render(false, false, {
      providerId: CODEX_SHARED_PROVIDER_ID,
      reasoningEffort: 'default'
    })

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger?.textContent).toContain('Codex subscription')
    expect(trigger?.textContent).not.toContain('gpt-5.4')
  })

  it('warns (does not hide) when the only provider is incompatible with the framework', () => {
    // Claude Code (anthropic-only) + a lone OpenAI-only provider: the picker must not silently vanish.
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      providers: [provider({ id: 'p1', apiEndpoints: ['openai'], models: ['gpt-x'] })]
    })
    render()

    // The picker surfaces as a warning trigger (not the plain "Select model") so it stays visible.
    expect(container.querySelector('[aria-label="Select model"]')).toBeNull()
    const trigger = container.querySelector('[aria-label="No compatible model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('No compatible model')
  })

  it('treats a Chat provider as bridge-compatible under Codex without a per-model probe', async () => {
    // Bridge support is static: a custom provider (no vendorId) is always supported, so its models are
    // selectable under Codex — there is no runtime streaming-function-tool probe gating them.
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ],
      providers: [
        provider({ id: 'p1', name: 'DeepSeek', apiEndpoints: ['openai'], models: ['ds', 'ds2'] })
      ]
    })
    render()

    // The compatible picker shows (not the "No compatible model" warning), and its models are usable.
    expect(container.querySelector('[aria-label="No compatible model"]')).toBeNull()
    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    await openMenu(trigger!)
    // The catalog itself lives in the Model submenu; open it before asserting on its rows.
    const modelRow = modelRowTrigger()
    expect(modelRow, 'expected the "Model" subtrigger').toBeDefined()
    await openSubmenu(modelRow!)
    expect(document.body.textContent).toContain('ds2')
    expect(document.body.textContent).not.toContain('not supported over the Codex')
  })

  it('explains a model-specific endpoint mismatch on hover or focus', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['anthropic', 'openai'],
          supportsSkills: true
        }
      ],
      providers: [
        provider({
          id: 'mixed',
          type: 'official',
          vendorId: 'opencode',
          name: 'Mixed catalog',
          apiEndpoints: ['openai'],
          models: ['kimi-k2.7-code', 'gpt-5.6-sol']
        })
      ],
      activeProviderId: 'mixed',
      activeModel: 'kimi-k2.7-code'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    await openMenu(trigger!)
    const modelRow = modelRowTrigger()
    expect(modelRow).toBeDefined()
    await openSubmenu(modelRow!)

    const unavailableItem = menuItems().find((item) =>
      item.getAttribute('aria-label')?.includes('gpt-5.6-sol')
    )
    const reason = unavailableItem?.getAttribute('aria-label')
    expect(reason).toContain('/v1/responses')
    expect(reason).toContain('OpenCode')
    expect(reason).toContain('/v1/chat/completions')
    expect(reason).not.toContain('Codex Chat Completions bridge')
    expect(unavailableItem?.getAttribute('aria-disabled')).toBe('true')

    await act(async () => unavailableItem?.focus())
    await flush()

    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      reason
    )
    act(() => unavailableItem?.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('exposes each incompatible provider reason as a focusable, non-actionable menu item', async () => {
    // Claude Code (anthropic-only) + only OpenAI-speaking providers: the menu must state why each
    // provider is unavailable in an item roving focus can reach (not a label or a disabled item, both
    // keyboard-unreachable), keep it unselectable, and still offer a way out to Settings. The reason
    // row now lives inside the "Model" submenu; "Open Settings" stays on the first level.
    const openSettings = vi.fn()
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportedApiTypes: ['anthropic'],
          supportsSkills: true
        }
      ],
      providers: [
        provider({ id: 'p1', apiEndpoints: ['openai'], name: 'OpenAI Gateway', models: ['gpt-x'] })
      ],
      openSettings
    })
    render()

    const expectedReason = incompatibilityReason(
      { apiEndpoints: ['openai'], type: 'custom', name: 'OpenAI Gateway' },
      'Claude Code',
      ['anthropic'],
      i18next.getFixedT('en')
    )
    expect(expectedReason).toContain('/v1/messages')
    expect(expectedReason).toContain('/v1/chat/completions')

    // Surfaces as the warning trigger. Its content is portaled and only mounts once opened.
    const trigger = container.querySelector('[aria-label="No compatible model"]')
    expect(trigger).not.toBeNull()
    expect(document.querySelector('[role="menuitem"]')).toBeNull()

    // 1. Open the dropdown.
    await openMenu(trigger!)

    // 2. With no active provider there is no effort row, so roving focus lands on the "Model"
    // subtrigger first; ArrowDown/ArrowUp step between it and the first-level "Open Settings".
    const modelRow = modelRowTrigger()
    expect(modelRow, 'expected the "Model" subtrigger').toBeDefined()
    expect(
      document.activeElement,
      'keyboard-open should place roving focus on the first (Model) item'
    ).toBe(modelRow)
    await arrowKey('ArrowDown')
    expect((document.activeElement as HTMLElement | null)?.textContent).toContain('Open Settings')
    await arrowKey('ArrowUp')
    expect(document.activeElement, 'ArrowUp must return roving focus to the Model row').toBe(
      modelRow
    )

    // 3. Open the Model submenu: the reason lives in a real menu item there (reached by arrow-key
    // roving focus). The full reason is exposed to assistive tech via aria-label/title while the
    // visible label stays compact, and the item is marked unselectable.
    await openSubmenu(modelRow!)
    const reasonItem = menuItems().find((el) => el.getAttribute('aria-label') === expectedReason)
    expect(reasonItem, 'expected a menu item carrying the incompatibility reason').toBeDefined()
    expect(reasonItem?.getAttribute('aria-label')).toContain('OpenAI Gateway')
    expect(reasonItem?.getAttribute('aria-label')).toContain('Claude Code')
    expect(reasonItem?.getAttribute('title')).toBe(expectedReason)
    expect(reasonItem?.textContent).toContain('Unavailable for Claude Code')
    expect(reasonItem?.getAttribute('aria-disabled')).toBe('true')
    // A Radix `disabled` item is skipped by roving focus; the reason item must NOT be disabled so a
    // keyboard user can land on it — proven by the absence of the data-disabled marker.
    expect(reasonItem?.hasAttribute('data-disabled')).toBe(false)

    // 3b. Prove roving focus can actually land on the reason item: it is the submenu's only item,
    // so an ArrowDown from wherever focus settled must move (or loop) onto it — a Radix-`disabled`
    // item would be dropped from the roving-focus ring entirely and never reached.
    await arrowKey('ArrowDown')
    expect(
      document.activeElement,
      'ArrowDown inside the Model submenu must land on the reason item'
    ).toBe(reasonItem)

    // 4. Activating the reason item must not switch the model (it is informational only).
    act(() => reasonItem!.click())
    expect(onChange).not.toHaveBeenCalled()

    // 5. Open Settings still works as the escape hatch, from the first level.
    const openSettingsItem = menuItems().find((el) => el.textContent?.includes('Open Settings'))
    expect(openSettingsItem, 'expected an "Open Settings" menu item').toBeDefined()
    act(() => openSettingsItem!.click())
    expect(openSettings).toHaveBeenCalledTimes(1)
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
      { apiEndpoints: ['openai'], type: 'custom', name: 'OpenAI Gateway' },
      'Claude Code',
      ['anthropic'],
      i18next.getFixedT('en')
    )

    expect(reason).toContain('OpenAI Gateway')
    expect(reason).toContain('Claude Code')
    expect(reason).toContain('/v1/messages')
    expect(reason).toContain('/v1/chat/completions')
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
        provider({ id: 'c', name: 'Gateway', model: 'my-model', models: [] }),
        provider({ id: 'local', type: 'custom', name: 'Local', model: undefined, models: [] })
      ],
      activeProviderId: 'c',
      activeModel: 'my-model'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger?.textContent).toContain('my-model')
  })

  it('shows an actionable warning when the Session configuration is unavailable', () => {
    useSettingsStore.setState({
      providers: [provider({ id: 'active', name: 'Gateway', model: 'model', models: [] })],
      activeProviderId: 'active',
      activeModel: 'model'
    })
    render(true)

    expect(container.querySelector('[aria-label="Session model unavailable"]')).not.toBeNull()
  })

  it('suffixes the trigger with the effort label when a non-default effort is set and supported', () => {
    // gpt-5.2 is not in the bundled OpenAI catalog, so it resolves to the vendor-level profile
    // (low-medium-high-xhigh) — supported, with the stored 'high' intent mapping to the High rung.
    useSettingsStore.setState({
      ...codexFramework,
      providers: [
        provider({
          id: 'off',
          type: 'official',
          vendorId: 'openai',
          name: 'OpenAI',
          models: ['gpt-5.2', 'gpt-5.5']
        })
      ],
      activeProviderId: 'off',
      activeModel: 'gpt-5.2',
      reasoningEffort: 'high'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('gpt-5.2')
    expect(trigger?.textContent).toContain('· High')
    // The provider name no longer appears on the trigger — the effort suffix replaced it.
    expect(trigger?.textContent).not.toContain('OpenAI')
  })

  it('lets the trigger shrink while preserving the effort suffix and ellipsizing the model', () => {
    // Long model names must not swallow the effort suffix: the model span truncates, the suffix
    // span is shrink-protected and never wraps.
    useSettingsStore.setState({
      ...codexFramework,
      providers: [
        provider({
          id: 'off',
          type: 'official',
          vendorId: 'openai',
          name: 'OpenAI',
          models: ['gpt-5.2-with-a-very-long-model-name', 'gpt-5.5']
        })
      ],
      activeProviderId: 'off',
      activeModel: 'gpt-5.2-with-a-very-long-model-name',
      reasoningEffort: 'high'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('· High')
    const triggerClasses = trigger?.className.split(/\s+/) ?? []
    expect(triggerClasses).toContain('min-w-0')
    expect(triggerClasses).toContain('shrink')
    expect(triggerClasses).not.toContain('shrink-0')
    const suffix = Array.from(trigger!.querySelectorAll('span')).find(
      (el) => el.textContent?.trim() === '· High'
    )
    expect(suffix?.className).toContain('shrink-0')
    expect(suffix?.className).not.toContain('truncate')
    const modelName = Array.from(trigger!.querySelectorAll('span')).find(
      (el) => el.textContent === 'gpt-5.2-with-a-very-long-model-name'
    )
    expect(modelName?.className).toContain('truncate')
  })

  it('shows no effort suffix on the trigger when the effort intent is default', () => {
    useSettingsStore.setState({
      ...codexFramework,
      providers: [
        provider({
          id: 'off',
          type: 'official',
          vendorId: 'openai',
          name: 'OpenAI',
          models: ['gpt-5.2', 'gpt-5.5']
        })
      ],
      activeProviderId: 'off',
      activeModel: 'gpt-5.2',
      reasoningEffort: 'default'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger?.textContent).toContain('gpt-5.2')
    expect(trigger?.textContent).not.toContain('·')
  })

  it('hides the effort row and suffix when the active model does not support reasoning effort', async () => {
    // claude-haiku-4-5-20251001 is statically marked effort-unsupported in the vendor catalog, so
    // neither the trigger suffix nor the "Reasoning effort" row may appear.
    useSettingsStore.setState({
      providers: [
        provider({
          id: 'ant',
          type: 'official',
          vendorId: 'anthropic',
          name: 'Anthropic',
          models: ['claude-haiku-4-5-20251001']
        }),
        provider({ id: 'p2', name: 'Gateway', models: ['gm'] })
      ],
      activeProviderId: 'ant',
      activeModel: 'claude-haiku-4-5-20251001',
      reasoningEffort: 'high'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).not.toContain('· High')

    await openMenu(trigger!)
    expect(
      subTriggers().find((el) => el.textContent?.includes('Reasoning effort')),
      'expected no "Reasoning effort" subtrigger for an unsupported model'
    ).toBeUndefined()
    expect(modelRowTrigger(), 'expected the "Model" subtrigger to remain').toBeDefined()
  })

  it('lists the profile effort levels in the effort submenu and applies the picked intent', async () => {
    // DeepSeek's catalog profile is none-high-max: the submenu offers Default plus that profile's
    // rungs, and picking one stores the intent the profile maps the rung to.
    useSettingsStore.setState({
      providers: [
        provider({
          id: 'ds',
          type: 'official',
          vendorId: 'deepseek',
          name: 'DeepSeek',
          models: ['deepseek-v4-pro', 'deepseek-v4-flash']
        })
      ],
      activeProviderId: 'ds',
      activeModel: 'deepseek-v4-pro'
    })
    render()

    const control = resolveReasoningEffortControl(
      'default',
      reasoningEffortProfile('none-high-max')
    )
    expect(control.options.map((option) => option.label)).toEqual(['None', 'High', 'Max'])

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    await openMenu(trigger!)

    const effortRow = subTriggers().find((el) => el.textContent?.includes('Reasoning effort'))
    expect(effortRow, 'expected the "Reasoning effort" subtrigger').toBeDefined()
    // With the stored intent at default, the first-level capsule echoes "Default".
    expect(effortRow?.textContent).toContain('Default')
    await openSubmenu(effortRow!)

    const effortOptions = radioItems()
    expect(effortOptions.map((el) => el.textContent)).toEqual([
      'Defaultprovider default',
      'None',
      'High',
      'Max'
    ])

    // Default is the stored intent, so its row carries the selected marker (aria-checked + Check).
    const defaultItem = effortOptions.find((el) => el.textContent === 'Defaultprovider default')
    expect(defaultItem?.getAttribute('aria-checked')).toBe('true')
    expect(defaultItem?.querySelector('svg.text-primary')).not.toBeNull()

    const highItem = effortOptions.find((el) => el.textContent === 'High')
    const highOption = control.options.find((option) => option.label === 'High')
    act(() => highItem!.click())
    expect(onChange).toHaveBeenCalledWith({
      providerId: 'ds',
      model: 'deepseek-v4-pro',
      reasoningEffort: highOption?.intent
    })
  })

  it('summarizes the current pick in the Model row as provider line over model name', async () => {
    useSettingsStore.setState({
      ...codexFramework,
      providers: [
        provider({
          id: 'off',
          type: 'official',
          vendorId: 'openai',
          name: 'OpenAI',
          models: ['gpt-5.2', 'gpt-5.5']
        })
      ],
      activeProviderId: 'off',
      activeModel: 'gpt-5.2'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    await openMenu(trigger!)

    // Two-line summary: the small bold provider line (with the provider's icon) sits above the
    // model name — no `model · provider` capsule anymore.
    const modelRow = modelRowTrigger()
    expect(modelRow, 'expected the "Model" subtrigger').toBeDefined()
    expect(modelRow?.textContent).toContain('OpenAI')
    expect(modelRow?.textContent).toContain('gpt-5.2')
    expect(modelRow?.textContent).not.toContain('·')
  })

  it('adapts the effort submenu to the standard-5 profile and echoes the current effort in the row capsule', async () => {
    // A model absent from the Anthropic catalog resolves to the vendor default (standard-5): five
    // distinct rungs. The stored 'medium' intent checks the rung the profile maps it to, and the
    // first-level row capsule shows that rung's label.
    useSettingsStore.setState({
      providers: [
        provider({
          id: 'ant',
          type: 'official',
          vendorId: 'anthropic',
          name: 'Anthropic',
          models: ['claude-next', 'claude-next-mini']
        }),
        provider({ id: 'p2', name: 'Gateway', models: ['gm'] })
      ],
      activeProviderId: 'ant',
      activeModel: 'claude-next',
      reasoningEffort: 'medium'
    })
    render()

    const control = resolveReasoningEffortControl('medium', reasoningEffortProfile('standard-5'))
    expect(control.options).toHaveLength(5)
    const selectedLabel = control.options.find(
      (option) => option.value === control.selectedValue
    )?.label

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    await openMenu(trigger!)

    const effortRow = subTriggers().find((el) => el.textContent?.includes('Reasoning effort'))
    expect(effortRow, 'expected the "Reasoning effort" subtrigger').toBeDefined()
    expect(effortRow?.textContent).toContain(selectedLabel!)

    await openSubmenu(effortRow!)
    const effortOptions = radioItems()
    expect(effortOptions.map((el) => el.textContent)).toEqual([
      'Defaultprovider default',
      ...control.options.map((option) => option.label)
    ])

    // The rung the stored intent maps onto carries the selected marker (aria-checked + Check).
    const checkedItem = effortOptions.find((el) => el.getAttribute('aria-checked') === 'true')
    expect(checkedItem?.textContent).toBe(selectedLabel)
    expect(checkedItem?.querySelector('svg.text-primary')).not.toBeNull()
  })

  it('keeps the grouped provider catalog in the Model submenu and switches on pick', async () => {
    useSettingsStore.setState({
      ...codexFramework,
      providers: [
        provider({
          id: 'off',
          type: 'official',
          vendorId: 'openai',
          name: 'OpenAI',
          models: ['gpt-5.2', 'gpt-5.5']
        }),
        provider({ id: 'gw', name: 'Gateway', apiEndpoints: ['openai'], models: ['gm'] })
      ],
      activeProviderId: 'off',
      activeModel: 'gpt-5.2'
    })
    render()

    const trigger = container.querySelector('[aria-label="Select model"]')
    expect(trigger).not.toBeNull()
    await openMenu(trigger!)

    const modelRow = modelRowTrigger()
    expect(modelRow, 'expected the "Model" subtrigger').toBeDefined()
    await openSubmenu(modelRow!)

    // Both provider groups render under their own heading, with every catalog model listed.
    expect(document.body.textContent).toContain('OpenAI')
    expect(document.body.textContent).toContain('Gateway')
    expect(document.body.textContent).toContain('gpt-5.5')

    // The active model row is the one carrying the selected marker (aria-checked + Check).
    const activeModelItem = radioItems().find((el) => el.textContent === 'gpt-5.2')
    expect(activeModelItem, 'expected the active model menu item').toBeDefined()
    expect(activeModelItem?.getAttribute('aria-checked')).toBe('true')
    expect(activeModelItem?.querySelector('svg.text-primary')).not.toBeNull()

    const gatewayModel = radioItems().find((el) => el.textContent === 'gm')
    expect(gatewayModel, 'expected the Gateway model menu item').toBeDefined()
    act(() => gatewayModel!.click())
    expect(onChange).toHaveBeenCalledWith({
      providerId: 'gw',
      model: 'gm',
      reasoningEffort: 'default'
    })
  })
})
