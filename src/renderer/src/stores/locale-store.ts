import { create } from 'zustand'

import { setI18nLocale, prepareI18nLocale } from '@/i18n'
import {
  applyHtmlLang,
  LANGUAGE_STORAGE_KEY,
  persistPreference,
  resolveLocalePreference,
  resolvePreference
} from '@/lib/locale-preference'
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
    const versionAtStart = broadcastVersion
    const operationAtStart = operation
    unsubscribe = localeApi.onChanged((snapshot) => {
      if (!active) return
      broadcastVersion += 1
      confirmed = snapshot
      if (pendingOperation === undefined) applyLocaleSnapshot(snapshot)
    })
    const cachedPreference = useLocaleStore.getState().preference
    void localeApi
      .initialize({ cachedPreference })
      .then((snapshot) => {
        if (!active || versionAtStart !== broadcastVersion) return
        if (operationAtStart >= confirmedOperation) confirmed = snapshot
        // Startup can arrive after a failed optimistic choice. Reconcile that failure too, but never
        // replace a pending choice or a newer successful command with an old startup snapshot.
        if (
          pendingOperation === undefined &&
          (operationAtStart === operation || useLocaleStore.getState().saveFailed)
        ) {
          applyLocaleSnapshot(confirmed)
        }
      })
      .catch(() => undefined)
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
