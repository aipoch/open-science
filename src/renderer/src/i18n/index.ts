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

import type { i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'

import {
  COMMON_NAMESPACE,
  createI18nInstance,
  initializeI18nInstance,
  RENDERER_NAMESPACE
} from '../../../shared/i18n/core'
import type { Locale } from '../../../shared/locale'
import { DEFAULT_NAMESPACE, resources } from './resources'

let initialized = false
const i18next = createI18nInstance()

export const initI18n = (locale: Locale): i18n => {
  if (initialized) {
    void i18next.changeLanguage(locale)
    return i18next
  }

  i18next.use(initReactI18next)
  initializeI18nInstance(i18next, {
    locale,
    resources,
    namespaces: [RENDERER_NAMESPACE, COMMON_NAMESPACE],
    defaultNamespace: DEFAULT_NAMESPACE,
    fallbackNamespaces: [COMMON_NAMESPACE]
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
