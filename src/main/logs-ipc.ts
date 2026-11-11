import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveConfigRoot } from './storage-root'
import { desktopShellInteraction } from './desktop-interaction'

import { ipcMainHandle } from './ipc-handler-registry'

import { getLogFileStatus } from '@aipoch/diagnostics/node'
import type {
  LogFileStatus,
  OpenLogFileResult,
  RevealLogFileResult,
  StartupLogFile
} from '../shared/logs'

type LogsCommandOwner = Readonly<{
  getStatus: () => Promise<LogFileStatus>
  openFile: (name?: string) => Promise<OpenLogFileResult>
  revealInFolder: (name?: string) => Promise<RevealLogFileResult>
}>

const createLogsCommandOwner = (): LogsCommandOwner => {
  const startupFiles = async (): Promise<StartupLogFile[]> => {
    try {
      const root = await realpath(resolveConfigRoot())
      const directory = join(root, 'logs')
      if ((await lstat(directory)).isSymbolicLink()) return []
      const files: StartupLogFile[] = []
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const match = /^desktop-backend-\d{1,10}-(\d{13})\.log$/.exec(entry.name)
        if (entry.isFile() && match) {
          files.push({
            name: entry.name,
            path: join(directory, entry.name),
            startedAt: Number(match[1])
          })
        }
      }
      return files.sort((a, b) => b.startedAt - a.startedAt || b.name.localeCompare(a.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const selectedStatus = async (name?: string): Promise<LogFileStatus> => {
    if (name === undefined) return getLogFileStatus()
    const file =
      typeof name === 'string'
        ? (await startupFiles()).find((file) => file.name === name)
        : undefined
    const existing = file
      ? await lstat(file.path).then(
          (stat) => stat.isFile() && !stat.isSymbolicLink(),
          () => false
        )
      : false
    return {
      configured: true,
      path: file?.path ?? null,
      existing,
      lastWriteSucceeded: null,
      lastFailureCategory: null
    }
  }
  return {
    getStatus: async () => ({
      ...(await getLogFileStatus()),
      // Optional startup history must not hide an otherwise usable active log sink.
      startupFiles: await startupFiles().catch(() => [])
    }),
    openFile: async (name): Promise<OpenLogFileResult> => {
      const status = await selectedStatus(name)

      if (!status.path || !status.existing) {
        return { opened: false, error: 'No log file is available yet.' }
      }

      // desktopShellInteraction().openPath resolves to '' on success or an error string on failure.
      const error = await desktopShellInteraction().openPath(status.path)

      return error ? { opened: false, error } : { opened: true }
    },
    revealInFolder: async (name): Promise<RevealLogFileResult> => {
      const status = await selectedStatus(name)

      if (!status.path || !status.existing) {
        return { revealed: false, error: 'No log file is available yet.' }
      }

      // Electron returns void here, so the only observable guarantee is that the file existed
      // immediately before the shell request.
      await desktopShellInteraction().revealPath(status.path)

      return { revealed: true }
    }
  }
}

// Renderer-callable diagnostics surface. Local-only Host gates remain in the Host router; this
// adapter only shares the same injectable command owner with Electron IPC.
const registerLogsIpcHandlers = (
  owner: LogsCommandOwner = createLogsCommandOwner()
): LogsCommandOwner => {
  ipcMainHandle('logs:get-status', () => owner.getStatus())
  ipcMainHandle('logs:open-file', (_event, name?: string) => owner.openFile(name))
  ipcMainHandle('logs:reveal-in-folder', (_event, name?: string) => owner.revealInFolder(name))
  return owner
}

export type { LogsCommandOwner }
export { registerLogsIpcHandlers, createLogsCommandOwner }
