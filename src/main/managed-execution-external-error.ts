/** Shared error contract for authenticated execution and evidence-viewing adapters. */
export class ManagedExecutionExternalError extends Error {
  constructor(
    readonly code:
      | 'unauthorized'
      | 'unsupported_location'
      | 'unavailable'
      | 'invalid_request'
      | 'conflict'
      | 'not_found',
    message: string
  ) {
    super(message)
    this.name = 'ManagedExecutionExternalError'
  }
}
