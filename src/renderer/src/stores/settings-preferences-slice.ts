import type { NetworkProxySettings } from '../../../shared/network-proxy'
import type { PackageMirror } from '../../../shared/mirror'
import type {
  AppIconVariant,
  ProjectFilesFilterPreference,
  ReasoningEffort,
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration,
  SettingsSnapshot,
  SubagentModelConfiguration,
  VisionModelConfiguration
} from '../../../shared/settings'
import type { CloseActionPreference } from '../../../shared/window-controls'
import type { PermissionProfileId } from '../../../shared/permission-profiles'
import { isMirrorConfigured } from '../pages/settings/mirror-view'
import type {
  OptimisticSettingsWriteKey,
  SettingsWriteCoordinator
} from './settings-write-coordinator'

type SettingsPreferencesState = {
  onboardingCompletedAt?: number
  networkProxy?: NetworkProxySettings
  packageMirror?: PackageMirror
  reasoningEffort: ReasoningEffort
  reviewerModel?: ReviewerModelConfiguration
  reviewerModelPending?: boolean
  sessionDetailsModel?: SessionDetailsModelConfiguration
  sessionDetailsModelPending?: boolean
  subagentModel?: SubagentModelConfiguration
  subagentModelPending?: boolean
  visionModel?: VisionModelConfiguration
  visionModelPending?: boolean
  notificationsEnabled: boolean
  showNotificationContent: boolean
  conversationSkillImportEnabled: boolean
  closePreference: CloseActionPreference | undefined
  appIconVariant: AppIconVariant
  projectFilesFilter: ProjectFilesFilterPreference | undefined
  defaultPermissionProfile: PermissionProfileId
}

type OptimisticPreferenceField =
  | 'reasoningEffort'
  | 'sessionDetailsModel'
  | 'notificationsEnabled'
  | 'showNotificationContent'
  | 'conversationSkillImportEnabled'
  | 'closePreference'
  | 'appIconVariant'
  | 'projectFilesFilter'
  | 'defaultPermissionProfile'

export type SettingsPreferencesActions = {
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>
  setReviewerModel: (configuration: ReviewerModelConfiguration) => Promise<void>
  setSessionDetailsModel: (configuration: SessionDetailsModelConfiguration) => Promise<void>
  setSubagentModel: (configuration: SubagentModelConfiguration) => Promise<void>
  setVisionModel: (configuration: VisionModelConfiguration | undefined) => Promise<void>
  setNotificationsEnabled: (enabled: boolean) => Promise<void>
  setShowNotificationContent: (enabled: boolean) => Promise<void>
  setConversationSkillImportEnabled: (enabled: boolean) => Promise<void>
  setClosePreference: (preference: CloseActionPreference | undefined) => Promise<void>
  setAppIconVariant: (variant: AppIconVariant) => Promise<void>
  setProjectFilesFilter: (filter: ProjectFilesFilterPreference | undefined) => Promise<void>
  setDefaultPermissionProfile: (profile: PermissionProfileId) => Promise<void>

  completeOnboarding: () => Promise<void>
  setPackageMirror: (mirror: PackageMirror) => Promise<void>
  setNetworkProxy: (settings: NetworkProxySettings) => Promise<void>
}

type SettingsPreferencesCommands = Pick<
  Window['api']['settings'],
  | 'setReasoningEffort'
  | 'setNotificationsEnabled'
  | 'setShowNotificationContent'
  | 'setConversationSkillImportEnabled'
  | 'setClosePreference'
  | 'setAppIconVariant'
  | 'setProjectFilesFilter'
  | 'setDefaultPermissionProfile'
  | 'markOnboardingComplete'
  | 'setPackageMirror'
> &
  Partial<
    Pick<
      Window['api']['settings'],
      | 'getSettings'
      | 'setReviewerModel'
      | 'setSessionDetailsModel'
      | 'setSubagentModel'
      | 'setVisionModel'
      | 'setNetworkProxy'
    >
  >

type SettingsPreferencesSliceOptions = {
  getState: () => SettingsPreferencesState
  setState: (patch: Partial<SettingsPreferencesState>) => void
  getCommands: () => SettingsPreferencesCommands
  reconcileSnapshot: (snapshot: SettingsSnapshot) => void
  writeCoordinator: SettingsWriteCoordinator
}

const OPTIMISTIC_PREFERENCE_WRITES = [
  ['reasoningEffort', 'reasoningEffort'],
  ['sessionDetailsModel', 'sessionDetailsModel'],
  ['notificationsEnabled', 'notifications'],
  ['showNotificationContent', 'notificationContent'],
  ['conversationSkillImportEnabled', 'conversationSkillImport'],
  ['closePreference', 'closePreference'],
  ['appIconVariant', 'appIcon'],
  ['projectFilesFilter', 'projectFilesFilter'],
  ['defaultPermissionProfile', 'defaultPermissionProfile']
] as const satisfies ReadonlyArray<readonly [OptimisticPreferenceField, OptimisticSettingsWriteKey]>

export const omitInFlightOptimisticPreferences = <Patch extends Partial<SettingsPreferencesState>>(
  patch: Patch,
  hasPending: (key: OptimisticSettingsWriteKey) => boolean
): Patch => {
  const next = { ...patch }
  for (const [field, key] of OPTIMISTIC_PREFERENCE_WRITES) {
    if (hasPending(key)) delete next[field]
  }
  return next
}

const SETTINGS_WRITE_ERRORS: Record<OptimisticSettingsWriteKey, string> = {
  reasoningEffort: 'Could not save reasoning effort. Try again.',
  sessionDetailsModel:
    'Could not save Session details model. Refresh the model catalog and try again.',
  notifications: 'Could not save notification preference. Try again.',
  notificationContent: 'Could not save notification preference. Try again.',
  conversationSkillImport: 'Could not save conversation Skill import preference. Try again.',
  closePreference: 'Could not save window close preference. Try again.',
  appIcon: 'Could not save app icon preference. Try again.',
  projectFilesFilter: 'Could not save files filter preference. Try again.',
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
      write.complete({ value: snapshot[field] as unknown as SettingsPreferencesState[Field] })
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
    setSessionDetailsModel: async (configuration) => {
      setState({ sessionDetailsModelPending: true })
      try {
        await runOptimisticWrite(
          'sessionDetailsModel',
          'sessionDetailsModel',
          configuration,
          () => getCommands().setSessionDetailsModel!({ configuration }),
          'Failed to set Session details model'
        )
      } finally {
        if (!writeCoordinator.hasPending('sessionDetailsModel')) {
          setState({ sessionDetailsModelPending: false })
        }
      }
    },

    setReviewerModel: async (configuration) => {
      const write = writeCoordinator.begin('reviewerModel')
      setState({ reviewerModelPending: true })
      try {
        const snapshot = await getCommands().setReviewerModel!({ configuration })
        if (!write.isCurrent()) return
        reconcileSnapshot(snapshot)
        write.succeed()
      } catch (error) {
        write.fail('Could not save Reviewer model. Refresh the model catalog and try again.')
        console.error('Failed to set Reviewer model', error)
        const refresh = getCommands().getSettings
        if (refresh) {
          try {
            reconcileSnapshot(await refresh())
          } catch (refreshError) {
            console.error('Failed to refresh Settings after rejected Reviewer model', refreshError)
          }
        }
      } finally {
        if (write.isCurrent()) setState({ reviewerModelPending: false })
      }
    },

    setSubagentModel: async (configuration) => {
      const write = writeCoordinator.begin('subagentModel')
      setState({ subagentModelPending: true })
      try {
        const snapshot = await getCommands().setSubagentModel!({ configuration })
        if (!write.isCurrent()) return
        reconcileSnapshot(snapshot)
        write.succeed()
      } catch (error) {
        write.fail('Could not save Subagent model. Refresh the model catalog and try again.')
        console.error('Failed to set Subagent model', error)
        const refresh = getCommands().getSettings
        if (refresh) {
          try {
            reconcileSnapshot(await refresh())
          } catch (refreshError) {
            console.error('Failed to refresh Settings after rejected Subagent model', refreshError)
          }
        }
      } finally {
        if (write.isCurrent()) setState({ subagentModelPending: false })
      }
    },

    setVisionModel: async (configuration) => {
      const write = writeCoordinator.begin('visionModel')
      setState({ visionModelPending: true })
      try {
        const snapshot = await getCommands().setVisionModel!({ configuration })
        if (!write.isCurrent()) return
        reconcileSnapshot(snapshot)
        write.succeed()
      } catch (error) {
        write.fail('Could not save Vision model. Refresh the model catalog and try again.')
        console.error('Failed to set Vision model', error)
        const refresh = getCommands().getSettings
        if (refresh) {
          try {
            reconcileSnapshot(await refresh())
          } catch (refreshError) {
            console.error('Failed to refresh Settings after rejected Vision model', refreshError)
          }
        }
      } finally {
        if (write.isCurrent()) setState({ visionModelPending: false })
      }
    },

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

    setShowNotificationContent: (enabled) =>
      runOptimisticWrite(
        'showNotificationContent',
        'notificationContent',
        enabled,
        () => getCommands().setShowNotificationContent({ enabled }),
        'Failed to set notification content visibility'
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

    setProjectFilesFilter: (filter) =>
      runOptimisticWrite(
        'projectFilesFilter',
        'projectFilesFilter',
        filter,
        () => getCommands().setProjectFilesFilter({ filter }),
        'Failed to set project files filter'
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
    },

    setNetworkProxy: async (networkProxy) => {
      const setNetworkProxy = getCommands().setNetworkProxy
      if (!setNetworkProxy) throw new Error('Network proxy settings are unavailable.')
      const saved = await setNetworkProxy(networkProxy)
      setState({ networkProxy: saved })
    }
  }
}
