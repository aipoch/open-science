// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderKindPicker } from './ProviderKindPicker'
import { OFFICIAL_VENDORS } from '../../../../shared/provider-registry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
  document.body.innerHTML = ''
})

const optionLabels = (): string[] =>
  Array.from(document.body.querySelectorAll('[data-slot="provider-kind-option"]')).map(
    (option) => option.textContent ?? ''
  )

describe('ProviderKindPicker', () => {
  it('lists official vendors first, from the top, with the custom options last', () => {
    act(() => {
      root.render(<ProviderKindPicker onSelect={vi.fn()} />)
    })

    const labels = optionLabels()
    // Codex subscription is hidden unless the active framework is Codex, so the first options are
    // the official vendors in registry order (OpenAI, Anthropic, DeepSeek, ...) — the ones the old
    // auto-scrolled dropdown hid above the viewport (issue #294).
    expect(labels[0]).toContain('OpenAI')
    expect(labels[1]).toContain('Anthropic')
    expect(labels[2]).toContain('DeepSeek')
    expect(labels).toHaveLength(OFFICIAL_VENDORS.length + 2)
    expect(labels[labels.length - 2]).toContain('Custom Gateway')
    expect(labels[labels.length - 1]).toContain('Local Claude')

    // Group headers frame the list; the scroll box is labelled for assistive tech.
    expect(document.body.textContent).toContain('Official API')
    expect(document.body.textContent).toContain('Other')
    expect(document.body.textContent).not.toContain('Codex subscription')
    expect(document.body.querySelector('[aria-label="Choose a provider"]')).not.toBeNull()
  })

  it('shows the Codex subscription group only for the Codex framework', () => {
    act(() => {
      root.render(<ProviderKindPicker onSelect={vi.fn()} showCodexSubscriptions />)
    })

    const labels = optionLabels()
    expect(document.body.textContent).toContain('Codex subscription')
    expect(labels[0]).toContain('Codex')
    expect(labels).toHaveLength(OFFICIAL_VENDORS.length + 3)
  })

  it('calls onSelect with the provider-kind key when an option is picked', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<ProviderKindPicker onSelect={onSelect} />)
    })

    const options = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-slot="provider-kind-option"]')
    )
    const openai = options.find((option) => option.textContent?.includes('OpenAI'))
    const custom = options.find((option) => option.textContent?.includes('Custom Gateway'))

    act(() => openai?.click())
    expect(onSelect).toHaveBeenLastCalledWith('official:openai')
    act(() => custom?.click())
    expect(onSelect).toHaveBeenLastCalledWith('custom')
  })
})
