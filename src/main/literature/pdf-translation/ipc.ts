import { callerLeaseForEvent } from '../../caller-lifecycle'
import { callerContextForEvent } from '../../caller-context'
import { ipcMainHandle } from '../../ipc-handler-registry'
import type { ApplicationCommandHandler } from '../../application-command-router'
import { createPdfTranslationHandlers } from './application-commands'
import type { PdfTranslationOwner } from './index'

export const registerPdfTranslationIpc = (owner: PdfTranslationOwner): void => {
  for (const [channel, handler] of Object.entries(createPdfTranslationHandlers(owner))) {
    ipcMainHandle(channel, (event, ...args) =>
      (handler as ApplicationCommandHandler<readonly unknown[], unknown>)({
        args,
        callerContext: callerContextForEvent(event),
        callerLease: callerLeaseForEvent(event)
      })
    )
  }
}
