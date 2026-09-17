import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { hasDataRootContent, initDataRoot, resolveDataRoot } from '../storage-root'
import { SettingsDocumentStore } from '../settings/document-store'
import { SettingsRepository } from '../settings/repository'

// Settings is the sole saved location and onboarding state. Reuse the same document owner for
// locale/IPC writes, and pin a default only when no dataRoot has been saved yet.
export const initializeDataLocation = async (repository: SettingsRepository): Promise<void> => {
  const settings = await repository.getSettings()
  if (
    settings.dataRoot &&
    (!existsSync(settings.dataRoot) || !statSync(settings.dataRoot).isDirectory())
  )
    throw new Error(
      `The saved data location is missing or is not a directory: ${settings.dataRoot}. Reconnect it before restarting.`
    )
  initDataRoot(settings.dataRoot)
  if (!settings.dataRoot) {
    const root = resolveDataRoot()
    const fresh = !hasDataRootContent(root)
    await mkdir(root, { recursive: true })
    await repository.pinInitialDataRoot(root, fresh)
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
