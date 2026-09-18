// Shared by read-only credential preflight and the durable store so startup keeps the original
// configuration recovery message even when malformed settings are detected before Electron ready.
export const settingsDocumentReadError = (path: string, cause: unknown): Error => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(
    `Cannot read application configuration: ${path}\n${reason}\nRestore this file from a verified backup, correct its dataRoot or access permissions, or use an application version that supports it, then restart. Preserve the original file and recovery files; no new configuration or data was initialized.`,
    { cause }
  )
  error.name = 'SettingsDocumentReadError'
  return Object.assign(error, { path })
}
