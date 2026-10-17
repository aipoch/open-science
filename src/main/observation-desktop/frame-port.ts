import type { CallerContext } from '../caller-context'
export interface ObservationFrameRegistration {
  issueGrant(url: string, expiresAt: number): void | Promise<void>
  authenticateGrant(grant: string): void | Promise<void>
  close(): void
}
export interface ObservationFramePort {
  registerViewer(input: {
    origin: string
    caller: CallerContext
    expiresAt: number
    assertCurrent(): void
  }): ObservationFrameRegistration | Promise<ObservationFrameRegistration>
  registerRuntime(input: {
    origin: string
    parents: readonly string[]
    expiresAt: number
    excludedPath: string
    assertCurrent(): void
    allowsPath(path: string): boolean
  }): ObservationFrameRegistration | undefined | Promise<ObservationFrameRegistration | undefined>
}
