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
