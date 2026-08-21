// i18next setup for the renderer, shared by the Electron window and the localhost web build.
//
// initI18n() is called synchronously before React mounts (main.tsx / web/bootstrap.ts) so the first
// paint is already in the resolved language. i18next's init is synchronous when resources are passed
// inline and no async backend is configured, which is why the catalogs are statically imported.
//
// Keys are the English source text: t('Data folder not found'), not t('dataRoot.missing.title').
// English therefore has no catalog — it renders from i18next's missing-key fallback, which returns
// the key verbatim and still runs interpolation over it. Two consequences worth knowing:
//   - A reviewer reads the real English copy in the diff, which is the reason for this scheme.
//   - A missing or deleted translation degrades to correct English, never to a visible key path.

import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'

import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../../shared/locale'
import { DEFAULT_NAMESPACE, englishSourceFallbackPostProcessor, resources } from './resources'

// Every translated locale falls back directly to English. Cross-locale fallback would mix languages
// on one screen whenever a key is missing, which reads worse than a clean English string and hides the
// gap from reviewers.
const fallbackLng: Record<string, string[]> = {
  fr: [DEFAULT_LOCALE],
  ja: [DEFAULT_LOCALE],
  ko: [DEFAULT_LOCALE],
  ru: [DEFAULT_LOCALE],
  'zh-Hant': [DEFAULT_LOCALE],
  'zh-Hans': [DEFAULT_LOCALE],
  default: [DEFAULT_LOCALE]
}

let initialized = false

export const initI18n = (locale: Locale): i18n => {
  if (initialized) {
    void i18next.changeLanguage(locale)
    return i18next
  }

  void i18next
    .use(englishSourceFallbackPostProcessor)
    .use(initReactI18next)
    .init({
      lng: locale,
      fallbackLng,
      supportedLngs: [...LOCALES],
      resources,
      defaultNS: DEFAULT_NAMESPACE,
      ns: [DEFAULT_NAMESPACE],
      // Both separators are off because keys are English sentences. Left at their defaults, a period in
      // 'Data folder not found.' would be read as key nesting and a colon in 'Note: saved' as a
      // namespace prefix, so either would silently fail to resolve.
      keySeparator: false,
      nsSeparator: false,
      // Our copy goes through JSX, which escapes on its own; i18next escaping on top would double-encode
      // apostrophes and quotes that appear throughout the English source.
      interpolation: { escapeValue: false },
      postProcess: [englishSourceFallbackPostProcessor.name],
      returnNull: false
    })

  initialized = true
  return i18next
}

// Switches the active language on an already-initialized instance. Safe to call before init (the
// store's setter may run in a test that never bootstrapped): init then applies the same locale.
export const setI18nLocale = (locale: Locale): void => {
  if (!initialized) {
    initI18n(locale)
    return
  }

  void i18next.changeLanguage(locale)
}

export { i18next }
