import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import { researchWorkspaceKey, useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { loadReplayDocument } from '@/lib/replay'
import { forkSession, sessionForkAvailable } from '@/lib/session-fork'
import type { ReplayDocument, ReplayResource, ReplayStep } from '../../../../shared/replay'
import type { ReplayViewState } from '../../../../shared/research-workspace'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../../../shared/uploads'
import { ReplayPanel } from './replay/ReplayPanel'
import type { ReplayStepContext } from './replay/replay-context'
import { createPreviewFileItem } from './preview-file-item'
import { ResearchReplayViewWriter } from './research-replay-view-writer'
import { ResearchReplayEvidence } from './ResearchReplayEvidence'

type Props = { item: PreviewToolItem; isActive?: boolean }
type LoadedReplay = {
  document: ReplayDocument
  view?: ReplayViewState
  writer: ResearchReplayViewWriter
  attempt: number
}

const ResearchReplaySession = ({ item, isActive = true }: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const projectId = item.projectId ?? ''
  const sourceSessionId = item.replaySourceSessionId ?? item.sessionId
  const expanded = usePreviewWorkbenchStore((state) => state.expandedToolItemId === item.id)
  const [loaded, setLoaded] = useState<LoadedReplay>()
  const [error, setError] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [evidenceStep, setEvidenceStep] = useState<ReplayStep>()
  const loadAbort = useRef<AbortController | undefined>(undefined)
  const activeWriter = useRef<ResearchReplayViewWriter | undefined>(undefined)
  const sourceStatus = useResearchWorkspaceStore(
    (state) => state.snapshots[researchWorkspaceKey(projectId, sourceSessionId)]?.sourceStatus
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
    sourceStatus === 'unreadable' ||
    sourceStatus === 'not-imported'

  useEffect(() => {
    const abort = new AbortController()
    loadAbort.current = abort
    let writer: ResearchReplayViewWriter | undefined
    void Promise.all([
      loadReplayDocument(
        window.api,
        { projectId, sessionId: sourceSessionId },
        { signal: abort.signal }
      ),
      window.api.researchWorkspaces.get({ projectId, sourceSessionId })
    ])
      .then(([document, snapshot]) => {
        if (abort.signal.aborted) return
        useResearchWorkspaceStore.getState().put(snapshot)
        if (snapshot.sourceStatus !== 'available' && snapshot.sourceStatus !== 'archived')
          throw new Error(t('The source research is unavailable.'))
        writer = new ResearchReplayViewWriter(
          { projectId, sourceSessionId },
          snapshot.view?.revision ?? 0,
          (request) => window.api.researchWorkspaces.saveView(request),
          (result) => {
            if (abort.signal.aborted) return
            setSaveError(
              result === 'saved'
                ? undefined
                : result === 'conflict'
                  ? t(
                      'The viewing position changed in another window. Pause again to save this position.'
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
  }, [projectId, sourceSessionId, attempt, t])

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

  const askStep = (context: ReplayStepContext): void => {
    if (sourceUnavailable) return
    const navigation = useNavigationStore.getState()
    useResearchWorkspaceStore.getState().ask(context)
    usePreviewWorkbenchStore.getState().setToolItemExpanded(null)
    if (
      navigation.researchWorkspace?.sourceSessionId !== sourceSessionId ||
      navigation.activeProjectId !== projectId
    ) {
      if (!navigation.openSession(projectId, sourceSessionId, 'user')) {
        setSaveError(t('The source research is unavailable.'))
      }
    }
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      {saveError ? (
        <p role="status" className="px-3 py-1 text-xs text-status-warning">
          {saveError}
        </p>
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
          onViewChange={loaded.writer.enqueue}
          onAskStep={askStep}
          onOpenEvidence={openEvidence}
          onContinueResearch={
            sessionForkAvailable()
              ? () => {
                  void forkSession({ projectId, id: sourceSessionId })
                }
              : undefined
          }
        />
      </div>
      {evidenceStep ? (
        <ResearchReplayEvidence
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
export const ResearchReplayPreview = (props: Props): React.JSX.Element => (
  <ResearchReplaySession
    key={JSON.stringify([
      props.item.projectId,
      props.item.replaySourceSessionId ?? props.item.sessionId
    ])}
    {...props}
  />
)
