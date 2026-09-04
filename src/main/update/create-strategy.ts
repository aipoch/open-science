import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

import { app } from 'electron'

import { createLogger } from '../logger'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { UpdateService } from './service'
import type { InstallGate, UpdateStrategy } from './strategy'
import type { NativeTranslator } from '../locale/main-process-messages'

export type CreateStrategyOptions = {
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

// Read the installed bundle's signing metadata without performing a trust evaluation. The latter can
// depend on machine policy/keychain state, while Squirrel.Mac only needs the current and replacement
// bundles to carry compatible designated requirements. Stable CI releases are signed by this bundle
// ID + Team ID; local packages are ad-hoc signed and report no TeamIdentifier.
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

// macOS in-place auto-update (electron-updater / Squirrel.Mac) only works on a packaged build that is
// signed with the same Developer ID as the replacement. CI signs stable mac builds; local packages
// and nightlies are ad-hoc, so ShipIt rejects an official replacement at apply time. Check the actual
// installed signature rather than inferring it from the version, and fail closed to the manual
// installer flow whenever compatibility cannot be established.
const macCanAutoUpdate = (isPackaged: boolean, version: string): boolean =>
  isPackaged && !version.includes('-') && hasOfficialMacSignature()

// Picks the update strategy for the host platform. Windows/Linux always get true in-place auto-update
// via electron-updater. macOS gets it too on signed stable builds (see macCanAutoUpdate); otherwise
// (dev, nightly, or any other platform) it falls back to the manifest installer flow (UpdateService).
export const createUpdateStrategy = (
  platform: NodeJS.Platform = process.platform,
  opts: CreateStrategyOptions = {}
): UpdateStrategy => {
  const log = createLogger('update')
  const createInPlaceStrategy = (): ElectronUpdaterStrategy =>
    new ElectronUpdaterStrategy({
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
