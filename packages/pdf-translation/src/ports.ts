/** The caller owns authority and cancels the lease on reload or disconnect. */
export type TranslationCallerLease = Readonly<{
  leaseId: string
  generation: number
  signal: AbortSignal
  isCurrent: () => boolean
}>
export type TranslationDiagnostics = {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  errorFields(error: unknown): Record<string, unknown>
}
export const silentDiagnostics: TranslationDiagnostics = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  errorFields() {
    return {}
  }
}
export type TranslationWriteAdmission = {
  /** Admit one operation. The package must not recursively acquire this capability. */
  write<T>(operation: () => Promise<T>): Promise<T>
  recover(operation: () => Promise<void>): Promise<void>
}
export const standaloneWriteAdmission: TranslationWriteAdmission = {
  write: (operation) => operation(),
  recover: (operation) => operation()
}
