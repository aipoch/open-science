// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useThemeStore } from './theme-store'
import { getStoredPreference, resolveInitialTheme, resolvePreference } from '@/lib/theme'

type MediaListener = (event: { matches: boolean }) => void

// Mutable matchMedia stub: flip `prefersDark` then invoke listeners to simulate an OS theme change.
let prefersDark = false
const listeners = new Set<MediaListener>()

const emitSystemChange = (nextPrefersDark: boolean): void => {
  prefersDark = nextPrefersDark
  listeners.forEach((listener) => listener({ matches: nextPrefersDark }))
}

beforeEach(() => {
  prefersDark = false
  listeners.clear()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: prefersDark && query.includes('dark'),
      media: query,
      addEventListener: (_: string, listener: MediaListener) => listeners.add(listener),
      removeEventListener: (_: string, listener: MediaListener) => listeners.delete(listener)
    }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme lib', () => {
  it('defaults to the system preference when nothing is stored', () => {
    expect(getStoredPreference()).toBeUndefined()
    expect(resolvePreference()).toBe('system')
  })

  it('resolves the system preference against the OS', () => {
    prefersDark = true
    expect(resolveInitialTheme()).toBe('dark')
    prefersDark = false
    expect(resolveInitialTheme()).toBe('light')
  })

  it('prefers an explicit stored choice over the OS', () => {
    prefersDark = true
    localStorage.setItem('open-science-theme', 'light')
    expect(resolvePreference()).toBe('light')
    expect(resolveInitialTheme()).toBe('light')
  })

  it('ignores a corrupt stored value', () => {
    localStorage.setItem('open-science-theme', 'chartreuse')
    expect(getStoredPreference()).toBeUndefined()
  })
})

describe('theme store', () => {
  it('applies the class and persists the preference when set to dark', () => {
    useThemeStore.getState().setPreference('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('open-science-theme')).toBe('dark')
    expect(useThemeStore.getState().resolvedTheme).toBe('dark')

    useThemeStore.getState().setPreference('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(localStorage.getItem('open-science-theme')).toBe('light')
  })

  it('resolves system against the OS and live-follows OS changes', () => {
    prefersDark = true
    useThemeStore.getState().setPreference('system')
    expect(useThemeStore.getState().resolvedTheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('open-science-theme')).toBe('system')

    // OS flips to light while following the system: repaints, but the preference stays 'system'.
    emitSystemChange(false)
    expect(useThemeStore.getState().resolvedTheme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(useThemeStore.getState().preference).toBe('system')
  })

  it('stops following the OS once a fixed theme is chosen', () => {
    useThemeStore.getState().setPreference('system')
    useThemeStore.getState().setPreference('light')

    // An OS flip must not override the explicit light choice.
    emitSystemChange(true)
    expect(useThemeStore.getState().resolvedTheme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
