import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LANGUAGE_PREFERENCE,
  DEFAULT_LOCALE,
  htmlLang,
  isLanguagePreference,
  isLocale,
  resolveLocale,
  resolveLocaleFromTags
} from './locale'

describe('resolveLocaleFromTags', () => {
  it('matches English', () => {
    expect(resolveLocaleFromTags(['en'])).toBe('en')
    expect(resolveLocaleFromTags(['en-US'])).toBe('en')
    expect(resolveLocaleFromTags(['en-GB'])).toBe('en')
  })

  it('reads an explicit script subtag ahead of the region', () => {
    // zh-Hant-HK and zh-Hans-HK share a region but not a script; the script must win.
    expect(resolveLocaleFromTags(['zh-Hant-HK'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['zh-Hans-HK'])).toBe('zh-Hans')
    expect(resolveLocaleFromTags(['zh-Hant'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['zh-Hans'])).toBe('zh-Hans')
  })

  it('infers the script from the region when no script subtag is present', () => {
    expect(resolveLocaleFromTags(['zh-CN'])).toBe('zh-Hans')
    expect(resolveLocaleFromTags(['zh-SG'])).toBe('zh-Hans')
    expect(resolveLocaleFromTags(['zh-MY'])).toBe('zh-Hans')
    expect(resolveLocaleFromTags(['zh-TW'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['zh-HK'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['zh-MO'])).toBe('zh-Hant')
  })

  it('treats a bare zh as Simplified', () => {
    expect(resolveLocaleFromTags(['zh'])).toBe('zh-Hans')
  })

  it('accepts the legacy Windows CHS/CHT forms', () => {
    expect(resolveLocaleFromTags(['zh-CHS'])).toBe('zh-Hans')
    expect(resolveLocaleFromTags(['zh-CHT'])).toBe('zh-Hant')
  })

  it('is case- and separator-insensitive', () => {
    expect(resolveLocaleFromTags(['ZH_TW'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['zh_hant'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['EN-us'])).toBe('en')
  })

  it('walks the whole list so an unsupported first entry does not shadow a supported later one', () => {
    // The bug this guards: reading only navigator.language would return 'en' here, not zh-Hans.
    expect(resolveLocaleFromTags(['ja', 'zh-CN', 'en'])).toBe('zh-Hans')
    expect(resolveLocaleFromTags(['ko-KR', 'de', 'zh-TW'])).toBe('zh-Hant')
  })

  it('honors list order between two supported tags', () => {
    expect(resolveLocaleFromTags(['zh-TW', 'en'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['en', 'zh-TW'])).toBe('en')
  })

  it('falls back to English when nothing matches', () => {
    expect(resolveLocaleFromTags(['ja', 'ko', 'de-DE'])).toBe('en')
    expect(resolveLocaleFromTags([])).toBe('en')
    expect(resolveLocaleFromTags([''])).toBe('en')
  })
})

describe('resolveLocale', () => {
  it('consults the host list for the system preference', () => {
    expect(resolveLocale('system', ['zh-TW'])).toBe('zh-Hant')
    expect(resolveLocale('system', ['ja'])).toBe('en')
  })

  it('returns an explicit preference verbatim, ignoring the host list', () => {
    expect(resolveLocale('en', ['zh-TW'])).toBe('en')
    expect(resolveLocale('zh-Hant', ['en-US'])).toBe('zh-Hant')
    expect(resolveLocale('zh-Hans', [])).toBe('zh-Hans')
  })
})

describe('guards and constants', () => {
  it('recognizes locales and preferences', () => {
    expect(isLocale('zh-Hans')).toBe(true)
    expect(isLocale('zh-CN')).toBe(false)
    expect(isLocale('system')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(isLanguagePreference('system')).toBe(true)
    expect(isLanguagePreference('zh-Hant')).toBe(true)
    expect(isLanguagePreference('fr')).toBe(false)
  })

  it('defaults to system with an English fallback', () => {
    expect(DEFAULT_LANGUAGE_PREFERENCE).toBe('system')
    expect(DEFAULT_LOCALE).toBe('en')
  })

  it('emits valid BCP-47 html lang values', () => {
    expect(htmlLang('en')).toBe('en')
    expect(htmlLang('zh-Hans')).toBe('zh-Hans')
    expect(htmlLang('zh-Hant')).toBe('zh-Hant')
  })
})
