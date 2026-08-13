import { sanitizeSessionTitle } from '../../shared/session-persistence'
import type { ResolvedAgentBackend } from '../agent-framework'

export const fetchOpenCodeSessionTitle = async (
  api: NonNullable<ResolvedAgentBackend['opencodeUsageApi']>,
  sessionId: string,
  cwd: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<string | undefined> => {
  try {
    const url = new URL(
      `/session/${encodeURIComponent(sessionId)}`,
      api.baseUrl.endsWith('/') ? api.baseUrl : `${api.baseUrl}/`
    )
    url.searchParams.set('directory', cwd)
    const response = await fetchImpl(url, {
      headers: { authorization: api.authorization },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
        : AbortSignal.timeout(2_000)
    })
    if (!response.ok) return undefined

    const session = (await response.json()) as unknown
    if (typeof session !== 'object' || session === null || Array.isArray(session)) return undefined
    return sanitizeSessionTitle((session as { title?: unknown }).title)
  } catch {
    return undefined
  }
}
