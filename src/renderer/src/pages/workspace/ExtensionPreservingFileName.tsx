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
  const probeRef = useRef<HTMLSpanElement>(null)
  const [measured, setMeasured] = useState<MeasuredName>()

  useLayoutEffect(() => {
    const root = rootRef.current
    const probe = probeRef.current
    if (!root || !probe) return

    const update = (): void => {
      const width = root.getBoundingClientRect().width
      if (width <= 0) return
      const widths = new Map<string, number>([['', 0]])
      const measure = (text: string): number => {
        const cached = widths.get(text)
        if (cached !== undefined) return cached
        probe.textContent = text
        const result = probe.getBoundingClientRect().width
        probe.textContent = ''
        widths.set(text, result)
        return result
      }
      const naturalWidth = measure(name)
      if (naturalWidth <= 0) return
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
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(root)
    // Fonts can change text widths even when the container width stays fixed.
    document.fonts?.addEventListener('loadingdone', update)
    return () => {
      observer.disconnect()
      document.fonts?.removeEventListener('loadingdone', update)
    }
  }, [name])

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
      <span
        ref={probeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute w-max whitespace-nowrap"
      />
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
