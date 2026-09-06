// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguagePreferenceMenu, LanguageSelect } from '@/components/LanguageControls'
import { i18next, setI18nLocale } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { LocalePreferenceOwner } from '../../../main/locale/owner'
import { SettingsRepository } from '../../../main/settings/repository'
import type { LanguagePreference, LocalePreferenceSnapshot } from '../../../shared/locale'
import { startLocalePreferenceSync, useLocaleStore } from './locale-store'

let directory: string
let repository: SettingsRepository
let owner: LocalePreferenceOwner
let stop: (() => void) | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'locale-recovery-'))
  repository = new SettingsRepository(directory)
  await repository.setLocalePreference('en')
  owner = new LocalePreferenceOwner(['en-US'], repository, 'en')
  localStorage.clear()
  localStorage.setItem('open-science-language', 'en')
  document.documentElement.lang = 'en'
  setI18nLocale('en')
  useLocaleStore.setState({ preference: 'en', locale: 'en', saveFailed: false })
  useSettingsStore.setState({ isSettingsOpen: false })
  vi.stubGlobal('api', {
    locale: {
      initialize: ({ cachedPreference }: { cachedPreference: LanguagePreference }) =>
        owner.initialize(cachedPreference),
      setPreference: ({ preference }: { preference: LanguagePreference }) =>
        owner.setPreference(preference),
      onChanged: (listener: (snapshot: LocalePreferenceSnapshot) => void) =>
        owner.subscribe(listener)
    }
  })
})

afterEach(async () => {
  stop?.()
  stop = undefined
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  setI18nLocale('en')
  await rm(directory, { recursive: true, force: true })
})

const projection = (): Record<string, unknown> => ({
  main: owner.snapshot(),
  renderer: {
    preference: useLocaleStore.getState().preference,
    locale: useLocaleStore.getState().locale
  },
  cache: localStorage.getItem('open-science-language'),
  html: document.documentElement.lang,
  i18next: i18next.language
})

const settle = async (): Promise<void> => {
  // The owner queue is the public barrier for repository completion, followed by IPC continuations.
  await owner.initialize('en')
  await Promise.resolve()
  await Promise.resolve()
}

describe('G01 desktop locale persistence recovery', () => {
  it.each([LanguageSelect, LanguagePreferenceMenu])(
    'restores the confirmed language and exposes the failure at %s',
    async (Control) => {
      stop = startLocalePreferenceSync()
      await settle()
      const view = render(<Control />)
      vi.spyOn(repository, 'setLocalePreference').mockRejectedValue(
        new Error('settings write rejected')
      )

      await act(async () => {
        useLocaleStore.getState().setPreference('ja')
        await settle()
      })

      expect.soft(projection()).toEqual({
        main: { preference: 'en', locale: 'en' },
        renderer: { preference: 'en', locale: 'en' },
        cache: 'en',
        html: 'en',
        i18next: 'en'
      })
      if (Control === LanguageSelect)
        expect.soft(view.getByRole('combobox').textContent).toBe('English')
      else expect.soft(view.queryByRole('button', { name: 'Language: English' })).not.toBeNull()
      expect.soft(view.queryByRole('alert')).not.toBeNull()
      expect((await repository.getSettings()).localePreference).toBe('en')
    }
  )

  it.each(['ja', 'fr'] as const)(
    'does not let an older failure overwrite a newer successful %s selection',
    async (newer) => {
      let deliverFailure: (() => void) | undefined
      const nativeSet = window.api.locale.setPreference
      vi.spyOn(repository, 'setLocalePreference').mockRejectedValueOnce(
        new Error('first write rejected')
      )
      window.api.locale.setPreference = ({ preference }) =>
        new Promise((resolve, reject) => {
          void nativeSet({ preference }).then(resolve, (error) => {
            deliverFailure = () => reject(error)
          })
        })
      stop = startLocalePreferenceSync()
      await settle()
      const view = render(<LanguageSelect />)

      await act(async () => {
        useLocaleStore.getState().setPreference('ja')
        await settle()
        useLocaleStore.getState().setPreference(newer)
        await settle()
        expect(deliverFailure).toBeTypeOf('function')
        deliverFailure?.()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(projection()).toEqual({
        main: { preference: newer, locale: newer },
        renderer: { preference: newer, locale: newer },
        cache: newer,
        html: newer,
        i18next: newer
      })
      expect(view.queryByRole('alert')).toBeNull()
    }
  )
})

describe('G02 browser locale storage synchronization', () => {
  it.each(['ja', 'system', 'invalid', null])(
    'applies another tab’s %s preference without writing it back',
    async (value) => {
      vi.stubGlobal('api', {})
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR'])
      stop = startLocalePreferenceSync()
      const view = render(<LanguageSelect />)
      const write = vi.spyOn(localStorage, 'setItem')
      if (value === null) localStorage.removeItem('open-science-language')
      else localStorage.setItem('open-science-language', value)
      write.mockClear()

      await act(async () => {
        window.dispatchEvent(
          Object.defineProperty(
            new StorageEvent('storage', {
              key: 'open-science-language',
              newValue: value
            }),
            'storageArea',
            { value: localStorage }
          )
        )
      })

      const preference = value === 'ja' ? 'ja' : 'system'
      const locale = value === 'ja' ? 'ja' : 'fr'
      expect.soft(useLocaleStore.getState()).toMatchObject({ preference, locale })
      expect.soft(document.documentElement.lang).toBe(locale)
      expect.soft(i18next.language).toBe(locale)
      expect
        .soft(view.getByRole('combobox').textContent)
        .toBe(value === 'ja' ? '日本語' : 'Langue du système')
      expect(write).not.toHaveBeenCalled()
    }
  )

  it('keeps desktop language under Main authority when its cache changes', async () => {
    stop = startLocalePreferenceSync()
    await settle()
    localStorage.setItem('open-science-language', 'ja')
    window.dispatchEvent(
      Object.defineProperty(
        new StorageEvent('storage', {
          key: 'open-science-language',
          newValue: 'ja'
        }),
        'storageArea',
        { value: localStorage }
      )
    )
    expect(useLocaleStore.getState()).toMatchObject({ preference: 'en', locale: 'en' })
    expect(i18next.language).toBe('en')
  })
})

describe('locale synchronization lifecycle', () => {
  it('shows only the Settings error when the Home control remains mounted behind Settings', () => {
    useSettingsStore.setState({ isSettingsOpen: true })
    useLocaleStore.setState({ saveFailed: true })
    const view = render(
      <>
        <LanguagePreferenceMenu />
        <LanguageSelect />
      </>
    )
    expect(view.getAllByRole('alert')).toHaveLength(1)
  })

  it('removes browser listeners and ignores unrelated keys and session storage', () => {
    vi.stubGlobal('api', {})
    stop = startLocalePreferenceSync()
    localStorage.setItem('open-science-language', 'ja')
    const emit = (key: string | null, storage: Storage): void => {
      window.dispatchEvent(
        Object.defineProperty(new StorageEvent('storage', { key }), 'storageArea', {
          value: storage
        })
      )
    }
    emit('unrelated', localStorage)
    emit('open-science-language', sessionStorage)
    expect(useLocaleStore.getState().locale).toBe('en')
    stop()
    emit('open-science-language', localStorage)
    expect(useLocaleStore.getState().locale).toBe('en')
    stop = startLocalePreferenceSync()
    localStorage.clear()
    emit(null, localStorage)
    expect(useLocaleStore.getState().preference).toBe('system')
  })

  it('ignores a startup response after its subscription is stopped', async () => {
    let resolve: ((snapshot: LocalePreferenceSnapshot) => void) | undefined
    window.api.locale.initialize = () =>
      new Promise((done) => {
        resolve = done
      })
    stop = startLocalePreferenceSync()
    stop()
    resolve?.({ preference: 'ja', locale: 'ja' })
    await Promise.resolve()
    expect(useLocaleStore.getState().locale).toBe('en')
  })

  it('keeps the newer preview during an intermediate commit and rolls back to that commit on failure', async () => {
    stop = startLocalePreferenceSync()
    await settle()
    let rejectWrite: ((error: Error) => void) | undefined
    const persist = repository.setLocalePreference.bind(repository)
    vi.spyOn(repository, 'setLocalePreference')
      .mockImplementationOnce(persist)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectWrite = reject
          })
      )
    useLocaleStore.getState().setPreference('ja')
    useLocaleStore.getState().setPreference('fr')
    await vi.waitFor(() => expect(rejectWrite).toBeTypeOf('function'))
    expect(owner.snapshot().locale).toBe('ja')
    expect(useLocaleStore.getState().locale).toBe('fr')
    rejectWrite?.(new Error('second write rejected'))
    await settle()
    expect(projection()).toEqual({
      main: { preference: 'ja', locale: 'ja' },
      renderer: { preference: 'ja', locale: 'ja' },
      cache: 'ja',
      html: 'ja',
      i18next: 'ja'
    })
    expect(useLocaleStore.getState().saveFailed).toBe(true)
  })
})
