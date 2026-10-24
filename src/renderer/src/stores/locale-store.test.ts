// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { setI18nLocale, prepareI18nLocale } = vi.hoisted(() => ({
  setI18nLocale: vi.fn(),
  prepareI18nLocale: vi.fn()
}))

vi.mock('@/i18n', () => ({ setI18nLocale, prepareI18nLocale }))

import type { RuntimeStartupState } from '../../../shared/runtime-startup'
import { startLocalePreferenceSync, useLocaleStore } from './locale-store'

describe('locale store desktop synchronization', () => {
  let changed:
    ((snapshot: { preference: 'system' | 'ja'; locale: 'en' | 'ja' }) => void) | undefined
  const initialize = vi.fn()
  const setPreference = vi.fn()
  const unsubscribe = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    setI18nLocale.mockClear()
    prepareI18nLocale.mockReset()
    initialize.mockReset()
    setPreference.mockReset()
    unsubscribe.mockClear()
    changed = undefined
    ;(window as unknown as { api: unknown }).api = {
      locale: {
        initialize,
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

  it.each(['idle', 'blocked', 'stopping', 'recovering'] as const)(
    'waits for runtime readiness while %s',
    async (phase) => {
      const state: RuntimeStartupState =
        phase === 'idle'
          ? { phase }
          : {
              phase,
              issue: {
                reason: 'startup-recovery-required',
                desktopVersion: '1',
                canStop: true,
                canRecover: false
              }
            }
      let publish!: (next: RuntimeStartupState) => void
      const detached = vi.fn()
      window.api.runtimeStartup = {
        getState: async () => state,
        onStateChanged: (listener) => {
          publish = listener
          return detached
        },
        stopAndContinue: vi.fn(),
        recover: vi.fn(),
        quit: vi.fn()
      }
      initialize.mockResolvedValue({ preference: 'ja', locale: 'ja' })
      const stop = startLocalePreferenceSync()
      await Promise.resolve()
      expect(initialize).not.toHaveBeenCalled()
      publish({ phase: 'ready' })
      await vi.waitFor(() => expect(useLocaleStore.getState().locale).toBe('ja'))
      publish({ phase: 'ready' })
      expect(initialize).toHaveBeenCalledOnce()
      stop()
      expect(detached).toHaveBeenCalledOnce()
    }
  )

  it('ignores a ready snapshot superseded by a blocked event and cleans pending reads on disposal', async () => {
    let publish!: (next: RuntimeStartupState) => void
    let resolve!: (next: RuntimeStartupState) => void
    const detached = vi.fn()
    window.api.runtimeStartup = {
      getState: () =>
        new Promise((done) => {
          resolve = done
        }),
      onStateChanged: (listener) => {
        publish = listener
        return detached
      },
      stopAndContinue: vi.fn(),
      recover: vi.fn(),
      quit: vi.fn()
    }
    initialize.mockResolvedValue({ preference: 'ja', locale: 'ja' })
    const stop = startLocalePreferenceSync()
    publish({
      phase: 'blocked',
      issue: {
        reason: 'startup-recovery-required',
        desktopVersion: '1',
        canStop: true,
        canRecover: false
      }
    })
    resolve({ phase: 'ready' })
    await Promise.resolve()
    expect(initialize).not.toHaveBeenCalled()
    stop()
    publish({ phase: 'ready' })
    expect(initialize).not.toHaveBeenCalled()
    expect(detached).toHaveBeenCalledOnce()
  })

  it('retries after startup-read failure and rejects locale replies from an interrupted initialization', async () => {
    let publish!: (next: RuntimeStartupState) => void
    let resolveOld!: (snapshot: { preference: 'ja'; locale: 'ja' }) => void
    window.api.runtimeStartup = {
      getState: async () => {
        throw new Error('startup unavailable')
      },
      onStateChanged: (listener) => {
        publish = listener
        return vi.fn()
      },
      stopAndContinue: vi.fn(),
      recover: vi.fn(),
      quit: vi.fn()
    }
    initialize
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveOld = done
          })
      )
      .mockResolvedValue({ preference: 'system', locale: 'en' })
    const stop = startLocalePreferenceSync()
    await Promise.resolve()
    expect(initialize).not.toHaveBeenCalled()
    publish({ phase: 'ready' })
    publish({
      phase: 'blocked',
      issue: {
        reason: 'startup-recovery-required',
        desktopVersion: '1',
        canStop: false,
        canRecover: true
      }
    })
    publish({ phase: 'ready' })
    await Promise.resolve()
    resolveOld({ preference: 'ja', locale: 'ja' })
    await Promise.resolve()
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(useLocaleStore.getState().locale).toBe('en')
    stop()
  })

  it('retains the current language and skips persistence when a catalog fails, then permits retry', async () => {
    prepareI18nLocale.mockRejectedValueOnce(new Error('chunk unavailable'))
    useLocaleStore.getState().setPreference('ja')
    await vi.waitFor(() => expect(useLocaleStore.getState().saveFailed).toBe(true))
    expect(useLocaleStore.getState().locale).toBe('en')
    expect(setPreference).not.toHaveBeenCalled()
    expect(localStorage.getItem('open-science-language')).not.toBe('ja')
    setPreference.mockResolvedValue({ preference: 'ja', locale: 'ja' })
    useLocaleStore.getState().setPreference('ja')
    await vi.waitFor(() => expect(useLocaleStore.getState().locale).toBe('ja'))
    expect(setPreference).toHaveBeenCalledTimes(1)
  })

  it('retries a failed readiness read on focus without requiring another state event', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ phase: 'ready' })
    window.api.runtimeStartup = {
      getState,
      onStateChanged: () => vi.fn(),
      stopAndContinue: vi.fn(),
      recover: vi.fn(),
      quit: vi.fn()
    }
    initialize.mockResolvedValue({ preference: 'ja', locale: 'ja' })
    const stop = startLocalePreferenceSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getState).toHaveBeenCalledOnce()
    expect(initialize).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('focus'))
    expect(getState).toHaveBeenCalledTimes(2)
    stop()
    window.dispatchEvent(new Event('focus'))
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it('does not commit a slower catalog after a newer selection', async () => {
    let finish!: () => void
    prepareI18nLocale.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    setPreference.mockResolvedValue({ preference: 'fr', locale: 'fr' })
    useLocaleStore.getState().setPreference('ja')
    expect(setPreference).not.toHaveBeenCalled()
    useLocaleStore.getState().setPreference('fr')
    finish()
    await vi.waitFor(() => expect(useLocaleStore.getState().locale).toBe('fr'))
    expect(setPreference).toHaveBeenCalledExactlyOnceWith({ preference: 'fr' })
  })

  it('ignores late catalog completion after a newer broadcast or unsubscribe', async () => {
    initialize.mockReturnValue(new Promise(() => {}))
    const stop = startLocalePreferenceSync()
    let finish!: () => void
    prepareI18nLocale.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    changed?.({ preference: 'ja', locale: 'ja' })
    changed?.({ preference: 'system', locale: 'en' })
    finish()
    await Promise.resolve()
    expect(useLocaleStore.getState().locale).toBe('en')
    prepareI18nLocale.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    changed?.({ preference: 'ja', locale: 'ja' })
    stop()
    finish()
    await Promise.resolve()
    expect(useLocaleStore.getState().locale).toBe('en')
  })

  it('lets a newer browser storage event supersede a pending local catalog load', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    let finish!: () => void
    prepareI18nLocale.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const stop = startLocalePreferenceSync()
    useLocaleStore.getState().setPreference('ja')
    localStorage.setItem('open-science-language', 'fr')
    window.dispatchEvent(
      Object.defineProperty(
        new StorageEvent('storage', {
          key: 'open-science-language'
        }),
        'storageArea',
        { value: localStorage }
      )
    )
    finish()
    await Promise.resolve()
    expect(useLocaleStore.getState().locale).toBe('fr')
    expect(localStorage.getItem('open-science-language')).toBe('fr')
    stop()
  })

  it('loads the persisted main preference and refreshes the renderer cache', async () => {
    initialize.mockResolvedValue({ preference: 'ja', locale: 'ja' })

    const stop = startLocalePreferenceSync()

    expect(initialize).toHaveBeenCalledWith({ cachedPreference: 'system' })
    await vi.waitFor(() => expect(useLocaleStore.getState().locale).toBe('ja'))
    expect(document.documentElement.lang).toBe('ja')
    expect(localStorage.getItem('open-science-language')).toBe('ja')

    changed?.({ preference: 'ja', locale: 'ja' })
    expect(localStorage.getItem('open-science-language')).toBe('ja')

    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('updates the renderer immediately while synchronizing an explicit choice', () => {
    initialize.mockResolvedValue({ preference: 'system', locale: 'en' })
    setPreference.mockResolvedValue({ preference: 'ja', locale: 'ja' })

    useLocaleStore.getState().setPreference('ja')

    expect(useLocaleStore.getState()).toMatchObject({ preference: 'ja', locale: 'ja' })
    expect(localStorage.getItem('open-science-language')).toBe('ja')
    expect(setPreference).toHaveBeenCalledWith({ preference: 'ja' })
  })

  it('ignores a stale startup reply after the user chooses another locale', async () => {
    let resolveStartup: ((snapshot: { preference: 'system'; locale: 'en' }) => void) | undefined
    initialize.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStartup = resolve
        })
    )
    setPreference.mockResolvedValue({ preference: 'ja', locale: 'ja' })

    const stop = startLocalePreferenceSync()
    useLocaleStore.getState().setPreference('ja')
    resolveStartup?.({ preference: 'system', locale: 'en' })
    await Promise.resolve()

    expect(useLocaleStore.getState()).toMatchObject({ preference: 'ja', locale: 'ja' })
    stop()
  })
})
