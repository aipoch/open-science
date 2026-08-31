import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SettingsPreferencesModule } from './preferences'
import { SettingsRepository } from './repository'

const roots: string[] = []

const createModule = async (
  now = 1_000
): Promise<{ preferences: SettingsPreferencesModule; repository: SettingsRepository }> => {
  const root = await mkdtemp(join(tmpdir(), 'settings-preferences-'))
  roots.push(root)
  const repository = new SettingsRepository(root)
  return { preferences: new SettingsPreferencesModule(repository, () => now), repository }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SettingsPreferencesModule', () => {
  it('resolves preference defaults without exposing the stored document', async () => {
    const { preferences } = await createModule()

    await expect(preferences.getSnapshot()).resolves.toEqual({
      reasoningEffort: 'default',
      notificationsEnabled: true,
      showNotificationContent: false,
      conversationSkillImportEnabled: true,
      appIconVariant: 'light',
      defaultPermissionProfile: 'ask'
    })
  })

  it('persists scalar commands with the existing defaults and one-time markers', async () => {
    const { preferences, repository } = await createModule(2_000)
    const dataRoot = resolve('/data/open-science')

    await preferences.setReasoningEffort('high')
    await preferences.setNotificationsEnabled(false)
    await preferences.setShowNotificationContent(true)
    await preferences.setConversationSkillImportEnabled(false)
    await preferences.setClosePreference('quit')
    await preferences.setAppIconVariant('dark')
    await preferences.setDefaultPermissionProfile('auto')
    await preferences.setDataRoot(dataRoot, { completeOnboarding: true })
    await preferences.markPathsNormalized()
    await preferences.dismissLegacyDataMovePrompt()

    await expect(preferences.getSnapshot()).resolves.toEqual({
      onboardingCompletedAt: 2_000,
      pathsNormalizedAt: 2_000,
      legacyDataMovePromptDismissedAt: 2_000,
      dataRoot,
      reasoningEffort: 'high',
      notificationsEnabled: false,
      showNotificationContent: true,
      conversationSkillImportEnabled: false,
      closePreference: 'quit',
      appIconVariant: 'dark',
      defaultPermissionProfile: 'auto'
    })

    await preferences.setClosePreference(undefined)
    await preferences.markOnboardingComplete()
    await expect(repository.getSettings()).resolves.toMatchObject({
      onboardingCompletedAt: 2_000,
      pathsNormalizedAt: 2_000,
      legacyDataMovePromptDismissedAt: 2_000,
      dataRoot,
      reasoningEffort: 'high',
      notificationsEnabled: false,
      showNotificationContent: true,
      conversationSkillImportEnabled: false,
      appIconVariant: 'dark',
      defaultPermissionProfile: 'auto'
    })
    expect((await repository.getSettings()).closePreference).toBeUndefined()
  })

  it('projects and clears the project files filter preference', async () => {
    const { preferences } = await createModule(2_000)

    expect((await preferences.getSnapshot()).projectFilesFilter).toBeUndefined()

    await preferences.setProjectFilesFilter({ sourceMode: 'local', localRootId: 'root-1' })
    expect((await preferences.getSnapshot()).projectFilesFilter).toEqual({
      sourceMode: 'local',
      localRootId: 'root-1'
    })

    await preferences.setProjectFilesFilter(undefined)
    expect((await preferences.getSnapshot()).projectFilesFilter).toBeUndefined()
  })
})
