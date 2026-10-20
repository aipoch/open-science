// Observed state of the package-owned log sink.

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
