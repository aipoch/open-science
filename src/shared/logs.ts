// Shared types for the diagnostics/logs IPC surface.

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
