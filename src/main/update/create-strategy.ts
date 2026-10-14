import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

import { app } from 'electron'

import { createLogger } from '@aipoch/diagnostics/node'
import { createMacInstallationGuard } from '../mac-installation'
import { ElectronUpdaterStrategy, type UpdateInstallationHooks } from './electron-updater-strategy'
import { UpdateService } from './service'
import type { InstallGate, UpdateStrategy } from './strategy'
import type { NativeTranslator } from '../locale/main-process-messages'

export type CreateStrategyOptions = UpdateInstallationHooks & {
  // Whether this is a packaged (installed) build. Defaults to app.isPackaged; injectable for tests.
  isPackaged?: boolean
  // Running app version. Defaults to app.getVersion(); injectable for tests.
  version?: string
  // Immutable pre-install backend shutdown gate for in-place strategies. The manual installer flow
  // ignores it because applying there does not quit or replace the running app.
  installGate?: InstallGate
  releaseInstallHandoff?: () => void
  translate?: NativeTranslator
}

const OFFICIAL_MAC_BUNDLE_ID = 'com.aipoch.open-science'
const OFFICIAL_MAC_TEAM_ID = '87G9WFU9H3'

// Read signing metadata as an initial compatibility filter for official macOS update discovery.
// This is not artifact trust verification or channel acceptance: protected installation preflight
// performs those checks separately. Local ad-hoc packages have no official TeamIdentifier.
const hasOfficialMacSignature = (): boolean => {
  const bundlePath = resolve(dirname(app.getPath('exe')), '../..')
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', bundlePath], {
    encoding: 'utf8'
  })
  if (result.status !== 0) return false

  const details = new Set(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/))
  return (
    details.has(`Identifier=${OFFICIAL_MAC_BUNDLE_ID}`) &&
    details.has(`TeamIdentifier=${OFFICIAL_MAC_TEAM_ID}`)
  )
}

// Only packaged official stable macOS builds select electron-updater discovery/downloads.
// Applying a downloaded update still requires the channel certification gate and the protected
// external executor; selecting this strategy does not authorize installation or invoke ShipIt.
const macCanAutoUpdate = (isPackaged: boolean, version: string): boolean =>
  isPackaged && !version.includes('-') && hasOfficialMacSignature()

// Selects discovery/download machinery, not permission to replace an installation. Windows/Linux
// and compatible macOS builds use electron-updater; other builds use the manifest download flow.
// Production apply is separately gated on native acceptance and supervised external installation.
export const createUpdateStrategy = (
  platform: NodeJS.Platform = process.platform,
  opts: CreateStrategyOptions = {}
): UpdateStrategy => {
  const log = createLogger('update')
  const createInPlaceStrategy = (): ElectronUpdaterStrategy =>
    new ElectronUpdaterStrategy({
      ...opts,
      installationGuard: createMacInstallationGuard(),
      ...(opts.installGate ? { installGate: opts.installGate } : {}),
      ...(opts.releaseInstallHandoff ? { releaseInstallHandoff: opts.releaseInstallHandoff } : {}),
      log
    })

  if (platform === 'win32' || platform === 'linux') return createInPlaceStrategy()

  const isPackaged = opts.isPackaged ?? app?.isPackaged ?? false
  const version = opts.version ?? app?.getVersion?.() ?? '0.0.0'
  if (platform === 'darwin' && macCanAutoUpdate(isPackaged, version)) {
    return createInPlaceStrategy()
  }
  return new UpdateService({ log, translate: opts.translate })
}
