import { APP } from '../../shared/app-config'
import type {
  AppInfo,
  ManualInstallInfo,
  UpdateApplyOptions,
  UpdateDownloadOptions,
  UpdateStatus
} from '../../shared/update'
import type { UpdateStrategy } from './strategy'
type UpdateCommandOwner = Readonly<{
  getManualInstall: () => Promise<ManualInstallInfo>
  revealManualInstaller: () => Promise<ManualInstallInfo>
  getAppInfo: () => AppInfo
  recheck: () => Promise<UpdateStatus>
  recover: () => Promise<UpdateStatus>
  getStatus: () => UpdateStatus
  check: () => Promise<UpdateStatus>
  download: (options?: UpdateDownloadOptions) => Promise<UpdateStatus>
  cancel: () => Promise<UpdateStatus>
  apply: (options?: UpdateApplyOptions) => Promise<UpdateStatus>
}>

const blocked = (strategy: UpdateStrategy): ManualInstallInfo => ({
  kind: 'blocked',
  identity: 'unavailable',
  platform:
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
  arch: process.arch,
  version: strategy.getStatus().latest
})
const createUpdateCommandOwner = (strategy: UpdateStrategy): UpdateCommandOwner => ({
  getManualInstall: () => strategy.getManualInstall?.() ?? Promise.resolve(blocked(strategy)),
  revealManualInstaller: () =>
    strategy.revealManualInstaller?.() ?? Promise.resolve(blocked(strategy)),
  getAppInfo: (): AppInfo => ({
    name: APP.name,
    version: strategy.getStatus().current,
    copyright: APP.copyright
  }),
  recheck: () => strategy.recheck?.() ?? Promise.resolve(strategy.getStatus()),
  recover: () => strategy.recover?.() ?? Promise.resolve(strategy.getStatus()),
  getStatus: () => strategy.getStatus(),
  check: () => strategy.check(),
  download: (options) => strategy.download(options),
  cancel: () => strategy.cancel(),
  apply: (options) => strategy.apply(options)
})

export { createUpdateCommandOwner }
export type { UpdateCommandOwner }
