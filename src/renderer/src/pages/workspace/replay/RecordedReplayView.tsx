import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { buildObservationReplayDocument } from '@/lib/replay/live-source'
import type {
  RunObservationSnapshot,
  RunObservationExecutionContext
} from '../../../../../shared/run-observation'
import type { ReplayPanelProps } from './ReplayPanel'
import { ReplayPanel } from './ReplayPanel'
import { ExecutionPurposeNotice } from './ExecutionPurposeNotice'

type Props = Pick<
  ReplayPanelProps,
  'readResource' | 'renderResource' | 'materialViews' | 'active'
> & {
  title: string
  sourceIdentity: string
  snapshots: readonly RunObservationSnapshot[]
  executionContext?: RunObservationExecutionContext
  historyTruncated?: boolean
  onAskSelection: (snapshot: RunObservationSnapshot) => void | Promise<void>
}
const noAction = (): void => {}
/** Historical shell only. No runtime service, capture, stop or reconnect lifecycle. */
export const RecordedReplayView = (props: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const [asking, setAsking] = useState(false)
  const [failed, setFailed] = useState(false)
  const document = useMemo(
    () => buildObservationReplayDocument(props.snapshots, props.title),
    [props.snapshots, props.title]
  )
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="recorded-replay-view">
      <ExecutionPurposeNotice context={props.executionContext} />
      {failed ? <ErrorNotice inline title={t('Could not reference this recorded step.')} /> : null}
      <div className="min-h-0 flex-1">
        <ReplayPanel
          document={document}
          readResource={props.readResource}
          renderResource={props.renderResource}
          materialViews={props.materialViews}
          active={props.active}
          discussionPending={asking}
          onAskStep={noAction}
          onOpenEvidence={noAction}
          recorded={{
            sourceIdentity: props.sourceIdentity,
            snapshot: props.snapshots.at(-1)!,
            history: props.snapshots,
            executionContext: props.executionContext,
            historyTruncated: props.historyTruncated,
            onAskSelection: (snapshot) => {
              if (asking) return
              setAsking(true)
              setFailed(false)
              void Promise.resolve(props.onAskSelection(snapshot))
                .catch(() => setFailed(true))
                .finally(() => setAsking(false))
            }
          }}
        />
      </div>
    </div>
  )
}
