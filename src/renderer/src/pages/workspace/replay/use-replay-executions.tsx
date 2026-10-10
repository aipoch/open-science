import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReplayDocument } from '../../../../../shared/replay'
import type { RecordedEvidencePayload } from '../../../../../shared/run-observation-recorded'
import type { ResearchReplayObservationBinding } from '../../../../../shared/research-replay'
import {
  buildRecordedExecutionTracks,
  type RecordedExecutionTrack
} from '@/lib/replay/recorded-execution'
import { ErrorNotice } from '@/components/error-notice'

/** Optional state enrichment never delays or rebuilds the research clock. */
export function useReplayExecutions(
  document: ReplayDocument | undefined,
  payloads: readonly RecordedEvidencePayload[] | undefined,
  origins: Readonly<Record<string, number>> | undefined
): { executionTracks?: readonly RecordedExecutionTrack[]; executionNotice?: ReactNode } {
  const { t } = useTranslation()
  const [retry, setRetry] = useState(0)
  const [resolved, setResolved] = useState<{
    document: ReplayDocument
    bindings: ResearchReplayObservationBinding[]
    unavailable: boolean
  }>()
  const [failed, setFailed] = useState<ReplayDocument>()
  const archives = useMemo(() => payloads?.filter((payload) => 'archive' in payload), [payloads])
  useEffect(() => {
    if (!document || !archives?.length) return
    let disposed = false
    void (async () => {
      const read = window.api?.sessionReplay?.readObservationBindings
      if (!read) throw new Error('State association reader unavailable')
      const bindings: ResearchReplayObservationBinding[] = []
      let unavailable = false
      for (let offset = 0; offset < archives.length; offset += 64) {
        const result = await read({
          projectId: document.source.projectId,
          sourceSessionId: document.source.sessionId,
          sourceFingerprint: document.source.fingerprint,
          targets: archives.slice(offset, offset + 64).map((payload) => payload.receiving)
        })
        if (disposed) return
        if (result.sourceFingerprint !== document.source.fingerprint)
          throw new Error('Research changed while reading saved states')
        bindings.push(...result.bindings)
        unavailable ||= result.unavailableTargets.length > 0
      }
      if (!disposed) setResolved({ document, bindings, unavailable })
    })().catch(() => {
      if (!disposed) setFailed(document)
    })
    return () => {
      disposed = true
    }
  }, [document, archives, retry])
  const current = resolved?.document === document ? resolved : undefined
  const executionTracks = useMemo(() => {
    if (!document || !payloads || !origins) return undefined
    return buildRecordedExecutionTracks(document, payloads, current?.bindings ?? [], origins)
  }, [document, payloads, origins, current])
  const unlinked = useMemo(
    () =>
      current &&
      archives?.some(
        (payload) =>
          !executionTracks?.some((track) => {
            const target = track.select(track.snapshots[0]).receiving
            return (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).every(
              (key) => target[key] === payload.receiving[key]
            )
          })
      ),
    [current, archives, executionTracks]
  )
  const executionNotice =
    failed === document && document ? (
      <ErrorNotice
        inline
        tone="amber"
        title={t('Could not link saved execution states.')}
        primaryButton={{
          label: t('Retry'),
          onClick: () => {
            setFailed(undefined)
            setRetry((value) => value + 1)
          }
        }}
      />
    ) : current?.unavailable || unlinked ? (
      <p className="px-3 py-2 text-xs text-text-300">
        {t(
          'Some saved states could not be linked to a Notebook run. Open their recording separately.'
        )}
      </p>
    ) : archives?.length && !current ? (
      <p role="status" className="px-3 py-2 text-xs text-text-300">
        {t('Reading saved execution states…')}
      </p>
    ) : undefined
  return { executionTracks, executionNotice }
}
