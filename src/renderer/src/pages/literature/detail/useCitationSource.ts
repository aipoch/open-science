import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  literatureRelatedResultSchema,
  type LiteratureRelatedRequest,
  type LiteratureRelatedResult
} from '@aipoch/literature-discovery/contracts'
import { useLiteratureHost } from '../renderer-host'
import type { ScheduleRequest } from './useCitationGraphController'
import { citationRecordProvider } from './citation-graph'

export type CitationProviderChoice =
  NonNullable<LiteratureRelatedRequest['provider']> | 'opencitations-index'
export type CitationSourceState = Pick<LiteratureRelatedResult, 'provider' | 'opencitationsMode'>

/** Keep each request on the selected source without coupling independent view lifetimes. */
export function useCitationSource(provider: CitationProviderChoice): {
  source: CitationSourceState
  requestRelated: ScheduleRequest
} {
  const { api } = useLiteratureHost()
  // Legacy automatic requests use the default source without enabling another provider.
  const selectedChoice = provider === 'auto' ? 'europe-pmc' : provider
  const source = useMemo<CitationSourceState>(
    () =>
      selectedChoice === 'opencitations-index'
        ? { provider: 'opencitations', opencitationsMode: 'index' }
        : selectedChoice === 'opencitations'
          ? { provider: selectedChoice, opencitationsMode: 'skg-if' }
          : { provider: selectedChoice },
    [selectedChoice]
  )
  const mounted = useRef(true)
  const pending = useRef(new Set<string>())
  useEffect(() => {
    mounted.current = true
    const requests = pending.current
    return () => {
      mounted.current = false
      for (const requestId of requests)
        void api.literature.cancelRelated({ requestId }).catch(() => undefined)
      requests.clear()
    }
  }, [api])
  const requestRelated = useCallback<ScheduleRequest>(
    async (request, shouldRun) => {
      if (!mounted.current || !shouldRun()) throw new Error('Inactive citation source request.')
      const requestId = crypto.randomUUID()
      pending.current.add(requestId)
      let response: LiteratureRelatedResult
      try {
        response = literatureRelatedResultSchema.parse(
          await api.literature.related({
            ...request,
            requestId,
            provider: source.provider,
            ...(source.opencitationsMode ? { opencitationsMode: source.opencitationsMode } : {})
          })
        )
      } finally {
        pending.current.delete(requestId)
      }
      if (!mounted.current || !shouldRun()) throw new Error('Inactive citation source response.')
      if (
        response.itemId !== request.itemId ||
        response.metadataRevision !== request.expectedMetadataRevision ||
        response.direction !== request.direction
      )
        throw new Error('Citation source identity mismatch.')
      const actualProvider = response.provider
      if (!actualProvider) throw new Error('Missing citation source provider.')
      if (
        [...(response.seed ? [response.seed] : []), ...response.records].some(
          (record) => citationRecordProvider(record.paperId) !== actualProvider
        )
      )
        throw new Error('Citation record provider mismatch.')
      if (source.provider !== actualProvider) throw new Error('Citation source provider mismatch.')
      const actualMode =
        actualProvider === 'opencitations' ? (response.opencitationsMode ?? 'skg-if') : undefined
      if (source.opencitationsMode && source.opencitationsMode !== actualMode)
        throw new Error('Citation source mode mismatch.')
      return response
    },
    [api, source]
  )
  return { source, requestRelated }
}
