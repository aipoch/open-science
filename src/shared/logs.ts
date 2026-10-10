export type { LogFileStatus, LogWriteFailureCategory } from '@aipoch/diagnostics'

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
