import type { PackageMirror } from '../../shared/mirror'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import type {
  AppIconVariant,
  ReasoningEffort,
  SetPackageMirrorRequest
} from '../../shared/settings'
import type { CloseActionPreference } from '../../shared/window-controls'

// A narrow, detached view of app preferences. The capability never exposes the mutable persisted
// Settings document; callers receive scalar values whose defaults have already been resolved.
export type SettingsPreferencesSnapshot = {
  onboardingCompletedAt?: number
  pathsNormalizedAt?: number
  legacyDataMovePromptDismissedAt?: number
  dataRoot?: string
  reasoningEffort: ReasoningEffort
  notificationsEnabled: boolean
  conversationSkillImportEnabled: boolean
  closePreference?: CloseActionPreference
  appIconVariant: AppIconVariant
}

export interface SettingsPreferences {
  getSnapshot(): Promise<SettingsPreferencesSnapshot>
  markOnboardingComplete(): Promise<SettingsPreferencesSnapshot>
  markPathsNormalized(): Promise<SettingsPreferencesSnapshot>
  setDataRoot(path: string): Promise<SettingsPreferencesSnapshot>
  dismissLegacyDataMovePrompt(): Promise<SettingsPreferencesSnapshot>
  setReasoningEffort(effort: ReasoningEffort): Promise<SettingsPreferencesSnapshot>
  setNotificationsEnabled(enabled: boolean): Promise<SettingsPreferencesSnapshot>
  setConversationSkillImportEnabled(enabled: boolean): Promise<SettingsPreferencesSnapshot>
  setClosePreference(
    preference: CloseActionPreference | undefined
  ): Promise<SettingsPreferencesSnapshot>
  setAppIconVariant(variant: AppIconVariant): Promise<SettingsPreferencesSnapshot>
}

// One language's complete persisted Notebook policy, projected as detached values. Package mirrors
// are process-global, while runtime selection, enablement, and manual interpreters are per-language.
export type NotebookRuntimeSettingsSnapshot = {
  language: NotebookLanguage
  runtimeSelection?: RuntimeSelection
  runtimeEnablement: RuntimeEnablement
  manualInterpreters: string[]
  packageMirror: PackageMirror
}

export interface NotebookRuntimeSettings {
  getSnapshot(language: NotebookLanguage): Promise<NotebookRuntimeSettingsSnapshot>
  setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<NotebookRuntimeSettingsSnapshot>
  setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<NotebookRuntimeSettingsSnapshot>
  setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<NotebookRuntimeSettingsSnapshot>
  addManualInterpreter(
    language: NotebookLanguage,
    path: string
  ): Promise<NotebookRuntimeSettingsSnapshot>
  removeManualInterpreter(
    language: NotebookLanguage,
    path: string
  ): Promise<NotebookRuntimeSettingsSnapshot>
  setPackageMirror(
    request: SetPackageMirrorRequest,
    language?: NotebookLanguage
  ): Promise<NotebookRuntimeSettingsSnapshot>
}
