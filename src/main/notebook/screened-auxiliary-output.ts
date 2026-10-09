import type { AuxiliaryOutput, AuxiliaryOutputResult } from './managed-auxiliary-output'

/** Main-only patterns shared by required outputs and optional recording publication. */
export function configuredCredentialPatterns(secrets: readonly string[]): Buffer[] {
  return secrets
    .flatMap((secret) => [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64')
    ])
    .filter(Boolean)
    .map((secret) => Buffer.from(secret))
}

/** Optional evidence must not bypass the configured-credential screen used by required outputs. */
export function screenAuxiliaryOutput(
  save: (output: AuxiliaryOutput) => Promise<AuxiliaryOutputResult>,
  secrets: readonly string[]
): (output: AuxiliaryOutput) => Promise<AuxiliaryOutputResult> {
  const patterns = configuredCredentialPatterns(secrets)
  return async (output) => {
    const bytes = Buffer.from(
      output.source.content,
      output.source.encoding === 'base64' ? 'base64' : 'utf8'
    )
    if (patterns.some((pattern) => bytes.includes(pattern)))
      return { status: 'failed', code: 'invalid-output' }
    return save(output)
  }
}
