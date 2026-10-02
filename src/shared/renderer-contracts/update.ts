// Ordered fragments keep the public registration order when capabilities interleave.
import type { AppInfo, DownloadProgress, UpdateApplyOptions, UpdateStatus } from '../update'

import { callable, LOCAL, type RemoveListener, EVENT } from './definition'

export const updateApplyContracts = {
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
