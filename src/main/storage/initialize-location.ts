import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import {
  hasDataRootContent,
  initDataRoot,
  resolveConfigRoot,
  resolveDataRoot
} from '../storage-root'
import { SettingsDocumentStore } from '../settings/document-store'
import { SettingsRepository } from '../settings/repository'
import { readElectronProfileRecord, writeElectronProfileRecord } from './electron-profile'

// All startup writers share the repository returned by prepareApplicationLocations. IPC keeps this
// idempotent check as a second defense, including resumption of an interrupted first-run commit.
export const initializeDataLocation = async (
  repository: SettingsRepository,
  existingInstallation?: boolean
): Promise<void> => {
  const settings = await repository.getSettings()
  const pending = readElectronProfileRecord(resolveConfigRoot())?.bootstrap
  if (pending && settings.dataRoot && settings.dataRoot !== pending.dataRoot)
    throw new Error(
      'The pending data location differs from settings.dataRoot. Restore the intended location before restarting.'
    )
  initDataRoot(settings.dataRoot ?? pending?.dataRoot, existingInstallation)
  if (!settings.dataRoot) {
    const root = resolveDataRoot()
    const fresh = pending?.createDataRoot ?? !hasDataRootContent(root)
    if (fresh) await mkdir(root, { recursive: true })
    else if (!existsSync(root)) throw new Error(`The saved data location is missing: ${root}`)
    await repository.pinInitialDataRoot(root, fresh)
  }
}

export const prepareApplicationLocations = async (options: {
  configRoot: string
  profilePath: string
  existingInstallation: boolean
}): Promise<{ settingsStore: SettingsDocumentStore; repository: SettingsRepository }> => {
  const settingsStore = new SettingsDocumentStore(options.configRoot)
  const repository = new SettingsRepository(settingsStore)
  const settings = await repository.getSettings()
  if (
    settings.dataRoot &&
    (!existsSync(settings.dataRoot) || !statSync(settings.dataRoot).isDirectory())
  )
    throw new Error(
      `The saved data location is missing or is not a directory: ${settings.dataRoot}. Reconnect it before restarting.`
    )
  let record = readElectronProfileRecord(options.configRoot)
  if (record?.bootstrap && record.path !== options.profilePath)
    throw new Error(
      'The pending Electron profile location differs from the selected profile. Restore the intended selection before restarting.'
    )
  if (!record?.bootstrap) {
    initDataRoot(settings.dataRoot, options.existingInstallation)
    const dataRoot = resolveDataRoot()
    record = {
      version: 1,
      path: options.profilePath,
      bootstrap: {
        dataRoot,
        createDataRoot: !settings.dataRoot && !hasDataRootContent(dataRoot),
        createProfile: !existsSync(options.profilePath)
      }
    }
    // One durable choice precedes all fresh profile/data directories and all application writers.
    await writeElectronProfileRecord(options.configRoot, record)
  }
  if (record.bootstrap?.createProfile) await mkdir(options.profilePath, { recursive: true })
  if (!existsSync(options.profilePath) || !statSync(options.profilePath).isDirectory())
    throw new Error(`The saved Electron profile location is missing: ${options.profilePath}`)
  await initializeDataLocation(repository, options.existingInstallation)
  await writeElectronProfileRecord(options.configRoot, { version: 1, path: options.profilePath })
  return { settingsStore, repository }
}
