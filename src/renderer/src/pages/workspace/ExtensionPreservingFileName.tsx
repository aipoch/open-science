import { useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import {
  getExtensionPreservingFileNameParts,
  type ExtensionPreservingFileNameParts
} from './extension-preserving-file-name'

type ExtensionPreservingFileNameProps = {
  name: string
  className?: string
  // Retained for existing card callers; both densities follow the same width-based rule.
  compact?: boolean
}

type MeasuredName = {
  name: string
  naturalWidth: number
  parts: ExtensionPreservingFileNameParts
}

// All file-name surfaces share a measured prefix / ellipsis / suffix / extension layout.
const ExtensionPreservingFileName = ({
  name,
  className
}: ExtensionPreservingFileNameProps): React.JSX.Element => {
  const rootRef = useRef<HTMLSpanElement>(null)
  const [measured, setMeasured] = useState<MeasuredName>()

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    let context: CanvasRenderingContext2D | null = null
    // Widths belong to this name and font, and are released when the label unmounts.
    const widths = new Map<string, number>()
    let typography: string | undefined
    let availableWidth = 0
    let fittedWidth: number | undefined

    const update = (width: number): void => {
      availableWidth = width
      if (width <= 0) return
      context ??= root.ownerDocument.createElement('canvas').getContext('2d')
      if (!context) return
      const style = getComputedStyle(root)
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const spacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing
      const key = `${font}/${spacing}`
      const metrics = context
      if (key !== typography) {
        typography = key
        metrics.font = font
        metrics.letterSpacing = spacing
        widths.clear()
        widths.set('', 0)
        fittedWidth = undefined
      }
      const measure = (text: string): number => {
        const cached = widths.get(text)
        if (cached !== undefined) return cached
        const result = metrics.measureText(text).width
        widths.set(text, result)
        return result
      }
      // CSS layout rounds fractional canvas advances to its own subpixel grid.
      const naturalWidth = Math.ceil(measure(name))
      const fitWidth = Math.min(width, naturalWidth)
      if (naturalWidth <= 0 || fittedWidth === fitWidth) return
      fittedWidth = fitWidth
      const parts = getExtensionPreservingFileNameParts(name, { width, measure })
      setMeasured((previous) =>
        previous?.name === name &&
        previous.naturalWidth === naturalWidth &&
        previous.parts.head === parts.head &&
        previous.parts.tail === parts.tail &&
        previous.parts.extension === parts.extension &&
        previous.parts.isAbbreviated === parts.isAbbreviated
          ? previous
          : { name, naturalWidth, parts }
      )
    }
    if (typeof ResizeObserver === 'undefined') {
      update(root.getBoundingClientRect().width)
      return
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) update(entry.contentRect.width)
    })
    observer.observe(root)
    const fonts = root.ownerDocument.fonts
    const onFontLoaded = (): void => {
      typography = undefined
      update(availableWidth)
    }
    fonts?.addEventListener('loadingdone', onFontLoaded)
    return () => {
      observer.disconnect()
      fonts?.removeEventListener('loadingdone', onFontLoaded)
    }
  }, [name, className])

  const current = measured?.name === name ? measured : undefined
  const { head, tail, extension, isAbbreviated } =
    current?.parts ?? getExtensionPreservingFileNameParts(name)

  return (
    <span
      ref={rootRef}
      data-testid="file-name-root"
      aria-label={name}
      dir="ltr"
      style={{ width: current?.naturalWidth, unicodeBidi: 'isolate' }}
      className={cn(
        'relative flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap',
        className
      )}
    >
      <bdi data-testid="file-name-head" className="min-w-0 shrink truncate">
        {head}
      </bdi>
      {isAbbreviated ? (
        <span data-testid="file-name-ellipsis" className="shrink-0">
          …
        </span>
      ) : null}
      {tail ? (
        <bdi data-testid="file-name-tail" className="shrink-0">
          {tail}
        </bdi>
      ) : null}
      {extension ? (
        <span
          data-testid="file-name-extension"
          className={cn(
            'shrink-0 overflow-hidden text-ellipsis',
            (!current || isAbbreviated) && 'max-w-[50%]'
          )}
        >
          {extension}
        </span>
      ) : null}
    </span>
  )
}

export { ExtensionPreservingFileName }
