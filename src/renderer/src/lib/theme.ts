// App theme (light / dark). The choice is a pure display preference, so it lives in localStorage —
// read synchronously and applied before React renders (see main.tsx) to avoid a light-mode flash.
// Both the Electron renderer and the localhost web build bootstrap through main.tsx, so this covers
// both. Applying = toggling the `.dark` class on <html>, which drives the @custom-variant dark
// selector and the token overrides in main.css / agent-markdown.css.

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'open-science-theme'

const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark'

// The OS preference, used only as the first-run default before the user makes an explicit choice.
const systemPrefersDark = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

// The stored choice, or undefined when the user has never picked one (falls back to the OS default).
export const getStoredTheme = (): Theme | undefined => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isTheme(value) ? value : undefined
  } catch {
    // Private-mode / disabled storage: treat as "no stored choice".
    return undefined
  }
}

// The effective theme to render: the explicit stored choice, else the OS preference.
export const resolveInitialTheme = (): Theme =>
  getStoredTheme() ?? (systemPrefersDark() ? 'dark' : 'light')

// Reflects the theme onto <html>. Guarded for non-DOM contexts (tests importing the store).
export const applyTheme = (theme: Theme): void => {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export const persistTheme = (theme: Theme): void => {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Non-fatal: the theme still applies for this session, it just won't be remembered.
  }
}
