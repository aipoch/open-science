import { redactSensitiveText } from './diagnostic-redaction'

/** Safe provider diagnostics that survive Electron invoke's Error serialization. */
export type ProviderTextGenerationFailure = Readonly<{
  kind:
    | 'authentication'
    | 'permission'
    | 'quota'
    | 'rate-limit'
    | 'unavailable'
    | 'request'
    | 'network'
    | 'http'
  status?: number
}>

export function providerHttpFailure(
  status: number,
  providerCode?: string
): ProviderTextGenerationFailure {
  const kind =
    status === 401
      ? 'authentication'
      : status === 403
        ? 'permission'
        : status === 402 ||
            (status === 429 &&
              ['insufficient_quota', 'billing_hard_limit_reached'].includes(providerCode ?? ''))
          ? 'quota'
          : status === 429
            ? 'rate-limit'
            : status >= 500
              ? 'unavailable'
              : status >= 400 && status < 500
                ? 'request'
                : 'http'
  return { kind, status }
}

export function providerTextGenerationFailure(
  error: unknown
): ProviderTextGenerationFailure | undefined {
  if (!(error instanceof Error)) return undefined
  const match =
    /\[provider-failure:(authentication|permission|quota|rate-limit|unavailable|request|network|http):(0|[1-5]\d{2})\]/.exec(
      error.message
    )
  if (!match) return undefined
  return {
    kind: match[1] as ProviderTextGenerationFailure['kind'],
    ...(match[2] !== '0' ? { status: Number(match[2]) } : {})
  }
}

/** Keep provider/Agent wording readable without forwarding credentials or an unbounded payload. */
export function providerErrorDetails(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  for (const secret of secrets) {
    if (secret) {
      for (const value of [
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret)
      ]) {
        text = text.replaceAll(value, '[REDACTED]')
      }
    }
  }
  return redactSensitiveText(text)
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^\[provider-text-generation:[a-z-]+\]\s*/, '')
    .replace(/\[provider-failure:[a-z-]+:\d+\]\s*/g, '')
    .slice(0, 4096)
}
