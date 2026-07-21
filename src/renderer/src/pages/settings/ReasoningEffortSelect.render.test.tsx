// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'

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

// Open the Select trigger and click an option by its visible text (portalled to body).
const openEffortSelect = (): void => {
  const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Reasoning effort"]')
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const clickEffortOption = (text: string): void => {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.includes(text)
  )
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ReasoningEffortSelect', () => {
  it('renders the selector showing the current level', async () => {
    useSettingsStore.setState({ reasoningEffort: 'high' })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    expect(container.querySelector('[aria-label="Reasoning effort"]')?.textContent).toContain(
      'High'
    )
  })

  it('calls the store action with the picked level', async () => {
    const setReasoningEffort = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ reasoningEffort: 'default', setReasoningEffort })

    await act(async () => {
      root.render(<ReasoningEffortSelect />)
    })

    openEffortSelect()
    clickEffortOption('Max')

    expect(setReasoningEffort).toHaveBeenCalledWith('max')
  })
})
