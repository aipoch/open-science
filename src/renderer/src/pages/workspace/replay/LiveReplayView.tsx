import type { ReactNode } from 'react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import {
  buildObservationReplayDocument,
  normalizeObservationHistory
} from '@/lib/replay/live-source'
import type { ReplayResource } from '../../../../../shared/replay'
import type {
  RunObservationExecutionContext,
  RunObservationSnapshot
} from '../../../../../shared/run-observation'
import type { ReplayNotebookRunReader } from '@/lib/replay'
import type { ReplayResourceReader } from './replay-resources'
import type { ReplayProjectActivation, ReplayRuntimeSurface } from './ReplayLiveRecord'
import { ReplayPanel } from './ReplayPanel'
import { ExecutionPurposeNotice } from './ExecutionPurposeNotice'
import { DemoViewingNotice } from './DemoViewingNotice'

export type LiveReplayViewProps = {
  title: string
  /** Host-selected admission identity; never replace it with a changing observation revision. */
  sourceIdentity: string
  snapshot: RunObservationSnapshot
  history?: readonly RunObservationSnapshot[]
  recorded?: boolean
  /** Host-validated recording context; archive v1 remains unchanged. */
  executionContext?: RunObservationExecutionContext
  historyTruncated?: boolean
  connection: 'connected' | 'reconnecting' | 'disconnected'
  readResource: ReplayResourceReader
  runtimeSurface?: ReplayRuntimeSurface
  projectActivation?: ReplayProjectActivation
  renderLiveActions?: (enabled: boolean) => ReactNode
  renderRecordedSurface?: (snapshot: RunObservationSnapshot) => ReactNode | undefined
  renderResource?: (resource: ReplayResource, onClose: () => void) => ReactNode
  onAskSelection: (snapshot: RunObservationSnapshot) => void | Promise<void>
  onStop?: () => void | Promise<void>
  active?: boolean
  expanded?: boolean
  onToggleExpanded?: () => void
}

const noHistoricalDiscussion = (): void => {}
const noNotebookRead: ReplayNotebookRunReader = async () => ({
  status: 'unavailable',
  reason: 'not-recorded'
})

// This surface has no transport and no window.api dependency. The browser and Electron hosts
// provide scoped readers, selection capture, runtime page capability and an explicit stop action.
const LiveReplayViewContent = (props: LiveReplayViewProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [error, setError] = useState<'selection' | 'stop'>()
  const [asking, setAsking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const askPending = useRef(false)
  const stopPending = useRef(false)
  const projected = useMemo(() => {
    try {
      const history = normalizeObservationHistory(props.snapshot, props.history)
      return { history, document: buildObservationReplayDocument(history, props.title) }
    } catch {
      return undefined
    }
  }, [props.snapshot, props.history, props.title])
  const ask = async (snapshot: RunObservationSnapshot): Promise<void> => {
    if (askPending.current) return
    askPending.current = true
    setAsking(true)
    setError(undefined)
    try {
      await props.onAskSelection(snapshot)
    } catch {
      setError('selection')
    } finally {
      askPending.current = false
      setAsking(false)
    }
  }
  const stop = async (): Promise<void> => {
    if (stopPending.current || stopping || !props.onStop) return
    stopPending.current = true
    setStopping(true)
    setError(undefined)
    try {
      await props.onStop()
      // Only an actual terminal snapshot says the run stopped; a successful request is not proof.
    } catch {
      stopPending.current = false
      setStopping(false)
      setError('stop')
    }
  }
  if (!projected)
    return (
      <ErrorNotice
        inline
        title={t('The recorded evidence is unavailable.')}
        description={t(
          'Observation records do not match this run. Reconnect to load a fresh view.'
        )}
      />
    )
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="live-replay-view">
      <ExecutionPurposeNotice context={props.executionContext ?? props.snapshot.executionContext} />
      <DemoViewingNotice
        context={props.executionContext ?? props.snapshot.executionContext}
        phase={props.snapshot.phase}
        recorded={props.recorded}
      />
      {error ? (
        <ErrorNotice
          inline
          title={
            error === 'selection'
              ? t('Could not reference this recorded step.')
              : t('Could not request the run to stop.')
          }
          description={
            error === 'selection'
              ? t('The observation may have expired. Return to the latest record and try again.')
              : t('The run may still be active. Check its current status before retrying.')
          }
          dismissButton={{ label: t('Dismiss'), onClick: () => setError(undefined) }}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <ReplayPanel
          document={projected.document}
          active={props.active}
          expanded={props.expanded}
          onToggleExpanded={props.onToggleExpanded}
          readResource={props.readResource}
          readNotebookRun={noNotebookRead}
          renderResource={
            props.renderResource ??
            (() => <ErrorNotice inline title={t('This file preview is unavailable here.')} />)
          }
          onAskStep={noHistoricalDiscussion}
          onOpenEvidence={noHistoricalDiscussion}
          discussionPending={asking}
          live={{
            sourceIdentity: props.sourceIdentity,
            executionContext: props.executionContext ?? props.snapshot.executionContext,
            snapshot: props.snapshot,
            history: projected.history,
            connection: props.connection,
            runtimeSurface: props.runtimeSurface,
            projectActivation: props.projectActivation,
            renderActions: props.renderLiveActions,
            renderRecordedSurface: props.renderRecordedSurface,
            onAskSelection: (snapshot) => {
              void ask(snapshot)
            },
            onStop: props.onStop
              ? () => {
                  void stop()
                }
              : undefined,
            stopping,
            recorded: props.recorded,
            historyTruncated: props.historyTruncated
          }}
        />
      </div>
    </div>
  )
}

export const LiveReplayView = (props: LiveReplayViewProps): React.JSX.Element => (
  <LiveReplayViewContent
    key={JSON.stringify([
      props.snapshot.identity.projectId,
      props.snapshot.identity.sessionId,
      props.sourceIdentity
    ])}
    {...props}
  />
)
