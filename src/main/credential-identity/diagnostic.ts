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
export const credentialDiagnosticSchema = z
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
export type CredentialDiagnostic = z.infer<typeof credentialDiagnosticSchema>

export function credentialSystemCode(error: unknown): CredentialDiagnostic['systemCode'] {
  const result = systemCodeSchema.safeParse(
    error && typeof error === 'object' && 'code' in error ? error.code : undefined
  )
  return result.success ? result.data : undefined
}
