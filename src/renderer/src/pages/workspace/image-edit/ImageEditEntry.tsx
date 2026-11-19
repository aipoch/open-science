import { MousePointer2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  fitContainedImageRect,
  viewportPointToNormalized
} from '../annotations/image-annotation-geometry'

export function ImageEditEntry({
  onEdit,
  disabledReason,
  sourceSize,
  canAnnotate,
  children
}: {
  onEdit?: () => void
  disabledReason?: string
  sourceSize?: { width: number; height: number }
  canAnnotate: boolean
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const surface = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number; id: number } | undefined>(undefined)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hovered, setHovered] = useState(false)
  const [decodedSize, setDecodedSize] = useState<{ width: number; height: number }>()
  const naturalSize = sourceSize ?? decodedSize
  useEffect(() => {
    const node = surface.current
    if (!node) return
    const measure = (): void => {
      setSize({ width: node.clientWidth, height: node.clientHeight })
      // Cached images can finish loading before React observes their load event.
      const image = node.querySelector('img')
      if (image?.complete && image.naturalWidth > 0) {
        setDecodedSize({ width: image.naturalWidth, height: image.naturalHeight })
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const rect = naturalSize
    ? fitContainedImageRect({ left: 0, top: 0, ...size }, naturalSize)
    : undefined
  const inside = (x: number, y: number): boolean => {
    const node = surface.current
    const image = node?.querySelector('img')
    const natural =
      sourceSize ?? (image ? { width: image.naturalWidth, height: image.naturalHeight } : undefined)
    const bounds =
      node && natural ? fitContainedImageRect(node.getBoundingClientRect(), natural) : undefined
    return Boolean(bounds && viewportPointToNormalized({ x, y }, bounds))
  }
  const isControl = (target: EventTarget): boolean =>
    target instanceof Element &&
    Boolean(target.closest('button, input, textarea, [data-radix-popper-content-wrapper]'))
  return (
    <div
      ref={surface}
      className="image-edit-entry relative size-full outline-none"
      data-testid={onEdit ? 'image-edit-entry' : undefined}
      data-hovered={hovered}
      role={onEdit ? 'group' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      aria-label={onEdit ? t('Edit image') : undefined}
      aria-disabled={onEdit && disabledReason ? true : undefined}
      title={
        onEdit
          ? (disabledReason ??
            (canAnnotate ? t('Click to edit image. Alt-click to add a note.') : t('Edit image')))
          : undefined
      }
      onLoadCapture={(event) => {
        if (event.target instanceof HTMLImageElement && event.target.naturalWidth > 0) {
          setDecodedSize({ width: event.target.naturalWidth, height: event.target.naturalHeight })
        }
      }}
      onPointerMoveCapture={(event) =>
        setHovered(Boolean(onEdit) && !event.altKey && inside(event.clientX, event.clientY))
      }
      onPointerLeave={() => setHovered(false)}
      onPointerDownCapture={(event) => {
        start.current = undefined
        if (
          !onEdit ||
          disabledReason ||
          event.button !== 0 ||
          event.isPrimary === false ||
          event.altKey ||
          isControl(event.target) ||
          !inside(event.clientX, event.clientY)
        )
          return
        start.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
      }}
      onPointerCancel={() => {
        start.current = undefined
      }}
      onPointerUpCapture={(event) => {
        const down = start.current
        start.current = undefined
        if (
          !down ||
          down.id !== event.pointerId ||
          event.altKey ||
          event.button !== 0 ||
          isControl(event.target) ||
          Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 ||
          !inside(event.clientX, event.clientY)
        )
          return
        event.stopPropagation()
        onEdit?.()
      }}
      onKeyDown={(event) => {
        if (
          !onEdit ||
          disabledReason ||
          event.target !== event.currentTarget ||
          event.nativeEvent.isComposing ||
          event.repeat ||
          (event.key !== 'Enter' && event.key !== ' ')
        )
          return
        event.preventDefault()
        event.stopPropagation()
        onEdit()
      }}
    >
      {children}
      {onEdit && rect ? (
        <div
          aria-hidden="true"
          data-testid="image-edit-entry-outline"
          data-hovered={hovered}
          className="image-edit-entry-outline pointer-events-none absolute"
          style={rect}
        />
      ) : null}
      {onEdit && rect ? (
        <div
          className="image-edit-entry-action absolute z-10"
          style={{
            left: rect.left + rect.width / 2,
            top: rect.top + Math.min(12, rect.height / 8),
            transform: 'translateX(-50%)'
          }}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 border-border-200 bg-bg-000 text-text-100 shadow-lg"
            disabled={Boolean(disabledReason)}
            title={disabledReason}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onEdit()
            }}
          >
            <MousePointer2 className="size-3.5" />
            {t('Click to edit')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
