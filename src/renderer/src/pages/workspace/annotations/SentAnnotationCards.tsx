/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, FileText, MapPin, Quote, ScanLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AcpMessageImage } from '../../../../../shared/acp'

type SentAnnotationCardView =
  | Readonly<{
      id: string
      kind: 'text'
      content: string
      source?: string
      note?: string
    }>
  | Readonly<{
      id: string
      kind: 'image-point'
      number: number
      x: number
      y: number
      source?: string
      note?: string
    }>
  | Readonly<{
      id: string
      kind: 'pdf-text'
      content: string
      source: string
      note?: string
    }>
  | Readonly<{
      id: string
      kind: 'pdf-region'
      content: string
      source: string
      note?: string
      image: AcpMessageImage
    }>

type SentAnnotationCardsProps = Readonly<{
  cards: readonly SentAnnotationCardView[]
  placement: 'message' | 'side-chat' | 'side-chat-after-text'
  onActivate?: (id: string) => void
}>

type SentAnnotationCardProps = Readonly<{
  card: SentAnnotationCardView
  placement: SentAnnotationCardsProps['placement']
  onActivate?: SentAnnotationCardsProps['onActivate']
}>

const PDF_QUOTE_PREVIEW_LINE_COUNT = 3

const sentAnnotationSectionClassName = (
  placement: SentAnnotationCardsProps['placement']
): string => {
  if (placement === 'message') return 'mb-2 space-y-2'
  if (placement === 'side-chat-after-text') return 'mt-2 space-y-2'
  return 'space-y-2'
}

const SentAnnotationCard = ({
  card,
  placement,
  onActivate
}: SentAnnotationCardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const quoteId = useId()
  const quoteRef = useRef<HTMLQuoteElement>(null)
  const [isQuoteExpanded, setIsQuoteExpanded] = useState(false)
  const [canExpandQuote, setCanExpandQuote] = useState(false)
  const isPdfQuote = card.kind === 'pdf-text'
  const cardContent = 'content' in card ? card.content : undefined

  useLayoutEffect(() => {
    const quote = quoteRef.current
    if (!isPdfQuote || !quote) {
      setIsQuoteExpanded(false)
      setCanExpandQuote(false)
      return
    }

    setIsQuoteExpanded(false)
    const measureOverflow = (): void => {
      const style = window.getComputedStyle(quote)
      const lineHeight = Number.parseFloat(style.lineHeight)
      const previewHeight = Number.isFinite(lineHeight)
        ? lineHeight * PDF_QUOTE_PREVIEW_LINE_COUNT
        : quote.clientHeight
      const overflows = quote.scrollHeight > previewHeight + 1
      setCanExpandQuote(overflows)
      if (!overflows) setIsQuoteExpanded(false)
    }

    measureOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(quote)
    return () => observer.disconnect()
  }, [card.id, cardContent, isPdfQuote])

  if (card.kind === 'pdf-text' || card.kind === 'pdf-region') {
    const region = card.kind === 'pdf-region'
    const Icon = region ? ScanLine : FileText
    return (
      <article
        data-sent-annotation-kind={card.kind}
        className="overflow-hidden rounded-lg border border-border/70 bg-background/80"
      >
        <button
          type="button"
          disabled={!onActivate}
          className="group w-full p-2 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 active:bg-muted disabled:cursor-default disabled:opacity-70"
          aria-label={t('Show annotation source')}
          onClick={() => onActivate?.(card.id)}
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-3.5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-foreground">
                {region ? t('PDF area') : t('PDF quote')}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {card.source}
              </span>
            </span>
          </div>
          {region ? (
            <span className="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <img
                src={`data:${card.image.mimeType};base64,${card.image.data}`}
                alt=""
                className="h-14 w-20 rounded-md border border-border/70 bg-muted object-cover"
              />
              <span className="line-clamp-3 self-center whitespace-pre-wrap break-words text-xs leading-5 text-foreground/90">
                {card.content}
              </span>
            </span>
          ) : (
            <blockquote
              ref={quoteRef}
              id={quoteId}
              className={`mt-2 whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-2 text-xs leading-5 text-foreground/90 ${isQuoteExpanded ? '' : 'line-clamp-3'}`}
            >
              {card.content}
            </blockquote>
          )}
          {card.note ? (
            <span className="mt-2 block border-t border-border/60 pt-2 text-xs text-foreground">
              {card.note}
            </span>
          ) : null}
        </button>
        {!region && canExpandQuote ? (
          <button
            type="button"
            className="flex w-full items-center justify-end gap-1 border-t border-border/50 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
            aria-label={isQuoteExpanded ? t('Show less') : t('Show more')}
            aria-expanded={isQuoteExpanded}
            aria-controls={quoteId}
            onClick={() => setIsQuoteExpanded((expanded) => !expanded)}
          >
            <span>{isQuoteExpanded ? t('Show less') : t('Show more')}</span>
            {isQuoteExpanded ? (
              <ChevronUp className="size-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </article>
    )
  }
  const imagePoint = card.kind === 'image-point'
  return (
    <article
      data-side-chat-annotation-card={placement === 'message' ? undefined : 'true'}
      className="rounded-lg border border-border/70 bg-background/70 p-2"
    >
      <div className="flex items-center gap-1 text-xs font-semibold">
        {imagePoint ? (
          <MapPin className="size-3" aria-hidden="true" />
        ) : (
          <Quote className="size-3" aria-hidden="true" />
        )}
        {imagePoint ? t('Image point {{number}}', { number: card.number }) : t('Text quote')}
      </div>
      <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-2 text-xs">
        {imagePoint
          ? t('Point {{number}} at {{x}}, {{y}}', {
              number: card.number,
              x: card.x,
              y: card.y
            })
          : card.content}
      </blockquote>
      {card.source ? (
        <div
          className={
            placement === 'message'
              ? 'mt-1 text-[11px] opacity-70'
              : 'mt-1 break-all text-[11px] opacity-70'
          }
        >
          {t('Source: {{source}}', { source: card.source })}
        </div>
      ) : null}
      {card.note ? <div className="mt-1 text-xs">{card.note}</div> : null}
    </article>
  )
}

const SentAnnotationCards = ({
  cards,
  placement,
  onActivate
}: SentAnnotationCardsProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (cards.length === 0) return null
  return (
    <section
      className={sentAnnotationSectionClassName(placement)}
      aria-label={t('Sent annotations')}
    >
      {cards.map((card) => (
        <SentAnnotationCard
          key={card.id}
          card={card}
          placement={placement}
          onActivate={onActivate}
        />
      ))}
    </section>
  )
}

export { SentAnnotationCards }
export type { SentAnnotationCardView }
