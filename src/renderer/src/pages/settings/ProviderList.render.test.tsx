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
  models: ['claude-sonnet-4-5'],
  maskedKey: 'sk-a…wxyz',
  hasKey: true,
  needsKey: false,
  lastValidatedAt: 1,
  ...overrides
})

const noop = vi.fn()

const renderList = (providers: ProviderView[], activeId?: string, busyId?: string): void => {
  act(() => {
    root.render(
      <ProviderList
        providers={providers}
        activeProviderId={activeId}
        busyProviderId={busyId}
        onEdit={noop}
        onDelete={noop}
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

    expect(container.querySelector('[data-slot="settings-list-row"]')).not.toBeNull()
    expect(container.textContent).toContain('sk-a…wxyz')
    expect(container.textContent).toContain('claude-sonnet-4-5')
    // A masked hint is displayed, but there is no way to render a real secret here.
    expect(container.textContent).not.toContain('sk-abcdefwxyz')
  })

  it('does not show any provider-level active/select control (selection is by model)', () => {
    renderList([provider()], 'p1')

    // No per-provider "Select"/"Selected" control, and no "active provider" wording.
    const labels = Array.from(container.querySelectorAll('button')).map((button) =>
      button.textContent?.trim()
    )
    expect(labels).not.toContain('Select')
    expect(container.textContent).not.toContain('Selected')
    expect(container.textContent).not.toContain('Active')
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

  it('flags a provider whose last test failed with the reason', () => {
    renderList([
      provider({ lastValidatedAt: 1, lastValidationFailure: { at: 2, category: 'auth' } })
    ])

    expect(container.textContent).toContain('authentication rejected')
  })

  it('shows the Local Claude probe message instead of referring to an API key', () => {
    renderList([
      provider({
        type: 'claude-default',
        name: 'Local Claude',
        lastValidationFailure: {
          at: 2,
          category: 'auth',
          message: 'Local Claude could not authenticate. Run `claude` in a terminal and log in.'
        }
      })
    ])

    expect(container.textContent).toContain('Run `claude` in a terminal')
    expect(container.textContent).not.toContain('check the API key')
  })

  it('does not flag a provider whose latest validation succeeded', () => {
    // A stale failure older than the last success is not a warning.
    renderList([
      provider({ lastValidatedAt: 5, lastValidationFailure: { at: 2, category: 'auth' } })
    ])

    expect(container.textContent).not.toContain('Test failed')
  })

  it('marks a provider whose test passed with a verified check', () => {
    renderList([provider({ lastValidatedAt: 5 })])

    expect(container.querySelector('[aria-label="Connection verified"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Test failed')
  })

  it('shows a testing state (and no check/warning) while a provider is being validated', () => {
    renderList([provider({ id: 'p1', lastValidatedAt: 5 })], undefined, 'p1')

    expect(container.textContent).toContain('Testing…')
    expect(container.querySelector('[aria-label="Connection verified"]')).toBeNull()
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

  it('badges the chat endpoint a provider speaks, defaulting to Anthropic when unset', () => {
    renderList([provider({ apiType: undefined })])

    const badge = container.querySelector(
      '[aria-label="Speaks the Anthropic /v1/messages endpoint"]'
    )
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('Anthropic')
  })

  it('badges an OpenAI-compatible provider distinctly', () => {
    renderList([provider({ apiType: 'openai' })])

    const badge = container.querySelector(
      '[aria-label="Speaks the OpenAI-compatible /v1/chat/completions endpoint"]'
    )
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('OpenAI')
  })

  it('badges a dual-endpoint provider with both APIs', () => {
    renderList([provider({ apiType: 'both' })])

    expect(container.textContent).toContain('Anthropic · OpenAI')
  })
})
