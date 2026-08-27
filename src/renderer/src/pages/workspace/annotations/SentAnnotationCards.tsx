import { MapPin, Quote } from 'lucide-react'
import { useTranslation } from 'react-i18next'

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

type SentAnnotationCardsProps = Readonly<{
  cards: readonly SentAnnotationCardView[]
  placement: 'message' | 'side-chat' | 'side-chat-after-text'
}>

type SentAnnotationCardProps = Readonly<{
  card: SentAnnotationCardView
  placement: SentAnnotationCardsProps['placement']
}>

const sentAnnotationSectionClassName = (
  placement: SentAnnotationCardsProps['placement']
): string => {
  if (placement === 'message') return 'mb-2 space-y-2'
  if (placement === 'side-chat-after-text') return 'mt-2 space-y-2'
  return 'space-y-2'
}

const SentAnnotationCard = ({ card, placement }: SentAnnotationCardProps): React.JSX.Element => {
  const { t } = useTranslation()
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
  placement
}: SentAnnotationCardsProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (cards.length === 0) return null
  return (
    <section
      className={sentAnnotationSectionClassName(placement)}
      aria-label={t('Sent annotations')}
    >
      {cards.map((card) => (
        <SentAnnotationCard key={card.id} card={card} placement={placement} />
      ))}
    </section>
  )
}

export { SentAnnotationCards }
export type { SentAnnotationCardView }
