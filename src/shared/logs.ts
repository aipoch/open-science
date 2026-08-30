// Shared types for the diagnostics/logs IPC surface.

export type LogWriteFailureCategory = 'directory' | 'inspect' | 'rotation' | 'append'

// Observed state of the active log file. `lastWriteSucceeded` is null until the first queued write
// completes; `existing` is refreshed from disk whenever this status is requested.
export type LogFileStatus = {
  configured: boolean
  path: string | null
  existing: boolean
  lastWriteSucceeded: boolean | null
  lastFailureCategory: LogWriteFailureCategory | null
}

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
