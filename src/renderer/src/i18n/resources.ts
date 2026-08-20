// The message catalogs, statically imported so they are in the bundle before the first paint. All
// translated locales ship together: this is a desktop app (and a localhost web build), so there is no
// network cost to amortize, and lazy loading would reintroduce the language flash that reading the
// preference synchronously exists to avoid.
//
// There is no English catalog. Keys ARE the English source text (see i18n/index.ts), so English
// renders from i18next's missing-key fallback, which returns the key and still runs interpolation.
// A translated string that goes missing therefore degrades to correct English rather than to a
// visible key path.

import fr from '../locales/fr.json'
import ja from '../locales/ja.json'
import ko from '../locales/ko.json'
import zhHans from '../locales/zh-Hans.json'
import zhHant from '../locales/zh-Hant.json'

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

// Chinese, Japanese, and Korean resolve only the `_other` plural category. When a locale entry is
// missing or sanitized to its English source, i18next may ignore defaultValue_one and render
// "1 files". Correct only genuine English-source fallbacks; valid translations, including French
// `_one` entries, remain untouched.
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

// CI rejects malformed catalogs, but a shipped bad entry must still render usable copy. Keep valid
// catalogs by reference; only allocate when an invalid value needs to fall back to its English key.
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

// A single flat namespace. Natural-language keys are globally unique by construction, so there is
// nothing for a namespace split to disambiguate, and callers never have to know which file a string
// lives in.
export const DEFAULT_NAMESPACE = 'translation'

export const resources = {
  fr: { [DEFAULT_NAMESPACE]: sanitizeCatalog(fr) },
  ja: { [DEFAULT_NAMESPACE]: sanitizeCatalog(ja) },
  ko: { [DEFAULT_NAMESPACE]: sanitizeCatalog(ko) },
  'zh-Hans': { [DEFAULT_NAMESPACE]: sanitizeCatalog(zhHans) },
  'zh-Hant': { [DEFAULT_NAMESPACE]: sanitizeCatalog(zhHant) }
} as const
