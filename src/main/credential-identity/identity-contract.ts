import { credentialDiagnosticSchema, type CredentialDiagnostic } from './diagnostic'
import type { IdentityProbeResult } from './probe-contract'
import type { LinuxKWalletBackend } from './linux-backend-contract'

// Interactive vault authorization must finish before the desktop startup deadline.
export const CREDENTIAL_AUTHORIZATION_TIMEOUT_MS = 120_000

export type CredentialIdentity = Readonly<
  | { backend: 'mac-keychain' | 'linux-secret-service'; appName: string; exists: boolean }
  | {
      backend: 'linux-kwallet'
      appName: string
      exists: boolean
      passwordStore: LinuxKWalletBackend
      wallet: string
    }
  | { backend: 'windows-dpapi' | 'file'; appName: string }
>

export class CredentialIdentityError extends Error {
  readonly diagnostic?: CredentialDiagnostic
  constructor(
    readonly reason: string,
    readonly probe?: IdentityProbeResult & Readonly<{ appName: string }>,
    diagnostic?: CredentialDiagnostic
  ) {
    // Native startup recovery translates this stable message before displaying it.
    super(
      'Credential storage needs recovery. Existing credentials and profile data have been preserved.'
    )
    this.name = 'CredentialIdentityError'
    const parsed = credentialDiagnosticSchema.safeParse(diagnostic)
    if (parsed.success) this.diagnostic = parsed.data
  }
}
