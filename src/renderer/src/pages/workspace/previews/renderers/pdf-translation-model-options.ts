import { useMemo } from 'react'
import { PDF_TRANSLATION_LANGUAGES } from '@aipoch/pdf-translation/text'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import type { ModelProtocol } from '@aipoch/providers'
import {
  pdfTranslationAgentModels,
  pdfTranslationApiModels
} from '../../../../../../shared/pdf-translation-models'
import type { AgentFrameworkId, ProviderView } from '../../../../../../shared/settings'

function defaultTargetLanguage(locale?: string): string {
  const language = locale?.toLocaleLowerCase().split(/[-_]/)[0]
  return (
    (
      {
        ar: 'Arabic',
        de: 'German',
        es: 'Spanish',
        fr: 'French',
        hi: 'Hindi',
        it: 'Italian',
        ja: 'Japanese',
        ko: 'Korean',
        nl: 'Dutch',
        pt: 'Portuguese',
        ru: 'Russian',
        zh: 'Chinese'
      } as Record<string, string>
    )[language ?? ''] ?? 'English'
  )
}

const selectionLanguageKey = 'open-science:pdf-selection-translation-language'

export function initialSelectionTargetLanguage(locale: string): string {
  try {
    const saved = localStorage.getItem(selectionLanguageKey)
    const match = PDF_TRANSLATION_LANGUAGES.find((language) => language === saved)
    if (match) return match
  } catch {
    // Storage can be unavailable in a restricted browser profile.
  }
  const fallback = defaultTargetLanguage(locale)
  return PDF_TRANSLATION_LANGUAGES.find((language) => language === fallback) ?? 'English'
}

export function rememberSelectionTargetLanguage(language: string): void {
  try {
    localStorage.setItem(selectionLanguageKey, language)
  } catch {
    // The open popover still uses the selected language.
  }
}

function useAvailableApiModels(): ReturnType<typeof pdfTranslationApiModels> {
  const providers = useSettingsStore((store) => store.providers)
  return useMemo(() => pdfTranslationApiModels(providers), [providers])
}

function useAgentModels(overrideFramework?: AgentFrameworkId): {
  models: ReturnType<typeof pdfTranslationAgentModels>
  providers: ProviderView[]
  frameworkId: AgentFrameworkId
  frameworkEndpoints: ModelProtocol[]
  activeProviderId?: string
  frameworkName: string
} {
  const providers = useSettingsStore((store) => store.providers)
  const activeProviderId = useSettingsStore((store) => store.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (store) => store.claudeSubscriptionProviderId
  )
  const activeFramework = useSettingsStore((store) => store.agentFrameworkId)
  const frameworks = useSettingsStore((store) => store.agentFrameworks)
  const activeEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const frameworkId = overrideFramework ?? activeFramework
  const framework = frameworks.find((entry) => entry.id === frameworkId)
  const frameworkEndpoints = framework?.supportedApiTypes ?? activeEndpoints
  const models = useMemo(
    () =>
      pdfTranslationAgentModels({
        providers,
        activeProviderId,
        claudeSubscriptionProviderId,
        frameworkId,
        frameworkEndpoints
      }),
    [providers, activeProviderId, claudeSubscriptionProviderId, frameworkId, frameworkEndpoints]
  )
  return {
    models,
    providers,
    frameworkId,
    frameworkEndpoints,
    activeProviderId,
    frameworkName: framework?.displayName ?? frameworkId
  }
}

export { defaultTargetLanguage, useAvailableApiModels, useAgentModels }
