import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { researchVideoFilename } from '../../../shared/research-video-presentation'
import { dialogBodyClassName, dialogFooterClassName } from './ui/dialog-chrome'
import { WorkflowDialogFrame } from './ui/workflow-dialog-frame'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  Video,
  Loader2,
  Play,
  Clock3,
  AudioLines,
  RotateCcw,
  MoreHorizontal,
  Trash2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { ErrorNotice } from './error-notice'
import { DownloadProgressLine } from './DownloadProgressLine'
import { ResearchVideoProgressLine } from './research-video-progress'
import { localModelDownloadProgress, type LocalModelSnapshot } from '../../../shared/local-models'
import type {
  ResearchVideoPresentation,
  ResearchVideoPresentationRequest,
  ResearchVideoPresentationStatus
} from '../../../shared/research-video-presentation'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

export type ResearchVideoTriggerState = { label: string; disabledReason?: string }

const narrationReady = (model: LocalModelSnapshot | undefined): boolean =>
  model?.availability === 'ready' && !model.updateAvailable

export function ResearchVideoButton({
  renderTrigger,
  ...request
}: ResearchVideoPresentationRequest & {
  renderTrigger?: (
    open: (() => void) | undefined,
    state: ResearchVideoTriggerState
  ) => React.ReactNode
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { projectId, sessionId, branchId } = request
  const [open, setOpen] = useState(false)
  const deletionScope = JSON.stringify([projectId, sessionId, branchId])
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
  const [status, setStatus] = useState<ResearchVideoPresentationStatus>({})
  const [model, setModel] = useState<LocalModelSnapshot>()
  const [pending, setPending] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string>()
  const triggerRef = useRef<HTMLSpanElement>(null)
  const regenerateRef = useRef<HTMLButtonElement>(null)
  const cancelRegenerationRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (confirmRegeneration) cancelRegenerationRef.current?.focus()
    else regenerateRef.current?.focus()
  }, [confirmRegeneration])
  const statusVersion = useRef(0)
  const live = useRef(true)
  const startAfterInstall = useRef(false)
  const busy =
    status.progress && !['completed', 'failed', 'cancelled'].includes(status.progress.phase)
  const duration = Math.max(0, Math.round(status.result?.duration ?? 0))
  const blockMessages = {
    unavailable: t('This session is unavailable.'),
    empty: t('Add conversation content before generating.'),
    'awaiting-reply': t('Wait for a completed response before generating.'),
    busy: t('Wait for the current response to finish before generating.')
  }
  const preflightMessages: Record<string, string> = {
    'Select a model in Settings before generating a research film.': t(
      'Select a model in Settings before generating a research film.'
    ),
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
    'Set up the selected agent runtime in Settings before generating a research film.': t(
      'Set up the selected agent runtime in Settings before generating a research film.'
    ),
    'Check the selected model and credentials in Settings before generating a research film.': t(
      'Check the selected model and credentials in Settings before generating a research film.'
    )
  }
  const blocked = status.generationBlock
    ? blockMessages[status.generationBlock]
    : status.preflightError && (preflightMessages[status.preflightError] ?? status.preflightError)
  const triggerState: ResearchVideoTriggerState = {
    label:
      busy || installing || pending
        ? t('View generation progress')
        : status.result
          ? t('View research film')
          : t('Generate research film'),
    disabledReason:
      !status.result && !busy && !installing && !pending && status.generationBlock
        ? blocked
        : undefined
  }
  const desktop = document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true'
  useEffect(() => {
    live.current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (!desktop) return
      const version = statusVersion.current
      const finishingInstallation = startAfterInstall.current
      try {
        const next = await window.api.researchVideo.status({ projectId, sessionId, branchId })
        if (live.current && version === statusVersion.current) setStatus(next)
        if (startAfterInstall.current) {
          const snapshot = await window.api.localModels.getSnapshot('research-narration')
          if (!live.current) return
          setModel(snapshot)
          if (narrationReady(snapshot)) {
            startAfterInstall.current = false
            setInstalling(false)
            if (!next.generationBlock)
              setStatus(await window.api.researchVideo.start({ projectId, sessionId, branchId }))
          } else if (snapshot.availability !== 'installing') {
            startAfterInstall.current = false
            setInstalling(false)
            setError(t('Narration installation did not finish. Retry to continue.'))
          }
        }
      } catch (caught) {
        if (live.current && finishingInstallation) {
          startAfterInstall.current = false
          setInstalling(false)
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
      if (live.current) timer = setTimeout(() => void poll(), 750)
    }
    void poll()
    return () => {
      live.current = false
      startAfterInstall.current = false
      clearTimeout(timer)
    }
  }, [projectId, sessionId, branchId, desktop, t])
  const generate = async (regenerate = false): Promise<void> => {
    if (pending || busy || installing) {
      setOpen(true)
      return
    }
    setOpen(true)
    setPending(true)
    setError(undefined)
    try {
      const current = await window.api.researchVideo.status({ ...request, checkReadiness: true })
      if (!live.current) return
      setStatus(current)
      if (current.result && !regenerate) return
      if (current.generationBlock || current.preflightError) return
      if (
        current.progress &&
        !['completed', 'failed', 'cancelled'].includes(current.progress.phase)
      )
        return
      const snapshot = await window.api.localModels.getSnapshot('research-narration')
      if (!live.current) return
      setModel(snapshot)
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
      const current = await window.api.researchVideo.status({ ...request, checkReadiness: true })
      if (!live.current) return
      setStatus(current)
      if (current.generationBlock || current.preflightError) return
      const snapshot = await window.api.localModels.install('research-narration')
      if (!live.current) return
      setModel(snapshot)
      startAfterInstall.current = true
      setInstalling(true)
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (live.current) setPending(false)
    }
  }
  const cancel = async (): Promise<void> => {
    startAfterInstall.current = false
    setPending(true)
    try {
      if (installing) await window.api.localModels.cancel('research-narration')
      else await window.api.researchVideo.cancel(request)
      if (live.current) {
        setInstalling(false)
        setStatus(await window.api.researchVideo.status(request))
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
      statusVersion.current++
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
  if (!desktop) return renderTrigger ? <>{renderTrigger(undefined, triggerState)}</> : null
  return (
    <>
      <span ref={triggerRef} className="contents">
        {renderTrigger ? (
          // eslint-disable-next-line react-hooks/refs -- The factory binds this event handler; it never runs generation during render.
          renderTrigger(() => void generate(), triggerState)
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || Boolean(triggerState.disabledReason)}
            title={triggerState.disabledReason}
            onClick={() => void generate()}
          >
            {busy || installing ? (
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
          description={status.result ? undefined : t('Create a short film from this conversation.')}
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
          }}
          className="w-[min(480px,calc(100vw-2rem))]"
          footer={
            (busy || installing || status.result || model?.availability === 'ready') && (
              <footer className={`${dialogFooterClassName} justify-between gap-2`}>
                {busy || installing ? (
                  <>
                    <p className="min-w-0 flex-1 self-center text-xs leading-relaxed text-muted-foreground">
                      {t('You can close this window. Generation continues in the background.')}
                    </p>
                    <Button variant="ghost" disabled={pending} onClick={() => void cancel()}>
                      {t('Cancel')}
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
                    {(status.result || model?.availability === 'ready') && (
                      <Button
                        ref={regenerateRef}
                        variant={status.result ? 'ghost' : 'default'}
                        size="sm"
                        disabled={pending || Boolean(blocked)}
                        title={blocked}
                        className="ml-auto"
                        onClick={() => setConfirmRegeneration(true)}
                      >
                        {pending ? (
                          <Loader2 className="animate-spin" aria-hidden="true" />
                        ) : (
                          <RotateCcw aria-hidden="true" />
                        )}
                        {t('Generate again')}
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
              {blocked && !busy && <ErrorNotice inline level="warning" description={blocked} />}
              {!blocked && (error || status.error) && (
                <ErrorNotice inline tone="amber" description={error ?? status.error} />
              )}
              {status.result && (
                <section className="space-y-4" aria-label={t('Research film ready')}>
                  <div className="space-y-2">
                    <h3 className="text-lg font-medium leading-snug text-foreground">
                      {status.result.title}
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
                    </div>
                  </div>
                  <Button
                    className="min-h-10 w-full whitespace-normal"
                    onClick={() => preview(status.result!)}
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
              {installing && model ? (
                <DownloadProgressLine progress={localModelDownloadProgress(model)} />
              ) : (
                status.progress &&
                (!status.result || status.progress.phase !== 'completed') && (
                  <ResearchVideoProgressLine progress={status.progress} />
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
