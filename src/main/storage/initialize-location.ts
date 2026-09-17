import { existsSync, statSync } from 'node:fs'
import { initDataRoot, resolveDataRoot } from '../storage-root'
import { SettingsDocumentStore } from '../settings/document-store'
import { SettingsRepository } from '../settings/repository'

// Settings alone determines the research location. Merely entering onboarding never saves a root.
export const initializeDataLocation = async (repository: SettingsRepository): Promise<void> => {
  const settings = await repository.getSettings()
  initDataRoot(settings.dataRoot, settings.onboardingCompletedAt)
  const root = resolveDataRoot()
  if (
    (settings.dataRoot !== undefined || settings.onboardingCompletedAt !== undefined) &&
    (!existsSync(root) || !statSync(root).isDirectory())
  )
    throw new Error(
      `The saved data location is missing or is not a directory: ${root}. Reconnect it before restarting.`
    )
}

export const prepareApplicationLocations = async (
  configRoot: string
): Promise<{ settingsStore: SettingsDocumentStore; repository: SettingsRepository }> => {
  const settingsStore = new SettingsDocumentStore(configRoot)
  const repository = new SettingsRepository(settingsStore)
  await initializeDataLocation(repository)
  return { settingsStore, repository }
}
