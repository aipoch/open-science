import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createNamespacedResource } from '../../shared/i18n/core'
import { LOCALES, type Locale } from '../../shared/locale'

// The Electron build emits only common/native catalogs beside its main-process chunks.
// Source runners (Vitest) read the canonical shared catalogs instead.
declare const __OPEN_SCIENCE_NATIVE_LOCALE_DIRECTORY__: string
const catalogDirectory =
  typeof __OPEN_SCIENCE_NATIVE_LOCALE_DIRECTORY__ === 'undefined'
    ? join(__dirname, '../../shared/i18n/locales')
    : join(__dirname, __OPEN_SCIENCE_NATIVE_LOCALE_DIRECTORY__)

type TranslatedLocale = Exclude<Locale, 'en'>
type Catalog = Record<string, string>
type NativeResource = { common: Catalog; native: Catalog }
const catalogs = new Map<TranslatedLocale, NativeResource>()
const sanitizedResources = new Map<TranslatedLocale, NativeResource>()

const readCatalog = (locale: TranslatedLocale): NativeResource => {
  let catalog = catalogs.get(locale)
  if (!catalog) {
    const { common, native } = JSON.parse(
      readFileSync(join(catalogDirectory, `${locale}.json`), 'utf8')
    ) as NativeResource
    catalog = { common, native }
    catalogs.set(locale, catalog)
  }
  return catalog
}

const getResource = (locale: TranslatedLocale): NativeResource => {
  let resource = sanitizedResources.get(locale)
  if (!resource) {
    resource = createNamespacedResource(readCatalog(locale))
    sanitizedResources.set(locale, resource)
  }
  return resource
}

// Preserve the catalog inspection API without reading unused languages at module import time.
const translatedLocales = LOCALES.filter((locale): locale is TranslatedLocale => locale !== 'en')
export const nativeResources = Object.defineProperties(
  {},
  Object.fromEntries(
    translatedLocales.map((locale) => [
      locale,
      { enumerable: true, get: () => getResource(locale) }
    ])
  )
) as Record<TranslatedLocale, NativeResource>

export const nativeCatalogs = Object.defineProperties(
  {},
  Object.fromEntries(
    translatedLocales.map((locale) => [
      locale,
      { enumerable: true, get: () => readCatalog(locale).native }
    ])
  )
) as Record<TranslatedLocale, Catalog>
