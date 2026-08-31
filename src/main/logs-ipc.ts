import { shell } from 'electron'

import { ipcMainHandle } from './ipc-handler-registry'

import { getLogFileStatus } from './logger'
import type { LogFileStatus, OpenLogFileResult, RevealLogFileResult } from '../shared/logs'

type LogsCommandOwner = Readonly<{
  getStatus: () => Promise<LogFileStatus>
  openFile: () => Promise<OpenLogFileResult>
  revealInFolder: () => Promise<RevealLogFileResult>
}>

const createLogsCommandOwner = (): LogsCommandOwner => ({
  getStatus: () => getLogFileStatus(),
  openFile: async (): Promise<OpenLogFileResult> => {
    const status = await getLogFileStatus()

    if (!status.path || !status.existing) {
      return { opened: false, error: 'No log file is available yet.' }
    }

    // shell.openPath resolves to '' on success or an error string on failure.
    const error = await shell.openPath(status.path)

    return error ? { opened: false, error } : { opened: true }
  },
  revealInFolder: async (): Promise<RevealLogFileResult> => {
    const status = await getLogFileStatus()

    if (!status.path || !status.existing) {
      return { revealed: false, error: 'No log file is available yet.' }
    }

    // Electron returns void here, so the only observable guarantee is that the file existed
    // immediately before the shell request.
    shell.showItemInFolder(status.path)

    return { revealed: true }
  }
})

// Renderer-callable diagnostics surface. Local-only Host gates remain in the Host router; this
// adapter only shares the same injectable command owner with Electron IPC.
const registerLogsIpcHandlers = (
  owner: LogsCommandOwner = createLogsCommandOwner()
): LogsCommandOwner => {
  ipcMainHandle('logs:get-status', () => owner.getStatus())
  ipcMainHandle('logs:open-file', () => owner.openFile())
  ipcMainHandle('logs:reveal-in-folder', () => owner.revealInFolder())
  return owner
}

export type { LogsCommandOwner }
export { registerLogsIpcHandlers, createLogsCommandOwner }
