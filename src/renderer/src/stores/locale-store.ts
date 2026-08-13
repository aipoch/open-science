import { create } from 'zustand'

import { setI18nLocale } from '@/i18n'
import {
  applyHtmlLang,
  persistPreference,
  resolveLocalePreference,
  resolvePreference
} from '@/lib/locale-preference'
import type { LanguagePreference, Locale } from '../../../shared/locale'

type LocaleStore = {
  // The user's choice: 'system' (detect from the device) or an explicit locale.
  preference: LanguagePreference
  // The concrete locale currently painting, after resolving 'system' against the device.
  locale: Locale
  // Sets the preference, switches i18next, reflects <html lang>, and persists it. Unlike the theme's
  // 'system', there is no live OS listener to wire: no platform reports a language change to a running
  // process, so 'system' is resolved once per launch (the settings copy tells the user this).
  setPreference: (preference: LanguagePreference) => void
}

// Seeds from the stored preference (or 'system' on first run). main.tsx / web bootstrap.ts already
// initialized i18next and applied <html lang> before React mounted, so the initial store state, the
// DOM, and i18next are in sync.
export const useLocaleStore = create<LocaleStore>((set) => ({
  preference: resolvePreference(),
  locale: resolveLocalePreference(resolvePreference()),
  setPreference: (preference) => {
    const locale = resolveLocalePreference(preference)
    setI18nLocale(locale)
    applyHtmlLang(locale)
    persistPreference(preference)
    set({ preference, locale })
  }
}))
