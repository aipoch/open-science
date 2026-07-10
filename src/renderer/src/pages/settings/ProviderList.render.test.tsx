// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderView } from '../../../../shared/settings'
import { ProviderList } from './ProviderList'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const provider = (overrides: Partial<ProviderView> = {}): ProviderView => ({
  id: 'p1',
  type: 'custom',
  name: 'Gateway',
  baseUrl: 'https://g/v1',
  model: 'claude-sonnet-4-5',
  maskedKey: 'sk-a…wxyz',
  hasKey: true,
  needsKey: false,
  lastValidatedAt: 1,
  ...overrides
})

const noop = vi.fn()

const renderList = (providers: ProviderView[], activeId?: string): void => {
  act(() => {
    root.render(
      <ProviderList
        providers={providers}
        activeProviderId={activeId}
        onEdit={noop}
        onDelete={noop}
        onSetActive={noop}
        onTest={noop}
      />
    )
  })
}

// Finds an icon action button by its accessible name.
const buttonByLabel = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.getAttribute('aria-label') === label
  )

describe('ProviderList', () => {
  it('shows the masked key and model but never a plaintext key', () => {
    renderList([provider()])

    expect(container.textContent).toContain('sk-a…wxyz')
    expect(container.textContent).toContain('claude-sonnet-4-5')
    // A masked hint is displayed, but there is no way to render a real secret here.
    expect(container.textContent).not.toContain('sk-abcdefwxyz')
  })

  it('leads an unselected row with a Select button, never Test connection', () => {
    renderList([provider()])

    const buttons = Array.from(container.querySelectorAll('button'))
    // The first action must be Select; Test connection must never be first.
    expect(buttons[0]?.textContent?.trim()).toBe('Select')
    expect(buttons[0]?.getAttribute('aria-label')).not.toBe('Test connection')

    const selectIndex = buttons.findIndex((button) => button.textContent?.trim() === 'Select')
    const testIndex = buttons.findIndex(
      (button) => button.getAttribute('aria-label') === 'Test connection'
    )
    expect(selectIndex).toBe(0)
    expect(testIndex).toBeGreaterThan(selectIndex)
  })

  it('marks the selected provider with a Selected badge and no Select button (no "Active" wording)', () => {
    renderList([provider()], 'p1')

    expect(container.textContent).toContain('Selected')
    // "Active" is intentionally avoided because it implies availability, not selection.
    expect(container.textContent).not.toContain('Active')
    const selectButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Select'
    )
    expect(selectButton).toBeUndefined()
  })

  it('renders edit/delete/test as icon-only buttons with accessible labels', () => {
    renderList([provider()])

    const test = buttonByLabel('Test connection')
    const edit = buttonByLabel('Edit')
    const del = buttonByLabel('Delete')

    expect(test).toBeDefined()
    expect(edit).toBeDefined()
    expect(del).toBeDefined()
    // Icon-only: the button shows an SVG, not a visible text name.
    expect(edit?.querySelector('svg')).not.toBeNull()
    expect(del?.querySelector('svg')).not.toBeNull()
    expect(edit?.textContent?.trim()).toBe('')
    expect(del?.textContent?.trim()).toBe('')
  })

  it('disables delete for the selected provider so it cannot drop back to onboarding', () => {
    renderList([provider({ id: 'p1' }), provider({ id: 'p2', name: 'Other' })], 'p1')

    const deletes = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.getAttribute('aria-label') === 'Delete'
    )
    // p1 is selected -> its delete is disabled; p2 is unselected with siblings -> enabled.
    expect((deletes[0] as HTMLButtonElement).disabled).toBe(true)
    expect((deletes[1] as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables delete when only one provider remains', () => {
    renderList([provider()])

    expect((buttonByLabel('Delete') as HTMLButtonElement).disabled).toBe(true)
  })

  it('exposes an icon action name as a hover tooltip on focus', async () => {
    renderList([provider()])

    const edit = buttonByLabel('Edit')

    await act(async () => {
      edit?.focus()
    })

    // Radix opens the tooltip on focus and portals its content to the document body.
    expect(document.body.textContent).toContain('Edit')
  })

  it('flags a provider whose key needs re-entry', () => {
    renderList([provider({ needsKey: true })])

    expect(container.textContent).toContain('Key needs re-entry')
  })

  it('shows only the model for a local Claude provider and never a key row', () => {
    renderList([
      provider({
        type: 'claude-default',
        name: 'Local Claude',
        baseUrl: undefined,
        model: 'claude-opus',
        maskedKey: undefined,
        hasKey: false
      })
    ])

    expect(container.textContent).toContain('Model: claude-opus')
    expect(container.textContent).not.toContain('Key:')
  })

  it('labels an empty local-Claude model as the default', () => {
    renderList([
      provider({
        type: 'claude-default',
        name: 'Local Claude',
        baseUrl: undefined,
        model: undefined,
        maskedKey: undefined,
        hasKey: false
      })
    ])

    expect(container.textContent).toContain('Model: default')
    expect(container.textContent).not.toContain('Key:')
  })

  it('renders an empty state with no providers', () => {
    renderList([])

    expect(container.textContent).toContain('No providers yet')
  })
})
