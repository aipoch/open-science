// Interface language preference, stored per device. Mirrors lib/theme.ts: a pure display choice read
// synchronously from localStorage and applied before React renders (see main.tsx and web/bootstrap.ts)
// so the first paint is already in the right language. Both the Electron renderer and the localhost
// web build bootstrap through this module.
//
// Detection reads navigator.languages rather than the host OS locale on purpose. In the web build the
// backend may run on a machine whose OS language differs from the person using the browser; the
// browser's list is the one that describes the reader. In Electron, the renderer synchronizes this
// persisted choice to the main process, whose in-memory owner resolves `system` from Electron's
// preferred language list for native surfaces.

import {
  DEFAULT_LANGUAGE_PREFERENCE,
  htmlLang,
  normalizeLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type Locale
} from '../../../shared/locale'

const STORAGE_KEY = 'open-science-language'

// The host's prioritized language list. navigator.languages is the full list; navigator.language is
// the single top entry and exists everywhere navigator.languages might not (older WebViews, jsdom
// configurations). Empty in non-DOM contexts, which resolves to the English default.
export const systemLanguageTags = (): string[] => {
  if (typeof navigator === 'undefined') return []
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return [...navigator.languages]
  }

  return navigator.language ? [navigator.language] : []
}

// The stored preference, or undefined when the user has never picked one.
export const getStoredPreference = (): LanguagePreference | undefined => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    const preference = normalizeLanguagePreference(value)
    if (value === 'pt' && preference === 'pt-BR') {
      try {
        localStorage.setItem(STORAGE_KEY, preference)
      } catch {
        // The normalized value is still usable for this session when migration cannot be persisted.
      }
    }
    return preference
  } catch {
    // Private-mode / disabled storage: treat as "no stored choice".
    return undefined
  }
}

// The effective preference: the explicit stored choice, else 'system' (auto-detect) on first run.
export const resolvePreference = (): LanguagePreference =>
  getStoredPreference() ?? DEFAULT_LANGUAGE_PREFERENCE

// Resolves a preference to the locale to paint, detecting from the host when it is 'system'.
export const resolveLocalePreference = (preference: LanguagePreference): Locale =>
  resolveLocale(preference, systemLanguageTags())

// The locale to paint on first load, resolving the stored (or default 'system') preference.
export const resolveInitialLocale = (): Locale => resolveLocalePreference(resolvePreference())

// Reflects the locale onto <html lang>, which assistive tech and the browser's line-breaking both
// read. Guarded for non-DOM contexts (tests importing the store).
export const applyHtmlLang = (locale: Locale): void => {
  if (typeof document === 'undefined') return
  document.documentElement.lang = htmlLang(locale)
}

export const persistPreference = (preference: LanguagePreference): void => {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Non-fatal: the language still applies for this session, it just won't be remembered.
  }
}

export { STORAGE_KEY as LANGUAGE_STORAGE_KEY }
