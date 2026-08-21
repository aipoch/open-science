import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsRepository } from '../settings/repository'
import { LocalePreferenceOwner } from './owner'
import { englishMessages, translateNativeMessage } from './main-process-messages'

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
    expect(translateNativeMessage('ja', 'Quit')).toBe('終了')
    expect(translateNativeMessage('ko', 'Quit')).toBe('종료')
    expect(translateNativeMessage('ru', 'Quit')).toBe('Выйти')
    expect(translateNativeMessage('fr', 'Quit')).toBe('Quitter')
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

  it('keeps French high punctuation attached to the preceding text', () => {
    const keys = Object.keys(englishMessages) as Array<keyof typeof englishMessages>
    const offenders = keys.filter((key) => / [;:?!]/.test(translateNativeMessage('fr', key)))

    expect(offenders).toEqual([])
  })
})
