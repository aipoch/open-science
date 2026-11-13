import { contextBridge, ipcRenderer } from 'electron'
import { FILE_DIALOG_UI_CHANNEL, type FileDialogUiBridge } from '../shared/file-dialog-ui'

// The save window exposes only destination selection, never the desktop API or file contents.
const bridge: FileDialogUiBridge = {
  action: (action) => ipcRenderer.invoke(FILE_DIALOG_UI_CHANNEL, action)
}
contextBridge.exposeInMainWorld('fileDialog', bridge)
