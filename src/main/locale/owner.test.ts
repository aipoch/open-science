import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { common as frCommon } from '../../shared/i18n/locales/fr.json'
import { SettingsRepository } from '../settings/repository'
import { LocalePreferenceOwner } from './owner'
import { translateNativeMessage } from './main-process-messages'
import { nativeCatalogs } from './resources'

const roots: string[] = []

const createRepository = async (): Promise<SettingsRepository> => {
  const root = await mkdtemp(join(tmpdir(), 'locale-preference-owner-'))
  roots.push(root)
  return new SettingsRepository(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LocalePreferenceOwner', () => {
  it('creates isolated native i18next instances with CLDR plurals and direct English fallback', async () => {
    const messages =
      (await import('./main-process-messages')) as typeof import('./main-process-messages') & {
        createNativeI18n?: (locale: 'en' | 'es' | 'fr' | 'ru' | 'zh-Hans') => {
          t: (key: string, options?: Record<string, string | number>) => string
        }
      }

    expect(messages.createNativeI18n).toBeTypeOf('function')
    if (!messages.createNativeI18n) return

    const english = messages.createNativeI18n('en')
    const spanish = messages.createNativeI18n('es')
    const french = messages.createNativeI18n('fr')
    const russian = messages.createNativeI18n('ru')
    const simplifiedChinese = messages.createNativeI18n('zh-Hans')
    const key = '{{count}} notebooks already exist in the chosen directory.'
    const options = (count: number): { count: number; defaultValue_one: string } => ({
      count,
      defaultValue_one: '{{count}} notebook already exists in the chosen directory.'
    })

    expect(english).not.toBe(russian)
    expect([1, 2].map((count) => english.t(key, options(count)))).toEqual([
      '1 notebook already exists in the chosen directory.',
      '2 notebooks already exist in the chosen directory.'
    ])
    expect([1, 2, 5, 21].map((count) => russian.t(key, options(count)))).toEqual([
      'В выбранной папке уже существует 1 Notebook.',
      'В выбранной папке уже существуют 2 Notebook.',
      'В выбранной папке уже существуют 5 Notebook.',
      'В выбранной папке уже существует 21 Notebook.'
    ])
    expect([1, 2, 1_000_000].map((count) => french.t(key, options(count)))).toEqual([
      'Le dossier choisi contient déjà 1 Notebook.',
      'Le dossier choisi contient déjà 2 Notebooks.',
      'Le dossier choisi contient déjà 1000000 Notebooks.'
    ])
    expect([1, 2, 1_000_000].map((count) => spanish.t(key, options(count)))).toEqual([
      'Ya existe 1 Notebook en el directorio elegido.',
      'Ya existen 2 Notebooks en el directorio elegido.',
      'Ya existen 1000000 Notebooks en el directorio elegido.'
    ])
    expect([1, 2].map((count) => simplifiedChinese.t(key, options(count)))).toEqual([
      '所选目录中已存在 1 个 Notebook。',
      '所选目录中已存在 2 个 Notebook。'
    ])
    expect(
      french.t('Missing native translation for {{name}}.', {
        name: 'Ada'
      })
    ).toBe('Missing native translation for Ada.')

    const missingCountKey = '{{count}} missing native translations'
    const missingCountOptions = (count: number): { count: number; defaultValue_one: string } => ({
      count,
      defaultValue_one: '{{count}} missing native translation'
    })
    expect(french.t(missingCountKey, missingCountOptions(0))).toBe('0 missing native translations')
    expect(russian.t(missingCountKey, missingCountOptions(21))).toBe(
      '21 missing native translations'
    )
  })

  it('persists a changed preference and notifies consumers only after commit', async () => {
    const repository = await createRepository()
    const owner = new LocalePreferenceOwner(['ja-JP', 'en-US'], repository)
    const listener = vi.fn()
    owner.subscribe(listener)

    expect(owner.snapshot()).toEqual({ preference: 'system', locale: 'ja' })
    await expect(owner.setPreference('zh-Hant')).resolves.toEqual({
      preference: 'zh-Hant',
      locale: 'zh-Hant'
    })
    await expect(repository.getSettings()).resolves.toMatchObject({
      localePreference: 'zh-Hant'
    })
    expect(listener).toHaveBeenCalledWith({ preference: 'zh-Hant', locale: 'zh-Hant' })

    listener.mockClear()
    await owner.setPreference('zh-Hant')
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps a committed preference successful when a listener throws', async () => {
    const repository = await createRepository()
    const owner = new LocalePreferenceOwner(['en-US'], repository)
    owner.subscribe(() => {
      throw new Error('renderer broadcast failed')
    })

    await expect(owner.setPreference('ja')).resolves.toEqual({
      preference: 'ja',
      locale: 'ja'
    })
    await expect(repository.getSettings()).resolves.toMatchObject({ localePreference: 'ja' })
  })

  it('imports the historical renderer cache only when settings has no locale', async () => {
    const repository = await createRepository()
    const owner = new LocalePreferenceOwner(['en-US'], repository)

    await expect(owner.initialize('ja')).resolves.toEqual({ preference: 'ja', locale: 'ja' })
    await expect(repository.getSettings()).resolves.toMatchObject({ localePreference: 'ja' })

    const reloaded = new LocalePreferenceOwner(['en-US'], repository, 'ja')
    await expect(reloaded.initialize('zh-Hant')).resolves.toEqual({
      preference: 'ja',
      locale: 'ja'
    })
    await expect(repository.getSettings()).resolves.toMatchObject({ localePreference: 'ja' })
  })

  it('rejects invalid renderer input and translates native messages with interpolation', async () => {
    const owner = new LocalePreferenceOwner(['en-US'], await createRepository())

    expect(() => owner.setPreference('de')).toThrow('Invalid language preference')
    expect(translateNativeMessage('ja', 'Quit', { context: 'verb' })).toBe('終了')
    expect(translateNativeMessage('ko', 'Quit', { context: 'verb' })).toBe('종료')
    expect(translateNativeMessage('ru', 'Quit', { context: 'verb' })).toBe('Выйти')
    expect(translateNativeMessage('fr', 'Quit', { context: 'verb' })).toBe('Quitter')
    expect(translateNativeMessage('es', 'Quit', { context: 'verb' })).toBe('Salir')
    expect(
      translateNativeMessage(
        'zh-Hans',
        '{{count}} notebooks already exist in the chosen directory.',
        {
          count: 3
        }
      )
    ).toContain('3')
    expect(
      [1, 2, 5, 21].map((count) =>
        translateNativeMessage('ru', '{{count}} notebooks already exist in the chosen directory.', {
          count
        })
      )
    ).toEqual([
      'В выбранной папке уже существует 1 Notebook.',
      'В выбранной папке уже существуют 2 Notebook.',
      'В выбранной папке уже существуют 5 Notebook.',
      'В выбранной папке уже существует 21 Notebook.'
    ])
  })

  it('updates native translations before a preference change resolves', async () => {
    const owner = new LocalePreferenceOwner(['en-US'], await createRepository())

    expect(owner.t('Quit', { context: 'verb' })).toBe('Quit')
    await owner.setPreference('ru')
    expect(owner.t('Quit', { context: 'verb' })).toBe('Выйти')
    await owner.setPreference('fr')
    expect(owner.t('Quit', { context: 'verb' })).toBe('Quitter')
    await owner.setPreference('es')
    expect(owner.t('Quit', { context: 'verb' })).toBe('Salir')
  })

  it('keeps French high punctuation attached to the preceding text', () => {
    const keys = [...Object.keys(frCommon), ...Object.keys(nativeCatalogs.fr)].map(
      (key) => key.split('_')[0]
    )
    const offenders = keys.filter((key) => / [;:?!]/.test(translateNativeMessage('fr', key)))

    expect(offenders).toEqual([])
  })
})
