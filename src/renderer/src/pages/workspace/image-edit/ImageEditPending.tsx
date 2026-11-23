import { useLayoutEffect, useRef, useState } from 'react'
import { ImageIcon, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { fitContainedImageRect } from '../annotations/image-annotation-geometry'

// A new version occupies its own image-sized card. Keep it outside the zoom transform so
// status and source navigation remain reachable even after an edit at high magnification.
export function ImageEditPending({
  width = 4,
  height = 3,
  loading,
  onViewSource
}: {
  width?: number
  height?: number
  loading: boolean
  onViewSource(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const measure = (): void => setSize({ width: node.clientWidth, height: node.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const rect = fitContainedImageRect({ left: 0, top: 0, ...size }, { width, height })
  return (
    <div ref={viewport} className="absolute inset-3" data-testid="image-edit-pending">
      <div
        className="absolute rounded-xl border border-border-300/70 bg-bg-000 shadow-sm"
        style={
          rect
            ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
            : { inset: 0 }
        }
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-2 text-center">
        <ImageIcon aria-hidden className="size-8 text-text-300" />
        <div className="flex items-center gap-2 text-sm text-text-100">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          {loading ? t('Loading image…') : t('Generating image…')}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onViewSource}>
          {t('View source image')}
        </Button>
      </div>
    </div>
  )
}
