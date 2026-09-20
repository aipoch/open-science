import type { LiteratureFailure } from '../../shared/literature-failure'

export class LiteratureProviderError extends Error {
  constructor(readonly status: number) {
    super(`Literature provider request failed with HTTP ${status}.`)
  }
}

export function literatureFailure(
  error: unknown,
  phase: LiteratureFailure['phase'],
  source: LiteratureFailure['source'] = 'provider'
): LiteratureFailure {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : ''
  const status = error instanceof LiteratureProviderError ? error.status : undefined
  const code: LiteratureFailure['code'] =
    status === 429
      ? 'rate-limit'
      : status === 401 || status === 403
        ? 'authentication'
        : status === 404
          ? 'no-result'
          : status !== undefined && status >= 500
            ? 'network'
            : name === 'TimeoutError' ||
                name === 'AbortError' ||
                /^(ETIMEDOUT|ESOCKETTIMEDOUT)$/.test((error as NodeJS.ErrnoException)?.code ?? '')
              ? 'timeout'
              : /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH)$/.test(
                    (error as NodeJS.ErrnoException)?.code ?? ''
                  ) ||
                  (error instanceof TypeError && message === 'fetch failed')
                ? 'network'
                : /^(Reference unavailable|Literature Item is unavailable\.)$/.test(message)
                  ? 'unavailable'
                  : /^(Reference changed|Reference changed\. Search again and review the metadata\.|The reference changed during download\. Search again\.|Search again to refresh this older metadata review\.)$/.test(
                        message
                      )
                    ? 'conflict'
                    : 'unknown'
  return {
    code,
    phase,
    source: ['unavailable', 'conflict'].includes(code) ? 'catalog' : source,
    retryable: !['unavailable', 'authentication', 'no-result'].includes(code)
  }
}
