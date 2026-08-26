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

type ResolvedTranslation = {
  res?: unknown
  exactUsedKey?: string
}

type PostProcessorOptions = Record<string, unknown> & {
  count?: number
  defaultValue?: unknown
  i18nResolved?: ResolvedTranslation
  ordinal?: boolean
}

type PostProcessorTranslator = {
  interpolator: {
    interpolate(
      value: string,
      data: Record<string, unknown>,
      language: string,
      options: Record<string, unknown>
    ): string
  }
  pluralResolver: {
    getSuffix(language: string, count: number, options: Record<string, unknown>): string
  }
}

const englishDefaultValue = (
  key: string,
  options: PostProcessorOptions,
  translator: PostProcessorTranslator
): string => {
  if (typeof options.count !== 'number') {
    return typeof options.defaultValue === 'string' ? options.defaultValue : key
  }

  const suffix = translator.pluralResolver.getSuffix(DEFAULT_LOCALE, options.count, options)
  const ordinalSuffix = options.ordinal
    ? translator.pluralResolver.getSuffix(DEFAULT_LOCALE, options.count, {
        ...options,
        ordinal: false
      })
    : ''
  const candidates = [
    options.count === 0 && !options.ordinal ? options.defaultValue_zero : undefined,
    options[`defaultValue${suffix}`],
    ordinalSuffix ? options[`defaultValue${ordinalSuffix}`] : undefined,
    options.defaultValue,
    key
  ]

  return candidates.find((candidate): candidate is string => typeof candidate === 'string') ?? key
}

// i18next chooses default values with the active locale's plural categories. When a translated key
// is missing, resolve the English source with English CLDR rules instead, then delegate interpolation
// to i18next as well. Sanitized entries are recognized by their source-text value.
export const englishSourceFallbackPostProcessor = {
  type: 'postProcessor' as const,
  name: 'englishSourceFallback',
  process(
    value: string,
    keys: string | string[],
    options: PostProcessorOptions,
    translator: PostProcessorTranslator
  ): string {
    const key = typeof keys === 'string' ? keys : keys[0]
    const resolved = options.i18nResolved
    if (typeof key !== 'string' || !resolved) return value

    const sanitizedToEnglish =
      typeof resolved.res === 'string' &&
      typeof resolved.exactUsedKey === 'string' &&
      resolved.res === englishSource(resolved.exactUsedKey)
    if (resolved.res !== undefined && !sanitizedToEnglish) return value

    return translator.interpolator.interpolate(
      englishDefaultValue(key, options, translator),
      options,
      DEFAULT_LOCALE,
      options
    )
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
    postProcessPassResolved: true,
    returnNull: false,
    initAsync: false
  })

  return instance
}
