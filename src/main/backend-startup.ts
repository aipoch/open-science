import { z } from 'zod'
import { CredentialIdentityError } from './credential-identity/selection'
import { credentialDiagnosticSchema } from './credential-identity/diagnostic'

// Only fixed diagnostic codes cross this private pipe. Never send messages, paths, keys or stacks.
const credentialReasonSchema = z.enum([
  'credential-unavailable',
  'native-secret-operation-failed',
  'node-secret-backend-unavailable',
  'windows-profile-key-unavailable',
  'invalid-ciphertext',
  'unsupported-ciphertext-version',
  'ciphertext-inventory-unavailable',
  'decryption-failed',
  'key-missing-for-existing-ciphertext',
  'credential-access-unavailable',
  'credential-write-failed',
  'read-before-key-created',
  'access-probe-error',
  'access-not-found',
  'access-access-blocked',
  'access-error',
  'access-unsupported',
  'initialization-probe-access-blocked',
  'initialization-probe-error',
  'initialization-probe-unsupported',
  'linux-backend-unavailable-or-changed',
  'linux-credential-unavailable',
  'unsupported-backend'
])
export const backendStartupStatusSchema = z
  .object({
    protocolVersion: z.literal(1),
    attemptId: z.string().uuid(),
    stage: z.enum(['bootstrap', 'credentials', 'storage', 'database', 'runtime', 'endpoint']),
    kind: z.enum(['progress', 'failed', 'ready']),
    code: z.enum(['credential-unavailable', 'startup-failed']).optional(),
    reason: credentialReasonSchema.optional(),
    diagnostic: credentialDiagnosticSchema.optional()
  })
  .strict()
  .superRefine((status, context) => {
    if (
      (status.kind === 'failed') !== (status.code !== undefined) ||
      (status.reason !== undefined && status.code !== 'credential-unavailable') ||
      (status.diagnostic !== undefined && status.code !== 'credential-unavailable')
    )
      context.addIssue({ code: 'custom', message: 'Invalid startup status fields.' })
  })
export type BackendStartupStatus = z.infer<typeof backendStartupStatusSchema>

export class DesktopBackendStartupError extends Error {
  readonly credentialFailure?: CredentialIdentityError
  constructor(
    message: string,
    readonly stage: BackendStartupStatus['stage'],
    readonly canRetry: boolean,
    readonly logs: string,
    status?: BackendStartupStatus
  ) {
    super(message)
    this.name = 'DesktopBackendStartupError'
    if (status?.code === 'credential-unavailable')
      this.credentialFailure = new CredentialIdentityError(
        status.reason ?? 'credential-unavailable',
        undefined,
        status.diagnostic
      )
  }
}

// The reporter is owned by this launch attempt only. Its channel must not keep an otherwise
// finished backend alive, and losing Electron must not terminate the independent Node runtime.
// Capture the launch identity before the reporter removes it from the environment. The backend
// uses the same value to bind a credential inventory handoff without leaking it to descendants.
export let backendStartupAttemptId: string | undefined

export function createBackendStartupReporter(): {
  phase(stage: BackendStartupStatus['stage']): void
  failed(error: unknown): void
  ready(): void
} {
  const attemptId = process.env.OPEN_SCIENCE_STARTUP_ATTEMPT
  backendStartupAttemptId = attemptId
  delete process.env.OPEN_SCIENCE_STARTUP_ATTEMPT
  if (attemptId) process.channel?.unref()
  let stage: BackendStartupStatus['stage'] = 'bootstrap'
  const send = (fields: Partial<BackendStartupStatus>): void => {
    if (!attemptId || !process.send || !process.connected) return
    const status = backendStartupStatusSchema.safeParse({
      protocolVersion: 1,
      attemptId,
      stage,
      kind: 'progress',
      ...fields
    })
    if (!status.success) return
    try {
      process.send(status.data, () => {
        /* Closing the parent pipe is not a runtime failure. */
      })
    } catch {
      /* The parent may disappear between connected and send. */
    }
  }
  return {
    phase(next) {
      stage = next
      send({})
    },
    failed(error) {
      const diagnostic = credentialDiagnosticSchema.safeParse(
        error instanceof CredentialIdentityError ? error.diagnostic : undefined
      )
      const reason =
        error instanceof CredentialIdentityError
          ? credentialReasonSchema.safeParse(error.reason)
          : undefined
      send({
        kind: 'failed',
        ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}),
        code:
          error instanceof CredentialIdentityError ? 'credential-unavailable' : 'startup-failed',
        ...(reason
          ? {
              reason: reason.success
                ? reason.data
                : error instanceof CredentialIdentityError && error.reason.startsWith('linux-')
                  ? 'linux-credential-unavailable'
                  : 'credential-unavailable'
            }
          : {})
      })
    },
    ready() {
      send({ kind: 'ready' })
    }
  }
}
