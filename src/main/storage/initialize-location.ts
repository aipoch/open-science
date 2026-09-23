import { existsSync, statSync } from 'node:fs'
import { initDataRoot, resolveDataRoot } from '../storage-root'
import { SettingsDocumentStore } from '../settings/document-store'
import { SettingsRepository } from '../settings/repository'

// A saved root is authoritative. Completed installs without one retain historical routing;
// incomplete onboarding only offers the new default and never saves a root.
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
  if (settings.dataRoot === undefined && settings.onboardingCompletedAt !== undefined) {
    await repository.persistLegacyDataRoot(root, settings.onboardingCompletedAt)
    initDataRoot(root, settings.onboardingCompletedAt)
  }
}

export const prepareApplicationLocations = async (
  configRoot: string
): Promise<{ settingsStore: SettingsDocumentStore; repository: SettingsRepository }> => {
  const settingsStore = new SettingsDocumentStore(configRoot)
  const repository = new SettingsRepository(settingsStore)
  await initializeDataLocation(repository)
  return { settingsStore, repository }
}
