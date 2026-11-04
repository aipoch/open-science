import type { LogFileStatus as SinkStatus } from '@aipoch/diagnostics'
export type { LogWriteFailureCategory } from '@aipoch/diagnostics'

export type StartupLogFile = { name: string; path: string; startedAt: number }
export type LogFileStatus = SinkStatus & { startupFiles?: StartupLogFile[] }

// Result of asking the OS to open the log file.
export type OpenLogFileResult = {
  opened: boolean
  error?: string
}

// Result of asking the OS to reveal the log file in its containing folder.
export type RevealLogFileResult = {
  revealed: boolean
  error?: string
}
