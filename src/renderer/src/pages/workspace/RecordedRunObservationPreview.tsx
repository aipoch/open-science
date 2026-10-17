import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { RecordedReplayView } from './replay/RecordedReplayView'
import { ProjectReplay } from './replay/ProjectReplay'
import { ResultsPanel } from './replay/results/ResultsPanel'
import {
  readRecordedResource,
  type RecordedResourceReader
} from './replay/results/recorded-resource-reader'
import { recordedResults, authorizedRecordedResultsReader } from '@/lib/replay/recorded-results'
import {
  recordedFileSelectionForPayload,
  type RecordedObservationFileSelection
} from '../../../../shared/run-observation-recorded'
import { projectLegacyObservationToTrack } from '../../../../shared/project-recording'
import {
  authorizedRecordedResourceReader,
  projectRecordedObservation,
  type RecordedObservationReceivingScope,
  type ResolvedObservationMedia,
  type RecordedRunObservationSelection,
  type RecordedObservationResourceRenderer
} from '@/lib/replay/recorded-observation'
import type { RunObservationArchive } from '../../../../shared/run-observation-archive'
import type { RunObservationExecutionContext } from '../../../../shared/run-observation'
import type { ReplayResourceReader } from './replay/replay-resources'

export type RecordedRunObservationPreviewProps = {
  archive: RunObservationArchive
  receiving: RecordedObservationReceivingScope
  media: readonly ResolvedObservationMedia[]
  title: string
  executionContext?: RunObservationExecutionContext
  isActive?: boolean
  readResource: ReplayResourceReader
  renderResource?: RecordedObservationResourceRenderer
  readRawResource?: RecordedResourceReader
  onAskArchiveFile?: (selection: RecordedObservationFileSelection) => void | Promise<void>
  onAskArchiveSelection: (selection: RecordedRunObservationSelection) => void | Promise<void>
}

export const RecordedRunObservationPreview = (
  props: RecordedRunObservationPreviewProps
): React.JSX.Element => {
  const { t } = useTranslation()
  const { renderResource: renderAuthorizedResource } = props
  // Hosts may recreate a target object while updating a reference or title. Only an actual
  // receiving Artifact Version change should rebuild all immutable archive snapshots.
  const { projectId, sessionId, artifactId, versionId } = props.receiving
  const receiving = useMemo(
    () => ({ projectId, sessionId, artifactId, versionId }),
    [projectId, sessionId, artifactId, versionId]
  )
  const projection = useMemo(() => {
    try {
      return projectRecordedObservation(props.archive, receiving, props.media)
    } catch {
      return undefined
    }
  }, [props.archive, receiving, props.media])
  const readResource = useMemo(
    () =>
      projection
        ? authorizedRecordedResourceReader(projection.resolveResource, props.readResource)
        : async () => ({ status: 'unavailable' as const, reason: 'not-recorded' as const }),
    [projection, props.readResource]
  )
  const payload = useMemo(
    () => ({
      archive: props.archive,
      receiving,
      media: props.media,
      executionContext: props.executionContext
    }),
    [props.archive, receiving, props.media, props.executionContext]
  )
  const results = useMemo(() => recordedResults(payload), [payload])
  const readResults = useMemo(
    () => authorizedRecordedResultsReader(payload, props.readRawResource ?? readRecordedResource),
    [payload, props.readRawResource]
  )
  const renderResource = useCallback<RecordedObservationResourceRenderer>(
    (resource, onClose) => {
      const authorized = projection?.resolveResource(resource)
      if (!authorized)
        return <ErrorNotice inline title={t('The recorded evidence is unavailable.')} />
      return renderAuthorizedResource ? (
        renderAuthorizedResource(authorized, onClose)
      ) : (
        <ErrorNotice inline title={t('This file preview is unavailable here.')} />
      )
    },
    [projection, renderAuthorizedResource, t]
  )
  const track = useMemo(() => {
    try {
      return projectLegacyObservationToTrack(props.archive)
    } catch {
      return undefined
    }
  }, [props.archive])
  const readImage = useCallback(
    async (mediaKey: string) => {
      const mapping = props.media.find((item) => item.mediaKey === mediaKey)
      const resource = mapping && projection?.resources.get(mapping.versionId)
      if (!resource) return null
      const value = await readResource(resource)
      return value.status === 'ready' && value.kind === 'image' ? value.content : null
    },
    [props.media, projection, readResource]
  )
  if (!projection) return <ErrorNotice inline title={t('The recorded evidence is unavailable.')} />
  const archive = props.archive,
    source = archive.records.at(-1)!.sourceEvidence.identity
  const incomplete =
    !archive.coverage.terminalRunObserved ||
    archive.coverage.droppedEarlierObservations ||
    Boolean(
      archive.coverage.samplingFailures ||
      archive.coverage.unavailableSamples ||
      archive.coverage.sourceCursorGaps
    )
  const capacityMessage =
    archive.coverage.stopReason === 'capacity'
      ? archive.coverage.capacityLimit === 'snapshots'
        ? t(
            'Recording stopped at the observation count limit. Earlier records are preserved; later activity was not recorded.'
          )
        : archive.coverage.capacityLimit === 'record-bytes'
          ? t(
              'Recording stopped at this recording’s size limit. Earlier records are preserved; later activity was not recorded.'
            )
          : t(
              'Recording stopped at the total recording storage limit. Earlier records are preserved; later activity was not recorded.'
            )
      : undefined
  return (
    <div className="flex h-full min-h-0 flex-col" hidden={props.isActive === false}>
      <p className="shrink-0 px-3 pt-2 text-xs text-muted-foreground">
        {t(
          'Original IDs identify source evidence. Viewing this recording does not create a local Run.'
        )}
      </p>
      <details className="shrink-0 border-b border-border-200 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">{t('Archived observation')}</summary>
        <div className="mt-2 space-y-2">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-all">
            <dt>{t('Recording ID')}</dt>
            <dd>{archive.recordingId}</dd>
            <dt>{t('Source project')}</dt>
            <dd>{source.projectId}</dd>
            <dt>{t('Source Session')}</dt>
            <dd>{source.sessionId}</dd>
            {source.runId ? (
              <>
                <dt>{t('Source Run')}</dt>
                <dd>{source.runId}</dd>
              </>
            ) : null}
          </dl>
          <p>
            {t('Recorded from {{start}} to {{end}}.', {
              start: new Date(archive.coverage.firstObservedAt).toISOString(),
              end: new Date(archive.coverage.lastObservedAt).toISOString()
            })}
          </p>
          <p>{t('Activity before observation began is not included.')}</p>
        </div>
      </details>
      {capacityMessage ||
      incomplete ||
      projection.unresolvedMediaKeys.length ||
      projection.unlinkedSourceFiles ? (
        <div
          role="status"
          className="shrink-0 space-y-1 border-b border-border-200 px-3 py-2 text-xs text-status-warning-foreground"
        >
          {capacityMessage ? (
            <p>{capacityMessage}</p>
          ) : incomplete ? (
            <p>{t('This recording has gaps or ended before the Run finished.')}</p>
          ) : null}
          {projection.unresolvedMediaKeys.length ? (
            <p>{t('Some recorded media could not be resolved on this device.')}</p>
          ) : null}
          {projection.unlinkedSourceFiles ? (
            <p>{t('Some source files have no linked recorded media.')}</p>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <RecordedReplayView
          title={props.title}
          executionContext={props.executionContext}
          sourceIdentity={projection.sourceIdentity}
          snapshots={projection.snapshots}
          active={props.isActive !== false}
          historyTruncated={archive.coverage.droppedEarlierObservations}
          readResource={readResource}
          materialViews={[
            {
              id: 'project',
              label: t('Project replay'),
              content: (active, playback) =>
                track ? (
                  <ProjectReplay
                    active={active}
                    transport={playback}
                    track={track}
                    readImage={readImage}
                    onAskFrame={
                      props.onAskArchiveFile
                        ? (frame) =>
                            props.onAskArchiveFile!(
                              recordedFileSelectionForPayload(payload, frame.mediaKey)
                            )
                        : undefined
                    }
                  />
                ) : null
            },
            {
              id: 'results',
              label: t('Results'),
              content: (
                <ResultsPanel
                  entries={results}
                  read={readResults}
                  onAskFile={
                    props.onAskArchiveFile
                      ? (entry) =>
                          props.onAskArchiveFile!(
                            recordedFileSelectionForPayload(payload, entry.mediaKey!)
                          )
                      : undefined
                  }
                />
              )
            }
          ]}
          renderResource={renderResource}
          onAskSelection={(snapshot) => props.onAskArchiveSelection(projection.select(snapshot))}
        />
      </div>
    </div>
  )
}
