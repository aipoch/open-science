import {
  DEFAULT_LANGUAGE_PREFERENCE,
  isLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type LocalePreferenceSnapshot
} from '../../shared/locale'
import { translateNativeMessage, type NativeMessageKey } from './native-messages'

type LocalePreferenceListener = (snapshot: LocalePreferenceSnapshot) => void

// Current-process owner for desktop-native locale behavior. Renderer localStorage remains the
// persistence source; this Module centralizes main-process resolution and live consumers without
// introducing another on-disk record.
export class LocalePreferenceOwner {
  private preference: LanguagePreference = DEFAULT_LANGUAGE_PREFERENCE
  private readonly listeners = new Set<LocalePreferenceListener>()

  constructor(private readonly systemLanguageTags: readonly string[]) {}

  snapshot(): LocalePreferenceSnapshot {
    return {
      preference: this.preference,
      locale: resolveLocale(this.preference, this.systemLanguageTags)
    }
  }

  setPreference(value: unknown): LocalePreferenceSnapshot {
    if (!isLanguagePreference(value)) throw new Error('Invalid language preference')
    if (value === this.preference) return this.snapshot()

    this.preference = value
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }

  subscribe(listener: LocalePreferenceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  t(key: NativeMessageKey, values?: Record<string, string | number>): string {
    return translateNativeMessage(this.snapshot().locale, key, values)
  }
}

export type { NativeTranslator } from './native-messages'
