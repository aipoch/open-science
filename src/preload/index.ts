import { contextBridge, ipcRenderer, webUtils } from 'electron'

import { unwrapApplicationCommandOutcome } from '../shared/application-command-contract'
import { announceWindowFindReady, subscribeCloseActivePane } from '../shared/window-controls'
import { createElectronRendererApi } from './electron-renderer-api'
import { createElectronRendererContractAdapter } from './electron-renderer-contract-adapter'
import {
  STARTUP_PRESENTATION_CHANNEL,
  type StartupPresentationPhase
} from '../shared/startup-presentation'

const electronRendererContracts = createElectronRendererContractAdapter({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
  getPathForFile: (file) => webUtils.getPathForFile(file as File)
})

// Ordinary request, send, and subscription wrappers project directly from the typed renderer
// contract. These overrides are the only Electron behaviors that are not described by those three
// dispatch policies: process values, one transitional outcome envelope, and lifecycle handshakes.
const api = createElectronRendererApi(electronRendererContracts, {
  platform: process.platform,
  getRuntimeVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }),
  'sessions.saveSession': async (session, options) =>
    unwrapApplicationCommandOutcome(
      await electronRendererContracts.invoke('sessions.saveSession', session, options)
    ),
  'remoteAccess.onChanged': (listener) =>
    electronRendererContracts.subscribe('remoteAccess.onChanged', () => (listener as () => void)()),
  'window.onCloseActivePane': (listener) =>
    subscribeCloseActivePane(
      {
        on: (channel, paneListener) => {
          ipcRenderer.on(channel, paneListener)
          return () => ipcRenderer.removeListener(channel, paneListener)
        },
        send: (channel) => ipcRenderer.send(channel)
      },
      listener
    ),
  'window.announceWindowFindReady': () =>
    announceWindowFindReady({ send: (channel) => ipcRenderer.send(channel) })
})

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
    // Bootstrap lifecycle signal only: no application data or arbitrary IPC access.
    contextBridge.exposeInMainWorld('startupPresentation', {
      phase: (phase: StartupPresentationPhase) =>
        ipcRenderer.send(STARTUP_PRESENTATION_CHANNEL, phase)
    })
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (declared in renderer-api.d.ts)
  window.api = api
}
