// i18next setup for the renderer, shared by the Electron window and the localhost web build.
//
// Prepare the selected catalog before mounting React; initialization and already-loaded switches
// remain synchronous. Unselected catalogs are separate chunks and never enter the startup graph.
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
import { preparedI18nResources } from './locale-loader'
export { prepareI18nLocale } from './locale-loader'

let initialized = false
const i18next = createI18nInstance()

export const initI18n = (locale: Locale): i18n => {
  const resources = preparedI18nResources(locale)
  if (initialized) {
    for (const [namespace, catalog] of Object.entries(resources[locale] ?? {})) {
      if (!i18next.hasResourceBundle(locale, namespace))
        i18next.addResourceBundle(locale, namespace, catalog)
    }
    const startedAt = performance.now()
    void i18next.changeLanguage(locale).then(() => {
      performance.clearMeasures('open-science:i18n-locale-switch')
      performance.measure('open-science:i18n-locale-switch', { start: startedAt })
    })
    return i18next
  }

  const startedAt = performance.now()
  i18next.use(initReactI18next)
  initializeI18nInstance(i18next, {
    locale,
    resources,
    namespaces: [RENDERER_NAMESPACE, COMMON_NAMESPACE],
    defaultNamespace: RENDERER_NAMESPACE,
    fallbackNamespaces: [COMMON_NAMESPACE]
  })

  initialized = true
  performance.measure('open-science:i18n-init', { start: startedAt })
  return i18next
}

// Switches the active language on an already-initialized instance. Safe to call before init (the
// store's setter may run in a test that never bootstrapped): init then applies the same locale.
export const setI18nLocale = (locale: Locale): void => {
  initI18n(locale)
}

export { i18next }
