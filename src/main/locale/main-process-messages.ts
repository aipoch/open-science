import type { BackendModule, i18n } from 'i18next'

import {
  COMMON_NAMESPACE,
  createI18nInstance,
  initializeI18nInstance,
  NATIVE_NAMESPACE
} from '../../shared/i18n/core'
import { isLocale, type Locale } from '../../shared/locale'
import { nativeResources } from './resources'

export type NativeTranslateOptions = Record<string, string | number | undefined> & {
  context?: string
  count?: number
  defaultValue_one?: string
}

export type NativeTranslator = (key: string, options?: NativeTranslateOptions) => string

// Preference writes must not commit a locale whose bundled catalog cannot be loaded.
export const prepareNativeLocale = (locale: Locale): void => {
  if (locale !== 'en') void nativeResources[locale]
}

const nativeBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read(locale, namespace, callback) {
    if (
      !isLocale(locale) ||
      locale === 'en' ||
      (namespace !== COMMON_NAMESPACE && namespace !== NATIVE_NAMESPACE)
    ) {
      callback(null, {})
      return
    }
    callback(null, nativeResources[locale][namespace])
  }
}

export const createNativeI18n = (locale: Locale): i18n =>
  initializeI18nInstance(createI18nInstance().use(nativeBackend), {
    locale,
    namespaces: [NATIVE_NAMESPACE, COMMON_NAMESPACE],
    defaultNamespace: NATIVE_NAMESPACE,
    fallbackNamespaces: [COMMON_NAMESPACE]
  })

const standaloneInstances = new Map<Locale, i18n>()

export const translateNativeMessage = (
  locale: Locale,
  key: string,
  options: NativeTranslateOptions = {}
): string => {
  let instance = standaloneInstances.get(locale)
  if (!instance) {
    instance = createNativeI18n(locale)
    standaloneInstances.set(locale, instance)
  }
  return instance.t(key, options)
}

export const englishNativeTranslator: NativeTranslator = (key, options) =>
  translateNativeMessage('en', key, options)
