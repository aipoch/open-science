import { APP } from '../../shared/app-config'
import type {
  AppInfo,
  UpdateApplyOptions,
  UpdateDownloadOptions,
  UpdateStatus
} from '../../shared/update'
import type { UpdateStrategy } from './strategy'
type UpdateCommandOwner = Readonly<{
  getAppInfo: () => AppInfo
  getStatus: () => UpdateStatus
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
  getStatus: () => strategy.getStatus(),
  check: () => strategy.check(),
  download: (options) => strategy.download(options),
  cancel: () => strategy.cancel(),
  apply: (options) => strategy.apply(options)
})

export { createUpdateCommandOwner }
export type { UpdateCommandOwner }
