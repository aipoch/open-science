// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const theme = vi.hoisted(() => ({
  preference: 'light' as 'system' | 'light' | 'dark',
  resolvedTheme: 'light' as 'light' | 'dark'
}))

vi.mock('@/stores/theme-store', () => ({
  useThemeStore: <T,>(selector: (state: typeof theme) => T): T => selector(theme)
}))

import { useWindowFindAppearanceSync } from './useWindowFindAppearanceSync'

const Harness = (): null => {
  useWindowFindAppearanceSync()
  return null
}

describe('useWindowFindAppearanceSync', () => {
  let container: HTMLDivElement
  let root: Root
  const announceWindowFindAppearance = vi.fn()

  beforeEach(() => {
    theme.preference = 'light'
    theme.resolvedTheme = 'light'
    announceWindowFindAppearance.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.api = {
      window: { announceWindowFindAppearance }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (): Promise<void> => {
    await act(async () => root.render(<Harness />))
  }

  it('announces initial and changed explicit/system appearances', async () => {
    await render()
    expect(announceWindowFindAppearance).toHaveBeenLastCalledWith({
      theme: 'light',
      followsSystem: false
    })

    theme.preference = 'dark'
    theme.resolvedTheme = 'dark'
    await render()
    expect(announceWindowFindAppearance).toHaveBeenLastCalledWith({
      theme: 'dark',
      followsSystem: false
    })

    theme.preference = 'system'
    theme.resolvedTheme = 'light'
    await render()
    expect(announceWindowFindAppearance).toHaveBeenLastCalledWith({
      theme: 'light',
      followsSystem: true
    })

    theme.resolvedTheme = 'dark'
    await render()
    expect(announceWindowFindAppearance).toHaveBeenLastCalledWith({
      theme: 'dark',
      followsSystem: true
    })
  })
})
