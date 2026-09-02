import type { PackageMirror } from '../../shared/mirror'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement } from '../../shared/notebook-runtime'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type {
  AppIconVariant,
  ProjectFilesFilterPreference,
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
  showNotificationContent: boolean
  conversationSkillImportEnabled: boolean
  closePreference?: CloseActionPreference
  appIconVariant: AppIconVariant
  projectFilesFilter?: ProjectFilesFilterPreference
  defaultPermissionProfile: PermissionProfileId
}

export type SetDataRootOptions = Readonly<{
  completeOnboarding?: boolean
  previousDataRoot?: string
}>

export interface SettingsPreferences {
  getSnapshot(): Promise<SettingsPreferencesSnapshot>
  markOnboardingComplete(): Promise<SettingsPreferencesSnapshot>
  markPathsNormalized(): Promise<SettingsPreferencesSnapshot>
  setDataRoot(path: string, options?: SetDataRootOptions): Promise<SettingsPreferencesSnapshot>
  dismissLegacyDataMovePrompt(): Promise<SettingsPreferencesSnapshot>
  setReasoningEffort(effort: ReasoningEffort): Promise<SettingsPreferencesSnapshot>
  setNotificationsEnabled(enabled: boolean): Promise<SettingsPreferencesSnapshot>
  setShowNotificationContent(enabled: boolean): Promise<SettingsPreferencesSnapshot>
  setConversationSkillImportEnabled(enabled: boolean): Promise<SettingsPreferencesSnapshot>
  setClosePreference(
    preference: CloseActionPreference | undefined
  ): Promise<SettingsPreferencesSnapshot>
  setAppIconVariant(variant: AppIconVariant): Promise<SettingsPreferencesSnapshot>
  setProjectFilesFilter(
    filter: ProjectFilesFilterPreference | undefined
  ): Promise<SettingsPreferencesSnapshot>
  setDefaultPermissionProfile(profile: PermissionProfileId): Promise<SettingsPreferencesSnapshot>
}

// One language's complete persisted Notebook policy, projected as detached values. Package mirrors
// are process-global, while enablement and manual interpreters are per-language.
export type NotebookRuntimeSettingsSnapshot = {
  language: NotebookLanguage
  runtimeEnablement: RuntimeEnablement
  manualInterpreters: string[]
  packageMirror: PackageMirror
}

export interface NotebookRuntimeSettings {
  getSnapshot(language: NotebookLanguage): Promise<NotebookRuntimeSettingsSnapshot>
  getPackageMirror(): Promise<PackageMirror>
  setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement>
  setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<RuntimeEnablement>
  getAgentEnvironmentCreationEnabled(): Promise<boolean>
  setAgentEnvironmentCreationEnabled(enabled: boolean): Promise<boolean>
  addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
  removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
  setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror>
}
