import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  isSessionDetailsConflictError,
  SESSION_DETAILS_TITLE_MAX_LENGTH
} from '../../../../shared/session-persistence'

const SESSION_HOVER_PREVIEW_DELAY_MS = 300
const SESSION_HOVER_PREVIEW_SKIP_DELAY_MS = 300
const SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX = 0

type SessionPreviewContent = {
  title: string
  description?: string
}
type SessionPreviewDetails = SessionPreviewContent & { id: string }
type SessionPreviewRequest = (sessionId: string) => Promise<void> | void
type SessionRenameRequest = (
  title: string,
  expectedTitle: string
) => Promise<boolean | void> | boolean | void

type SessionHoverPreviewContextValue = {
  activeSessionId: string | null
  closeNow: (sessionId: string) => void
  requestOpen: (sessionId: string, immediate?: boolean) => void
  cancelOpen: (sessionId: string) => void
  setProtected: (sessionId: string, protectedFromHover: boolean) => void
}

const SessionHoverPreviewContext = createContext<SessionHoverPreviewContextValue | null>(null)

const SessionHoverPreviewProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)

  const protectedSessionRef = useRef<string | null>(null)
  const pendingRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const warmUntilRef = useRef(0)

  const cancelOpen = useCallback((sessionId: string): void => {
    if (pendingRef.current?.id !== sessionId) return
    clearTimeout(pendingRef.current.timer)
    pendingRef.current = null
  }, [])

  const requestOpen = useCallback((sessionId: string, immediate = false): void => {
    if (protectedSessionRef.current && protectedSessionRef.current !== sessionId) return
    if (pendingRef.current) clearTimeout(pendingRef.current.timer)
    pendingRef.current = null
    const show = (): void => {
      pendingRef.current = null
      activeSessionIdRef.current = sessionId
      setActiveSessionId(sessionId)
    }
    if (immediate || activeSessionIdRef.current || Date.now() < warmUntilRef.current) show()
    else
      pendingRef.current = {
        id: sessionId,
        timer: setTimeout(show, SESSION_HOVER_PREVIEW_DELAY_MS)
      }
  }, [])

  const closeNow = useCallback(
    (sessionId: string): void => {
      cancelOpen(sessionId)
      if (activeSessionIdRef.current !== sessionId) return
      activeSessionIdRef.current = null
      protectedSessionRef.current = null
      warmUntilRef.current = Date.now() + SESSION_HOVER_PREVIEW_SKIP_DELAY_MS
      setActiveSessionId(null)
    },
    [cancelOpen]
  )

  const setProtected = useCallback((sessionId: string, protectedFromHover: boolean): void => {
    if (protectedFromHover) {
      if (pendingRef.current) clearTimeout(pendingRef.current.timer)
      pendingRef.current = null
      protectedSessionRef.current = sessionId
    } else if (protectedSessionRef.current === sessionId) protectedSessionRef.current = null
  }, [])

  useEffect(
    () => () => {
      if (pendingRef.current) clearTimeout(pendingRef.current.timer)
    },
    []
  )

  const value = useMemo(
    () => ({ activeSessionId, closeNow, requestOpen, cancelOpen, setProtected }),
    [activeSessionId, closeNow, requestOpen, cancelOpen, setProtected]
  )

  return (
    <SessionHoverPreviewContext.Provider value={value}>
      {children}
    </SessionHoverPreviewContext.Provider>
  )
}

const sessionHoverPreviewTitleClassName =
  'whitespace-pre-wrap break-words text-sm font-semibold leading-5'

// Click-to-edit title for the hover card. Enter or blur commits a non-empty trimmed title,
// Escape cancels; editing state is mirrored to the parent so the card stays open mid-edit.
const SessionHoverPreviewTitle = ({
  title,
  canRename,
  onRenameTitle,
  onEditingChange
}: {
  title: string
  canRename: boolean
  onRenameTitle?: SessionRenameRequest
  onEditingChange?: (editing: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleButtonRef = useRef<HTMLButtonElement>(null)
  const restoreTitleFocusRef = useRef(false)
  // The input intentionally keeps its draft when live Session props change mid-edit. Keep the
  // matching optimistic-concurrency baseline stable for the same interval.
  const expectedTitleRef = useRef(title)
  const savingRef = useRef(false)
  const [isSaving, setIsSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  useEffect(() => {
    if (editing || !restoreTitleFocusRef.current) return
    restoreTitleFocusRef.current = false
    // Unmounting the editor drops focus to body. Do not steal focus from an explicit navigation.
    if (document.activeElement === document.body) titleButtonRef.current?.focus()
  }, [editing])

  const updateEditing = useCallback(
    (next: boolean): void => {
      editingRef.current = next
      setEditing(next)
      onEditingChange?.(next)
    },
    [onEditingChange]
  )

  const commit = useCallback((): void => {
    if (!editingRef.current || savingRef.current) return
    const nextTitle = inputRef.current?.value.trim() ?? ''
    if (!nextTitle || nextTitle === expectedTitleRef.current) {
      updateEditing(false)
      return
    }
    savingRef.current = true
    setIsSaving(true)
    setRenameError(null)
    void Promise.resolve(onRenameTitle?.(nextTitle, expectedTitleRef.current))
      .then((saved) => {
        if (saved === false) {
          queueMicrotask(() => inputRef.current?.focus())
          return
        }
        updateEditing(false)
      })
      .catch((error: unknown) => {
        setRenameError(
          isSessionDetailsConflictError(error)
            ? t(
                "This session's title or description changed in another window. Your changes were not saved. Close and reopen the editor to review the latest details."
              )
            : t('Could not save session details.')
        )
        queueMicrotask(() => inputRef.current?.focus())
      })
      .finally(() => {
        savingRef.current = false
        setIsSaving(false)
      })
  }, [onRenameTitle, t, updateEditing])

  if (!canRename) {
    return <p className={sessionHoverPreviewTitleClassName}>{title}</p>
  }

  if (editing) {
    return (
      <div className="space-y-1">
        <Input
          ref={inputRef}
          defaultValue={title}
          autoFocus
          maxLength={SESSION_DETAILS_TITLE_MAX_LENGTH}
          aria-label={t('Session title')}
          disabled={isSaving}
          className="h-auto rounded-sm px-1 py-0 text-sm font-semibold leading-5"
          onFocus={(event) => {
            if (!renameError) event.currentTarget.select()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              restoreTitleFocusRef.current = true
              commit()
              return
            }
            if (event.key === 'Escape' && !savingRef.current) {
              event.stopPropagation()
              restoreTitleFocusRef.current = true
              updateEditing(false)
            }
          }}
          onBlur={() => {
            if (!savingRef.current) restoreTitleFocusRef.current = false
            commit()
          }}
        />
        {renameError ? (
          <p role="alert" className="text-xs leading-4 text-danger-000">
            {renameError}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <button
      ref={titleButtonRef}
      type="button"
      data-slot="session-hover-preview-title-button"
      aria-label={t('Rename session title')}
      className={cn(
        'block w-full cursor-pointer rounded-sm text-left outline-none',
        'hover:bg-bg-300 focus-visible:ring-2 focus-visible:ring-ring',
        sessionHoverPreviewTitleClassName
      )}
      onClick={() => {
        expectedTitleRef.current = title
        setRenameError(null)
        updateEditing(true)
      }}
    >
      {title}
    </button>
  )
}

const SessionHoverPreviewCard = ({
  session,
  descriptionLoading = false,
  canRename = false,
  onRenameTitle,
  onEditingChange,
  className
}: {
  session: SessionPreviewContent
  descriptionLoading?: boolean
  canRename?: boolean
  onRenameTitle?: SessionRenameRequest
  onEditingChange?: (editing: boolean) => void
  className?: string
}): React.JSX.Element => {
  const description = session.description?.trim()

  return (
    <div
      data-slot="session-hover-preview"
      aria-busy={descriptionLoading || undefined}
      className={cn(
        'w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-dialog',
        'max-h-[min(24rem,calc(100vh-1rem))]',
        className
      )}
    >
      <SessionHoverPreviewTitle
        title={session.title}
        canRename={canRename}
        onRenameTitle={onRenameTitle}
        onEditingChange={onEditingChange}
      />
      {description ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-4 text-muted-foreground">
          {description}
        </p>
      ) : descriptionLoading ? (
        <span
          data-slot="session-hover-preview-description-loading"
          className="mt-2 block h-4 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
    </div>
  )
}

const SessionHoverPreview = ({
  session,
  onPreviewRequest,
  canRename = false,
  onRenameTitle,
  previewSuppressed = false,
  children
}: {
  session: SessionPreviewDetails
  onPreviewRequest?: SessionPreviewRequest
  canRename?: boolean
  onRenameTitle?: SessionRenameRequest
  previewSuppressed?: boolean
  children: ReactElement
}): React.JSX.Element => {
  const context = useContext(SessionHoverPreviewContext)
  if (!context) throw new Error('SessionHoverPreview must be inside SessionHoverPreviewProvider')

  const { activeSessionId, closeNow, requestOpen, cancelOpen, setProtected } = context
  const open = !previewSuppressed && activeSessionId === session.id
  const onPreviewRequestRef = useRef(onPreviewRequest)
  const triggerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [descriptionLoading, setDescriptionLoading] = useState(false)
  // While the inline title editor is active the card is pinned open; pointer leaves and
  // Radix-initiated close requests are ignored until the edit commits or cancels.
  const editingRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoreFocusRef = useRef(false)
  const focusOnOpenRef = useRef(false)
  const suppressFocusRef = useRef(false)
  const cancelClose = useCallback((): void => clearTimeout(closeTimerRef.current), [])

  useEffect(() => {
    onPreviewRequestRef.current = onPreviewRequest
  }, [onPreviewRequest])

  useEffect(() => {
    if (!open) return

    let active = true
    const request = onPreviewRequestRef.current?.(session.id)
    if (!request) {
      void Promise.resolve().then(() => setDescriptionLoading(false))
      return
    }
    void Promise.resolve().then(() => setDescriptionLoading(true))
    void Promise.resolve(request).then(
      () => {
        if (active) setDescriptionLoading(false)
      },
      () => {
        if (active) setDescriptionLoading(false)
      }
    )
    return () => {
      active = false
    }
  }, [open, session.id])

  useEffect(
    () => () => {
      cancelClose()
      closeNow(session.id)
    },
    [cancelClose, closeNow, session.id]
  )

  useEffect(() => {
    if (previewSuppressed) closeNow(session.id)
  }, [closeNow, previewSuppressed, session.id])

  const requestClose = useCallback((): void => {
    cancelOpen(session.id)
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      if (editingRef.current || contentRef.current?.contains(document.activeElement)) return
      if (
        triggerRef.current?.contains(document.activeElement) &&
        document.activeElement?.matches(':focus-visible')
      )
        return
      closeNow(session.id)
    }, SESSION_HOVER_PREVIEW_SKIP_DELAY_MS)
  }, [cancelClose, cancelOpen, closeNow, session.id])

  const handleEditingChange = useCallback(
    (editing: boolean): void => {
      editingRef.current = editing
      setProtected(session.id, editing)
      if (editing) {
        cancelClose()
        return
      }
      if (triggerRef.current?.matches(':hover') || contentRef.current?.matches(':hover')) return
      requestClose()
    },
    [cancelClose, requestClose, session.id, setProtected]
  )

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !editingRef.current) closeNow(session.id)
      }}
    >
      <PopoverAnchor
        data-session-preview={open ? 'open' : 'closed'}
        ref={triggerRef}
        asChild
        onPointerEnter={(event) => {
          cancelClose()
          if (!previewSuppressed && event.pointerType !== 'touch') requestOpen(session.id)
        }}
        onPointerLeave={requestClose}
        onFocus={(event) => {
          if (suppressFocusRef.current) {
            suppressFocusRef.current = false
            return
          }
          if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) return
          cancelClose()
          if (!previewSuppressed) requestOpen(session.id, true)
        }}
        onKeyDown={(event) => {
          const trigger = triggerRef.current
          const rowButton = trigger?.matches('button') ? trigger : trigger?.querySelector('button')
          if (event.key === 'ArrowRight' && event.target === rowButton && !previewSuppressed) {
            event.preventDefault()
            const control = contentRef.current?.querySelector<HTMLElement>('button, input')
            if (control) {
              control.focus()
            } else {
              focusOnOpenRef.current = true
              requestOpen(session.id, true)
            }
          }
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            contentRef.current?.contains(event.relatedTarget)
          )
            return
          requestClose()
        }}
      >
        {children}
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        side="right"
        align="start"
        sideOffset={0}
        alignOffset={SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX}
        collisionPadding={8}
        data-slot="session-preview-content"
        aria-label={session.title}
        onPointerEnter={cancelClose}
        onPointerLeave={requestClose}
        onFocusCapture={() => {
          cancelClose()
          setProtected(session.id, true)
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            contentRef.current?.contains(event.relatedTarget)
          )
            return
          if (!editingRef.current) setProtected(session.id, false)
          requestClose()
        }}
        onOpenAutoFocus={(event) => {
          if (!focusOnOpenRef.current) event.preventDefault()
          focusOnOpenRef.current = false
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!restoreFocusRef.current) return
          restoreFocusRef.current = false
          suppressFocusRef.current = true
          const trigger = triggerRef.current
          if (trigger?.matches('button')) trigger.focus()
          else trigger?.querySelector<HTMLElement>('button')?.focus()
        }}
        onInteractOutside={(event) => {
          if (editingRef.current) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (editingRef.current) {
            event.preventDefault()
            return
          }
          restoreFocusRef.current = contentRef.current?.contains(document.activeElement) ?? false
        }}
        className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain border-0 bg-transparent p-0 text-inherit shadow-none motion-reduce:animate-none"
      >
        <SessionHoverPreviewCard
          session={session}
          descriptionLoading={open && descriptionLoading}
          canRename={canRename}
          onRenameTitle={onRenameTitle}
          onEditingChange={handleEditingChange}
        />
      </PopoverContent>
    </Popover>
  )
}

export {
  SESSION_HOVER_PREVIEW_ALIGN_OFFSET_PX,
  SESSION_HOVER_PREVIEW_DELAY_MS,
  SESSION_HOVER_PREVIEW_SKIP_DELAY_MS,
  SessionHoverPreview,
  SessionHoverPreviewCard,
  SessionHoverPreviewProvider
}
export type { SessionPreviewRequest, SessionRenameRequest }
