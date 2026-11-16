import {
  SplitButton,
  SplitButtonGroup,
  SplitButtonPrimary,
  SplitButtonTrigger,
  SplitButtonContent
} from '@/components/ui/split-button'
import { ChevronDown, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionStore } from '@/stores/session-store'
import { ConversationPicker } from '../ConversationPicker'
import type { LiteratureReference } from '../../../../../shared/session-persistence'
import { useLibraryReferenceActions } from './library-reference-actions'

// Subscribe only while the destination popover is open.
function LibraryConversationPicker({
  onSelect
}: {
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const actions = useLibraryReferenceActions()
  const sessions = useSessionStore((state) => state.sessions)
  const eligible = sessions.filter(
    (session) =>
      session.projectId === actions?.projectId &&
      !session.isPending &&
      !session.packageOrigin &&
      session.archivedAt === undefined &&
      session.status !== 'waiting-plan-approval'
  )
  return (
    <>
      <ConversationPicker
        sessions={eligible}
        currentSessionId={actions?.currentSessionId}
        onSelect={onSelect}
      />
      <div className="mt-1 shrink-0 border-t border-border p-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => onSelect(null)}
        >
          <Plus aria-hidden="true" />
          {t('New conversation')}
        </Button>
      </div>
      <p className="px-3 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        {t('Added to the draft. You choose when to send.')}
      </p>
    </>
  )
}

export function LibraryChatButton({
  references
}: {
  references: readonly LiteratureReference[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const actions = useLibraryReferenceActions()
  const [open, setOpen] = useState(false)
  const selected = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openedByHover = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cancelHover = (): void => clearTimeout(hoverTimer.current)
  const closeHoveredPicker = (): void => {
    cancelHover()
    if (openedByHover.current) hoverTimer.current = setTimeout(() => setOpen(false), 180)
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const add = (sessionId: string | null): void => {
    if (!actions || !references.length) return
    cancelHover()
    selected.current = true
    setOpen(false)
    actions.add(references, sessionId)
  }
  return (
    <SplitButton
      kind="popover"
      open={open}
      onOpenChange={(value) => {
        cancelHover()
        selected.current = false
        setOpen(value)
      }}
    >
      <SplitButtonGroup className="border border-border bg-background">
        <Tooltip>
          <TooltipTrigger asChild>
            <SplitButtonPrimary
              variant="ghost"
              size="xs"
              className="border-0"
              disabled={!actions?.canAddToCurrent || !references.length}
              onClick={() => add(actions?.currentSessionId ?? null)}
            >
              {t('Add to chat')}
            </SplitButtonPrimary>
          </TooltipTrigger>
          <TooltipContent>{t('Add references to the current conversation draft')}</TooltipContent>
        </Tooltip>
        <SplitButtonTrigger
          ref={triggerRef}
          variant="ghost"
          size="xs"
          className="border-0 px-1.5"
          disabled={!actions || !references.length}
          aria-label={t('Choose another conversation')}
          onPointerEnter={(event) => {
            cancelHover()
            if (event.pointerType === 'touch' || !actions || !references.length || open) return
            hoverTimer.current = setTimeout(() => {
              selected.current = false
              openedByHover.current = true
              setOpen(true)
            }, 120)
          }}
          onPointerLeave={closeHoveredPicker}
          onClick={(event) => {
            cancelHover()
            // Match the PDF mark-style picker: clicking a hover-open panel pins it.
            if (open && openedByHover.current) {
              event.preventDefault()
              contentRef.current?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus()
            }
            openedByHover.current = false
          }}
        >
          <ChevronDown aria-hidden="true" />
        </SplitButtonTrigger>
      </SplitButtonGroup>
      <SplitButtonContent
        ref={contentRef}
        style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        align="end"
        onPointerEnter={cancelHover}
        onPointerLeave={closeHoveredPicker}
        onFocusCapture={() => {
          cancelHover()
          openedByHover.current = false
        }}
        onInteractOutside={(event) => {
          // Pinning through the trigger is not an outside dismissal; keep Radix focus return.
          if (triggerRef.current?.contains(event.target as Node)) event.preventDefault()
        }}
        onOpenAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
        aria-label={t('Choose another conversation')}
        className="z-[130] w-80 max-w-[calc(100vw-2rem)] border border-border bg-popover p-0 text-popover-foreground shadow-menu"
        onCloseAutoFocus={(event) => {
          if (selected.current || openedByHover.current) event.preventDefault()
        }}
      >
        <LibraryConversationPicker onSelect={add} />
      </SplitButtonContent>
    </SplitButton>
  )
}
