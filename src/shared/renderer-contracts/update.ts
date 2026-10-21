import type { DownloadProgress } from '@aipoch/resilient-download'
// Ordered fragments keep the public registration order when capabilities interleave.
import type { AppInfo, ManualInstallInfo, UpdateApplyOptions, UpdateStatus } from '../update'

import { callable, LOCAL, type RemoveListener, EVENT } from './definition'

export const updateApplyContracts = {
  'update.getManualInstall': callable<() => Promise<ManualInstallInfo>>()('update', [
    'update:get-manual-install',
    LOCAL
  ]),
  'update.revealManualInstaller': callable<() => Promise<ManualInstallInfo>>()('update', [
    'update:reveal-manual-installer',
    LOCAL
  ]),
  'update.recheck': callable<() => Promise<UpdateStatus>>()('update', ['update:recheck', LOCAL]),
  'update.recover': callable<() => Promise<UpdateStatus>>()('update', ['update:recover', LOCAL]),
  'update.apply': callable<(options?: UpdateApplyOptions) => Promise<UpdateStatus>>()('update', [
    'update:apply',
    LOCAL
  ]),
  'update.cancel': callable<() => Promise<UpdateStatus>>()('update', ['update:cancel', LOCAL]),
  'update.check': callable<() => Promise<UpdateStatus>>()('update', ['update:check']),
  'update.download': callable<() => Promise<UpdateStatus>>()('update', ['update:download', LOCAL]),
  'update.getAppInfo': callable<() => Promise<AppInfo>>()('update', ['update:get-app-info']),
  'update.getStatus': callable<() => Promise<UpdateStatus>>()('update', ['update:get-status'])
} as const

export const updateOnProgressContracts = {
  'update.onProgress': callable<
    (listener: (progress: DownloadProgress) => void) => RemoveListener
  >()('update', ['update:progress', EVENT]),
  'update.onStatus': callable<(listener: (status: UpdateStatus) => void) => RemoveListener>()(
    'update',
    ['update:status', EVENT]
  )
} as const
