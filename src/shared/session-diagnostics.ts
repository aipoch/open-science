/** Local diagnostic observations, never an import/restore format or an agent tool. */
export type SessionDiagnosticIdentity = { projectId: string; sessionId: string }
export type SessionDiagnosticRequest = SessionDiagnosticIdentity & { operationId: string }
export type SensitiveContentEvidence = {
  location: string
  offset: number
  rule: 'field' | 'assignment' | 'url' | 'token'
  matchLength: number
  label?: string
  leftBoundary: 'start' | 'whitespace' | 'punctuation' | 'letter' | 'number' | 'mark' | 'other'
  rightBoundary: 'end' | 'whitespace' | 'punctuation' | 'letter' | 'number' | 'mark' | 'other'
  context: string
  valueLength?: number
  valueHash: string
  sourceStorageKey?: string
}
export type SensitiveContentFailure = {
  occurredAt: string
  evidence: SensitiveContentEvidence[]
}
export type SessionDiagnosticItem = {
  id: string
  kind: 'session' | 'invalid-session' | 'log' | 'database' | 'sensitive-evidence' | 'sensitive-file'
  name: string
  available: boolean
  sizeBytes?: number
  reason?: string
}
export type SessionDiagnosticInspection = {
  items: SessionDiagnosticItem[]
  error?: string
}
export type SessionDiagnosticExportRequest = SessionDiagnosticRequest & { selectedItems: string[] }
export type SessionDiagnosticExportResult = {
  status: 'exported' | 'partial' | 'cancelled' | 'failed'
  path?: string
  error?: string
  report?: string
  reportPath?: string
}

/** Main-owned worker inputs; these paths never come from the renderer. */
export type SessionDiagnosticWorkerInput = SessionDiagnosticIdentity & {
  action: 'inspect' | 'export'
  dataRoot: string
  configRoot: string
  logPath?: string
  appVersion: string
  selectedItems?: string[]
  directory?: string
  sensitiveContent?: SensitiveContentFailure
}
export type SessionDiagnosticWorkerResult =
  | { kind: 'inspection'; inspection: SessionDiagnosticInspection }
  | { kind: 'archive'; partial: boolean; report: string }
  | { kind: 'error'; report: string }
