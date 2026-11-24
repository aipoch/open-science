import type { LiteratureRelatedResult } from './related-contracts.js'

export class SourceError extends Error {
  constructor(
    readonly issue: NonNullable<LiteratureRelatedResult['issue']>,
    readonly retryAt?: number,
    readonly status?: number,
    readonly retrySuppressed = false
  ) {
    super(issue)
  }
}
