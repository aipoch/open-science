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
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(5)
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
})
