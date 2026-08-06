import { Archive, KeyRound, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import type { PermissionUndo } from '@/stores/permission-grants-store'
import { useArchiveUndoStore, type ArchiveUndo } from '@/stores/archive-undo-store'

const PermissionUndoItem = ({
  undo,
  extend,
  restore,
  dismiss,
  isRestoring
}: {
  undo: PermissionUndo
  extend: (token: string) => Promise<number | undefined>
  restore: (token: string) => Promise<void>
  dismiss: (token: string) => void
  isRestoring: boolean
}): React.JSX.Element => {
  const [pointerPaused, setPointerPaused] = useState(false)
  const [focusPaused, setFocusPaused] = useState(false)
  const paused = pointerPaused || focusPaused

  useEffect(() => {
    if (paused) return
    const remaining = Math.max(0, undo.expiresAt - Date.now())
    const timer = window.setTimeout(() => dismiss(undo.token), remaining)
    return () => window.clearTimeout(timer)
  }, [dismiss, paused, undo.expiresAt, undo.token])

  useEffect(() => {
    if (!paused || undo.canRestore === false) return
    let cancelled = false
    let renewalTimer: number | undefined
    const renew = async (): Promise<void> => {
      const expiresAt = await extend(undo.token)
      if (cancelled) return
      if (!expiresAt || expiresAt <= Date.now()) {
        dismiss(undo.token)
        return
      }
      renewalTimer = window.setTimeout(
        () => void renew(),
        Math.max(250, Math.floor((expiresAt - Date.now()) / 2))
      )
    }
    void renew()
    return () => {
      cancelled = true
      if (renewalTimer !== undefined) window.clearTimeout(renewalTimer)
    }
  }, [dismiss, extend, paused, undo.canRestore, undo.token])

  return (
    <div
      role="status"
      tabIndex={-1}
      data-testid="permission-undo-snackbar"
      data-undo-token={undo.token}
      onMouseEnter={() => setPointerPaused(true)}
      onMouseLeave={() => setPointerPaused(false)}
      onFocusCapture={() => setFocusPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusPaused(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') dismiss(undo.token)
      }}
      className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-2xl border border-border/80 bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg shadow-black/10"
    >
      <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="max-w-[min(28rem,55vw)] truncate">{undo.message}</span>
      {undo.canRestore !== false ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="relative ml-1 h-8 gap-1.5 whitespace-nowrap px-2 font-medium before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
          disabled={isRestoring}
          onClick={() => void restore(undo.token)}
        >
          {isRestoring ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <RotateCcw className="size-4" aria-hidden="true" />
          )}
          {isRestoring ? (undo.retry ? 'Retrying…' : 'Restoring…') : undo.retry ? 'Retry' : 'Undo'}
        </Button>
      ) : null}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative size-8 shrink-0 before:absolute before:-inset-1.5 before:content-['']"
              aria-label="Dismiss permission Undo"
              disabled={isRestoring}
              onClick={() => dismiss(undo.token)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Dismiss</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

const ArchiveUndoItem = ({
  undo,
  dismiss,
  restore,
  isRestoring
}: {
  undo: ArchiveUndo
  dismiss: (key: string) => void
  restore: (key: string) => Promise<void>
  isRestoring: boolean
}): React.JSX.Element => {
  const [pointerPaused, setPointerPaused] = useState(false)
  const [focusPaused, setFocusPaused] = useState(false)
  const paused = pointerPaused || focusPaused

  useEffect(() => {
    if (paused) return
    const remaining = Math.max(0, undo.expiresAt - Date.now())
    const timer = window.setTimeout(() => dismiss(undo.key), remaining)
    return () => window.clearTimeout(timer)
  }, [dismiss, paused, undo.expiresAt, undo.key])

  return (
    <div
      role="status"
      tabIndex={-1}
      data-testid="archive-undo-snackbar"
      onMouseEnter={() => setPointerPaused(true)}
      onMouseLeave={() => setPointerPaused(false)}
      onFocusCapture={() => setFocusPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusPaused(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') dismiss(undo.key)
      }}
      className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-2xl border border-border/80 bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg shadow-black/10"
    >
      <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="max-w-[min(28rem,55vw)] truncate">{undo.message}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="relative ml-1 h-8 gap-1.5 whitespace-nowrap px-2 font-medium before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
        disabled={isRestoring}
        onClick={() => void restore(undo.key)}
      >
        {isRestoring ? (
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <RotateCcw className="size-4" aria-hidden="true" />
        )}
        {isRestoring ? (undo.retry ? 'Retrying…' : 'Restoring…') : undo.retry ? 'Retry' : 'Undo'}
      </Button>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative size-8 shrink-0 before:absolute before:-inset-1.5 before:content-['']"
              aria-label="Dismiss archive Undo"
              disabled={isRestoring}
              onClick={() => dismiss(undo.key)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Dismiss</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

// App-root ownership keeps Undo available when Settings closes. The Registry receipt remains the
// authority; this component only owns its short-lived renderer presentation.
const PermissionUndoSnackbar = (): React.JSX.Element | null => {
  const undo = usePermissionGrantsStore((state) => state.undo)
  const undoQueue = usePermissionGrantsStore((state) => state.undoQueue)
  const restore = usePermissionGrantsStore((state) => state.restore)
  const extend = usePermissionGrantsStore((state) => state.extendUndo)
  const dismiss = usePermissionGrantsStore((state) => state.dismissUndo)
  const isRestoring = usePermissionGrantsStore((state) => state.isRestoring)
  const archiveNotices = useArchiveUndoStore((state) => state.notices)
  const restoreArchive = useArchiveUndoStore((state) => state.undo)
  const dismissArchive = useArchiveUndoStore((state) => state.dismiss)
  const archiveRestoringKey = useArchiveUndoStore((state) => state.restoringKey)

  const items = useMemo(
    () => [undo, ...undoQueue].filter((item): item is PermissionUndo => Boolean(item)),
    [undo, undoQueue]
  )
  if (items.length === 0 && archiveNotices.length === 0) return null

  // The shared stack sizes to its receipts; separate Permission and Archive domains only share this
  // app-root presentation shell, not their timeout or restore authority.
  return (
    <div
      aria-live="polite"
      data-testid="permission-undo-stack"
      className="pointer-events-auto z-toast fixed top-[max(1.5rem,env(safe-area-inset-top))] left-1/2 max-h-[min(70svh,32rem)] -translate-x-1/2 overflow-y-auto overscroll-contain"
    >
      <div className="flex flex-col items-center gap-2 p-1 pr-3">
        {items.map((item) => (
          <PermissionUndoItem
            key={item.token}
            undo={item}
            extend={extend}
            restore={restore}
            dismiss={dismiss}
            isRestoring={isRestoring}
          />
        ))}
        {archiveNotices.map((item) => (
          <ArchiveUndoItem
            key={item.key}
            undo={item}
            dismiss={dismissArchive}
            restore={restoreArchive}
            isRestoring={archiveRestoringKey === item.key}
          />
        ))}
      </div>
    </div>
  )
}

export { PermissionUndoSnackbar }
