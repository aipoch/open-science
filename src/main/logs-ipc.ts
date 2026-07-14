import { ipcMain, shell } from 'electron'

import { getLogFilePath } from './logger'
import type { OpenLogFileResult, RevealLogFileResult } from '../shared/logs'

// Renderer-callable diagnostics surface. Logs live only on this device and are never transmitted; the
// renderer can read the file path (to show it), open the file, or reveal it in its folder (to grab and
// attach when reporting a bug). "Open" targets the log file itself; "reveal" selects it in the folder.
const registerLogsIpcHandlers = (): void => {
  ipcMain.handle('logs:get-path', () => getLogFilePath() ?? null)

  ipcMain.handle('logs:open-file', async (): Promise<OpenLogFileResult> => {
    const path = getLogFilePath()

    if (!path) return { opened: false, error: 'No log file is available yet.' }

    // shell.openPath resolves to '' on success or an error string on failure.
    const error = await shell.openPath(path)

    return error ? { opened: false, error } : { opened: true }
  })

  ipcMain.handle('logs:reveal-in-folder', (): RevealLogFileResult => {
    const path = getLogFilePath()

    if (!path) return { revealed: false, error: 'No log file is available yet.' }

    // Opens the containing folder with the log file selected; returns void, so success is assumed.
    shell.showItemInFolder(path)

    return { revealed: true }
  })
}

export { registerLogsIpcHandlers }
