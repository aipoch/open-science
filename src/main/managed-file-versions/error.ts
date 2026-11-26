import type { ManagedFileVersionErrorCode } from '../../shared/managed-file-versions'

export class ManagedFileVersionError extends Error {
  readonly name = 'ManagedFileVersionError'

  readonly versionNumber?: number

  constructor(
    readonly code: ManagedFileVersionErrorCode,
    message: string,
    options?: ErrorOptions & { versionNumber?: number }
  ) {
    super(message, options)
    this.versionNumber = options?.versionNumber
  }
}
