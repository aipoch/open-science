import { contextBridge, ipcRenderer } from 'electron'

import {
  MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL,
  MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL,
  type MacInstallationAssistantAction,
  type MacInstallationAssistantResult
} from '../shared/mac-installation'

const send = (action: Exclude<MacInstallationAssistantAction, 'install'>): void => {
  ipcRenderer.send(MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL, action)
}

const install = (): Promise<MacInstallationAssistantResult> =>
  new Promise((resolve) => {
    ipcRenderer.once(MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL, (_event, result) => {
      resolve(result as MacInstallationAssistantResult)
    })
    ipcRenderer.send(MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL, 'install')
  })

contextBridge.exposeInMainWorld('installationAssistant', {
  continueUsing: () => send('continue'),
  install,
  restart: () => send('restart'),
  showInFinder: () => send('show-in-finder')
})
