import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LANGUAGE_PREFERENCE,
  DEFAULT_LOCALE,
  htmlLang,
  isLanguagePreference,
  isLocale,
  normalizeLanguagePreference,
  resolveLocale,
  resolveLocaleFromTags
} from './locale'

describe('resolveLocaleFromTags', () => {
  it('matches German and its regional tags', () => {
    expect(resolveLocaleFromTags(['de'])).toBe('de')
    expect(resolveLocaleFromTags(['de-DE'])).toBe('de')
    expect(resolveLocaleFromTags(['DE_at'])).toBe('de')
  })

  it('matches Korean and its regional tags', () => {
    expect(resolveLocaleFromTags(['ko'])).toBe('ko')
    expect(resolveLocaleFromTags(['ko-KR'])).toBe('ko')
    expect(resolveLocaleFromTags(['KO_kr'])).toBe('ko')
  })

  it('matches Russian and its regional tags', () => {
    expect(resolveLocaleFromTags(['ru'])).toBe('ru')
    expect(resolveLocaleFromTags(['ru-RU'])).toBe('ru')
    expect(resolveLocaleFromTags(['RU_ru'])).toBe('ru')
  })

  it('matches French and its regional tags', () => {
    expect(resolveLocaleFromTags(['fr'])).toBe('fr')
    expect(resolveLocaleFromTags(['fr-FR'])).toBe('fr')
    expect(resolveLocaleFromTags(['FR_ca'])).toBe('fr')
  })

  it('matches Brazilian Portuguese without claiming European Portuguese', () => {
    expect(resolveLocaleFromTags(['pt'])).toBe('pt-BR')
    expect(resolveLocaleFromTags(['pt-BR'])).toBe('pt-BR')
    expect(resolveLocaleFromTags(['PT_br'])).toBe('pt-BR')
    expect(resolveLocaleFromTags(['pt-PT'])).toBe('en')
    expect(resolveLocaleFromTags(['pt-PT', 'fr-FR'])).toBe('fr')
  })

  it('matches Spanish and its regional tags', () => {
    expect(resolveLocaleFromTags(['es'])).toBe('es')
    expect(resolveLocaleFromTags(['es-ES'])).toBe('es')
    expect(resolveLocaleFromTags(['ES_mx'])).toBe('es')
  })

  it('matches Japanese and its regional tags', () => {
    expect(resolveLocaleFromTags(['ja'])).toBe('ja')
    expect(resolveLocaleFromTags(['ja-JP'])).toBe('ja')
    expect(resolveLocaleFromTags(['JA_jp'])).toBe('ja')
  })

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
    expect(resolveLocaleFromTags(['it', 'zh-CN', 'en'])).toBe('zh-Hans')
    expect(resolveLocaleFromTags(['vi-VN', 'it', 'zh-TW'])).toBe('zh-Hant')
  })

  it('honors list order between two supported tags', () => {
    expect(resolveLocaleFromTags(['zh-TW', 'en'])).toBe('zh-Hant')
    expect(resolveLocaleFromTags(['en', 'zh-TW'])).toBe('en')
  })

  it('falls back to English when nothing matches', () => {
    expect(resolveLocaleFromTags(['vi', 'it-IT'])).toBe('en')
    expect(resolveLocaleFromTags([])).toBe('en')
    expect(resolveLocaleFromTags([''])).toBe('en')
  })
})

describe('resolveLocale', () => {
  it('consults the host list for the system preference', () => {
    expect(resolveLocale('system', ['zh-TW'])).toBe('zh-Hant')
    expect(resolveLocale('system', ['ja-JP'])).toBe('ja')
    expect(resolveLocale('system', ['ko-KR'])).toBe('ko')
    expect(resolveLocale('system', ['ru-RU'])).toBe('ru')
    expect(resolveLocale('system', ['fr-CA'])).toBe('fr')
    expect(resolveLocale('system', ['pt-BR'])).toBe('pt-BR')
    expect(resolveLocale('system', ['de-CH'])).toBe('de')
    expect(resolveLocale('system', ['es-MX'])).toBe('es')
  })

  it('returns an explicit preference verbatim, ignoring the host list', () => {
    expect(resolveLocale('en', ['zh-TW'])).toBe('en')
    expect(resolveLocale('fr', ['en-US'])).toBe('fr')
    expect(resolveLocale('pt-BR', ['en-US'])).toBe('pt-BR')
    expect(resolveLocale('de', ['en-US'])).toBe('de')
    expect(resolveLocale('ja', ['en-US'])).toBe('ja')
    expect(resolveLocale('ko', ['en-US'])).toBe('ko')
    expect(resolveLocale('ru', ['en-US'])).toBe('ru')
    expect(resolveLocale('es', ['en-US'])).toBe('es')
    expect(resolveLocale('zh-Hant', ['en-US'])).toBe('zh-Hant')
    expect(resolveLocale('zh-Hans', [])).toBe('zh-Hans')
  })
})

describe('guards and constants', () => {
  it('recognizes locales and preferences', () => {
    expect(isLocale('zh-Hans')).toBe(true)
    expect(isLocale('ja')).toBe(true)
    expect(isLocale('ko')).toBe(true)
    expect(isLocale('ru')).toBe(true)
    expect(isLocale('fr')).toBe(true)
    expect(isLocale('pt-BR')).toBe(true)
    expect(isLocale('pt')).toBe(false)
    expect(isLocale('de')).toBe(true)
    expect(isLocale('es')).toBe(true)
    expect(isLocale('zh-CN')).toBe(false)
    expect(isLocale('system')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(isLanguagePreference('system')).toBe(true)
    expect(isLanguagePreference('zh-Hant')).toBe(true)
    expect(isLanguagePreference('ja')).toBe(true)
    expect(isLanguagePreference('ko')).toBe(true)
    expect(isLanguagePreference('ru')).toBe(true)
    expect(isLanguagePreference('fr')).toBe(true)
    expect(isLanguagePreference('pt-BR')).toBe(true)
    expect(isLanguagePreference('pt')).toBe(false)
    expect(isLanguagePreference('de')).toBe(true)
    expect(isLanguagePreference('es')).toBe(true)
  })

  it('normalizes the legacy Portuguese preference on persisted-data boundaries', () => {
    expect(normalizeLanguagePreference('pt')).toBe('pt-BR')
    expect(normalizeLanguagePreference('pt-BR')).toBe('pt-BR')
    expect(normalizeLanguagePreference('system')).toBe('system')
    expect(normalizeLanguagePreference('pt-PT')).toBeUndefined()
    expect(normalizeLanguagePreference(undefined)).toBeUndefined()
  })

  it('defaults to system with an English fallback', () => {
    expect(DEFAULT_LANGUAGE_PREFERENCE).toBe('system')
    expect(DEFAULT_LOCALE).toBe('en')
  })

  it('emits valid BCP-47 html lang values', () => {
    expect(htmlLang('en')).toBe('en')
    expect(htmlLang('fr')).toBe('fr')
    expect(htmlLang('pt-BR')).toBe('pt-BR')
    expect(htmlLang('de')).toBe('de')
    expect(htmlLang('es')).toBe('es')
    expect(htmlLang('ja')).toBe('ja')
    expect(htmlLang('ko')).toBe('ko')
    expect(htmlLang('ru')).toBe('ru')
    expect(htmlLang('zh-Hans')).toBe('zh-Hans')
    expect(htmlLang('zh-Hant')).toBe('zh-Hant')
  })
})
