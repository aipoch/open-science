import type { CallerContext } from './caller-context'

export const SESSION_PACKAGE_EXTERNAL_METHODS = [
  'preflightImport',
  'commitImport',
  'cancelImport',
  'export'
] as const
export type SessionPackageExternalMethod = (typeof SESSION_PACKAGE_EXTERNAL_METHODS)[number]

/** Explicit local paths enter only through this authenticated Main-owned transfer adapter.
 * Desktop dialog commands retain their existing electron-only safety boundary.
 */
export type SessionPackageExternalPort = {
  call(
    method: SessionPackageExternalMethod,
    payload: unknown,
    callerContext?: CallerContext
  ): Promise<unknown>
}
export class SessionPackageExternalError extends Error {
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
    this.name = 'SessionPackageExternalError'
  }
}
