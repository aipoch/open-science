import { create } from 'zustand'

import { applyTheme, persistTheme, resolveInitialTheme, type Theme } from '@/lib/theme'

type ThemeStore = {
  theme: Theme
  // Sets the theme, reflects it onto <html>, and persists the choice.
  setTheme: (theme: Theme) => void
  // Convenience for the settings toggle: flip between light and dark.
  toggleTheme: () => void
}

// Seeds from the stored choice (or OS preference on first run). main.tsx already applied this same
// value to <html> before React mounted, so the initial store state and the DOM are in sync.
export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: resolveInitialTheme(),
  setTheme: (theme) => {
    applyTheme(theme)
    persistTheme(theme)
    set({ theme })
  },
  toggleTheme: () => {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark')
  }
}))
