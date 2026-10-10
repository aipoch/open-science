import { runtimeMetadata } from '../runtime-metadata'
import { join } from 'node:path'
import type { ApplicationEvents } from '../application-events'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { createLogger, diagnosticErrorFields, errorLogFields } from '../logger'
import { removeMicromambaCacheForRoot } from '../notebook/micromamba-cache'
import { certifyNativeShell } from '../notebook/native-shell-certification'
import { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import { removeNotebookWorkloadCache } from '../notebook/notebook-workload-cache-paths'
import { createNotificationInboxController } from '../notifications/notification-inbox-controller'
import { NotificationInboxDbRepository } from '../notifications/notification-inbox-repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { NetworkProxyRuntime } from '../settings/network-proxy-runtime'
import { SettingsService } from '../settings/service'
import {
  computeDefaultDataRoot,
  initDataRoot,
  resolveConfigRoot,
  resolveDataRoot,
  samePath
} from '../storage-root'
import { DataRootCleanupJournal, createDataRootSourceCleanup } from '../storage/data-root-cleanup'
import { createWslNpmMigration } from '../storage/wsl-npm-migration'
import {
  initializeDataRootWriteAvailability,
  runDataRootStartupRecovery
} from '../storage/migration-state'
import { isDataRootMissing } from '../storage/path-presence'
import { runPackagedWsl2RestartCertification } from '../wsl/wsl2-packaged-restart-certification'
import { wsl2BashPreviewStatus } from '../wsl/wsl2-preview-gate'

export async function composeStorageStartup({
  applicationEvents,
  networkProxyRuntime,
  notebookNetworkSandbox,
  settingsService,
  headless,
  composition
}: {
  applicationEvents: ApplicationEvents
  networkProxyRuntime: NetworkProxyRuntime
  notebookNetworkSandbox: NotebookNetworkSandboxOwner
  settingsService: SettingsService
  headless: boolean
  composition: DiagnosticOperation
}): Promise<{
  storedSettings: import('../settings/types').StoredSettings
  storageLog: ReturnType<typeof createLogger>
  dataRootCleanupJournal: DataRootCleanupJournal
  cleanupDataRootSources: ReturnType<typeof createDataRootSourceCleanup>
  notificationInbox: ReturnType<typeof createNotificationInboxController>
}> {
  const storedSettings = await settingsService.getStoredSettings()
  const storageLog = createLogger('storage')
  await networkProxyRuntime.apply(storedSettings.networkProxy)
  await certifyNativeShell({
    appPackaged: runtimeMetadata().packaged,
    headless,
    storageRoot: resolveConfigRoot(),
    environment: process.env,
    processSandbox: notebookNetworkSandbox
  })
  await runPackagedWsl2RestartCertification({
    appPackaged: runtimeMetadata().packaged,
    headless,
    platform: process.platform,
    arch: process.arch,
    previewAvailable: wsl2BashPreviewStatus().available,
    storageRoot: resolveConfigRoot(),
    environment: process.env,
    processSandbox: notebookNetworkSandbox
  })
  // Prime the data-root cache from settings before any data repository is constructed below. A change
  // to this value only takes effect after a restart, so reading it once here is sufficient.
  initDataRoot(storedSettings.dataRoot, storedSettings.onboardingCompletedAt)
  const configuredDataRootMissing =
    (Boolean(storedSettings.dataRoot) || storedSettings.onboardingCompletedAt !== undefined) &&
    (await isDataRootMissing(resolveDataRoot()))
  initializeDataRootWriteAvailability(configuredDataRootMissing)
  const npmMigration = createWslNpmMigration(
    async () => (await settingsService.getStoredSettings()).activatedWslSelection
  )
  const dataRootCleanupJournal = new DataRootCleanupJournal(resolveConfigRoot(), npmMigration)
  const cleanupDataRootSources = createDataRootSourceCleanup(
    (runtimeRoot) => notebookNetworkSandbox.revokeManagedRAccess(runtimeRoot),
    npmMigration
  )
  await runDataRootStartupRecovery(
    async () => {
      const cleanup = await dataRootCleanupJournal.recover(
        resolveDataRoot(),
        cleanupDataRootSources,
        (sourceRoot) => {
          const runtimeRoot = join(sourceRoot, 'runtime')
          const workloadRemoved = removeNotebookWorkloadCache(runtimeRoot)
          const micromambaRemoved = removeMicromambaCacheForRoot(runtimeRoot)
          return workloadRemoved && micromambaRemoved
        }
      )
      if (cleanup.pending) {
        storageLog.warn('old data root cleanup remains pending', {
          cleanupFailureCount: cleanup.failureCount
        })
      }
    },
    {
      reportFailure: (error) =>
        storageLog.warn('old data root cleanup recovery failed', diagnosticErrorFields(error))
    }
  )
  const notificationInbox = createNotificationInboxController({
    repository: new NotificationInboxDbRepository(() => getProjectDbClient(resolveConfigRoot())),
    onChanged: (event) => applicationEvents.publish('notifications:changed', event),
    onError: (error) =>
      createLogger('notifications').warn('message center operation failed', errorLogFields(error))
  })
  await notificationInbox.restore()
  // Record only the location class. Absolute paths (including reversible code-point renderings) can
  // expose usernames and folder names in a support bundle.
  storageLog.info('data root resolved', {
    location: samePath(resolveDataRoot(), computeDefaultDataRoot()) ? 'default' : 'custom'
  })
  composition.phase('data-root')
  return {
    storedSettings,
    storageLog,
    dataRootCleanupJournal,
    cleanupDataRootSources,
    notificationInbox
  }
}
