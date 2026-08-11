import { ArrowUpRight, ChevronDown, ChevronUp, HelpCircle, MessageSquare } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'

import type { InlineParentMessageProjection } from './subagent-release-projection'

type WorkspaceSubagentMessageRowProps = {
  message: InlineParentMessageProjection
  onOpenSource: () => void
}

const MESSAGE_PREVIEW_LINE_COUNT = 6

const WorkspaceSubagentMessageRow = ({
  message,
  onOpenSource
}: WorkspaceSubagentMessageRowProps): React.JSX.Element => {
  const isQuestion = message.kind === 'question'
  const intentLabel = isQuestion ? 'asked a question' : 'sent a message'
  const IntentIcon = isQuestion ? HelpCircle : MessageSquare
  const messageBodyId = useId()
  const messageBodyRef = useRef<HTMLParagraphElement>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)

  useLayoutEffect(() => {
    const body = messageBodyRef.current
    if (!body) return

    setIsExpanded(false)
    const measureOverflow = (): void => {
      const style = window.getComputedStyle(body)
      const parsedLineHeight = Number.parseFloat(style.lineHeight)
      const parsedFontSize = Number.parseFloat(style.fontSize)
      const lineHeight =
        Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight < 4 && Number.isFinite(parsedFontSize)
            ? parsedLineHeight * parsedFontSize
            : parsedLineHeight
          : undefined
      const previewHeight = lineHeight ? lineHeight * MESSAGE_PREVIEW_LINE_COUNT : body.clientHeight
      const overflows = body.scrollHeight > previewHeight + 1
      setCanExpand(overflows)
      if (!overflows) setIsExpanded(false)
    }

    measureOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(body)
    return () => observer.disconnect()
  }, [message.messageId, message.text])

  return (
    <article
      aria-label={`${message.sourceName} ${intentLabel}.`}
      className="overflow-hidden rounded-xl border border-border-200 bg-bg-000 text-card-foreground shadow-sm"
    >
      <header className="flex min-w-0 items-center gap-2.5 border-b border-border-200 bg-bg-100/60 px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <IntentIcon className="size-3.5" aria-hidden="true" />
        </span>
        <h3 className="min-w-0 flex-1 break-words text-xs font-medium">
          {message.sourceName} {intentLabel}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Open Subagent preview for ${message.sourceName}`}
          className="text-primary"
          onClick={onOpenSource}
        >
          <span>View agent</span>
          <ArrowUpRight data-icon="inline-end" className="size-3.5" aria-hidden="true" />
        </Button>
      </header>
      <div className="min-w-0 px-3 py-3">
        <p
          ref={messageBodyRef}
          id={messageBodyId}
          data-testid="subagent-message-body"
          className={`whitespace-pre-wrap break-words text-xs text-text-100 leading-5 ${canExpand && !isExpanded ? 'line-clamp-6' : ''}`}
        >
          {message.text}
        </p>
        {canExpand ? (
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={isExpanded}
              aria-controls={messageBodyId}
              className="-mb-1 -mr-1 text-muted-foreground hover:text-foreground"
              onClick={() => setIsExpanded((expanded) => !expanded)}
            >
              <span>{isExpanded ? 'Show less' : 'Show more'}</span>
              {isExpanded ? (
                <ChevronUp data-icon="inline-end" className="size-3" aria-hidden="true" />
              ) : (
                <ChevronDown data-icon="inline-end" className="size-3" aria-hidden="true" />
              )}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  )
}

export { WorkspaceSubagentMessageRow }
