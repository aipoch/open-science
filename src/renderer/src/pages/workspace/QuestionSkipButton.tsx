import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import './question-skip-button.css'

type QuestionSkipButtonProps = {
  disabled: boolean
  onSkip: () => void
  onSkipAll: () => void
}

export const QuestionSkipButton = ({
  disabled,
  onSkip,
  onSkipAll
}: QuestionSkipButtonProps): React.JSX.Element => {
  const { t } = useTranslation()
  const groupRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoredEscapeFocus = useRef(false)
  const [width, setWidth] = useState<number>()
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [enteredContent, setEnteredContent] = useState<HTMLDivElement | null>(null)
  const [side, setSide] = useState('bottom')
  const isOpen = open && !disabled

  // Match the complete split control, rather than Radix's arrow-only anchor, across locales.
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    const measure = (): void => setWidth(group.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(group)
    return () => observer.disconnect()
  }, [])

  // Radix owns collision placement. Follow its resolved side, including live window resizing.
  useLayoutEffect(() => {
    if (!content) return
    const syncSide = (): void => setSide(content.dataset.side ?? 'bottom')
    syncSide()
    const observer = new MutationObserver(syncSide)
    observer.observe(content, { attributes: true, attributeFilter: ['data-side'] })
    return () => observer.disconnect()
  }, [content])

  // Paint a collapsed frame at the actual anchor before expanding. DropdownMenu does not
  // expose Popper's placement callback, so use the joined edge rather than a mount-time guess.
  useLayoutEffect(() => {
    if (!isOpen || !content || enteredContent === content) return
    let frame: number
    const waitForPlacement = (): void => {
      const anchor = groupRef.current?.getBoundingClientRect()
      const menu = content.getBoundingClientRect()
      const joined =
        anchor &&
        menu.height > 0 &&
        (Math.abs(menu.top - anchor.bottom) < 1 || Math.abs(menu.bottom - anchor.top) < 1)
      if (!joined) {
        frame = requestAnimationFrame(waitForPlacement)
        return
      }
      if (
        content.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        setEnteredContent(content)
      } else {
        frame = requestAnimationFrame(() => setEnteredContent(content))
      }
    }
    frame = requestAnimationFrame(waitForPlacement)
    return () => cancelAnimationFrame(frame)
  }, [isOpen, content, enteredContent])

  if (disabled && open) setOpen(false)

  const changeOpen = (next: boolean): void => {
    if (next) restoredEscapeFocus.current = false
    setOpen(next)
    // Reversing an exit keeps the same FocusScope mounted; restore its normal entry focus.
    if (next && content) {
      requestAnimationFrame(() => {
        if (content.isConnected && content.dataset.state === 'open') content.focus()
      })
    }
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={changeOpen} modal={false}>
      <div
        ref={groupRef}
        data-testid="question-skip-control"
        data-open={isOpen && content !== null && enteredContent === content}
        data-connected={content !== null}
        data-side={side}
        className="question-skip-control inline-flex shrink-0 rounded-lg bg-secondary"
      >
        <Button
          className="rounded-r-none bg-transparent px-3 hover:bg-surface-control-hover focus-visible:z-10"
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            setOpen(false)
            onSkip()
          }}
        >
          {t('Skip')}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            className="rounded-l-none border-l-border-200 bg-transparent hover:bg-surface-control-hover focus-visible:z-10 aria-expanded:bg-transparent aria-expanded:hover:bg-surface-control-hover"
            type="button"
            variant="secondary"
            size="icon"
            disabled={disabled}
            aria-label={t('More skip options')}
          >
            <ChevronDown
              className="question-skip-arrow size-3.5"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        ref={setContent}
        data-testid="question-skip-menu"
        data-entered={content !== null && enteredContent === content}
        className="question-skip-menu scrollbar-auto-hide min-w-0 overflow-y-auto rounded-lg p-1"
        style={{
          width,
          maxWidth: 'var(--radix-dropdown-menu-content-available-width)',
          maxHeight: 'var(--radix-dropdown-menu-content-available-height)'
        }}
        side="bottom"
        align="end"
        sideOffset={0}
        collisionPadding={8}
        sticky="always"
        onEscapeKeyDown={() => {
          // Exit motion must not delay Escape → ArrowDown/Tab keyboard navigation.
          restoredEscapeFocus.current = true
          triggerRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          const active = content?.ownerDocument.activeElement
          if (
            restoredEscapeFocus.current ||
            (active && active !== content?.ownerDocument.body && !content?.contains(active))
          ) {
            event.preventDefault()
          }
          restoredEscapeFocus.current = false
        }}
        onInteractOutside={(event) => {
          // The retained exit layer must not dismiss a fresh toggle on the same pointer event.
          if (groupRef.current?.contains(event.detail.originalEvent.target as Node))
            event.preventDefault()
        }}
        inert={!isOpen || undefined}
        aria-hidden={!isOpen || undefined}
      >
        <DropdownMenuItem
          className="whitespace-normal break-words text-status-warning-foreground data-[highlighted]:bg-status-warning-surface data-[highlighted]:text-status-warning-foreground dark:text-status-warning-dark-foreground dark:data-[highlighted]:bg-status-warning-dark-surface dark:data-[highlighted]:text-status-warning-dark-foreground"
          disabled={disabled}
          onSelect={onSkipAll}
        >
          {t('Skip all')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
