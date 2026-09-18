import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
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
  return {
    preferences: new SettingsPreferencesModule(
      repository,
      () => now,
      () => join(root, 'Open-Science')
    ),
    repository
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SettingsPreferencesModule', () => {
  it('commits the default and completion together only when Finish is requested', async () => {
    const { preferences, repository } = await createModule(3000)
    expect((await repository.getSettings()).dataRoot).toBeUndefined()
    expect((await repository.getSettings()).onboardingCompletedAt).toBeUndefined()
    const complete = await preferences.markOnboardingComplete()
    const persisted = JSON.parse(await readFile(join(roots.at(-1)!, 'settings.json'), 'utf8'))
    expect(complete).toMatchObject({
      dataRoot: join(roots.at(-1)!, 'Open-Science'),
      onboardingCompletedAt: 3000
    })
    expect(persisted).toMatchObject({ dataRoot: complete.dataRoot, onboardingCompletedAt: 3000 })
  })

  it('does not mark completion or recreate a saved root removed during onboarding', async () => {
    const { preferences, repository } = await createModule()
    const selected = join(roots.at(-1)!, 'Open-Science')
    await repository.setDataRoot({ dataRoot: selected })
    await expect(preferences.markOnboardingComplete()).rejects.toThrow(/missing/)
    expect((await repository.getSettings()).onboardingCompletedAt).toBeUndefined()
    expect((await repository.getSettings()).dataRoot).toBe(selected)
  })

  it('does not commit a different saved choice over the running root at Finish', async () => {
    const { preferences, repository } = await createModule()
    const other = join(roots.at(-1)!, 'other-research')
    await mkdir(other)
    await repository.setDataRoot({ dataRoot: other })
    await expect(preferences.markOnboardingComplete()).rejects.toThrow(/location changed/)
    expect((await repository.getSettings()).onboardingCompletedAt).toBeUndefined()
    expect((await repository.getSettings()).dataRoot).toBe(other)
  })

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
