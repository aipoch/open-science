import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { PackageImportSelection } from './PackageImportSelection'
import { PackageImportQueue } from './PackageImportQueue'
import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Dialog } from 'radix-ui'
import { Check, ChevronRight, Clock3, LoaderCircle, PackageOpen, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import type {
  PackageOperationRequest,
  PackageOperationSnapshot
} from '../../../shared/session-package'

import { PackageFileSelection } from './PackageFileSelection'
import {
  formatPackageBytes as bytes,
  PACKAGE_DEFAULT_IO_BYTES_PER_SECOND
} from '../../../shared/session-package'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { drainWorkspaceRuntimeEventsForPersistence } from '@/lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'

const operationStatus = (
  operation: PackageOperationSnapshot,
  t: TFunction
): { phase: string; status: string; waiting: boolean; busy: boolean; description?: string } => {
  const phase = {
    preparing: t('Preparing package…'),
    selecting:
      operation.kind === 'import'
        ? t('Choose a destination project')
        : t('Choose package contents'),
    copying: t('Copying files…'),
    validating: t('Validating package…'),
    compressing: t('Compressing package…'),
    saving: t('Saving package…'),
    importing: t('Importing research…'),
    'choosing-location': t('Waiting for a save location…'),
    confirming: t('Waiting for import confirmation…'),
    cleaning: t('Cleaning temporary files…')
  }[operation.progress.phase]
  const status =
    operation.state === 'succeeded'
      ? operation.cleanupPending
        ? t('Completed, cleanup pending')
        : t('Package operation completed')
      : operation.state === 'failed'
        ? t('Package operation failed')
        : operation.state === 'cancelled'
          ? t('Package operation cancelled')
          : operation.state === 'cancelling'
            ? t('Cancelling and cleaning up…')
            : phase
  const waiting =
    operation.state !== 'cancelling' &&
    packageOperationActive(operation) &&
    ['selecting', 'choosing-location', 'confirming'].includes(operation.progress.phase)
  const busy = packageOperationActive(operation) && !waiting
  const description =
    operation.state === 'cancelling' || operation.progress.phase === 'cleaning'
      ? t('Removing temporary files. Keep the app open until cleanup finishes.')
      : waiting
        ? operation.progress.phase === 'confirming'
          ? t('Review the package summary before importing.')
          : operation.progress.phase === 'choosing-location'
            ? t('Choose where to save the package in the system dialog.')
            : t('Choose package contents')
        : busy
          ? t('Keep the app open. You can work in other Sessions while this finishes.')
          : undefined
  return { phase, status, waiting, busy, description }
}

const PackageProgressMeter = ({
  operation,
  compact = false
}: {
  operation: PackageOperationSnapshot
  compact?: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { waiting, phase } = operationStatus(operation, t)
  if (operation.state !== 'running' || waiting) return null
  const { completedBytes, totalBytes } = operation.progress
  const measurable = totalBytes !== undefined && totalBytes > 0 && completedBytes !== undefined
  const percent = measurable
    ? Math.min(100, Math.max(0, Math.floor((completedBytes / totalBytes) * 100)))
    : undefined
  if (!measurable)
    return (
      <>
        <div
          role="progressbar"
          aria-label={t('Package progress')}
          aria-valuetext={phase}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            aria-hidden="true"
            className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-[install-progress-indeterminate_1.2s_ease-in-out_infinite]"
          />
        </div>
      </>
    )
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {compact ? `${bytes(completedBytes)} / ${bytes(totalBytes)}` : t('Current stage')}
        </span>
        {percent !== undefined ? (
          <span className={`${compact ? 'text-sm' : 'text-xl'} font-semibold tabular-nums`}>
            {percent}%
          </span>
        ) : null}
      </div>
      <progress
        aria-label={t('Package progress')}
        aria-valuetext={percent !== undefined ? `${t('Current stage')}: ${percent}%` : undefined}
        className="block h-2 w-full overflow-hidden rounded-full accent-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
        max={measurable ? totalBytes : undefined}
        value={measurable ? completedBytes : undefined}
      />
      {!compact ? (
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
          {measurable ? (
            <span>
              {bytes(completedBytes)} / {bytes(totalBytes)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const PackageOperationIndicator = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { operation, open, dismissedId, setOpen, dismiss } = usePackageOperationStore()
  if (!operation || open || dismissedId === operation.id) return null
  const active = packageOperationActive(operation)
  const { status, waiting, busy } = operationStatus(operation, t)
  const Icon =
    operation.state === 'succeeded' ? Check : waiting ? Clock3 : busy ? LoaderCircle : PackageOpen
  return (
    <section
      aria-label={t('Package progress')}
      className="mb-3 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <Icon
          className={`size-4 shrink-0 ${waiting ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground' : 'text-primary'} ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`}
          aria-hidden="true"
        />
        <p role="status" className="min-w-0 flex-1 text-sm">
          {waiting ? (
            <span className="mr-2 text-xs font-medium text-status-warning-foreground dark:text-status-warning-dark-foreground">
              {t('Waiting for you')}
            </span>
          ) : null}
          {status}
        </p>
        <Button variant="link" size="sm" className="h-6 p-0 text-xs" onClick={() => setOpen(true)}>
          {t('View progress')}
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
        {!active ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t('Dismiss')}
            onClick={dismiss}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {operation.state === 'running' && !waiting ? (
        <div className="border-t border-border px-3 py-3">
          <PackageProgressMeter operation={operation} compact />
        </div>
      ) : null}
    </section>
  )
}

export const SessionPackageOperation = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { operation, open, receive, setOpen, dismiss } = usePackageOperationStore()
  const [operationError, setError] = useState<{ id: string; message: string }>()
  const [retrying, setRetrying] = useState(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const navigationIntent = useRef<string | undefined>(undefined)
  const isWeb = document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true'
  useEffect(() => {
    if (isWeb || !window.api?.sessions?.onPackageOperation) return
    let received = false
    let disposed = false
    const remove = window.api.sessions.onPackageOperation((snapshot) => {
      received = true
      receive(snapshot)
    })
    void window.api.sessions
      .packageOperation?.({ action: 'snapshot' })
      .then((snapshot) => {
        if (!disposed && !received) receive(snapshot)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      remove()
    }
  }, [receive, isWeb])
  const openedImport = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (
      isWeb ||
      navigationIntent.current !== operation?.id ||
      operation?.state !== 'succeeded' ||
      !operation.result?.imported ||
      openedImport.current === operation.id
    )
      return
    openedImport.current = operation.id
    const identity = operation.result.imported
    void useProjectStore
      .getState()
      .loadProjects()
      .then(() => {
        useNavigationStore.getState().openSession(identity.projectId, identity.sessionId, 'user')
      })
      .catch(() => undefined)
  }, [operation, isWeb])
  if (isWeb || !operation) return null
  const error = operationError?.id === operation.id ? operationError.message : undefined
  const active = packageOperationActive(operation)
  const title =
    operation.kind === 'export' ? t('Export Session package') : t('Import Session package')
  const { phase, status, waiting, busy, description } = operationStatus(operation, t)
  const selecting = operation.state === 'awaiting-selection'
  const OperationIcon =
    operation.state === 'succeeded' ? Check : waiting ? Clock3 : busy ? LoaderCircle : PackageOpen
  const respond = async (request: PackageOperationRequest): Promise<void> => {
    setError(undefined)
    if (request.action === 'confirm-import') navigationIntent.current = operation.id
    try {
      await window.api.sessions.packageOperation(request)
    } catch (caught) {
      if (navigationIntent.current === operation.id) navigationIntent.current = undefined
      setError({
        id: operation.id,
        message: caught instanceof Error ? caught.message : String(caught)
      })
    }
  }
  const retry = async (chooseAnotherPackage = false): Promise<void> => {
    setRetrying(true)
    setError(undefined)
    try {
      if (operation.kind === 'export' && operation.session) {
        await drainWorkspaceRuntimeEventsForPersistence(operation.session.sessionId)
        await flushSessionPersistence()
        await window.api.sessions.exportPackage(operation.session)
      } else if (operation.importRequestId && !chooseAnotherPackage)
        await respond({ action: 'retry-import', operationId: operation.id })
      else await window.api.sessions.importPackage(operation.importTarget)
    } catch (caught) {
      setError({
        id: operation.id,
        message: caught instanceof Error ? caught.message : String(caught)
      })
    } finally {
      setRetrying(false)
    }
  }
  const transferSettings =
    active && (!waiting || selecting) && operation.progress.phase !== 'cleaning' ? (
      <details className="group border-t border-border pt-3 text-sm">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 group-open:rotate-90" aria-hidden="true" />
          {selecting ? t('Transfer settings') : t('Transfer details')}
        </summary>
        <div className="mt-4 space-y-4">
          {operation.progress.currentFile ? (
            <p className="break-all text-xs text-muted-foreground">
              {operation.progress.currentFile}
            </p>
          ) : null}
          {operation.progress.totalFiles !== undefined ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              {t('Files: {{completed}} / {{total}}', {
                completed: operation.progress.completedFiles ?? 0,
                total: operation.progress.totalFiles
              })}
            </p>
          ) : null}
          {busy && operation.ioBytesPerSecond !== undefined ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              {t('Disk activity: {{speed}}/s', { speed: bytes(operation.ioBytesPerSecond) })}
            </p>
          ) : null}
          <label className="flex items-center justify-between gap-4">
            <span>{t('Disk activity limit')}</span>
            <select
              className="rounded-md border border-border bg-background px-3 py-2"
              value={operation.transferBytesPerSecond ?? PACKAGE_DEFAULT_IO_BYTES_PER_SECOND}
              disabled={operation.state === 'cancelling'}
              onChange={(event) =>
                void respond({
                  action: 'set-speed',
                  operationId: operation.id,
                  bytesPerSecond: Number(event.target.value)
                })
              }
            >
              {[4, 16, 64].map((rate) => (
                <option key={rate} value={rate * 1024 ** 2}>
                  {t('{{speed}}/s', { speed: bytes(rate * 1024 ** 2) })}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              'Lower speeds reduce disk activity and take longer. The limit is shared by reads and writes.'
            )}
          </p>
        </div>
      </details>
    ) : null
  const openImported = async (): Promise<void> => {
    try {
      await useProjectStore.getState().loadProjects()
      const identity = operation.result?.imported
      if (
        identity &&
        useNavigationStore.getState().openSession(identity.projectId, identity.sessionId, 'user')
      )
        dismiss()
    } catch (caught) {
      setError({
        id: operation.id,
        message: caught instanceof Error ? caught.message : String(caught)
      })
    }
  }
  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            onOpenAutoFocus={(event) => {
              // Start at the task context; focusing the close control would open its tooltip.
              event.preventDefault()
              titleRef.current?.focus()
            }}
            className={dialogPanelClassName(
              'flex max-h-[min(85svh,800px)] w-[min(560px,calc(100vw-2rem))] flex-col p-0',
              selecting &&
                (operation.kind === 'import' ? 'h-[min(85svh,480px)]' : 'h-[min(85svh,560px)]')
            )}
          >
            <div className={`${dialogHeaderClassName} shrink-0`}>
              <div className="min-w-0 w-full space-y-1">
                <div className="flex items-start gap-2">
                  <Dialog.Title
                    ref={titleRef}
                    tabIndex={-1}
                    className={`${dialogTitleClassName} min-w-0 flex-1 break-words py-0.5 leading-6 outline-none`}
                  >
                    {title}
                  </Dialog.Title>
                  <div className="flex shrink-0 items-center gap-1">
                    <PackageImportQueue
                      key={operation.id}
                      operation={operation}
                      onAction={respond}
                    />
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={dialogCloseButtonClassName}
                            aria-label={active ? t('Hide progress') : t('Dismiss')}
                            onClick={() => (active ? setOpen(false) : dismiss())}
                          >
                            <X className="size-4" aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {active
                            ? t('Hide this window. The operation will continue.')
                            : t('Dismiss')}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
                {operation.kind === 'import' && operation.importFilename ? (
                  <p
                    className="truncate text-sm text-muted-foreground"
                    title={operation.importFilename}
                  >
                    {operation.importFilename}
                  </p>
                ) : null}
                <Dialog.Description
                  className={
                    operation.kind === 'import' && selecting && !operation.importPreview
                      ? 'sr-only'
                      : 'text-sm leading-relaxed text-muted-foreground'
                  }
                >
                  {operation.kind === 'export'
                    ? active && operation.progress.phase !== 'cleaning'
                      ? t('Research history is always included.')
                      : t('The Session is unlocked. You can continue your research.')
                    : t('Import creates a new read-only Session. No code runs automatically.')}
                </Dialog.Description>
              </div>
            </div>
            {operation.importQueueFull ? (
              <div className="mx-5 mt-4 flex shrink-0 items-start gap-3">
                <ErrorNotice
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 [&_[role=alert]]:basis-0"
                  role="alert"
                  tone="amber"
                  description={t('Waiting list is full. Open remaining packages later.')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-6 shrink-0 px-1 py-0"
                  onClick={() =>
                    void respond({ action: 'dismiss-queue-warning', operationId: operation.id })
                  }
                >
                  {t('Dismiss')}
                </Button>
              </div>
            ) : null}
            {!selecting ? (
              <div
                className={`${dialogBodyClassName} min-h-0 space-y-5 overflow-y-auto overscroll-contain`}
              >
                {!(operation.state === 'failed' && operation.error) ? (
                  <div className="space-y-5 py-1">
                    <div className="flex items-start gap-3">
                      <div
                        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center ${waiting ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground' : 'text-primary'}`}
                      >
                        <OperationIcon
                          className={`size-5 ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="min-w-0 flex-1 space-y-1.5">
                        {waiting ? (
                          <p className="text-xs font-medium text-status-warning-foreground dark:text-status-warning-dark-foreground">
                            {t('Waiting for you')}
                          </p>
                        ) : null}
                        <p role="status" className="text-base font-semibold leading-6">
                          {status}
                        </p>
                        {description ? (
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {description}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <PackageProgressMeter operation={operation} />
                  </div>
                ) : null}
                {transferSettings}
                {error || operation.error ? (
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <ErrorNotice
                      className="min-w-0 flex-1 basis-64 border-0 bg-transparent p-0 [&_[role=alert]]:basis-0"
                      role="alert"
                      tone="amber"
                      description={error ?? operation.error}
                    />
                    {operation.state === 'failed' ? (
                      <details className="min-w-0 pt-0.5 text-xs text-muted-foreground open:basis-full">
                        <summary className="w-fit cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                          {t('Details')}
                        </summary>
                        <p className="mt-2">{t('Last stage: {{stage}}', { stage: phase })}</p>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {operation.cleanupPending && !active ? (
                  <ErrorNotice
                    className="border-0 bg-transparent p-0 [&_[role=status]]:basis-0"
                    role="status"
                    tone="amber"
                    description={t(
                      'Some temporary files could not be removed. Retry cleanup without repeating the transfer.'
                    )}
                  />
                ) : null}
              </div>
            ) : operation.kind === 'import' ? (
              <PackageImportSelection
                key={`${operation.id}:${operation.progress.phase}`}
                operation={operation}
                error={error}
                onCancel={() => void respond({ action: 'cancel', operationId: operation.id })}
                onContinue={async (target) =>
                  respond(
                    target
                      ? { action: 'select-project', operationId: operation.id, target }
                      : { action: 'confirm-import', operationId: operation.id }
                  )
                }
              />
            ) : (
              <PackageFileSelection
                key={operation.id}
                files={operation.files ?? []}
                summary={operation.summary}
                notice={
                  error || operation.error ? (
                    <ErrorNotice role="alert" tone="amber" description={error ?? operation.error} />
                  ) : null
                }
                onCancel={() => void respond({ action: 'cancel', operationId: operation.id })}
                onSelect={(excludedStorageKeys) =>
                  void respond({ action: 'select', operationId: operation.id, excludedStorageKeys })
                }
              >
                {transferSettings}
              </PackageFileSelection>
            )}
            {!selecting ? (
              <div className={`${dialogFooterClassName} shrink-0 flex-wrap`}>
                {active ? (
                  <Button
                    variant="ghost"
                    className={dialogCancelButtonClassName}
                    disabled={operation.state === 'cancelling'}
                    onClick={() => void respond({ action: 'cancel', operationId: operation.id })}
                  >
                    {t('Cancel operation')}
                  </Button>
                ) : null}
                {!waiting ? (
                  <Button
                    variant={active ? 'default' : 'outline'}
                    onClick={() => (active ? setOpen(false) : dismiss())}
                  >
                    {active ? t('Run in background') : t('Close')}
                  </Button>
                ) : null}
                {operation.cleanupPending && !active ? (
                  <Button
                    variant={operation.state === 'succeeded' ? 'secondary' : 'default'}
                    onClick={() =>
                      void respond({ action: 'retry-cleanup', operationId: operation.id })
                    }
                  >
                    {t('Retry cleanup')}
                  </Button>
                ) : null}
                {operation.state === 'succeeded' && operation.result?.filePath ? (
                  <Button
                    onClick={() => void respond({ action: 'reveal', operationId: operation.id })}
                  >
                    {t('Show in folder')}
                  </Button>
                ) : null}
                {operation.state === 'succeeded' && operation.result?.imported ? (
                  <Button onClick={() => void openImported()}>{t('Open imported Session')}</Button>
                ) : null}
                {operation.state === 'failed' && !operation.cleanupPending ? (
                  <>
                    {operation.kind === 'import' && operation.importRequestId ? (
                      <Button
                        variant="outline"
                        disabled={retrying}
                        onClick={() => void retry(true)}
                      >
                        {t('Choose another package')}
                      </Button>
                    ) : null}
                    <Button disabled={retrying} onClick={() => void retry()}>
                      {t('Try again')}
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
