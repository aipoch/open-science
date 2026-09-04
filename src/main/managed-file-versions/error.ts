import type { ManagedFileVersionErrorCode } from '../../shared/managed-file-versions'

export class ManagedFileVersionError extends Error {
  readonly name = 'ManagedFileVersionError'

  constructor(
    readonly code: ManagedFileVersionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
