export type FailureCategory =
  'configuration' | 'service' | 'environment' | 'input' | 'session' | 'internal'

export type FailureReason = `${FailureCategory}/${string}`

export type FailureDiagnostics = Readonly<{
  status?: number
  code?: string
  provider?: string
  model?: string
  requestId?: string
  raw?: string
}>

export type ClassifiedFailure = Readonly<{
  category: FailureCategory
  reason?: FailureReason
  diagnostics: FailureDiagnostics
}>

export type FailureFacts = Readonly<{
  origin: 'provider' | 'agent-runtime' | 'environment' | 'session' | 'operation'
  status?: number
  code?: string | number
  provider?: string
  model?: string
  requestId?: string
  text?: string
}>

export type Recognizer = (facts: FailureFacts) => ClassifiedFailure | undefined
