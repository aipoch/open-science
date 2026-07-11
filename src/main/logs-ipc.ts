import { ipcMain, shell } from 'electron'

import { getLogFilePath } from './logger'
import type { OpenLogFileResult } from '../shared/logs'

// Renderer-callable diagnostics surface. Logs live only on this device and are never transmitted; the
// renderer can read the file path (to show it) and ask the OS to open the file (to share when reporting
// a bug). "Open" targets the log file itself, not its folder.
const registerLogsIpcHandlers = (): void => {
  ipcMain.handle('logs:get-path', () => getLogFilePath() ?? null)

  ipcMain.handle('logs:open-file', async (): Promise<OpenLogFileResult> => {
    const path = getLogFilePath()

    if (!path) return { opened: false, error: 'No log file is available yet.' }

    // shell.openPath resolves to '' on success or an error string on failure.
    const error = await shell.openPath(path)

    return error ? { opened: false, error } : { opened: true }
  })
}

export { registerLogsIpcHandlers }
