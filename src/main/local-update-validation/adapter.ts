import {
  appendFileSync,
  createReadStream,
  readFileSync,
  realpathSync,
  lstatSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { app, session, shell } from 'electron'
import { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { findFile } from 'electron-updater/out/providers/Provider'
import { ElectronUpdaterStrategy } from '../update/electron-updater-strategy'
import type { CreateStrategyOptions } from '../update/create-strategy'
import type { UpdateStatus } from '../../shared/update'
import { UpdateLifecycleError } from '../../shared/update'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { RuntimeStartupOptions } from '../desktop-runtime-info'
import { assertLocalUpdateUrl, readLocalUpdateValidationConfig } from './config'
import { verifyLocalUpdateCredentialScope } from './credentials'
import { inspectValidationManualInstaller } from './manual-installer'
import type { ManualInstallerOptions } from '../update/manual-install'

// AppUpdater owns the same provider discovery, streaming download and SHA512 verification used by
// MacUpdater. Its native Squirrel bridge normally starts during download; omit that bridge entirely.
export class LocalMacDownloadUpdater extends AppUpdater {
  lastDownloadUsedNetwork = false
  private readonly downloadExecutor = new ElectronHttpExecutor()
  constructor(feedUrl: string, cacheRoot: string, metadata: string) {
    super({ provider: 'generic', url: feedUrl, useMultipleRangeRequest: false })
    Object.defineProperties(this.app, {
      baseCachePath: { value: cacheRoot },
      appUpdateConfigPath: { value: metadata }
    })
  }
  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    this.lastDownloadUsedNetwork = false
    const { info, provider } = options.updateInfoAndProvider
    const file = findFile(provider.resolveFiles(info), 'zip', ['pkg', 'dmg'])
    if (!file) throw new Error('The local macOS feed has no ZIP artifact.')
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo: file,
      downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        const result = await this.downloadExecutor.download(file.url, destination, downloadOptions)
        this.lastDownloadUsedNetwork = true
        return result
      },
      done: async (event) => this.dispatchUpdateDownloaded(event)
    })
  }
  quitAndInstall(): never {
    throw new Error('Native installation is disabled in this validation build.')
  }
}

export type LocalUpdateValidation = {
  config: ReturnType<typeof readLocalUpdateValidationConfig>
  record(type: string, fields?: Record<string, unknown>): void
  assertConfiguration(startup: RuntimeStartupOptions): void
  runtimeStopped(fields: Record<string, unknown>): void
  runtimeRecovered(fields: Record<string, unknown>): void
  createStrategy(options: CreateStrategyOptions): ElectronUpdaterStrategy
  manualInstallerOptions: ManualInstallerOptions
}

declare const __OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CREDENTIAL_SANDBOX__: boolean

export function initializeLocalUpdateValidation(path: string): LocalUpdateValidation {
  if (process.platform !== 'darwin' || !app.isPackaged)
    throw new Error('Local update validation requires a packaged macOS test build.')
  const config = readLocalUpdateValidationConfig(path)
  const sandbox =
    typeof __OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CREDENTIAL_SANDBOX__ !== 'undefined' &&
    __OPEN_SCIENCE_LOCAL_UPDATE_VALIDATION_CREDENTIAL_SANDBOX__
  if (sandbox !== (config.credentialMode === 'sandbox'))
    throw new Error('Validation credential build/config mismatch.')
  const credentialScope = sandbox
    ? {
        isolated: true,
        mode: 'local-update-credential-sandbox',
        productionCredentialAcceptance: false
      }
    : verifyLocalUpdateCredentialScope(config)
  const settingsPath = join(config.configRoot, 'settings.json')
  if (JSON.parse(readFileSync(settingsPath, 'utf8')).dataRoot !== config.dataRoot)
    throw new Error(
      'The local validation fixture must select its isolated data root before startup.'
    )
  app.setPath('home', config.homeRoot)
  process.env.HOME = config.homeRoot
  process.env.OPEN_SCIENCE_CONFIG_ROOT = config.configRoot
  process.env.OPEN_SCIENCE_USER_DATA = config.userDataRoot
  // The backend inherits the exact isolated roots; its persisted settings select dataRoot.
  const record = (type: string, fields: Record<string, unknown> = {}): void => {
    appendFileSync(
      config.eventsPath,
      JSON.stringify({
        schema: 1,
        type,
        at: new Date().toISOString(),
        runId: config.runId,
        scenario: config.scenario,
        ...fields
      }) + '\n',
      { mode: 0o600 }
    )
  }
  record('credential-scope-verified', credentialScope)
  record('application-started', { pid: process.pid, version: app.getVersion() })
  app.once('quit', () => record('application-quit', { pid: process.pid }))
  const assertConfiguration = (startup: RuntimeStartupOptions): void => {
    if (
      startup.configRoot !== config.configRoot ||
      startup.profilePath !== config.userDataRoot ||
      startup.dataRoot !== config.dataRoot
    )
      throw new Error('Runtime roots do not match the isolated local validation configuration.')
  }
  let stopped: Record<string, unknown> | undefined
  let verified: { localPath: string; artifactSha512: string } | undefined
  return {
    config,
    record,
    manualInstallerOptions: {
      manualInstallStorePath: join(config.userDataRoot, 'manual-update-artifact.json'),
      verifyManualInstallerSignature: async (artifact) => {
        await inspectValidationManualInstaller(artifact, config)
        record('manual-artifact-verified', {
          path: artifact.path,
          version: artifact.version,
          checksum: artifact.checksum,
          verification: 'test-channel-ad-hoc-archive'
        })
      },
      revealManualInstallerFile: (path) => {
        shell.showItemInFolder(path)
        // Invocation is not proof of Finder selection, and never means installation succeeded.
        record('manual-file-reveal-invoked', {
          path,
          nativeInstallInvoked: false,
          targetStarted: false
        })
      }
    },
    assertConfiguration,
    runtimeStopped(fields: Record<string, unknown>): void {
      stopped = fields
      record('runtime-stopped', fields)
    },
    runtimeRecovered(fields: Record<string, unknown>): void {
      stopped = undefined
      record('runtime-recovered', fields)
    },
    createStrategy(options: CreateStrategyOptions): ElectronUpdaterStrategy {
      const origin = assertLocalUpdateUrl(config.feedUrl).origin
      // This partition belongs only to electron-updater. Check every request, including redirects.
      session
        .fromPartition('electron-updater', { cache: false })
        .webRequest.onBeforeRequest((details, callback) => {
          try {
            assertLocalUpdateUrl(details.url, origin)
            callback({ cancel: false })
          } catch {
            record('source-rejected', { url: details.url })
            callback({ cancel: true })
          }
        })
      const metadata = join(config.configRoot, 'local-update-validation-updater.yml')
      writeFileSync(metadata, 'updaterCacheDirName: local-update-validation\n', { mode: 0o600 })
      const updater = new LocalMacDownloadUpdater(config.feedUrl, config.updateCacheRoot, metadata)
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.disableDifferentialDownload = true
      updater.on('update-downloaded', (event) => {
        const match = event.files.filter((file) => file.url.split('?')[0].endsWith('.zip'))
        if (match.length === 1) {
          verified = { localPath: event.downloadedFile, artifactSha512: match[0].sha512 }
          record('download-verified', {
            ...verified,
            networkTransferred: updater.lastDownloadUsedNetwork,
            checksumAlgorithm: 'sha512'
          })
        }
      })
      return new ElectronUpdaterStrategy({
        ...options,
        updater,
        platform: 'darwin',
        manifestUrl: config.manifestUrl,
        fetchImpl: async (input, init) => {
          assertLocalUpdateUrl(String(input), origin)
          return fetch(input, { ...init, redirect: 'error' })
        },
        broadcast: (channel, payload) => {
          if (
            channel === 'update:status' &&
            ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(
              (payload as UpdateStatus).reason ?? ''
            )
          )
            record('runtime-stop-failed', { status: payload })
          record(
            channel === 'update:status' ? 'update-status' : 'update-progress',
            channel === 'update:status' ? { status: payload } : { progress: payload }
          )
          broadcastToRenderers(channel, payload)
        },
        beforeInstallHandoff: async (status: UpdateStatus) => {
          if (
            !stopped ||
            !verified ||
            status.localPath !== verified.localPath ||
            status.artifactSha512 !== verified.artifactSha512
          )
            throw new Error(
              'The validated download and confirmed runtime stop are required before handoff.'
            )
          const inside = relative(config.updateCacheRoot, verified.localPath)
          if (inside === '..' || inside.startsWith(`..${sep}`))
            throw new Error('Artifact escaped isolated cache.')
          if (
            realpathSync(verified.localPath) !== verified.localPath ||
            !lstatSync(verified.localPath).isFile()
          )
            throw new Error(
              'The downloaded artifact must be a regular file inside the isolated cache.'
            )
          const hash = createHash('sha512')
          for await (const chunk of createReadStream(verified.localPath)) hash.update(chunk)
          if (hash.digest('base64') !== verified.artifactSha512)
            throw new Error('Downloaded artifact changed before handoff.')
          record(config.installBehavior === 'fail' ? 'handoff-failure' : 'handoff-boundary', {
            ...verified,
            stop: stopped,
            nativeInstallInvoked: false,
            targetStarted: false,
            injected: config.installBehavior === 'fail'
          })
          throw new UpdateLifecycleError(
            'install-failed',
            config.installBehavior === 'fail'
              ? 'Local validation injected an installation handoff failure. Restore the service to continue.'
              : 'Local validation reached the installation handoff boundary. Restore the service to continue.',
            {
              phase: 'stopped',
              runtime: 'stopped-clean',
              installation: 'unchanged',
              canCancel: true,
              canRecover: true,
              canRetryInstall: false
            }
          )
        },
        executeInstall: async () => {
          throw new Error('Native installation is disabled in local validation.')
        }
      })
    }
  }
}
