import i18next, { type i18n, type Resource } from 'i18next'

import { DEFAULT_LOCALE, LOCALES, type Locale } from '../locale'

export const COMMON_NAMESPACE = 'common'
export const NATIVE_NAMESPACE = 'native'
export const RENDERER_NAMESPACE = 'renderer'

const englishSource = (key: string): string => key.split('_')[0]

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[0]).sort()

const tagMarkers = (text: string): string[] =>
  [...text.matchAll(/<(\/?\w+)>/g)].map((match) => match[0]).sort()

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

export const hasValidTagStructure = (text: string): boolean => {
  const stack: string[] = []

  for (const match of text.matchAll(/<(\/)?(\w+)>/g)) {
    const closing = Boolean(match[1])
    const name = match[2]
    if (VOID_ELEMENTS.has(name.toLowerCase())) return false

    if (!closing) {
      stack.push(name)
      continue
    }

    if (stack.pop() !== name) return false
  }

  return stack.length === 0
}

const isValidTranslation = (key: string, value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim().length === 0) return false

  const source = englishSource(key)
  return (
    placeholders(source).join('|') === placeholders(value).join('|') &&
    tagMarkers(source).join('|') === tagMarkers(value).join('|') &&
    hasValidTagStructure(source) &&
    hasValidTagStructure(value)
  )
}

const interpolateEnglish = (value: string, options: Record<string, unknown>): string =>
  value.replace(/\{\{(\w+)\}\}/g, (marker, name: string) =>
    Object.hasOwn(options, name) ? String(options[name]) : marker
  )

// A missing translated plural can otherwise render "1 files" because the English source key is the
// plural form. Keep this process-neutral so both adapters honor defaultValue_one the same way.
export const englishSourceFallbackPostProcessor = {
  type: 'postProcessor' as const,
  name: 'englishSourceFallback',
  process(value: string, keys: string[], options: Record<string, unknown>): string {
    const key = keys[0]
    const singular = options.defaultValue_one
    if (options.count !== 1 || typeof key !== 'string' || typeof singular !== 'string') return value

    return value === interpolateEnglish(key, options)
      ? interpolateEnglish(singular, options)
      : value
  }
}

export const sanitizeCatalog = (
  catalog: Readonly<Record<string, unknown>>
): Record<string, string> => {
  let sanitized: Record<string, string> | undefined

  for (const [key, value] of Object.entries(catalog)) {
    if (isValidTranslation(key, value)) continue

    sanitized ??= Object.fromEntries(
      Object.entries(catalog).map(([entryKey, entryValue]) => [
        entryKey,
        typeof entryValue === 'string' ? entryValue : englishSource(entryKey)
      ])
    )
    sanitized[key] = englishSource(key)
  }

  return (sanitized ?? catalog) as Record<string, string>
}

export const createNamespacedResource = <Namespace extends string>(
  catalogs: Readonly<Record<Namespace, Readonly<Record<string, unknown>>>>
): Record<Namespace, Record<string, string>> =>
  Object.fromEntries(
    Object.entries(catalogs).map(([namespace, catalog]) => [
      namespace,
      sanitizeCatalog(catalog as Readonly<Record<string, unknown>>)
    ])
  ) as Record<Namespace, Record<string, string>>

const fallbackLng: Record<string, string[]> = {
  fr: [DEFAULT_LOCALE],
  ja: [DEFAULT_LOCALE],
  ko: [DEFAULT_LOCALE],
  ru: [DEFAULT_LOCALE],
  'zh-Hant': [DEFAULT_LOCALE],
  'zh-Hans': [DEFAULT_LOCALE],
  default: [DEFAULT_LOCALE]
}

export const createI18nInstance = (): i18n => i18next.createInstance()

export const initializeI18nInstance = (
  instance: i18n,
  options: {
    locale: Locale
    resources: Resource
    namespaces: readonly string[]
    defaultNamespace: string
    fallbackNamespaces?: readonly string[]
  }
): i18n => {
  instance.use(englishSourceFallbackPostProcessor)
  void instance.init({
    lng: options.locale,
    fallbackLng,
    supportedLngs: [...LOCALES],
    resources: options.resources,
    defaultNS: options.defaultNamespace,
    ns: [...options.namespaces],
    fallbackNS: options.fallbackNamespaces ? [...options.fallbackNamespaces] : false,
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    postProcess: [englishSourceFallbackPostProcessor.name],
    returnNull: false,
    initAsync: false
  })

  return instance
}
