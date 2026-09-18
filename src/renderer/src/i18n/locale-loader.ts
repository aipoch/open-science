import type { Resource } from 'i18next'
import {
  COMMON_NAMESPACE,
  RENDERER_NAMESPACE,
  createNamespacedResource
} from '../../../shared/i18n/core'
import type { Locale } from '../../../shared/locale'

// Literal imports let Vite emit one independent catalog chunk per locale.
const loaders = {
  de: () => import('../../../shared/i18n/locales/de.json'),
  es: () => import('../../../shared/i18n/locales/es.json'),
  fr: () => import('../../../shared/i18n/locales/fr.json'),
  ja: () => import('../../../shared/i18n/locales/ja.json'),
  ko: () => import('../../../shared/i18n/locales/ko.json'),
  ru: () => import('../../../shared/i18n/locales/ru.json'),
  'zh-Hans': () => import('../../../shared/i18n/locales/zh-Hans.json'),
  'zh-Hant': () => import('../../../shared/i18n/locales/zh-Hant.json')
}
const resources: Resource = {}
const inFlight = new Map<Locale, Promise<void>>()

// English is source text. Already-loaded locales keep the synchronous initialization path.
export const prepareI18nLocale = (locale: Locale): Promise<void> | undefined => {
  if (locale === 'en' || resources[locale]) return undefined
  const existing = inFlight.get(locale)
  if (existing) return existing
  const request = loaders[locale]()
    .then((catalog) => {
      resources[locale] = createNamespacedResource({
        [COMMON_NAMESPACE]: catalog.common,
        [RENDERER_NAMESPACE]: catalog.renderer
      })
    })
    .finally(() => {
      inFlight.delete(locale)
    })
  inFlight.set(locale, request)
  return request
}

export const preparedI18nResources = (locale: Locale): Resource => {
  if (locale !== 'en' && !resources[locale])
    throw new Error('Renderer locale has not been prepared.')
  return resources
}
