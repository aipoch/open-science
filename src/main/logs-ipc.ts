import { shell } from 'electron'

import { ipcMainHandle } from './ipc-handler-registry'

import { getLogFilePath } from './logger'
import type { OpenLogFileResult, RevealLogFileResult } from '../shared/logs'

type LogsCommandOwner = Readonly<{
  getPath: () => string | null
  openFile: () => Promise<OpenLogFileResult>
  revealInFolder: () => RevealLogFileResult
}>

const createLogsCommandOwner = (): LogsCommandOwner => ({
  getPath: () => getLogFilePath() ?? null,
  openFile: async (): Promise<OpenLogFileResult> => {
    const path = getLogFilePath()

    if (!path) return { opened: false, error: 'No log file is available yet.' }

    // shell.openPath resolves to '' on success or an error string on failure.
    const error = await shell.openPath(path)

    return error ? { opened: false, error } : { opened: true }
  },
  revealInFolder: (): RevealLogFileResult => {
    const path = getLogFilePath()

    if (!path) return { revealed: false, error: 'No log file is available yet.' }

    // Opens the containing folder with the log file selected; returns void, so success is assumed.
    shell.showItemInFolder(path)

    return { revealed: true }
  }
})

// Renderer-callable diagnostics surface. Local-only Host gates remain in the Host router; this
// adapter only shares the same injectable command owner with Electron IPC.
const registerLogsIpcHandlers = (
  owner: LogsCommandOwner = createLogsCommandOwner()
): LogsCommandOwner => {
  ipcMainHandle('logs:get-path', () => owner.getPath())
  ipcMainHandle('logs:open-file', () => owner.openFile())
  ipcMainHandle('logs:reveal-in-folder', () => owner.revealInFolder())
  return owner
}

export type { LogsCommandOwner }
export { registerLogsIpcHandlers, createLogsCommandOwner }
