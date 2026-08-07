import type { PackageMirror } from '../../../shared/mirror'
import type { AppIconVariant, ReasoningEffort, SettingsSnapshot } from '../../../shared/settings'
import type { CloseActionPreference } from '../../../shared/window-controls'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import { isMirrorConfigured } from '../pages/settings/mirror-view'
import type {
  OptimisticSettingsWriteKey,
  SettingsWriteCoordinator
} from './settings-write-coordinator'

type SettingsPreferencesState = {
  onboardingCompletedAt?: number
  packageMirror?: PackageMirror
  reasoningEffort: ReasoningEffort
  notificationsEnabled: boolean
  conversationSkillImportEnabled: boolean
  closePreference: CloseActionPreference | undefined
  appIconVariant: AppIconVariant
  defaultPermissionProfile: PermissionProfileId
}

type OptimisticPreferenceField =
  | 'reasoningEffort'
  | 'notificationsEnabled'
  | 'conversationSkillImportEnabled'
  | 'closePreference'
  | 'appIconVariant'
  | 'defaultPermissionProfile'

export type SettingsPreferencesActions = {
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>
  setNotificationsEnabled: (enabled: boolean) => Promise<void>
  setConversationSkillImportEnabled: (enabled: boolean) => Promise<void>
  setClosePreference: (preference: CloseActionPreference | undefined) => Promise<void>
  setAppIconVariant: (variant: AppIconVariant) => Promise<void>
  setDefaultPermissionProfile: (profile: PermissionProfileId) => Promise<void>
  completeOnboarding: () => Promise<void>
  setPackageMirror: (mirror: PackageMirror) => Promise<void>
}

type SettingsPreferencesCommands = Pick<
  Window['api']['settings'],
  | 'setReasoningEffort'
  | 'setNotificationsEnabled'
  | 'setConversationSkillImportEnabled'
  | 'setClosePreference'
  | 'setAppIconVariant'
  | 'setDefaultPermissionProfile'
  | 'markOnboardingComplete'
  | 'setPackageMirror'
>

type SettingsPreferencesSliceOptions = {
  getState: () => SettingsPreferencesState
  setState: (patch: Partial<SettingsPreferencesState>) => void
  getCommands: () => SettingsPreferencesCommands
  reconcileSnapshot: (snapshot: SettingsSnapshot) => void
  writeCoordinator: SettingsWriteCoordinator
}

const SETTINGS_WRITE_ERRORS: Record<OptimisticSettingsWriteKey, string> = {
  reasoningEffort: 'Could not save reasoning effort. Try again.',
  notifications: 'Could not save notification preference. Try again.',
  conversationSkillImport: 'Could not save conversation Skill import preference. Try again.',
  closePreference: 'Could not save window close preference. Try again.',
  appIcon: 'Could not save app icon preference. Try again.',
  defaultPermissionProfile: 'Could not save the default permission mode. Try again.'
}

// Owns renderer preference commands and their optimistic settlement. Core remains the sole owner of
// full Settings snapshots so every successful preference write still reconciles atomically.
export const createSettingsPreferencesSlice = ({
  getState,
  setState,
  getCommands,
  reconcileSnapshot,
  writeCoordinator
}: SettingsPreferencesSliceOptions): SettingsPreferencesActions => {
  const runOptimisticWrite = async <Field extends OptimisticPreferenceField>(
    field: Field,
    key: OptimisticSettingsWriteKey,
    value: SettingsPreferencesState[Field],
    command: () => Promise<SettingsSnapshot>,
    consoleMessage: string
  ): Promise<void> => {
    const write = writeCoordinator.beginOptimistic(key, getState()[field])
    setState({ [field]: value } as Partial<SettingsPreferencesState>)

    try {
      const snapshot = await write.run(command)
      write.complete({ value: snapshot[field] as SettingsPreferencesState[Field] })
      if (!write.isCurrent()) return
      reconcileSnapshot(snapshot)
      write.succeed()
    } catch (error) {
      const confirmedValue = write.complete()
      if (write.isCurrent()) {
        setState({ [field]: confirmedValue } as Partial<SettingsPreferencesState>)
      }
      write.fail(SETTINGS_WRITE_ERRORS[key])
      console.error(consoleMessage, error)
    }
  }

  return {
    setReasoningEffort: (effort) =>
      runOptimisticWrite(
        'reasoningEffort',
        'reasoningEffort',
        effort,
        () => getCommands().setReasoningEffort({ effort }),
        'Failed to set reasoning effort'
      ),

    setNotificationsEnabled: (enabled) =>
      runOptimisticWrite(
        'notificationsEnabled',
        'notifications',
        enabled,
        () => getCommands().setNotificationsEnabled({ enabled }),
        'Failed to set notifications enabled'
      ),

    setConversationSkillImportEnabled: (enabled) =>
      runOptimisticWrite(
        'conversationSkillImportEnabled',
        'conversationSkillImport',
        enabled,
        () => getCommands().setConversationSkillImportEnabled({ enabled }),
        'Failed to set conversation Skill import enabled'
      ),

    setClosePreference: (preference) =>
      runOptimisticWrite(
        'closePreference',
        'closePreference',
        preference,
        () => getCommands().setClosePreference({ preference }),
        'Failed to set close preference'
      ),

    setAppIconVariant: (variant) =>
      runOptimisticWrite(
        'appIconVariant',
        'appIcon',
        variant,
        () => getCommands().setAppIconVariant({ variant }),
        'Failed to set app icon variant'
      ),

    setDefaultPermissionProfile: (profile) =>
      runOptimisticWrite(
        'defaultPermissionProfile',
        'defaultPermissionProfile',
        profile,
        () => getCommands().setDefaultPermissionProfile({ profile }),
        'Failed to set default permission profile'
      ),

    completeOnboarding: async () => {
      reconcileSnapshot(await getCommands().markOnboardingComplete())
    },

    setPackageMirror: async (mirror) => {
      const saved = await getCommands().setPackageMirror(mirror)
      setState({ packageMirror: isMirrorConfigured(saved) ? saved : undefined })
    }
  }
}
