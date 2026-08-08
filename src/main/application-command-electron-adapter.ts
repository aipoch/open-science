import type { IpcMainInvokeEvent } from 'electron'

import {
  toApplicationCommandErrorEnvelope,
  type ApplicationCommandOutcome
} from '../shared/application-command-contract'
import { ELECTRON_APPLICATION_COMMAND_CHANNELS } from '../shared/renderer-contract-catalog'
import type { ApplicationCommandByNameDispatcher } from './application-command-composition'
import type { ApplicationInvocation } from './application-command-router'
import { callerContextForEvent } from './caller-context'
import { callerLeaseForEvent } from './caller-lifecycle'
import {
  invokeWithIpcRejectionDiagnostics,
  type IpcRejectionLogger
} from './diagnostics/ipc-rejection'
import { ipcMainHandle } from './ipc-handler-registry'
import { createLogger } from './logger'

const registerApplicationCommandElectronAdapter = (
  dispatcher: ApplicationCommandByNameDispatcher,
  log: IpcRejectionLogger = createLogger('ipc')
): void => {
  const channels = ELECTRON_APPLICATION_COMMAND_CHANNELS
  if (channels.join('\n') !== [...dispatcher.commandNames()].sort().join('\n')) {
    throw new Error('Electron Application Command adapter inventory mismatch.')
  }
  for (const channel of channels) {
    ipcMainHandle(channel, async (event, ...args): Promise<ApplicationCommandOutcome<unknown>> => {
      const ipcEvent = event as IpcMainInvokeEvent
      const callerContext = callerContextForEvent(ipcEvent)
      const invocation: ApplicationInvocation<readonly unknown[]> = Object.freeze({
        callerContext,
        callerLease: callerLeaseForEvent(ipcEvent),
        args: Object.freeze([...args])
      })
      try {
        const result = await invokeWithIpcRejectionDiagnostics({
          channel,
          callerContext,
          invoke: () => dispatcher.invoke(channel, invocation),
          log
        })
        return Object.freeze({ ok: true, result })
      } catch (error) {
        return Object.freeze({ ok: false, error: toApplicationCommandErrorEnvelope(error) })
      }
    })
  }
}

export { registerApplicationCommandElectronAdapter }
