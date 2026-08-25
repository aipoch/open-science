import type { i18n } from 'i18next'

import {
  COMMON_NAMESPACE,
  createI18nInstance,
  initializeI18nInstance,
  NATIVE_NAMESPACE
} from '../../shared/i18n/core'
import type { Locale } from '../../shared/locale'
import { nativeResources } from './resources'

export type NativeTranslateOptions = Record<string, string | number | undefined> & {
  context?: string
  count?: number
  defaultValue_one?: string
}

export type NativeTranslator = (key: string, options?: NativeTranslateOptions) => string

export const createNativeI18n = (locale: Locale): i18n =>
  initializeI18nInstance(createI18nInstance(), {
    locale,
    resources: nativeResources,
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
