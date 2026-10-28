import { APP } from '../../shared/app-config'
import type {
  AppInfo,
  UpdateApplyOptions,
  UpdateDownloadOptions,
  UpdateInstaller,
  UpdateInstallerRevealResult,
  UpdateStatus
} from '../../shared/update'
import type { UpdateStrategy } from './strategy'
type UpdateCommandOwner = Readonly<{
  getAppInfo: () => AppInfo
  recheck: () => Promise<UpdateStatus>
  recover: () => Promise<UpdateStatus>
  getStatus: () => UpdateStatus
  getInstaller: () => Promise<UpdateInstaller | null>
  revealInstaller: () => Promise<UpdateInstallerRevealResult>
  check: () => Promise<UpdateStatus>
  download: (options?: UpdateDownloadOptions) => Promise<UpdateStatus>
  cancel: () => Promise<UpdateStatus>
  apply: (options?: UpdateApplyOptions) => Promise<UpdateStatus>
}>

const createUpdateCommandOwner = (strategy: UpdateStrategy): UpdateCommandOwner => ({
  getAppInfo: (): AppInfo => ({
    name: APP.name,
    version: strategy.getStatus().current,
    copyright: APP.copyright
  }),
  recheck: () => strategy.recheck?.() ?? Promise.resolve(strategy.getStatus()),
  recover: () => strategy.recover?.() ?? Promise.resolve(strategy.getStatus()),
  getStatus: () => strategy.getStatus(),
  getInstaller: () => strategy.getInstaller(),
  revealInstaller: () => strategy.revealInstaller(),
  check: () => strategy.check(),
  download: (options) => strategy.download(options),
  cancel: () => strategy.cancel(),
  apply: (options) => strategy.apply(options)
})

export { createUpdateCommandOwner }
export type { UpdateCommandOwner }
