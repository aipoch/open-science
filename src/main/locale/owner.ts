import {
  DEFAULT_LANGUAGE_PREFERENCE,
  isLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type LocalePreferenceSnapshot
} from '../../shared/locale'
import type { SettingsRepository } from '../settings/repository'
import {
  createNativeI18n,
  type NativeTranslateOptions,
  type NativeTranslator
} from './main-process-messages'

type LocalePreferenceListener = (snapshot: LocalePreferenceSnapshot) => void

// Main-process owner for desktop locale behavior. SettingsRepository remains the single semantic
// route into settings.json; this Module serializes preference commits, resolves native locale, and
// publishes live snapshots without introducing a second persistence path.
export class LocalePreferenceOwner {
  private preference: LanguagePreference
  private hasPersistedPreference: boolean
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<LocalePreferenceListener>()
  private readonly i18n

  constructor(
    private readonly systemLanguageTags: readonly string[],
    private readonly repository: SettingsRepository,
    initialPreference?: LanguagePreference
  ) {
    this.preference = initialPreference ?? DEFAULT_LANGUAGE_PREFERENCE
    this.hasPersistedPreference = initialPreference !== undefined
    this.i18n = createNativeI18n(resolveLocale(this.preference, this.systemLanguageTags))
  }

  snapshot(): LocalePreferenceSnapshot {
    return {
      preference: this.preference,
      locale: resolveLocale(this.preference, this.systemLanguageTags)
    }
  }

  // Imports the historical renderer cache only when settings.json has never owned a locale. Once a
  // persisted value exists, Main wins and the caller receives that authoritative snapshot.
  initialize(value: unknown): Promise<LocalePreferenceSnapshot> {
    if (!isLanguagePreference(value)) throw new Error('Invalid language preference')
    return this.enqueue(async () =>
      this.hasPersistedPreference ? this.snapshot() : this.commitPreference(value)
    )
  }

  setPreference(value: unknown): Promise<LocalePreferenceSnapshot> {
    if (!isLanguagePreference(value)) throw new Error('Invalid language preference')
    return this.enqueue(() => this.commitPreference(value))
  }

  private async commitPreference(value: LanguagePreference): Promise<LocalePreferenceSnapshot> {
    if (value === this.preference && this.hasPersistedPreference) return this.snapshot()

    await this.repository.setLocalePreference(value)

    const changed = value !== this.preference
    this.preference = value
    this.hasPersistedPreference = true
    const snapshot = this.snapshot()
    if (changed) {
      await this.i18n.changeLanguage(snapshot.locale)
      for (const listener of this.listeners) listener(snapshot)
    }
    return snapshot
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  subscribe(listener: LocalePreferenceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  t(key: string, options?: NativeTranslateOptions): string {
    return this.i18n.t(key, options)
  }
}

export type { NativeTranslator }
