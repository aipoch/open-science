import {
  DEFAULT_APP_ICON_VARIANT,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_NOTIFICATIONS_ENABLED,
  DEFAULT_SHOW_NOTIFICATION_CONTENT,
  DEFAULT_REASONING_EFFORT,
  type AppIconVariant,
  type ProjectFilesFilterPreference,
  type ReasoningEffort
} from '../../shared/settings'
import type { CloseActionPreference } from '../../shared/window-controls'
import {
  getDefaultPermissionProfile,
  type PermissionProfileId
} from '../../shared/permission-profiles'
import type {
  SetDataRootOptions,
  SettingsPreferences,
  SettingsPreferencesSnapshot
} from './capabilities'
import type { SettingsRepository } from './repository'
import type { StoredSettings } from './types'

// Project only the values owned by this module. Keeping the projection here lets the compatibility
// facade combine one repository read with its provider/runtime views without exposing StoredSettings
// through the capability interface.
const toSettingsPreferencesSnapshot = (settings: StoredSettings): SettingsPreferencesSnapshot => ({
  ...(settings.onboardingCompletedAt === undefined
    ? {}
    : { onboardingCompletedAt: settings.onboardingCompletedAt }),
  ...(settings.pathsNormalizedAt === undefined
    ? {}
    : { pathsNormalizedAt: settings.pathsNormalizedAt }),
  ...(settings.legacyDataMovePromptDismissedAt === undefined
    ? {}
    : { legacyDataMovePromptDismissedAt: settings.legacyDataMovePromptDismissedAt }),
  ...(settings.dataRoot === undefined ? {} : { dataRoot: settings.dataRoot }),
  reasoningEffort: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  notificationsEnabled: settings.notificationsEnabled ?? DEFAULT_NOTIFICATIONS_ENABLED,
  showNotificationContent: settings.showNotificationContent ?? DEFAULT_SHOW_NOTIFICATION_CONTENT,
  conversationSkillImportEnabled:
    settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  ...(settings.closePreference === undefined ? {} : { closePreference: settings.closePreference }),
  appIconVariant: settings.appIconVariant ?? DEFAULT_APP_ICON_VARIANT,
  ...(settings.projectFilesFilter === undefined
    ? {}
    : { projectFilesFilter: settings.projectFilesFilter }),
  defaultPermissionProfile: getDefaultPermissionProfile(settings)
})

class SettingsPreferencesModule implements SettingsPreferences {
  constructor(
    private readonly repository: SettingsRepository,
    private readonly now: () => number = Date.now
  ) {}

  async getSnapshot(): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.getSettings())
  }

  async markOnboardingComplete(): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.markOnboardingComplete(this.now()))
  }

  async markPathsNormalized(): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.markPathsNormalized(this.now()))
  }

  async setDataRoot(
    path: string,
    options: SetDataRootOptions = {}
  ): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(
      await this.repository.setDataRoot({
        dataRoot: path,
        ...(options.previousDataRoot ? { previousDataRoot: options.previousDataRoot } : {}),
        ...(options.completeOnboarding ? { onboardingCompletedAt: this.now() } : {})
      })
    )
  }

  async dismissLegacyDataMovePrompt(): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(
      await this.repository.markLegacyDataMovePromptDismissed(this.now())
    )
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.setReasoningEffort(effort))
  }

  async setNotificationsEnabled(enabled: boolean): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.setNotificationsEnabled(enabled))
  }

  async setShowNotificationContent(enabled: boolean): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.setShowNotificationContent(enabled))
  }

  async setConversationSkillImportEnabled(enabled: boolean): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(
      await this.repository.setConversationSkillImportEnabled(enabled)
    )
  }

  async setClosePreference(
    preference: CloseActionPreference | undefined
  ): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.setClosePreference(preference))
  }

  async setAppIconVariant(variant: AppIconVariant): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.setAppIconVariant(variant))
  }

  async setProjectFilesFilter(
    filter: ProjectFilesFilterPreference | undefined
  ): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.setProjectFilesFilter(filter))
  }

  async setDefaultPermissionProfile(
    profile: PermissionProfileId
  ): Promise<SettingsPreferencesSnapshot> {
    return toSettingsPreferencesSnapshot(await this.repository.setDefaultPermissionProfile(profile))
  }
}

export { SettingsPreferencesModule, toSettingsPreferencesSnapshot }
export type { SetDataRootOptions } from './capabilities'
