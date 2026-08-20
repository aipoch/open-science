// Supported interface languages and the normalization that maps an arbitrary BCP-47 tag onto one.
// Shared because both the renderer (which detects from navigator.languages) and the main process
// (which detects from app.getLocale() for the tray and native dialogs) must agree on the result.

// The locales that actually paint. Script subtags are the canonical form: 'zh-Hans' / 'zh-Hant'
// rather than 'zh-CN' / 'zh-TW', because the script is what selects the catalog — a Traditional
// reader in Singapore and one in Taiwan get the same copy.
export const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr'] as const
export type Locale = (typeof LOCALES)[number]

// The fallback when nothing matches, and the source language every catalog is authored against.
export const DEFAULT_LOCALE: Locale = 'en'

// The user's choice. 'system' resolves against the host language list at startup; the explicit
// locales stay pinned. Unlike the theme's 'system', this cannot live-follow the OS — neither
// Chromium nor Electron reports a language change to a running process — so it is resolved once per
// launch and the settings copy says so.
export const LANGUAGE_PREFERENCES = ['system', ...LOCALES] as const
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number]

export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = 'system'

// Current desktop projection. Main persists `preference` in settings.json and resolves `system`
// against Electron's system-language list for native surfaces. Renderer localStorage is a synchronous
// first-paint cache and the historical source imported when settings.json has no locale field yet.
export type LocalePreferenceSnapshot = {
  preference: LanguagePreference
  locale: Locale
}

export type InitializeLocalePreferenceRequest = {
  cachedPreference: LanguagePreference
}

export type SetLocalePreferenceRequest = {
  preference: LanguagePreference
}

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

export const isLanguagePreference = (value: unknown): value is LanguagePreference =>
  typeof value === 'string' && (LANGUAGE_PREFERENCES as readonly string[]).includes(value)

// Regions written in Simplified script; everything else Chinese falls back to Simplified, which is
// the larger population and matches what Windows/macOS do for a bare 'zh'.
const SIMPLIFIED_REGIONS = new Set(['cn', 'sg', 'my'])
// Regions written in Traditional script.
const TRADITIONAL_REGIONS = new Set(['tw', 'hk', 'mo'])

// Maps one language tag onto a supported locale, or undefined when it isn't supported.
// Handles the three shapes seen in the wild: an explicit script subtag ('zh-Hant-HK'), a region that
// implies a script ('zh-TW'), and the legacy Windows two-letter forms ('zh-CHS' / 'zh-CHT').
const matchTag = (tag: string): Locale | undefined => {
  const parts = tag.toLowerCase().split(/[-_]/)
  const [language, ...rest] = parts

  if (language === 'en') return 'en'
  if (language === 'fr') return 'fr'
  if (language === 'ja') return 'ja'
  if (language === 'ko') return 'ko'
  if (language !== 'zh') return undefined

  if (rest.includes('hant') || rest.includes('cht')) return 'zh-Hant'
  if (rest.includes('hans') || rest.includes('chs')) return 'zh-Hans'
  if (rest.some((part) => TRADITIONAL_REGIONS.has(part))) return 'zh-Hant'
  if (rest.some((part) => SIMPLIFIED_REGIONS.has(part))) return 'zh-Hans'

  // Bare 'zh' with no script or region.
  return 'zh-Hans'
}

// Resolves a *prioritized* list of host language tags to the locale to use, walking the list in
// order so a user whose languages are ['de', 'zh-CN', 'en'] lands on zh-Hans rather than skipping
// straight to the default. This is standard BCP-47 lookup behavior, and the reason we read the whole
// list instead of only navigator.language. Falls back to English when nothing matches.
export const resolveLocaleFromTags = (tags: readonly string[]): Locale => {
  for (const tag of tags) {
    const matched = matchTag(tag)
    if (matched) return matched
  }

  return DEFAULT_LOCALE
}

// Resolves a stored preference against the host language list. 'system' consults the list; an
// explicit locale is returned as-is.
export const resolveLocale = (
  preference: LanguagePreference,
  systemTags: readonly string[]
): Locale => (preference === 'system' ? resolveLocaleFromTags(systemTags) : preference)

// The value for <html lang>. Our locale identifiers are already valid BCP-47 tags, so this is
// identity today; it exists so callers don't hardcode the assumption.
export const htmlLang = (locale: Locale): string => locale
