import { useEffect, useRef, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

// Use the same pointer capture and six-pixel activation threshold as the composer queue.
// Apply drag transforms to the grouped rows without rerendering the editor or journal table.
export function JournalFieldRow({
  id,
  name,
  disabled,
  onMove,
  children
}: {
  id: string
  name: string
  disabled: boolean
  onMove: (id: string, target: string) => void
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const row = useRef<HTMLDivElement>(null)
  const drag = useRef<
    | {
        pointerId: number
        startY: number
        active: boolean
        from: number
        to: number
        rows: { element: HTMLElement; top: number; height: number }[]
      }
    | undefined
  >(undefined)
  const reset = (): void => {
    drag.current?.rows.forEach(({ element }) => {
      element.style.transform = ''
      element.style.transition = ''
      delete element.dataset.dragging
    })
    drag.current = undefined
  }
  useEffect(() => reset, [])
  const siblings = (): HTMLElement[] =>
    Array.from(
      row.current?.parentElement?.querySelectorAll<HTMLElement>(
        ':scope > [data-journal-field-id]'
      ) ?? []
    )
  return (
    <div
      ref={row}
      data-journal-field-id={id}
      className="relative rounded-lg border border-transparent bg-card p-2 hover:bg-muted/40 focus-within:bg-muted/40 data-[dragging=true]:z-20 data-[dragging=true]:border-primary data-[dragging=true]:shadow-lg data-[dragging=true]:ring-1 data-[dragging=true]:ring-primary/30"
    >
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          className="size-8 shrink-0 touch-none cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label={t('Reorder {{name}}', { name })}
          title={t('Drag to reorder, or use Arrow Up and Arrow Down.')}
          onPointerDown={(event) => {
            if (event.isPrimary === false || event.button !== 0) return
            event.currentTarget.setPointerCapture?.(event.pointerId)
            const rows = siblings().map((element) => {
              const bounds = element.getBoundingClientRect()
              return { element, top: bounds.top, height: bounds.height }
            })
            const from = rows.findIndex(({ element }) => element === row.current)
            drag.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              active: false,
              from,
              to: from,
              rows
            }
          }}
          onPointerMove={(event) => {
            const current = drag.current
            if (!current || current.pointerId !== event.pointerId || current.from < 0) return
            const delta = event.clientY - current.startY
            if (!current.active && Math.abs(delta) < 6) return
            event.preventDefault()
            current.active = true
            const { rows, from } = current
            const selected = rows[from]
            const center = selected.top + selected.height / 2 + delta
            current.to = rows.reduce(
              (nearest, entry, index) =>
                Math.abs(center - entry.top - entry.height / 2) <
                Math.abs(center - rows[nearest].top - rows[nearest].height / 2)
                  ? index
                  : nearest,
              from
            )
            const gap = rows.length > 1 ? rows[1].top - rows[0].top - rows[0].height : 0
            rows.forEach(({ element }, index) => {
              if (index === from) {
                element.dataset.dragging = 'true'
                element.style.transform = `translateY(${delta}px)`
              } else {
                const shift =
                  index > from && index <= current.to
                    ? -(selected.height + gap)
                    : index >= current.to && index < from
                      ? selected.height + gap
                      : 0
                element.style.transition = window.matchMedia('(prefers-reduced-motion: reduce)')
                  .matches
                  ? 'none'
                  : 'transform 150ms ease-out'
                element.style.transform = `translateY(${shift}px)`
              }
            })
          }}
          onPointerUp={(event) => {
            const current = drag.current
            if (!current || current.pointerId !== event.pointerId) return
            const target = current.active
              ? current.rows[current.to]?.element.dataset.journalFieldId
              : undefined
            reset()
            if (event.currentTarget.hasPointerCapture?.(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
            if (target && target !== id) onMove(id, target)
          }}
          onPointerCancel={reset}
          onLostPointerCapture={reset}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              reset()
              return
            }
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const rows = siblings()
            const index = rows.indexOf(row.current!)
            const target = rows[index + (event.key === 'ArrowUp' ? -1 : 1)]?.dataset.journalFieldId
            if (target) onMove(id, target)
          }}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1 space-y-2">{children}</div>
      </div>
    </div>
  )
}
