import { create } from 'zustand'

import { setI18nLocale, prepareI18nLocale } from '@/i18n'
import {
  applyHtmlLang,
  LANGUAGE_STORAGE_KEY,
  persistPreference,
  resolveLocalePreference,
  resolvePreference
} from '@/lib/locale-preference'
import type { RuntimeStartupState } from '../../../shared/runtime-startup'
import type { LanguagePreference, Locale, LocalePreferenceSnapshot } from '../../../shared/locale'

type LocaleStore = {
  preference: LanguagePreference
  locale: Locale
  saveFailed: boolean
  setPreference: (preference: LanguagePreference) => void
}

const initialPreference = resolvePreference()
let confirmed: LocalePreferenceSnapshot = {
  preference: initialPreference,
  locale: resolveLocalePreference(initialPreference)
}
let operation = 0
let confirmedOperation = 0
let pendingOperation: number | undefined
let broadcastVersion = 0
let applicationVersion = 0

export const useLocaleStore = create<LocaleStore>(() => ({
  ...confirmed,
  saveFailed: false,
  setPreference: (preference) => {
    const currentOperation = ++operation
    const versionAtStart = broadcastVersion
    const localeApi = window.api?.locale
    // Before desktop synchronization starts, retain the existing first-paint projection as fallback.
    if (pendingOperation === undefined && !stopLocalePreferenceSync) {
      const state = useLocaleStore.getState()
      confirmed = { preference: state.preference, locale: state.locale }
    }
    applicationVersion += 1
    useLocaleStore.setState({ saveFailed: false })
    pendingOperation = currentOperation
    void (async () => {
      try {
        const locale = resolveLocalePreference(preference)
        const preparing = prepareI18nLocale(locale)
        if (preparing) await preparing
        if (currentOperation !== operation) return
        applyLocaleSnapshot({ preference, locale })
        if (!localeApi) {
          confirmed = { preference, locale }
          return
        }
        const snapshot = await localeApi.setPreference({ preference })
        // Broadcasts are delivered in Main commit order. A delayed command reply must not replace
        // a newer broadcast or successful command, even when the user picks the same value again.
        if (versionAtStart === broadcastVersion && currentOperation > confirmedOperation) {
          confirmed = snapshot
          confirmedOperation = currentOperation
        }
        if (currentOperation === operation) applyLocaleSnapshot(confirmed)
      } catch {
        if (currentOperation === operation) {
          applyLocaleSnapshot(confirmed)
          useLocaleStore.setState({ saveFailed: true })
        }
      } finally {
        if (pendingOperation === currentOperation) pendingOperation = undefined
      }
    })()
  }
}))

const applyLocaleSnapshot = (snapshot: LocalePreferenceSnapshot, persist = true): void => {
  const version = ++applicationVersion
  const apply = (): void => {
    if (version !== applicationVersion) return
    setI18nLocale(snapshot.locale)
    applyHtmlLang(snapshot.locale)
    if (persist) persistPreference(snapshot.preference)
    useLocaleStore.setState(snapshot)
  }
  const preparing = prepareI18nLocale(snapshot.locale)
  if (preparing) {
    void preparing.then(apply).catch(() => {
      if (version === applicationVersion) useLocaleStore.setState({ saveFailed: true })
    })
  } else apply()
}

let stopLocalePreferenceSync: (() => void) | undefined

// Main owns desktop persistence; browser tabs share only their local preference. In both cases the
// subscription belongs to startup, not to a particular language control or Settings panel mount.
export const startLocalePreferenceSync = (): (() => void) => {
  stopLocalePreferenceSync?.()
  const localeApi = window.api?.locale
  let active = true
  let unsubscribe: () => void

  if (localeApi) {
    let initialized = false
    let initialization = 0
    const unsubscribeLocale = localeApi.onChanged((snapshot) => {
      if (!active) return
      broadcastVersion += 1
      confirmed = snapshot
      if (pendingOperation === undefined) applyLocaleSnapshot(snapshot)
    })
    const initialize = (): void => {
      if (!active || initialized) return
      initialized = true
      const attempt = ++initialization
      const versionAtStart = broadcastVersion
      const operationAtStart = operation
      const cachedPreference = useLocaleStore.getState().preference
      void localeApi
        .initialize({ cachedPreference })
        .then((snapshot) => {
          if (!active || attempt !== initialization || versionAtStart !== broadcastVersion) return
          if (operationAtStart >= confirmedOperation) confirmed = snapshot
          // Do not replace a pending choice or a newer successful command with a startup reply.
          if (
            pendingOperation === undefined &&
            (operationAtStart === operation || useLocaleStore.getState().saveFailed)
          ) {
            applyLocaleSnapshot(confirmed)
          }
        })
        .catch(() => {
          if (attempt === initialization) initialized = false
        })
    }
    const startup = window.api.runtimeStartup
    let unsubscribeStartup: (() => void) | undefined
    if (startup) {
      let revision = 0
      let reading = false
      const observe = (state: RuntimeStartupState): void => {
        if (!active) return
        if (state.phase === 'ready') initialize()
        else {
          initialized = false
          initialization++
        }
      }
      // The recovery window can render before the backend IPC relay exists. Subscribe first
      // and ignore an old snapshot if a newer readiness event arrives while reading it.
      const detachState = startup.onStateChanged((state) => {
        revision++
        observe(state)
      })
      const readReadiness = (): void => {
        if (!active || initialized || reading) return
        reading = true
        const observed = revision
        void startup
          .getState()
          .then((state) => {
            if (observed === revision) observe(state)
          })
          .catch(() => undefined)
          .finally(() => {
            reading = false
          })
      }
      // A transient IPC failure can miss the sole ready event. Retry when the user returns,
      // using a fresh readiness check rather than invoking an unavailable locale handler.
      window.addEventListener('focus', readReadiness)
      unsubscribeStartup = () => {
        window.removeEventListener('focus', readReadiness)
        detachState()
      }
      readReadiness()
    } else initialize()
    unsubscribe = () => {
      unsubscribeStartup?.()
      unsubscribeLocale()
    }
  } else {
    const onStorage = (event: StorageEvent): void => {
      if (
        event.storageArea !== localStorage ||
        (event.key !== null && event.key !== LANGUAGE_STORAGE_KEY)
      )
        return
      const preference = resolvePreference()
      operation += 1
      pendingOperation = undefined
      confirmed = { preference, locale: resolveLocalePreference(preference) }
      applyLocaleSnapshot(confirmed, false)
    }
    window.addEventListener('storage', onStorage)
    unsubscribe = () => window.removeEventListener('storage', onStorage)
  }

  const stop = (): void => {
    active = false
    applicationVersion += 1
    unsubscribe()
    if (stopLocalePreferenceSync === stop) stopLocalePreferenceSync = undefined
  }
  stopLocalePreferenceSync = stop
  return stop
}

if (import.meta.hot) import.meta.hot.dispose(() => stopLocalePreferenceSync?.())
