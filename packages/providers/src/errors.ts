export { providerErrorDetails, providerErrorExcerpt } from './transport/body'

/** Portable provider failure classification and bounded redaction. */
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

export class ProviderTextGenerationError extends Error {
  constructor(
    readonly code:
      | 'unsupported-target'
      | 'invalid-request'
      | 'http-error'
      | 'network-error'
      | 'incomplete-output',
    message: string,
    readonly status?: number,
    readonly failure: ProviderTextGenerationFailure | undefined = code === 'http-error' &&
    status !== undefined
      ? providerHttpFailure(status)
      : undefined
  ) {
    super(
      `[provider-text-generation:${code}]${failure ? ` [provider-failure:${failure.kind}:${failure.status ?? 0}]` : ''} ${message}`
    )
  }
}
