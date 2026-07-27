// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeSegmentedControl } from './ThemeControls'
import { useThemeStore } from '@/stores/theme-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  useThemeStore.getState().setPreference('light')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ThemeSegmentedControl', () => {
  it('renders the three choices and marks the active preference', async () => {
    await act(async () => {
      root.render(<ThemeSegmentedControl />)
    })

    const radios = Array.from(container.querySelectorAll('[role="radio"]'))
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      'System',
      'Light',
      'Dark'
    ])

    const light = radios.find((radio) => radio.getAttribute('aria-label') === 'Light')
    expect(light?.getAttribute('aria-checked')).toBe('true')
  })

  it('changes the preference when a segment is clicked', async () => {
    await act(async () => {
      root.render(<ThemeSegmentedControl />)
    })

    const dark = container.querySelector('[role="radio"][aria-label="Dark"]') as HTMLButtonElement
    await act(async () => {
      dark.click()
    })

    expect(useThemeStore.getState().preference).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
