import { BrowserWindow } from 'electron'
import type { ApplicationEventChannel, ApplicationEventMap } from './application-events'
import { addRendererBroadcastSink } from './renderer-broadcast'
import { createLogger, errorLogFields } from './logger'
const log = createLogger('renderer-broadcast')

const projectToElectron = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    } catch (error) {
      // Destruction can race the liveness check. One failed window must not starve its peers.
      log.warn('Could not deliver application event to renderer', {
        channel,
        ...errorLogFields(error)
      })
    }
  }
}

export const installElectronBroadcast = (): (() => void) =>
  addRendererBroadcastSink(projectToElectron)
