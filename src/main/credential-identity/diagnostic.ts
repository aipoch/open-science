import { z } from 'zod'

// Diagnostic categories, not credential states. No paths, native output or secret bytes.
const systemCodeSchema = z.enum([
  'EACCES',
  'EPERM',
  'EBUSY',
  'ENOENT',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EISDIR',
  'ENOTDIR',
  'ETIMEDOUT',
  'ENOBUFS',
  'ENOEXEC',
  'EINVAL',
  'UNKNOWN',
  'MODULE_NOT_FOUND'
])
export const windowsCredentialDiagnosticSchema = z
  .object({
    code: z.enum([
      'profile-read-failed',
      'profile-too-large',
      'profile-invalid-json',
      'profile-invalid-shape',
      'profile-key-missing',
      'profile-key-invalid',
      'profile-changed',
      'validator-start-failed',
      'validator-timeout',
      'validator-failed',
      'validator-invalid-response',
      'validator-input-failed',
      'validator-unsupported',
      'dpapi-unprotect-failed'
    ]),
    systemCode: systemCodeSchema.optional(),
    osStatus: z.number().int().min(0).max(0xffffffff).optional(),
    exitCode: z.number().int().min(-0x80000000).max(0xffffffff).optional()
  })
  .strict()

// Transient inventory context only. This allowlist never carries paths, contents or raw errors.
export const inventoryDiagnosticSchema = z
  .object({
    code: z.literal('inventory-failed'),
    source: z.enum([
      'configuration',
      'settings',
      'credentials',
      'application-database',
      'browser-profile',
      'cookies'
    ]),
    stage: z.enum([
      'read-files',
      'parse-document',
      'check-journal',
      'copy-snapshot',
      'read-database',
      'cleanup-snapshot',
      'inspect-profile'
    ]),
    reason: z.enum([
      'operation-failed',
      'invalid-json',
      'invalid-document',
      'pending-document',
      'too-large',
      'invalid-ciphertext',
      'unsupported-file',
      'source-changed',
      'journal-incomplete',
      'journal-invalid',
      'super-journal',
      'conflicting-journals',
      'sqlite-unavailable'
    ]),
    systemCode: systemCodeSchema.optional()
  })
  .strict()
export type InventoryDiagnostic = z.infer<typeof inventoryDiagnosticSchema>
export const nativeSecretDiagnosticSchema = z
  .object({
    code: z.enum([
      'secret-timeout',
      'secret-start-failed',
      'secret-exit-failed',
      'secret-signalled',
      'secret-empty-response'
    ]),
    systemCode: systemCodeSchema.optional(),
    exitCode: z.number().int().min(-0x80000000).max(0xffffffff).optional(),
    signal: z
      .enum([
        'SIGTERM',
        'SIGKILL',
        'SIGABRT',
        'SIGSEGV',
        'SIGINT',
        'SIGBUS',
        'SIGILL',
        'SIGPIPE',
        'UNKNOWN'
      ])
      .optional()
  })
  .strict()
export const credentialDiagnosticSchema = z.union([
  windowsCredentialDiagnosticSchema,
  inventoryDiagnosticSchema,
  nativeSecretDiagnosticSchema
])
export type CredentialDiagnostic = z.infer<typeof credentialDiagnosticSchema>

// Messages supplied here are fixed developer strings, never the original exception text.
export class CredentialInventoryFailure extends Error {
  readonly systemCode?: InventoryDiagnostic['systemCode']
  constructor(
    readonly stage: InventoryDiagnostic['stage'],
    readonly reason: InventoryDiagnostic['reason'],
    message: string,
    error?: unknown
  ) {
    super(message)
    this.systemCode = credentialSystemCode(error)
  }
}

export function credentialSystemCode(error: unknown): CredentialDiagnostic['systemCode'] {
  const result = systemCodeSchema.safeParse(
    error && typeof error === 'object' && 'code' in error ? error.code : undefined
  )
  return result.success ? result.data : undefined
}
