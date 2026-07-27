// App theme. Users pick a *preference* — 'system' (follow the OS), 'light', or 'dark' — which
// resolves to the actual light/dark theme that paints. The preference is a pure display choice, so
// it lives in localStorage: read synchronously and applied before React renders (see main.tsx) to
// avoid a light-mode flash. Both the Electron renderer and the localhost web build bootstrap through
// main.tsx, so this covers both. Applying = toggling the `.dark` class on <html>, which drives the
// @custom-variant dark selector and the token overrides in main.css / agent-markdown.css.

// The user's choice. 'system' defers to the OS and live-follows it (see subscribeSystemTheme).
export type ThemePreference = 'system' | 'light' | 'dark'
// The concrete theme that actually paints, after resolving 'system' against the OS.
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'open-science-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark'

// The current OS color-scheme preference. Guarded for non-DOM / no-matchMedia contexts (tests, SSR).
export const systemTheme = (): Theme =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(DARK_QUERY).matches
    ? 'dark'
    : 'light'

// The stored preference, or undefined when the user has never picked one. Legacy installs stored the
// resolved theme ('light'/'dark') under the same key; those remain valid preference values, so they
// migrate transparently to an explicit light/dark choice.
export const getStoredPreference = (): ThemePreference | undefined => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isPreference(value) ? value : undefined
  } catch {
    // Private-mode / disabled storage: treat as "no stored choice".
    return undefined
  }
}

// The effective preference: the explicit stored choice, else 'system' (auto-detect) on first run.
export const resolvePreference = (): ThemePreference => getStoredPreference() ?? 'system'

// Resolves a preference to the concrete theme to paint: 'system' consults the OS, else it's literal.
export const resolveTheme = (preference: ThemePreference): Theme =>
  preference === 'system' ? systemTheme() : preference

// The theme to paint on first load, resolving the stored (or default 'system') preference.
export const resolveInitialTheme = (): Theme => resolveTheme(resolvePreference())

// Reflects the theme onto <html>. Guarded for non-DOM contexts (tests importing the store).
export const applyTheme = (theme: Theme): void => {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export const persistPreference = (preference: ThemePreference): void => {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Non-fatal: the theme still applies for this session, it just won't be remembered.
  }
}

// Subscribes to OS color-scheme changes, invoking `onChange` with the new resolved theme whenever it
// flips. Callers use this only while the preference is 'system'. Returns an unsubscribe function; a
// no-op in non-DOM / no-matchMedia contexts.
export const subscribeSystemTheme = (onChange: (theme: Theme) => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(DARK_QUERY)
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches ? 'dark' : 'light')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
