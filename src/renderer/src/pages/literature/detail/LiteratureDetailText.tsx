import { ChevronDown, ChevronUp } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

const ABSTRACT_PREVIEW_LINE_COUNT = 8
const AUTHOR_PREVIEW_LINE_COUNT = 5

const CollapsibleDetailText = ({
  collapsedClassName,
  previewLineCount,
  text
}: {
  collapsedClassName: string
  previewLineCount: number
  text: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const textId = useId()
  const textRef = useRef<HTMLParagraphElement>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)

  useLayoutEffect(() => {
    const content = textRef.current
    if (!content) return

    setIsExpanded(false)
    const measureOverflow = (): void => {
      const style = window.getComputedStyle(content)
      const parsedLineHeight = Number.parseFloat(style.lineHeight)
      const parsedFontSize = Number.parseFloat(style.fontSize)
      const lineHeight =
        Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight < 4 && Number.isFinite(parsedFontSize)
            ? parsedLineHeight * parsedFontSize
            : parsedLineHeight
          : undefined
      const previewHeight = lineHeight ? lineHeight * previewLineCount : content.clientHeight
      setCanExpand(content.scrollHeight > previewHeight + 1)
    }

    measureOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [previewLineCount, text])

  return (
    <>
      <p
        ref={textRef}
        id={textId}
        className={cn(
          'mt-2 whitespace-pre-wrap break-words leading-6 text-muted-foreground',
          !isExpanded && collapsedClassName
        )}
      >
        {text}
      </p>
      {canExpand ? (
        <button
          type="button"
          className="-ml-2 mt-1 inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-primary outline-none transition-colors hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={isExpanded}
          aria-controls={textId}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? t('Show less') : t('Show more')}
          {isExpanded ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </>
  )
}

export const CollapsibleAbstract = ({ text }: { text: string }): React.JSX.Element => (
  <CollapsibleDetailText
    text={text}
    previewLineCount={ABSTRACT_PREVIEW_LINE_COUNT}
    collapsedClassName="line-clamp-8"
  />
)

export const CollapsibleAuthors = ({ text }: { text: string }): React.JSX.Element => (
  <CollapsibleDetailText
    text={text}
    previewLineCount={AUTHOR_PREVIEW_LINE_COUNT}
    collapsedClassName="line-clamp-5"
  />
)
