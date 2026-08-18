// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { setI18nLocale } = vi.hoisted(() => ({ setI18nLocale: vi.fn() }))

vi.mock('@/i18n', () => ({ setI18nLocale }))

import { startLocalePreferenceSync, useLocaleStore } from './locale-store'

describe('locale store desktop synchronization', () => {
  let changed:
    ((snapshot: { preference: 'system' | 'ja'; locale: 'en' | 'ja' }) => void) | undefined
  const setPreference = vi.fn()
  const unsubscribe = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    setI18nLocale.mockClear()
    setPreference.mockReset()
    unsubscribe.mockClear()
    changed = undefined
    ;(window as unknown as { api: unknown }).api = {
      locale: {
        setPreference,
        onChanged: (listener: typeof changed) => {
          changed = listener
          return unsubscribe
        }
      }
    }
    useLocaleStore.setState({ preference: 'system', locale: 'en' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('projects the stored preference to main and applies its resolved locale', async () => {
    setPreference.mockResolvedValue({ preference: 'system', locale: 'ja' })

    const stop = startLocalePreferenceSync()

    expect(setPreference).toHaveBeenCalledWith({ preference: 'system' })
    await vi.waitFor(() => expect(useLocaleStore.getState().locale).toBe('ja'))
    expect(document.documentElement.lang).toBe('ja')

    changed?.({ preference: 'ja', locale: 'ja' })
    expect(localStorage.getItem('open-science-language')).toBe('ja')

    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('updates the renderer immediately while synchronizing an explicit choice', () => {
    setPreference.mockResolvedValue({ preference: 'ja', locale: 'ja' })

    useLocaleStore.getState().setPreference('ja')

    expect(useLocaleStore.getState()).toMatchObject({ preference: 'ja', locale: 'ja' })
    expect(localStorage.getItem('open-science-language')).toBe('ja')
    expect(setPreference).toHaveBeenCalledWith({ preference: 'ja' })
  })

  it('ignores a stale startup reply after the user chooses another locale', async () => {
    let resolveStartup: ((snapshot: { preference: 'system'; locale: 'en' }) => void) | undefined
    setPreference.mockImplementation(({ preference }: { preference: 'system' | 'ja' }) =>
      preference === 'system'
        ? new Promise((resolve) => {
            resolveStartup = resolve
          })
        : Promise.resolve({ preference: 'ja', locale: 'ja' })
    )

    const stop = startLocalePreferenceSync()
    useLocaleStore.getState().setPreference('ja')
    resolveStartup?.({ preference: 'system', locale: 'en' })
    await Promise.resolve()

    expect(useLocaleStore.getState()).toMatchObject({ preference: 'ja', locale: 'ja' })
    stop()
  })
})
