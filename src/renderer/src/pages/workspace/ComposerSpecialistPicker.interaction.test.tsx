// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistListItem } from '../../../../shared/specialist'
import { useSpecialistStore } from '@/stores/specialist-store'
import { ComposerSpecialistPicker } from './ComposerSpecialistPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The picker behavior is owned by this component; flatten the Radix portal so keyboard and
// filtering semantics can be exercised directly in jsdom.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  PopoverTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  PopoverContent: ({
    children
  }: PropsWithChildren<{
    side?: string
    align?: string
    sideOffset?: number
    collisionPadding?: number
    onOpenAutoFocus?: (event: Event) => void
  }>): React.JSX.Element => <div>{children}</div>
}))

const specialist = (id: string, name: string, displayName?: string): SpecialistListItem => ({
  kind: 'custom',
  id,
  name,
  displayName,
  description: `${displayName ?? name} description`,
  systemPrompt: 'Help the user.',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
})

let container: HTMLDivElement
let root: Root

const renderPicker = (props?: {
  selectedId?: string
  readOnly?: boolean
  loadingLabel?: string
  onChange?: (id: string | undefined) => void
}): void => {
  act(() => {
    root.render(
      <ComposerSpecialistPicker
        selectedId={props?.selectedId ?? 'researcher'}
        readOnly={props?.readOnly}
        loadingLabel={props?.loadingLabel}
        onChange={props?.onChange ?? vi.fn()}
      />
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSpecialistStore.setState({
    items: [
      specialist(
        'researcher',
        'RESEARCHER',
        'A deliberately long Specialist display name that must never widen the composer'
      ),
      specialist('statistician', 'STATISTICIAN', 'Statistician')
    ],
    isLoaded: true
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ComposerSpecialistPicker', () => {
  it('shows only the avatar while preserving the full accessible name', () => {
    renderPicker()

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-specialist-picker-trigger"]'
    )!
    expect(trigger.getAttribute('aria-label')).toContain(
      'A deliberately long Specialist display name that must never widen the composer'
    )
    expect(trigger.className).toContain('w-8')
    expect(trigger.className.split(' ')).not.toContain('bg-bg-200')
    expect(trigger.textContent).toBe('')
  })

  it('replaces the avatar with progress and restores the picker after switching', () => {
    const onChange = vi.fn()
    renderPicker({ loadingLabel: 'Switching to Researcher', onChange })
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-specialist-picker-trigger"]'
    )!
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    expect(trigger.querySelector('.animate-spin')).not.toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Switching to Researcher')
    act(() => trigger.click())
    expect(onChange).not.toHaveBeenCalled()

    renderPicker({ onChange })
    expect(trigger.disabled).toBe(false)
    expect(trigger.getAttribute('aria-busy')).toBe('false')
    expect(trigger.querySelector('.animate-spin')).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps a progress icon available while switching to Main Agent without a selected avatar', () => {
    act(() =>
      root.render(
        <ComposerSpecialistPicker
          selectedId={undefined}
          loadingLabel="Switching to Main Agent"
          onChange={vi.fn()}
        />
      )
    )
    expect(
      container.querySelector('[data-testid="composer-specialist-picker-trigger"]')
    ).not.toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Switching to Main Agent')
    act(() => root.render(<ComposerSpecialistPicker selectedId={undefined} onChange={vi.fn()} />))
    expect(container.querySelector('[data-testid="composer-specialist-picker-trigger"]')).toBeNull()
  })

  it('filters by Specialist metadata and selects the result with Enter', () => {
    const onChange = vi.fn()
    renderPicker({ onChange })
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!

    act(() => {
      fireEvent.change(input, { target: { value: 'STATISTICIAN' } })
    })

    expect(
      container.querySelector('[data-testid="composer-specialist-option-researcher"]')
    ).toBeNull()
    expect(
      container.querySelector('[data-testid="composer-specialist-option-statistician"]')
    ).not.toBeNull()

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('statistician')
  })

  it('supports Arrow navigation and exposes a mobile-safe touch target without adding height', () => {
    const onChange = vi.fn()
    renderPicker({ onChange })
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith('researcher')
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-specialist-picker-trigger"]'
    )!
    expect(trigger.className).toContain('h-8')
    expect(trigger.className).toContain('[@media(pointer:coarse)]:before:-inset-y-1.5')
  })

  it('disables the switcher when Agent controls are read-only', () => {
    renderPicker({ readOnly: true })
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="composer-specialist-picker-trigger"]'
      )?.disabled
    ).toBe(true)
  })

  it('namespaces the synthetic Main Agent option away from valid Specialist ids', () => {
    useSpecialistStore.setState((state) => ({
      items: [...state.items, specialist('main-agent', 'MAIN_AGENT_SPECIALIST')]
    }))
    const onChange = vi.fn()
    renderPicker({ onChange })

    const mainOption = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-specialist-option-__main-agent-option"]'
    )!
    const specialistOption = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-specialist-option-main-agent"]'
    )!
    expect(mainOption.id).not.toBe(specialistOption.id)

    act(() => mainOption.click())
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
