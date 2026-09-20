import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})

beforeEach(() => {
  vi.resetModules()
  vi.mocked(readFileSync).mockClear()
})

it('reads no catalogs for English and loads only the selected and switched languages', async () => {
  const { createNativeI18n } = await import('./main-process-messages')
  const instance = createNativeI18n('en')
  expect(instance.t('Quit', { context: 'verb' })).toBe('Quit')
  expect(readFileSync).not.toHaveBeenCalled()

  await instance.changeLanguage('ru')
  expect(instance.t('Quit', { context: 'verb' })).toBe('Выйти')
  expect(readFileSync).toHaveBeenCalledTimes(1)
  expect(Object.keys(instance.store.data).sort()).toEqual(['en', 'ru'])

  await instance.changeLanguage('fr')
  expect(instance.t('Quit', { context: 'verb' })).toBe('Quitter')
  expect(readFileSync).toHaveBeenCalledTimes(2)
  await instance.changeLanguage('ru')
  const other = createNativeI18n('ru')
  expect(other.t('Quit', { context: 'verb' })).toBe('Выйти')
  expect(readFileSync).toHaveBeenCalledTimes(2)
})

it('makes a persisted non-English language available synchronously on first use', async () => {
  const { createNativeI18n } = await import('./main-process-messages')
  const instance = createNativeI18n('ja')
  expect(instance.isInitialized).toBe(true)
  expect(instance.t('Quit', { context: 'verb' })).toBe('終了')
  expect(readFileSync).toHaveBeenCalledTimes(1)
  expect(Object.keys(instance.store.data).sort()).toEqual(['en', 'ja'])
})

it('does not cache a failed file read and permits a fresh instance to retry', async () => {
  const { createNativeI18n } = await import('./main-process-messages')
  vi.mocked(readFileSync).mockImplementationOnce(() => {
    throw new Error('missing catalog')
  })
  expect(() => createNativeI18n('de')).toThrow('missing catalog')
  expect(createNativeI18n('de').t('Quit', { context: 'verb' })).toBe('Beenden')
})

it('leaves the persisted preference and listeners unchanged when the target catalog is missing', async () => {
  const { LocalePreferenceOwner } = await import('./owner')
  const setLocalePreference = vi.fn(async () => {})
  const owner = new LocalePreferenceOwner(
    ['en-US'],
    { setLocalePreference } as unknown as import('../settings/repository').SettingsRepository,
    'en'
  )
  const listener = vi.fn()
  owner.subscribe(listener)
  vi.mocked(readFileSync).mockImplementationOnce(() => {
    throw new Error('missing catalog')
  })
  await expect(owner.setPreference('ru')).rejects.toThrow('missing catalog')
  expect(setLocalePreference).not.toHaveBeenCalled()
  expect(listener).not.toHaveBeenCalled()
  expect(owner.snapshot()).toEqual({ preference: 'en', locale: 'en' })
  await owner.setPreference('ru')
  expect(owner.t('Quit', { context: 'verb' })).toBe('Выйти')
  expect(setLocalePreference).toHaveBeenCalledOnce()
})
