import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import { sessionReplayKey, useSessionReplayStore } from '@/stores/session-replay-store'
import { loadReplayDocument, projectReplayScene } from '@/lib/replay'
import type { ReplayDocument, ReplayResource, ReplayStep } from '../../../../shared/replay'
import type { ReplayViewState } from '../../../../shared/session-replay'
import { ReplayPanel } from './replay/ReplayPanel'
import { ReplaySourceBar } from './replay/ReplaySourceBar'
import { captureDiscussionStep, type SessionDiscussionCapture } from './replay/replay-context'
import ReplayFilePreview from './replay/ReplayFilePreview'
import { fixedReplayResource } from './replay/results/recorded-resource-reader'
import { SessionReplayProgressWriter } from './session-replay-progress-writer'
import { SessionReplayEvidence } from './SessionReplayEvidence'
import { SessionDiscussionDialog } from './SessionDiscussionDialog'
import { openResearchDiscussion } from './workspace-discussion-navigation'
import { ResearchMaterialsPanel } from './ResearchMaterialsPanel'
import { Button } from '@/components/ui/button'
import { RunRecordingsPanel } from './replay/RunRecordingsPanel'
import { useRecordingDiscovery } from './replay/use-recording-discovery'
import { useRecordedMaterials } from './replay/use-recorded-materials'
import { exitResearchReplayFullscreen } from './replay/exit-research-fullscreen'

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
  const discussionRequest = useRef<AbortController | undefined>(undefined)
  const [discussionError, setDiscussionError] = useState<string>()
  const [discussionPending, setDiscussionPending] = useState(false)
  useEffect(() => () => discussionRequest.current?.abort(), [])
  const [discussionCapture, setDiscussionCapture] = useState<SessionDiscussionCapture>()
  const sourceSessionId = item.replaySourceSessionId ?? item.sessionId
  const expanded = usePreviewWorkbenchStore((state) => state.expandedToolItemId === item.id)
  const [loaded, setLoaded] = useState<LoadedReplay>()
  const [error, setError] = useState<string>()
  const [checkpointFailed, setCheckpointFailed] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [evidenceFile, setEvidenceFile] = useState<ReplayResource>()
  const [evidenceStep, setEvidenceStep] = useState<ReplayStep>()
  const [materialsMode, setMaterialsMode] = useState<'replay' | 'runs' | 'records' | 'files'>(
    item.replayRevealMode ?? 'replay'
  )
  const materialsChosen = useRef(item.replayRevealRequest !== undefined)
  // Discovery may finish after the viewer starts playing, seeking, reading or opening evidence.
  // Any deliberate interaction owns the current view; timer checkpoints and programmatic
  // focus/scroll updates do not. Capture also covers controls inside evidence and player rows.
  const keepCurrentMaterials = (): void => {
    materialsChosen.current = true
  }
  const surface = useRef<HTMLDivElement>(null)
  const lastRecordId = useRef<string | undefined>(undefined)
  const returningFromEvidence = useRef(false)
  const lastRevealRequest = useRef(item.replayRevealRequest)
  useEffect(() => {
    if (
      item.replayRevealRequest !== undefined &&
      item.replayRevealRequest !== lastRevealRequest.current
    ) {
      lastRevealRequest.current = item.replayRevealRequest
      // Navigation from the conversation reveals the existing player without moving keyboard
      // focus into the evidence pane or resetting the playhead, speed, or discussion draft.
      returningFromEvidence.current = false
      setEvidenceStep(undefined)
      setEvidenceFile(undefined)
      materialsChosen.current = true
      setMaterialsMode(item.replayRevealMode ?? 'replay')
      return
    }
    if (!isActive || (!evidenceStep && !returningFromEvidence.current)) return
    returningFromEvidence.current = Boolean(evidenceStep)
    const frame = requestAnimationFrame(() => {
      const target = evidenceStep
        ? surface.current?.querySelector<HTMLElement>('[data-replay-evidence-back]')
        : materialsMode === 'records'
          ? [
              ...(surface.current?.querySelectorAll<HTMLElement>('[data-research-record]') ?? [])
            ].find((element) => element.dataset.researchRecord === lastRecordId.current)
          : surface.current?.querySelector<HTMLElement>('[data-replay-browse-steps]')
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [evidenceStep, isActive, materialsMode, item.replayRevealRequest, item.replayRevealMode])
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
  const sourceImportId = useSessionStore((state) => {
    const session = state.sessions.find(
      (candidate) => candidate.projectId === projectId && candidate.id === sourceSessionId
    )
    return session?.packageOrigin?.importId ?? session?.importedResearch?.importId
  })
  const demoSource = useMemo(
    () => (sourceImportId ? { projectId, sourceSessionId, sourceImportId } : undefined),
    [projectId, sourceSessionId, sourceImportId]
  )
  const [sourceObserved, setSourceObserved] = useState(sourcePresent)
  if (sourcePresent && !sourceObserved) setSourceObserved(true)
  const sourceUnavailable =
    (sourceObserved && !sourcePresent) ||
    sourceStatus === 'missing' ||
    sourceStatus === 'unreadable'
  const askStep = (context: SessionDiscussionCapture): void => {
    if (sourceUnavailable) return
    if (discussionRequest.current) return
    const abort = new AbortController()
    discussionRequest.current = abort
    setDiscussionPending(true)
    setDiscussionError(undefined)
    const captured = structuredClone(context)
    const open = async (): Promise<boolean> => {
      const exiting = exitResearchReplayFullscreen()
      if (exiting) await exiting
      if (abort.signal.aborted) return false
      return openResearchDiscussion(captured, abort.signal)
    }
    void open()
      .then((accepted) => {
        if (!accepted) throw new Error('Discussion unavailable')
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setDiscussionError(t('Could not open the research discussion. Please retry.'))
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          discussionRequest.current = undefined
          setDiscussionPending(false)
        }
      })
  }

  const chooseConversation = (context: SessionDiscussionCapture): void => {
    if (sourceUnavailable || discussionRequest.current) return
    const captured = structuredClone(context)
    const abort = new AbortController()
    discussionRequest.current = abort
    const open = async (): Promise<void> => {
      const exiting = exitResearchReplayFullscreen()
      if (exiting) await exiting
      if (!abort.signal.aborted) setDiscussionCapture(captured)
    }
    void open()
      .catch(() => {
        if (!abort.signal.aborted)
          setDiscussionError(t('Could not open the research discussion. Please retry.'))
      })
      .finally(() => {
        if (discussionRequest.current === abort) discussionRequest.current = undefined
      })
  }

  const discovery = useRecordingDiscovery(sourceUnavailable ? undefined : loaded?.document)
  const recordedMaterials = useRecordedMaterials(
    sourceUnavailable ? undefined : loaded?.document,
    discovery,
    demoSource,
    (resource) => {
      if (!loaded || sourceUnavailable) return
      const branch = loaded.document.branches.find((branch) =>
        branch.steps.some((step) => step.resourceIds.includes(resource.id))
      )
      const step = branch?.steps.find((step) => step.resourceIds.includes(resource.id))
      if (!branch || !step || !resource.versionId) throw new Error('Recorded evidence unavailable')
      const context = captureDiscussionStep(
        loaded.document,
        projectReplayScene(loaded.document, branch.id, Math.max(step.startMs, step.endMs - 1))
      )
      askStep({
        ...context,
        stepTitle: resource.name,
        excerpt: resource.name,
        evidence: [
          {
            kind: resource.source === 'upload' ? 'upload-version' : 'artifact-version',
            id: resource.versionId,
            projectId: resource.projectId,
            sessionId: resource.sessionId,
            branchId: branch.id,
            artifactId: resource.artifactId,
            fileId: resource.fileId,
            versionId: resource.versionId,
            part: 'record'
          }
        ],
        records: undefined
      })
    },
    'research'
  )

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

  const openEvidence = (resource: ReplayResource | undefined, step?: ReplayStep): void => {
    if (sourceUnavailable) return
    if (!resource) {
      setEvidenceFile(undefined)
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
    setEvidenceFile(fixedReplayResource({ ...recorded, locator: undefined }))
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
  const materialNavigation = (
    <div className="shrink-0 border-b border-border-200 px-3 py-2">
      {materialsMode !== 'replay' ? (
        <p
          className="truncate text-xs font-medium text-text-300"
          title={loaded.document.source.title}
        >
          {loaded.document.source.title}
        </p>
      ) : null}
      <div role="group" aria-label={t('Research materials')} className="flex flex-wrap gap-1">
        {(['replay', 'runs', 'records', 'files'] as const).map((mode) => (
          <Button
            key={mode}
            variant={materialsMode === mode ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            aria-pressed={materialsMode === mode}
            onClick={() => {
              materialsChosen.current = true
              setEvidenceStep(undefined)
              setEvidenceFile(undefined)
              setMaterialsMode(mode)
            }}
          >
            {mode === 'replay'
              ? t('Session process')
              : mode === 'runs'
                ? t('Run recordings')
                : mode === 'records'
                  ? t('Original records')
                  : t('Source files')}
          </Button>
        ))}
      </div>
    </div>
  )
  return (
    <div
      ref={surface}
      className="flex h-full min-h-0 flex-col"
      onPointerDownCapture={keepCurrentMaterials}
      onClickCapture={keepCurrentMaterials}
      onKeyDownCapture={keepCurrentMaterials}
      onWheelCapture={keepCurrentMaterials}
    >
      {materialsMode !== 'replay' || recordedMaterials.timingReady === false
        ? materialNavigation
        : null}
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
      {discussionError ? <ErrorNotice inline tone="amber" description={discussionError} /> : null}
      {saveError ? (
        <ErrorNotice
          tone="amber"
          description={saveError}
          primaryButton={
            checkpointFailed ? { label: t('Retry'), onClick: loaded.writer.retry } : undefined
          }
        />
      ) : null}
      <div
        className={
          evidenceFile || evidenceStep || materialsMode !== 'replay' ? 'hidden' : 'min-h-0 flex-1'
        }
      >
        {recordedMaterials.timingReady === false ? (
          <p role="status" className="p-4 text-sm text-text-300">
            {t('Preparing recorded material…')}
          </p>
        ) : (
          <ReplayPanel
            presentationMode="research"
            info={
              <>
                <ReplaySourceBar item={item} variant="details" />
                {materialNavigation}
              </>
            }
            recordedCoverage={recordedMaterials.timelineCoverage}
            executionTracks={recordedMaterials.executionTracks}
            executionNotice={recordedMaterials.executionNotice}
            onAskObservation={recordedMaterials.askObservation}
            recordedTimeOrigins={recordedMaterials.recordedTimeOrigins}
            expanded={expanded}
            onToggleExpanded={() =>
              usePreviewWorkbenchStore.getState().setToolItemExpanded(expanded ? null : item.id)
            }
            materialViews={recordedMaterials.views}
            materialViewRequest={recordedMaterials.request}
            document={recordedMaterials.playbackDocument ?? loaded.document}
            initialView={loaded.view}
            active={isActive && !evidenceFile && !evidenceStep && materialsMode === 'replay'}
            onViewChange={notebookUnavailable ? undefined : loaded.writer.enqueue}
            onAskStep={askStep}
            discussionPending={discussionPending}
            onChooseConversation={chooseConversation}
            onOpenEvidence={openEvidence}
          />
        )}
      </div>
      {materialsMode === 'runs' ? (
        <RunRecordingsPanel
          discovery={discovery}
          onChoose={(candidate) => {
            recordedMaterials.choose(candidate)
            setMaterialsMode('replay')
          }}
        />
      ) : null}
      {materialsMode === 'records' || materialsMode === 'files' ? (
        <div className={evidenceStep || evidenceFile ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
          <ResearchMaterialsPanel
            key={materialsMode}
            document={loaded.document}
            mode={materialsMode}
            onOpenRecord={(step) => {
              lastRecordId.current = step.id
              setEvidenceStep(step)
            }}
            onOpenFile={(resource) => openEvidence(resource)}
          />
        </div>
      ) : null}
      {evidenceFile ? (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={t('Recorded file version')}>
          <div className="flex items-center gap-2 border-b border-border-200 p-2">
            <Button size="sm" variant="outline" onClick={() => setEvidenceFile(undefined)}>
              {t('Back to recording')}
            </Button>
            <span className="truncate text-sm">{evidenceFile.name}</span>
          </div>
          <div className="min-h-0 flex-1">
            <ReplayFilePreview resource={evidenceFile} onClose={() => setEvidenceFile(undefined)} />
          </div>
        </section>
      ) : null}
      {evidenceStep && !evidenceFile ? (
        <SessionReplayEvidence
          source={loaded.document.source}
          step={evidenceStep}
          resources={loaded.document.resources}
          onBack={() => setEvidenceStep(undefined)}
          backLabel={materialsMode === 'records' ? t('Back to original records') : undefined}
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
