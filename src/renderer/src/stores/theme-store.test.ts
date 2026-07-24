// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useThemeStore } from './theme-store'
import { getStoredTheme, resolveInitialTheme } from '@/lib/theme'

const setMatchMedia = (prefersDark: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: prefersDark && query.includes('dark'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  )
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  setMatchMedia(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme lib', () => {
  it('falls back to the OS preference when nothing is stored', () => {
    setMatchMedia(true)
    expect(getStoredTheme()).toBeUndefined()
    expect(resolveInitialTheme()).toBe('dark')
  })

  it('prefers the stored choice over the OS preference', () => {
    setMatchMedia(true)
    localStorage.setItem('open-science-theme', 'light')
    expect(resolveInitialTheme()).toBe('light')
  })

  it('ignores a corrupt stored value', () => {
    localStorage.setItem('open-science-theme', 'chartreuse')
    expect(getStoredTheme()).toBeUndefined()
  })
})

describe('theme store', () => {
  it('applies the class to <html> and persists when set', () => {
    useThemeStore.getState().setTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('open-science-theme')).toBe('dark')

    useThemeStore.getState().setTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('open-science-theme')).toBe('light')
  })

  it('toggles between light and dark', () => {
    useThemeStore.setState({ theme: 'light' })
    useThemeStore.getState().toggleTheme()
    expect(useThemeStore.getState().theme).toBe('dark')
    useThemeStore.getState().toggleTheme()
    expect(useThemeStore.getState().theme).toBe('light')
  })
})
