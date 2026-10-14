import { providerErrorDetails as redactProviderError } from '@aipoch/providers/errors'

/** Normalize Electron's invoke envelope before presenting portable provider diagnostics. */
export function providerErrorDetails(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return redactProviderError(
    message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''),
    secrets
  )
}
