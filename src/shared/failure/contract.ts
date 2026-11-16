export type FailureCategory =
  'configuration' | 'service' | 'environment' | 'input' | 'session' | 'internal'

export type FailureReason = `${FailureCategory}/${string}`

export type FailureDiagnostics = Readonly<{
  status?: number
  code?: string
  safeMessage?: string
  adapterCode?: string
  upstreamCode?: string
  protocol?: 'chat-completions' | 'responses' | 'messages'
  phase?: string
  provider?: string
  model?: string
  requestId?: string
  raw?: string
}>

export type ClassifiedFailure = Readonly<{
  responseMessage?: string
  category: FailureCategory
  reason?: FailureReason
  diagnostics: FailureDiagnostics
}>

export type FailureFacts = Readonly<{
  responseMessage?: string
  origin: 'provider' | 'agent-runtime' | 'environment' | 'session' | 'operation'
  protocol?: 'chat-completions' | 'responses' | 'messages'
  status?: number
  code?: string | number
  adapterCode?: string
  upstreamCode?: string
  phase?: string
  provider?: string
  model?: string
  requestId?: string
  text?: string
}>

export type Recognizer = (facts: FailureFacts) => ClassifiedFailure | undefined
