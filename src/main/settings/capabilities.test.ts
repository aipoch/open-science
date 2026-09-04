import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { NotebookRuntimeSettingsModule } from './notebook-runtime-settings'
import { SettingsPreferencesModule } from './preferences'
import { SettingsRepository } from './repository'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Settings capabilities', () => {
  it('share one repository writer without changing the stored document shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'settings-capabilities-'))
    roots.push(root)
    const repository = new SettingsRepository(root)
    const preferences = new SettingsPreferencesModule(repository)
    const notebook = new NotebookRuntimeSettingsModule(repository)

    await Promise.all([
      preferences.setNotificationsEnabled(false),
      preferences.setShowNotificationContent(true),
      preferences.setClosePreference('minimize'),
      notebook.setPackageMirror({ pypiIndex: 'https://pypi.example/simple' })
    ])

    expect(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))).toEqual({
      version: SETTINGS_FILE_VERSION,
      providers: [],
      notificationsEnabled: false,
      showNotificationContent: true,
      closePreference: 'minimize',
      packageMirror: { pypiIndex: 'https://pypi.example/simple' },
      subagentModel: { mode: 'inherit' },
      reviewerModel: { mode: 'inherit' },
      sessionDetailsModel: { mode: 'inherit', reasoningEffort: 'low' }
    })
  })
})
