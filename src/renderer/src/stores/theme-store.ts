import { create } from 'zustand'

import {
  applyTheme,
  persistPreference,
  resolvePreference,
  resolveTheme,
  subscribeSystemTheme,
  type Theme,
  type ThemePreference
} from '@/lib/theme'

type ThemeStore = {
  // The user's choice: 'system' (follow the OS), 'light', or 'dark'.
  preference: ThemePreference
  // The concrete theme currently painting, after resolving 'system' against the OS.
  resolvedTheme: Theme
  // Sets the preference, reflects the resolved theme onto <html>, persists it, and (re)wires the OS
  // listener so 'system' live-follows the device while the other choices stay pinned.
  setPreference: (preference: ThemePreference) => void
}

// While the preference is 'system', we listen for OS color-scheme flips and repaint. Held at module
// scope (not in the store) so it survives re-renders; cleared whenever we leave 'system'.
let unsubscribeSystem: (() => void) | null = null

// Seeds from the stored preference (or 'system' on first run). main.tsx already applied the resolved
// theme to <html> before React mounted, so the initial store state and the DOM are in sync.
export const useThemeStore = create<ThemeStore>((set) => {
  const syncSystemListener = (preference: ThemePreference): void => {
    unsubscribeSystem?.()
    unsubscribeSystem = null
    if (preference !== 'system') return
    // OS flipped while following the system: repaint and update the store, but don't persist —
    // the preference is still 'system', only the resolved theme moved.
    unsubscribeSystem = subscribeSystemTheme((theme) => {
      applyTheme(theme)
      set({ resolvedTheme: theme })
    })
  }

  const initialPreference = resolvePreference()
  syncSystemListener(initialPreference)

  return {
    preference: initialPreference,
    resolvedTheme: resolveTheme(initialPreference),
    setPreference: (preference) => {
      const resolvedTheme = resolveTheme(preference)
      applyTheme(resolvedTheme)
      persistPreference(preference)
      syncSystemListener(preference)
      set({ preference, resolvedTheme })
    }
  }
})
