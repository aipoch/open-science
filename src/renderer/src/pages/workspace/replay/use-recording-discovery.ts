import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReplayDocument } from '../../../../../shared/replay'
import {
  discoverRecordingPage,
  recordingCandidates,
  mergeRecordingCandidates,
  type RecordingCandidate
} from './recording-discovery'

type DiscoveryState = {
  supportingResourceIds?: string[]
  source?: ReplayDocument
  scanned?: boolean
  recordings: RecordingCandidate[]
  nextOffset: number
  unchecked: number
  unavailable: number
  loading: boolean
  supported: boolean
}
const emptyState = (): DiscoveryState => ({
  recordings: [],
  nextOffset: 0,
  unchecked: 0,
  unavailable: 0,
  loading: false,
  supported: true
})

export type RecordingDiscovery = DiscoveryState & { loadMore: () => void; retry: () => void }

export const useRecordingDiscovery = (document: ReplayDocument | undefined): RecordingDiscovery => {
  const candidates = useMemo(
    () => (document ? recordingCandidates(document.resources, document.source) : []),
    [document]
  )
  const [state, setState] = useState(emptyState)
  const request = useRef<AbortController | undefined>(undefined)
  const scope = useRef(0)
  const scan = useCallback(
    async (offset: number, reset = false): Promise<void> => {
      if (request.current) return
      const reader = window.api?.artifacts?.readPreview
      if (!reader || !window.api?.observations?.openRecorded) {
        setState({ ...emptyState(), source: document, scanned: true, supported: false })
        return
      }
      const generation = scope.current
      const controller = new AbortController()
      request.current = controller
      setState((previous) => ({ ...(reset ? emptyState() : previous), loading: true }))
      try {
        const page = await discoverRecordingPage(candidates, reader, offset, controller.signal)
        if (controller.signal.aborted || generation !== scope.current) return
        setState((previous) => ({
          ...page,
          supportingResourceIds: [
            ...new Set([
              ...(reset ? [] : (previous.supportingResourceIds ?? [])),
              ...(page.supportingResourceIds ?? [])
            ])
          ],
          source: document,
          scanned: true,
          recordings: mergeRecordingCandidates(reset ? [] : previous.recordings, page.recordings),
          unavailable: (reset ? 0 : previous.unavailable) + page.unavailable,
          loading: false,
          supported: true
        }))
      } finally {
        if (request.current === controller) request.current = undefined
      }
    },
    [candidates, document]
  )
  useEffect(() => {
    scope.current += 1
    request.current?.abort()
    request.current = undefined
    const generation = scope.current
    if (document)
      void Promise.resolve()
        .then(() => {
          if (generation === scope.current) return scan(0, true)
          return undefined
        })
        .catch(() => undefined)
    return () => {
      scope.current += 1
      request.current?.abort()
      request.current = undefined
    }
  }, [document, scan])
  const loadMore = useCallback(
    () => void scan(state.nextOffset).catch(() => undefined),
    [scan, state.nextOffset]
  )
  const retry = useCallback(() => void scan(0, true).catch(() => undefined), [scan])
  return {
    ...state,
    scanned: Boolean(state.scanned && state.source === document),
    loadMore,
    retry
  }
}
