import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import { sessionReplayKey, useSessionReplayStore } from '@/stores/session-replay-store'
import { loadReplayDocument } from '@/lib/replay'
import type { ReplayDocument, ReplayResource, ReplayStep } from '../../../../shared/replay'
import type { ReplayViewState } from '../../../../shared/session-replay'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../../../shared/uploads'
import { ReplayPanel } from './replay/ReplayPanel'
import type { SessionDiscussionCapture } from './replay/replay-context'
import { createPreviewFileItem } from './preview-file-item'
import { SessionReplayProgressWriter } from './session-replay-progress-writer'
import { SessionReplayEvidence } from './SessionReplayEvidence'
import { SessionDiscussionDialog } from './SessionDiscussionDialog'

type Props = { item: PreviewToolItem; isActive?: boolean }
type LoadedReplay = {
  document: ReplayDocument
  view?: ReplayViewState
  writer: SessionReplayProgressWriter
  attempt: number
}

const SessionReplayContent = ({ item, isActive = true }: Props): React.JSX.Element => {
  const { t } = useTranslation()
  // Restored background tabs should not read entire archives before their first activation.
  const [activated, setActivated] = useState(isActive)
  if (isActive && !activated) setActivated(true)
  const projectId = item.replaySourceProjectId ?? item.projectId ?? ''
  const [discussionCapture, setDiscussionCapture] = useState<SessionDiscussionCapture>()
  const sourceSessionId = item.replaySourceSessionId ?? item.sessionId
  const expanded = usePreviewWorkbenchStore((state) => state.expandedToolItemId === item.id)
  const [loaded, setLoaded] = useState<LoadedReplay>()
  const [error, setError] = useState<string>()
  const [checkpointFailed, setCheckpointFailed] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [evidenceStep, setEvidenceStep] = useState<ReplayStep>()
  const surface = useRef<HTMLDivElement>(null)
  const returningFromEvidence = useRef(false)
  useEffect(() => {
    if (!isActive || (!evidenceStep && !returningFromEvidence.current)) return
    returningFromEvidence.current = Boolean(evidenceStep)
    const frame = requestAnimationFrame(() => {
      surface.current
        ?.querySelector<HTMLElement>(
          evidenceStep ? '[data-replay-evidence-back]' : '[data-replay-browse-steps]'
        )
        ?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [evidenceStep, isActive])
  const loadAbort = useRef<AbortController | undefined>(undefined)
  const activeWriter = useRef<SessionReplayProgressWriter | undefined>(undefined)
  const sourceStatus = useSessionReplayStore(
    (state) => state.snapshots[sessionReplayKey(projectId, sourceSessionId)]?.sourceStatus
  )
  const sourcePresent = useSessionStore((state) =>
    state.sessions.some(
      (session) => session.projectId === projectId && session.id === sourceSessionId
    )
  )
  const [sourceObserved, setSourceObserved] = useState(sourcePresent)
  if (sourcePresent && !sourceObserved) setSourceObserved(true)
  const sourceUnavailable =
    (sourceObserved && !sourcePresent) ||
    sourceStatus === 'missing' ||
    sourceStatus === 'unreadable'

  useEffect(() => {
    if (!activated) return
    const abort = new AbortController()
    loadAbort.current = abort
    let writer: SessionReplayProgressWriter | undefined
    void Promise.all([
      loadReplayDocument(
        window.api,
        { projectId, sessionId: sourceSessionId },
        { signal: abort.signal }
      ),
      window.api.sessionReplay.get({ projectId, sourceSessionId })
    ])
      .then(([document, snapshot]) => {
        if (abort.signal.aborted) return
        useSessionReplayStore.getState().put(snapshot)
        if (snapshot.sourceStatus !== 'available' && snapshot.sourceStatus !== 'archived')
          throw new Error(t('The source research is unavailable.'))
        writer = new SessionReplayProgressWriter(
          { projectId, sourceSessionId },
          snapshot.view?.revision ?? 0,
          (request) => window.api.sessionReplay.saveView(request),
          (result) => {
            if (abort.signal.aborted) return
            setCheckpointFailed(result !== 'saved')
            setSaveError(
              result === 'saved'
                ? undefined
                : result === 'conflict'
                  ? t(
                      'The viewing position changed in another window. Retry to save this position.'
                    )
                  : result.message
            )
          }
        )
        activeWriter.current = writer
        setSaveError(undefined)
        setEvidenceStep(undefined)
        setLoaded({ document, view: snapshot.view?.state, writer, attempt })
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      abort.abort()
      writer?.dispose()
      if (activeWriter.current === writer) activeWriter.current = undefined
    }
  }, [activated, projectId, sourceSessionId, attempt, t])

  useEffect(() => {
    if (sourceUnavailable) {
      loadAbort.current?.abort()
      activeWriter.current?.dispose()
    }
  }, [sourceUnavailable])

  const retry = (): void => {
    setSourceObserved(sourcePresent)
    setLoaded(undefined)
    setError(undefined)
    setSaveError(undefined)
    setEvidenceStep(undefined)
    setAttempt((value) => value + 1)
  }

  const askStep = (context: SessionDiscussionCapture): void => {
    if (sourceUnavailable) return
    setDiscussionCapture(context)
  }

  const openEvidence = (resource: ReplayResource | undefined, step: ReplayStep): void => {
    if (sourceUnavailable) return
    if (!resource) {
      setEvidenceStep(step)
      return
    }
    // An upload can be owned by a different Session while still being archived in this research.
    // Only the loaded source's exact record may authorize that cross-Session preview.
    const recorded = loaded?.document.resources.find(
      (candidate) =>
        candidate.id === resource.id &&
        (candidate.source ?? 'artifact') === (resource.source ?? 'artifact') &&
        candidate.projectId === resource.projectId &&
        candidate.sessionId === resource.sessionId &&
        candidate.artifactId === resource.artifactId &&
        candidate.fileId === resource.fileId &&
        candidate.versionId === resource.versionId
    )
    const source = recorded?.source ?? 'artifact'
    const fileId = source === 'upload' ? recorded?.fileId : recorded?.artifactId
    if (
      !recorded ||
      !fileId ||
      !recorded.versionId ||
      !recorded.sessionId ||
      recorded.availability !== 'recorded' ||
      recorded.projectId !== projectId ||
      (source === 'artifact' && recorded.sessionId !== sourceSessionId)
    ) {
      setCheckpointFailed(false)
      setSaveError(t('The recorded evidence is unavailable.'))
      return
    }
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createPreviewFileItem({
        id: `replay-evidence:${projectId}:${sourceSessionId}:${source}:${fileId}:${recorded.versionId}`,
        projectId,
        sessionId: recorded.sessionId,
        path:
          source === 'upload'
            ? createUploadVersionReference(recorded.versionId, {
                projectId,
                sessionId: recorded.sessionId,
                fileId
              })
            : createArtifactVersionLocator({
                projectId,
                appSessionId: recorded.sessionId,
                artifactId: fileId,
                versionId: recorded.versionId
              }),
        name: recorded.name,
        mimeType: recorded.mimeType,
        artifactId: source === 'artifact' ? fileId : undefined,
        managedFileId: fileId,
        selectedVersionId: recorded.versionId,
        versionNumber: recorded.versionNumber,
        size: recorded.size,
        source
      })
    )
  }

  if (error || sourceUnavailable)
    return (
      <ErrorNotice
        title={t('Could not load research replay')}
        description={error ?? t('The source research is unavailable.')}
        primaryButton={{ label: t('Retry'), onClick: retry }}
      />
    )
  if (!loaded || loaded.attempt !== attempt)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {t('Preparing research replay…')}
      </p>
    )
  const notebookUnavailable = loaded.document.issues.some(
    (issue) => issue.code === 'notebook-unavailable'
  )
  return (
    <div ref={surface} className="flex h-full min-h-0 flex-col">
      {notebookUnavailable ? (
        <ErrorNotice
          inline
          tone="amber"
          description={t('Recorded Notebook details are unavailable.')}
          primaryButton={{ label: t('Retry'), onClick: retry }}
        />
      ) : null}
      {discussionCapture ? (
        <SessionDiscussionDialog
          context={discussionCapture}
          onClose={() => setDiscussionCapture(undefined)}
        />
      ) : null}
      {saveError ? (
        <ErrorNotice
          tone="amber"
          description={saveError}
          primaryButton={
            checkpointFailed ? { label: t('Retry'), onClick: loaded.writer.retry } : undefined
          }
        />
      ) : null}
      <div className={evidenceStep ? 'hidden' : 'min-h-0 flex-1'}>
        <ReplayPanel
          expanded={expanded}
          onToggleExpanded={() =>
            usePreviewWorkbenchStore.getState().setToolItemExpanded(expanded ? null : item.id)
          }
          document={loaded.document}
          initialView={loaded.view}
          active={isActive && !evidenceStep}
          onViewChange={notebookUnavailable ? undefined : loaded.writer.enqueue}
          onAskStep={askStep}
          onOpenEvidence={openEvidence}
        />
      </div>
      {evidenceStep ? (
        <SessionReplayEvidence
          source={loaded.document.source}
          step={evidenceStep}
          resources={loaded.document.resources}
          onBack={() => setEvidenceStep(undefined)}
          onOpenResource={(resource) => openEvidence(resource, evidenceStep)}
        />
      ) : null}
    </div>
  )
}

// A source change remounts all viewing state. Late writes from the previous source keep their
// original identity and can never supply the new source's CAS revision or player state.
export const SessionReplayPreview = (props: Props): React.JSX.Element => (
  <SessionReplayContent
    key={JSON.stringify([
      props.item.projectId,
      props.item.replaySourceProjectId,
      props.item.replaySourceSessionId ?? props.item.sessionId
    ])}
    {...props}
  />
)
