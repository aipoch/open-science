import { RESEARCH_VIDEO_PLAYER_SIZE_ERROR } from '@aipoch/research-film/contracts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import {
  RESEARCH_VIDEO_STATUS_TIMEOUT_MS,
  RESEARCH_VIDEO_STATUS_TIMEOUT_MESSAGE,
  RESEARCH_FILM_BUSY_MESSAGE,
  RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE,
  researchVideoFilename
} from '../../../shared/research-video-presentation'
import { dialogBodyClassName, dialogFooterClassName } from './ui/dialog-chrome'
import { WorkflowDialogFrame } from './ui/workflow-dialog-frame'
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  Video,
  Loader2,
  Play,
  Clock3,
  AudioLines,
  RotateCcw,
  MoreHorizontal,
  Trash2,
  BookOpen,
  ListVideo,
  MessageSquare,
  Terminal,
  FileCheck2
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { ErrorNotice } from './error-notice'
import { DownloadProgressLine } from './DownloadProgressLine'
import { ResearchVideoProgressLine } from './research-video-progress'
import { localModelDownloadProgress, type LocalModelSnapshot } from '../../../shared/local-models'
import type {
  ResearchVideoPresentation,
  ResearchVideoPresentationRequest,
  ResearchVideoPresentationStatus,
  ResearchFilmMode
} from '../../../shared/research-video-presentation'
import { isDesktopRenderer } from '@/lib/interface-scale'
import { useSettingsStore } from '@/stores/settings-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

export type ResearchVideoTriggerState = { label: string; disabledReason?: string }

const missingModel = 'Select a model in Settings before generating a research film.'
const missingRuntime =
  'Set up the selected agent runtime in Settings before generating a research film.'

const narrationReady = (model: LocalModelSnapshot | undefined): boolean =>
  model?.availability === 'ready' && !model.updateAvailable

// Keep the settled deadline until the actual desktop request settles, including across remounts.
const filmStatusReads = new Map<
  string,
  { checkReadiness: boolean; result: Promise<ResearchVideoPresentationStatus> }
>()
function readFilmStatus(
  request: ResearchVideoPresentationRequest,
  checkReadiness = false
): Promise<ResearchVideoPresentationStatus> {
  const scope = JSON.stringify([
    request.projectId,
    request.sessionId,
    request.branchId,
    request.mode ?? 'research-explanation'
  ])
  const existing = filmStatusReads.get(scope)
  if (existing)
    return checkReadiness && !existing.checkReadiness
      ? existing.result.then(() => readFilmStatus(request, true))
      : existing.result
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    // Let the backend report its own timeout first when the transport is responding.
    timer = setTimeout(
      () => reject(new Error(RESEARCH_VIDEO_STATUS_TIMEOUT_MESSAGE)),
      RESEARCH_VIDEO_STATUS_TIMEOUT_MS + 1000
    )
  })
  const read = Promise.resolve()
    .then(() =>
      window.api.researchVideo.status(checkReadiness ? { ...request, checkReadiness } : request)
    )
    .finally(() => {
      clearTimeout(timer)
      filmStatusReads.delete(scope)
    })
  const bounded = Promise.race([read, deadline])
  filmStatusReads.set(scope, { checkReadiness, result: bounded })
  return bounded
}

function FilmErrorNotice({
  summary,
  detail
}: {
  summary: string
  detail: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <>
      <ErrorNotice
        inline
        tone="amber"
        role="alert"
        title={summary}
        diagnosticsLabel={t('Details')}
        errorCode={detail}
        className="[&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre]:overscroll-contain [&_pre]:select-text"
        secondaryButton={{
          variant: 'ghost',
          label: copyStatus === 'copied' ? t('Copied') : t('Copy error'),
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(detail)
              setCopyStatus('copied')
            } catch {
              setCopyStatus('failed')
            }
          }
        }}
      />
      {copyStatus === 'failed' && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('Could not copy details. Select the text and copy it manually.')}
        </p>
      )}
    </>
  )
}

type FilmButtonProps = ResearchVideoPresentationRequest & {
  preferSavedFilm?: boolean
  renderTrigger?: (
    open: (() => void) | undefined,
    state: ResearchVideoTriggerState
  ) => React.ReactNode
}

const filmModes = ['research-explanation', 'operation-replay'] as const

function FilmModeIllustration({ mode }: { mode: ResearchFilmMode }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-24 items-center justify-center rounded-md border border-border bg-card px-3 text-primary"
    >
      {mode === 'research-explanation' ? (
        <span className="grid w-full max-w-40 grid-cols-2 items-center gap-3">
          <span className="flex h-14 items-end justify-center gap-1.5 border-b border-border pb-1">
            <span className="h-1/3 w-2.5 rounded-t-sm bg-primary/25" />
            <span className="h-3/5 w-2.5 rounded-t-sm bg-primary/45" />
            <span className="h-full w-2.5 rounded-t-sm bg-primary/70" />
          </span>
          <span className="grid gap-2">
            <span className="h-1.5 w-3/4 rounded-full bg-primary/60" />
            <span className="h-1 rounded-full bg-muted-foreground/25" />
            <span className="h-1 w-2/3 rounded-full bg-muted-foreground/25" />
          </span>
        </span>
      ) : (
        <span className="relative grid w-full max-w-36 gap-1.5">
          <span className="absolute inset-y-2 left-[9px] w-px bg-primary/30" />
          {[MessageSquare, Terminal, FileCheck2].map((Icon, index) => (
            <span key={index} className="relative flex items-center gap-2">
              <Icon className="size-[18px] rounded bg-card p-0.5" />
              <span className="flex h-4 flex-1 items-center rounded-sm bg-muted px-2">
                <span className="h-1 w-3/4 rounded-full bg-muted-foreground/30" />
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

function filmRequest(
  projectId: string,
  sessionId: string,
  branchId: string | undefined,
  mode: ResearchFilmMode
): ResearchVideoPresentationRequest {
  return { projectId, sessionId, branchId, ...(mode === 'operation-replay' ? { mode } : {}) }
}

export function ResearchVideoButton(props: FilmButtonProps): React.JSX.Element | null {
  return (
    <ResearchVideoModeButton
      key={JSON.stringify([props.projectId, props.sessionId, props.branchId])}
      {...props}
    />
  )
}

export function ResearchVideoDialog(
  props: ResearchVideoPresentationRequest & { onDismiss: () => void }
): React.JSX.Element {
  return <ResearchVideoModeButton {...props} renderTrigger={() => null} />
}

function ResearchVideoModeButton({
  preferSavedFilm = false,
  onDismiss,
  renderTrigger,
  projectId,
  sessionId,
  branchId,
  mode: initialMode = 'research-explanation'
}: FilmButtonProps & { onDismiss?: () => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [statuses, setStatuses] = useState<
    Partial<Record<ResearchFilmMode, ResearchVideoPresentationStatus>>
  >({})
  const [selectedMode, setMode] = useState<ResearchFilmMode>()
  const mode =
    selectedMode ??
    (preferSavedFilm && !statuses[initialMode]?.result
      ? (filmModes.find((candidate) => statuses[candidate]?.result) ?? initialMode)
      : initialMode)

  const [open, setOpen] = useState(Boolean(onDismiss))
  const request = filmRequest(projectId, sessionId, branchId, mode)
  const deletionScope = mode
  const [deletionTarget, setDeletionTarget] = useState<string>()
  const confirmDeletion = deletionTarget === deletionScope
  const setConfirmDeletion = (confirm: boolean): void =>
    setDeletionTarget(confirm ? deletionScope : undefined)
  const [confirmRegeneration, setConfirmRegeneration] = useState(false)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const cancelDeletionRef = useRef<HTMLButtonElement>(null)
  const wasDeleting = useRef(false)
  useLayoutEffect(() => {
    if (confirmDeletion) cancelDeletionRef.current?.focus()
    else if (wasDeleting.current) deleteTriggerRef.current?.focus()
    wasDeleting.current = confirmDeletion
  }, [confirmDeletion])
  const confirmationDescriptionId = useId()
  const modeDescriptionId = useId()
  const status = statuses[mode] ?? {}
  const statusLoaded = statuses[mode] !== undefined
  const [model, setModel] = useState<LocalModelSnapshot>()
  const [pending, setPending] = useState(false)
  const installing = Boolean(status.narrationDownload)
  const [errors, setErrors] = useState<Partial<Record<ResearchFilmMode, string>>>({})
  const [readErrors, setReadErrors] = useState<Partial<Record<ResearchFilmMode, string>>>({})
  const setError = (next: string | undefined): void =>
    setErrors((current) => ({ ...current, [mode]: next }))
  const triggerRef = useRef<HTMLSpanElement>(null)
  const regenerateRef = useRef<HTMLButtonElement>(null)
  const cancelRegenerationRef = useRef<HTMLButtonElement>(null)
  const wasRegenerating = useRef(false)
  useLayoutEffect(() => {
    if (confirmRegeneration) cancelRegenerationRef.current?.focus()
    else if (wasRegenerating.current) regenerateRef.current?.focus()
    wasRegenerating.current = confirmRegeneration
  }, [confirmRegeneration])
  const settingsAfterClose = useRef(false)
  const statusVersion = useRef<Record<ResearchFilmMode, number>>({
    'research-explanation': 0,
    'operation-replay': 0
  })
  const live = useRef(true)
  const setStatus = (next: ResearchVideoPresentationStatus): void => {
    statusVersion.current[mode]++
    setReadErrors((current) =>
      current[mode] === undefined ? current : { ...current, [mode]: undefined }
    )
    setStatuses((current) => ({ ...current, [mode]: next }))
  }
  const busy =
    status.progress && !['completed', 'failed', 'cancelled'].includes(status.progress.phase)
  const playableResult = busy || installing || pending ? undefined : status.result
  const duration = Math.max(0, Math.round(playableResult?.duration ?? 0))
  const blockMessages = {
    unavailable: t('This session is unavailable.'),
    empty: t('Add conversation content before generating.'),
    'awaiting-reply': t('Wait for a completed response before generating.'),
    busy: t('Wait for the current response to finish before generating.')
  }
  const preflightMessages: Record<string, string> = {
    [RESEARCH_FILM_BUSY_MESSAGE]: t('Another film is being generated. Wait for it to finish.'),
    [missingModel]: t('Select a model in Settings before generating a research film.'),
    'The selected provider credentials are unavailable. Check them in Settings.': t(
      'The selected provider credentials are unavailable. Check them in Settings.'
    ),
    'The selected model is unavailable. Select another model in Settings.': t(
      'The selected model is unavailable. Select another model in Settings.'
    ),
    "This provider isn't compatible with the active agent framework.": t(
      "This provider isn't compatible with the active agent framework."
    ),
    'The selected model input limit cannot fit the research film instructions. Select a model with a larger input limit.':
      t(
        'The selected model input limit cannot fit the research film instructions. Select a model with a larger input limit.'
      ),
    [missingRuntime]: t(
      'Set up the selected agent runtime in Settings before generating a research film.'
    ),
    'Check the selected model and credentials in Settings before generating a research film.': t(
      'Check the selected model and credentials in Settings before generating a research film.'
    )
  }
  const filmErrors: Record<string, string> = {
    [RESEARCH_FILM_MODEL_TIMEOUT_MESSAGE]: t('Model request timed out. Try again.'),
    'Research film readiness check timed out. Try again.': t(
      'Generation preparation timed out. Try again.'
    ),
    'Research film model setup timed out. Try again.': t('Model setup timed out. Try again.'),
    'Research film generation reached the model output token limit. Increase the model output limit or select another model and try again.':
      t('The model reached its output limit. Increase the limit or select another model.'),
    'Research film generation stopped before completing (cancelled). Try again or select another model.':
      t('The model stopped before completing this step. Try again.'),
    'Restricted inference was cancelled.': t(
      'The model stopped before completing this step. Try again.'
    ),
    'Research film generation stopped before completing (refusal). Try again or select another model.':
      t('The model declined to generate this content.'),
    'Film is still waiting for the disk. Try again after the disk responds.': t(
      'Waiting for storage. Try again after it responds.'
    ),
    [RESEARCH_VIDEO_PLAYER_SIZE_ERROR]: t(
      'The film exceeds 200 MiB. Shorten it or use smaller media.'
    ),
    'Shorten the film to fit the narration audio limit.': t(
      'Shorten the film to fit the narration audio limit.'
    ),
    'The model returned no research film content. Try again or select another model.': t(
      'The model returned no film content.'
    ),
    'Research film generation stopped before completing (max_turn_requests). Try again or select another model.':
      t('The model reached a generation limit before completing this step.'),
    'Narration installation did not finish. Retry to continue.': t(
      'Narration installation did not finish. Retry to continue.'
    )
  }
  const failure = errors[mode] || status.error
  const statusReadFailure = !failure && readErrors[mode]
  const preflight = status.preflightError
  const knownPreflight = preflight && Object.hasOwn(preflightMessages, preflight)
  const blocked = status.generationBlock
    ? blockMessages[status.generationBlock]
    : preflight && (knownPreflight ? preflightMessages[preflight] : t('Research video failed'))
  const diagnostic = blocked
    ? !busy && !status.generationBlock && !knownPreflight && preflight
    : failure || statusReadFailure
  const modelSettingsAvailable =
    !status.generationBlock &&
    status.preflightError &&
    status.preflightError !== missingRuntime &&
    status.preflightError !== RESEARCH_FILM_BUSY_MESSAGE &&
    knownPreflight
  const loadingTrigger =
    !statusLoaded ||
    (preferSavedFilm &&
      !selectedMode &&
      !status.result &&
      filmModes.some((candidate) => statuses[candidate] === undefined))
  const triggerState: ResearchVideoTriggerState = {
    label: loadingTrigger
      ? t('Loading…')
      : busy || installing || pending
        ? t('View generation progress')
        : status.result
          ? t('View research film')
          : t('Generate research film'),
    disabledReason: loadingTrigger ? t('Loading…') : undefined
  }
  const renderSettingsButton = (label?: string): React.JSX.Element => (
    <button
      type="button"
      className="cursor-pointer rounded-sm text-left text-primary underline underline-offset-2 focus-visible:outline-ring"
      onClick={() => {
        settingsAfterClose.current = true
        setOpen(false)
      }}
    >
      {label}
    </button>
  )
  const desktop = isDesktopRenderer()
  const wasInstalling = useEffectEvent((target: ResearchFilmMode) => mode === target && installing)
  const watching = Object.values(statuses).some(
    (next) =>
      next.narrationDownload ||
      (next.progress && !['completed', 'failed', 'cancelled'].includes(next.progress.phase))
  )
  const pollingDelay = useEffectEvent((next: ResearchVideoPresentationStatus): number =>
    next.narrationDownload ||
    (next.progress && !['completed', 'failed', 'cancelled'].includes(next.progress.phase))
      ? 750
      : open
        ? 5_000
        : 30_000
  )
  useEffect(() => {
    if (!desktop) return
    live.current = true
    let subscribed = true
    // Each mode can settle independently. A slow read for one film does not block the other.
    const stopPolling = filmModes.map((target) => {
      let timer: ReturnType<typeof setTimeout>
      let failures = 0
      const targetRequest = filmRequest(projectId, sessionId, branchId, target)
      const poll = async (): Promise<void> => {
        const version = statusVersion.current[target]
        let delay = 750
        try {
          const next = await readFilmStatus(targetRequest)
          failures = 0
          delay = pollingDelay(next)
          const refreshedModel =
            subscribed && wasInstalling(target) && !next.narrationDownload
              ? await window.api.localModels.getSnapshot('research-narration')
              : undefined
          if (subscribed && version === statusVersion.current[target]) {
            setReadErrors((current) =>
              current[target] === undefined ? current : { ...current, [target]: undefined }
            )
            if (refreshedModel) setModel(refreshedModel)
            setStatuses((current) => ({ ...current, [target]: next }))
          }
        } catch (error) {
          delay = Math.min(30_000, 5_000 * 2 ** Math.min(failures++, 3))
          if (subscribed && version === statusVersion.current[target]) {
            setReadErrors((current) => ({
              ...current,
              [target]: error instanceof Error ? error.message : String(error)
            }))
            setStatuses((current) =>
              current[target] === undefined ? { ...current, [target]: {} } : current
            )
          }
        }
        if (subscribed) timer = setTimeout(() => void poll(), delay)
      }
      void poll()
      return () => clearTimeout(timer)
    })
    return () => {
      live.current = false
      subscribed = false
      stopPolling.forEach((stop) => stop())
    }
  }, [projectId, sessionId, branchId, desktop, open, watching])
  const checkSelectedReadiness = useEffectEvent(() => {
    let current = true
    const version = ++statusVersion.current[mode]
    void readFilmStatus(request, true)
      .then((next) => {
        if (current && version === statusVersion.current[mode]) {
          setStatus(next)
          setError(undefined)
        }
      })
      .catch((error: unknown) => {
        if (current && version === statusVersion.current[mode])
          setReadErrors((previous) => ({
            ...previous,
            [mode]: error instanceof Error ? error.message : String(error)
          }))
      })
    return () => {
      current = false
    }
  })
  useEffect(() => {
    if (open && desktop) return checkSelectedReadiness()
    return undefined
  }, [open, desktop])
  const selectMode = (next: ResearchFilmMode): void => {
    if (next === mode) return
    wasDeleting.current = false
    wasRegenerating.current = false
    setConfirmDeletion(false)
    setConfirmRegeneration(false)
    setModel(undefined)
    setMode(next)
  }
  const generate = async (regenerate = false, resume = false): Promise<void> => {
    if (pending || busy || installing) {
      setOpen(true)
      return
    }
    setOpen(true)
    setPending(true)
    setError(undefined)
    try {
      const current = await readFilmStatus(request, !resume).catch((caught: unknown) => {
        if (live.current)
          setReadErrors((previous) => ({
            ...previous,
            [mode]: caught instanceof Error ? caught.message : String(caught)
          }))
        return undefined
      })
      if (!live.current || !current) return
      setStatus(current)
      if (
        current.narrationDownload ||
        (current.result && !current.canResume && !regenerate && !resume)
      )
        return
      if (current.generationBlock || (!resume && current.preflightError)) return
      if (
        current.progress &&
        !['completed', 'failed', 'cancelled'].includes(current.progress.phase)
      )
        return
      // The owner can publish a complete checkpoint without loading the narration model.
      if (resume) {
        if (current.canResume)
          setStatus(await window.api.researchVideo.start({ ...request, resume: true }))
        return
      }
      const snapshot = await window.api.localModels.getSnapshot('research-narration')
      if (!live.current) return
      setModel(snapshot)
      if (current.canResume && !regenerate) return
      if (narrationReady(snapshot)) setStatus(await window.api.researchVideo.start(request))
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (live.current) setPending(false)
    }
  }
  const install = async (): Promise<void> => {
    if (blocked) return
    setPending(true)
    setError(undefined)
    try {
      const next = await window.api.researchVideo.start({
        ...request,
        installNarration: true,
        ...(status.canResume ? { resume: true } : {})
      })
      if (live.current) {
        setStatus(next)
      }
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (live.current) setPending(false)
    }
  }
  const cancel = async (): Promise<void> => {
    setPending(true)
    try {
      await window.api.researchVideo.cancel(request)
      if (live.current) {
        setStatus(await readFilmStatus(request))
      }
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (live.current) setPending(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (pending || busy || installing) return
    setPending(true)
    setError(undefined)
    try {
      const result = status.result
      const next = await window.api.researchVideo.remove(request)
      if (!live.current) return
      if (result)
        usePreviewWorkbenchStore.getState().removeItem(`research-video-${result.id}-player`)
      setStatus(next)
      setConfirmDeletion(false)
      setOpen(false)
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (live.current) setPending(false)
    }
  }
  const preview = (result: ResearchVideoPresentation): void => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem({
      id: `research-video-${result.id}-player`,
      type: 'file',
      source: 'local',
      projectId,
      sessionId,
      path: result.playerPath,
      name: researchVideoFilename(result.title, 'html'),
      title: result.title,
      format: 'html'
    })
    setConfirmRegeneration(false)
    setOpen(false)
  }
  const openDialog = (): void => {
    setMode(mode)
    setOpen(true)
  }
  if (!desktop) return renderTrigger ? <>{renderTrigger(undefined, triggerState)}</> : null
  return (
    <>
      <span ref={triggerRef} className="contents">
        {renderTrigger ? (
          renderTrigger(openDialog, triggerState)
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || Boolean(triggerState.disabledReason)}
            title={triggerState.disabledReason}
            onClick={openDialog}
          >
            {loadingTrigger || busy || installing ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Video className="size-4" aria-hidden="true" />
            )}
            {triggerState.label}
          </Button>
        )}
      </span>
      {open && (
        <WorkflowDialogFrame
          title={t('Research film')}
          stage={statusLoaded ? mode : 'loading'}
          descriptionClassName="truncate"
          busy={false}
          onClose={() => {
            setConfirmRegeneration(false)
            setConfirmDeletion(false)
            setOpen(false)
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.querySelector('button')?.focus()
            onDismiss?.()
            if (settingsAfterClose.current) {
              useSettingsStore.getState().openSettingsToPanel('model')
              settingsAfterClose.current = false
            }
          }}
          // Let the panel reveal the full layout without shrinking the scroll area mid-transition.
          className="w-[min(480px,calc(100vw-2rem))] *:h-auto *:flex-none"
          footer={
            !statusLoaded ? (
              !diagnostic && (
                <footer className={dialogFooterClassName}>
                  <span
                    role="status"
                    className="inline-flex min-h-8 items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                    {t('Loading…')}
                  </span>
                </footer>
              )
            ) : (
              <footer className={`${dialogFooterClassName} justify-between gap-2`}>
                {busy || installing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => void cancel()}
                    >
                      {t('Cancel')}
                    </Button>
                    <Button size="sm" onClick={() => setOpen(false)}>
                      {t('Run in background')}
                    </Button>
                  </>
                ) : confirmDeletion ? (
                  <div
                    className="w-full space-y-3"
                    role="group"
                    aria-label={t('Delete research film?')}
                  >
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {t(
                        'Delete this branch’s film and local generation files? Conversation content and separately saved files will be kept.'
                      )}
                    </p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        ref={cancelDeletionRef}
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setConfirmDeletion(false)}
                      >
                        {t('Cancel')}
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={pending}
                        onClick={() => void remove()}
                      >
                        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
                        {t('Delete research film')}
                      </Button>
                    </div>
                  </div>
                ) : confirmRegeneration ? (
                  <div
                    className="w-full space-y-3"
                    role="group"
                    aria-label={t('Generate again?')}
                    aria-describedby={confirmationDescriptionId}
                  >
                    <p
                      id={confirmationDescriptionId}
                      className="text-sm leading-relaxed text-muted-foreground"
                    >
                      {t('Generating a new film may take several minutes. Continue?')}
                    </p>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        ref={cancelRegenerationRef}
                        variant="ghost"
                        onClick={() => setConfirmRegeneration(false)}
                      >
                        {t('Cancel')}
                      </Button>
                      <Button
                        disabled={pending || Boolean(blocked)}
                        onClick={() => {
                          setConfirmRegeneration(false)
                          void generate(true)
                        }}
                      >
                        {t('Start generation')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {(status.result ||
                      status.canResume ||
                      (!blocked && (!model || narrationReady(model)))) && (
                      <Button
                        ref={regenerateRef}
                        variant={status.canResume || status.result ? 'ghost' : 'default'}
                        size="sm"
                        disabled={pending || Boolean(blocked)}
                        title={blocked}
                        className="ml-auto"
                        onClick={() =>
                          status.canResume || status.result
                            ? setConfirmRegeneration(true)
                            : void generate()
                        }
                      >
                        {pending ? (
                          <Loader2 className="animate-spin" aria-hidden="true" />
                        ) : (
                          <RotateCcw aria-hidden="true" />
                        )}
                        {status.canResume || status.result
                          ? t('Generate again')
                          : failure ||
                              status.progress?.phase === 'failed' ||
                              status.progress?.phase === 'cancelled'
                            ? t('Retry', { context: 'step' })
                            : t('Start generation')}
                      </Button>
                    )}
                    {status.canResume && (
                      <Button
                        size="sm"
                        disabled={pending || Boolean(status.generationBlock)}
                        onClick={() => void generate(false, true)}
                      >
                        {t('Retry', { context: 'step' })}
                      </Button>
                    )}
                    {status.result && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            ref={deleteTriggerRef}
                            variant="ghost"
                            size="sm"
                            aria-label={t('More actions')}
                            disabled={pending}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setConfirmRegeneration(false)
                              setConfirmDeletion(true)
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                            {t('Delete research film')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </>
                )}
              </footer>
            )
          }
        >
          <div className={`${dialogBodyClassName} min-h-0 overflow-y-auto`} data-workflow-body>
            <div className="space-y-4" data-workflow-content>
              <div
                className="grid gap-3 min-[420px]:grid-cols-2"
                role="group"
                aria-label={t('Film mode')}
              >
                {filmModes.map((value) => {
                  const isExplanation = value === 'research-explanation'
                  const label = isExplanation ? t('Research explanation') : t('Operation replay')
                  const description = isExplanation
                    ? t('Explains the research question, methods, and findings with visuals.')
                    : t('Replays the conversation, actions, and results in order.')
                  const Icon = isExplanation ? BookOpen : ListVideo
                  const descriptionId = `${modeDescriptionId}-${value}`
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={pending || Boolean(busy || installing)}
                      aria-pressed={value === mode}
                      aria-label={label}
                      aria-describedby={descriptionId}
                      className={`flex min-w-0 flex-col gap-2 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60 ${value === mode ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:bg-muted'}`}
                      onClick={() => selectMode(value)}
                    >
                      <FilmModeIllustration mode={value} />
                      <span className="flex items-start gap-1.5 text-sm leading-snug font-medium [overflow-wrap:anywhere]">
                        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        {label}
                      </span>
                      <span
                        id={descriptionId}
                        className="text-xs leading-relaxed text-muted-foreground"
                      >
                        {description}
                      </span>
                    </button>
                  )
                })}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  'Generating a film uses your token quota, and its quality depends on the model you select.'
                )}
              </p>
              {blocked && !busy && !diagnostic && (
                <ErrorNotice
                  inline
                  level="warning"
                  content={
                    modelSettingsAvailable && status.preflightError === missingModel ? (
                      <Trans
                        i18nKey="<chooseModel>Select a model</chooseModel> in Settings before generating a research film."
                        components={{ chooseModel: renderSettingsButton() }}
                      />
                    ) : modelSettingsAvailable ? (
                      renderSettingsButton(blocked)
                    ) : (
                      blocked
                    )
                  }
                />
              )}
              {diagnostic && (
                <FilmErrorNotice
                  key={diagnostic}
                  detail={diagnostic}
                  summary={
                    statusReadFailure && diagnostic === statusReadFailure
                      ? t('Could not retrieve generation status.')
                      : Object.hasOwn(filmErrors, diagnostic)
                        ? filmErrors[diagnostic]
                        : t('Research video failed')
                  }
                />
              )}
              {playableResult && (
                <section className="space-y-4" aria-label={t('Research film ready')}>
                  <div className="space-y-2">
                    <h3 className="text-lg font-medium leading-snug text-foreground">
                      {playableResult.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        <Clock3 className="size-3.5" aria-hidden="true" />
                        {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, '0')}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <AudioLines className="size-3.5" aria-hidden="true" />
                        {t('English narration')}
                      </span>
                      {playableResult.scriptScore !== undefined && (
                        <span>
                          {t('Narration rubric {{score}}/9', { score: playableResult.scriptScore })}
                        </span>
                      )}
                    </div>
                    {playableResult.sessionAppMode && (
                      <p className="text-xs text-muted-foreground">
                        {playableResult.sessionAppMode === 'live'
                          ? t('Includes the session app in motion.')
                          : t('Uses a drawn illustration of the session app.')}
                      </p>
                    )}
                  </div>
                  <Button
                    className="min-h-10 w-full whitespace-normal"
                    onClick={() => preview(playableResult)}
                  >
                    <Play className="size-4" aria-hidden="true" />
                    {t('Play research film')}
                  </Button>
                </section>
              )}
              {pending && !busy && !installing && (
                <p role="status" className="text-xs text-muted-foreground">
                  {t('Preparing research materials…')}
                </p>
              )}
              {status.narrationDownload ? (
                <DownloadProgressLine
                  progress={localModelDownloadProgress(status.narrationDownload)}
                />
              ) : (
                status.progress &&
                (!status.result || status.progress.phase !== 'completed') && (
                  <ResearchVideoProgressLine
                    progress={status.progress}
                    filmStep={status.filmStep}
                  />
                )
              )}
              {model && !narrationReady(model) && !installing && !busy && !blocked && (
                <ErrorNotice
                  inline
                  level="info"
                  description={t(
                    'Install narration resources ({{size}} MiB) to generate. They will be reused for future explanations.',
                    { size: (model.downloadBytes / 1024 / 1024).toFixed(1) }
                  )}
                  primaryButton={{
                    label: t('Install and generate'),
                    onClick: () => void install(),
                    loading: pending
                  }}
                />
              )}
            </div>
          </div>
        </WorkflowDialogFrame>
      )}
    </>
  )
}
