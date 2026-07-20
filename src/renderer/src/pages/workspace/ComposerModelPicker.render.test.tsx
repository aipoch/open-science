// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderView } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ComposerModelPicker } from './ComposerModelPicker'
import { incompatibilityReason } from './composer-model-picker-utils'

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

// The repo carries no @testing-library/user-event (no @testing-library at all — every existing
// interaction test drives the DOM via raw createRoot + act). These helpers dispatch the same real
// events user-event would, against the real Radix DropdownMenu: keyboard-open the menu, native-click
// a (portaled) menu item.
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
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

const menuItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))

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

    // The picker surfaces as a warning trigger (not the plain "Select model") so it stays visible.
    expect(container.querySelector('[aria-label="Select model"]')).toBeNull()
    const trigger = container.querySelector('[aria-label="No compatible model"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('No compatible model')
  })

  it('exposes each incompatible provider reason as a focusable, non-actionable menu item', async () => {
    // Claude Code (anthropic-only) + only OpenAI-speaking providers: the menu must state why each
    // provider is unavailable in an item roving focus can reach (not a label or a disabled item, both
    // keyboard-unreachable), keep it unselectable, and still offer a way out to Settings.
    const openSettings = vi.fn()
    const setActiveProvider = vi.fn()
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
        provider({ id: 'p1', apiType: 'openai', name: 'OpenAI Gateway', models: ['gpt-x'] })
      ],
      openSettings,
      setActiveProvider
    })
    render()

    const expectedReason = incompatibilityReason(
      { apiType: 'openai', type: 'custom', name: 'OpenAI Gateway' },
      'Claude Code',
      ['anthropic']
    )
    expect(expectedReason).toContain('/v1/messages')
    expect(expectedReason).toContain('/v1/chat/completions')

    // Surfaces as the warning trigger. Its content is portaled and only mounts once opened.
    const trigger = container.querySelector('[aria-label="No compatible model"]')
    expect(trigger).not.toBeNull()
    expect(document.querySelector('[role="menuitem"]')).toBeNull()

    // 1. Open the dropdown.
    await openMenu(trigger!)

    // 2. The reason lives in a real menu item (reached by arrow-key roving focus), carries the full
    // reason as visible text, and is marked unselectable.
    const reasonItem = menuItems().find((el) => el.textContent?.includes(expectedReason))
    expect(reasonItem, 'expected a menu item carrying the incompatibility reason').toBeDefined()
    expect(reasonItem?.textContent).toContain('OpenAI Gateway')
    expect(reasonItem?.textContent).toContain('Claude Code')
    expect(reasonItem?.getAttribute('aria-disabled')).toBe('true')
    // A Radix `disabled` item is skipped by roving focus; the reason item must NOT be disabled so a
    // keyboard user can land on it — proven by the absence of the data-disabled marker.
    expect(reasonItem?.hasAttribute('data-disabled')).toBe(false)

    // 2b. Prove keyboard ARROW roving focus can actually land on the reason item — the point of
    // leaving it aria-disabled rather than Radix-`disabled`. Absence of data-disabled alone only
    // shows the `disabled` prop was avoided; a Radix-`disabled` item would be dropped from the
    // roving-focus ring entirely and never reachable by arrow keys. Here we drive the real
    // ArrowDown/ArrowUp roving focus and assert document.activeElement moves off, then back ONTO,
    // the reason item via the arrow keys.
    const content = document.querySelector<HTMLElement>('[role="menu"]')
    expect(content, 'expected the portaled menu content to be mounted').not.toBeNull()
    // Radix's RovingFocusGroup defers the focus move to a macrotask (setTimeout), so a microtask
    // flush isn't enough — drain real timers after each arrow key.
    const flushTimers = async (): Promise<void> => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    const arrowKey = async (key: 'ArrowDown' | 'ArrowUp'): Promise<void> => {
      const target = (document.activeElement as Element | null) ?? content!
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
      await flushTimers()
    }
    // Keyboard-opening the menu lands roving focus on the first item, which is the reason item.
    expect(
      document.activeElement,
      'keyboard-open should place roving focus on the first (reason) item'
    ).toBe(reasonItem)
    // Step off it with ArrowDown (onto the next real item), then back onto it with ArrowUp — proving
    // arrow-key navigation genuinely traverses to the reason item rather than skipping it.
    await arrowKey('ArrowDown')
    expect(
      document.activeElement,
      'ArrowDown must move roving focus off the reason item onto the next item'
    ).not.toBe(reasonItem)
    expect((document.activeElement as HTMLElement | null)?.textContent).toContain('Open Settings')
    await arrowKey('ArrowUp')
    expect(
      document.activeElement,
      'ArrowUp must bring roving focus back onto the incompatibility reason item'
    ).toBe(reasonItem)

    // 3. Activating the reason item must not switch the model (it is informational only).
    act(() => reasonItem!.click())
    expect(setActiveProvider).not.toHaveBeenCalled()

    // 4. Open Settings still works as the escape hatch.
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
