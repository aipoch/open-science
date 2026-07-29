import { useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

import { getExtensionPreservingFileNameParts } from './extension-preserving-file-name'

type ExtensionPreservingFileNameProps = {
  name: string
  className?: string
  compact?: boolean
}

// Gives the basename room to truncate while keeping its ending and common final extensions visible.
const ExtensionPreservingFileName = ({
  name,
  className,
  compact = false
}: ExtensionPreservingFileNameProps): React.JSX.Element => {
  const rootRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [useCompactAbbreviation, setUseCompactAbbreviation] = useState(compact)

  useLayoutEffect(() => {
    if (!compact) return

    const updateAbbreviation = (): void => {
      const availableWidth = rootRef.current?.getBoundingClientRect().width ?? 0
      const requiredWidth = measureRef.current?.getBoundingClientRect().width ?? 0
      if (availableWidth === 0 || requiredWidth === 0) return
      setUseCompactAbbreviation(requiredWidth > availableWidth)
    }

    updateAbbreviation()
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateAbbreviation)
    observer.observe(root)
    return () => observer.disconnect()
  }, [compact, name])

  const { head, tail, extension, isCompactAbbreviation } = getExtensionPreservingFileNameParts(
    name,
    compact && useCompactAbbreviation
  )

  return (
    <span
      ref={rootRef}
      data-testid="file-name-root"
      className={cn(
        'flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap',
        className
      )}
    >
      {compact ? (
        <span
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none absolute invisible whitespace-nowrap"
        >
          {name}
        </span>
      ) : null}
      <span
        data-testid="file-name-head"
        className={cn('min-w-0', isCompactAbbreviation ? 'shrink-0' : 'shrink truncate')}
      >
        {head}
      </span>
      {isCompactAbbreviation ? (
        <span data-testid="file-name-ellipsis" className="shrink-0">
          ...
        </span>
      ) : null}
      {tail ? (
        <span data-testid="file-name-tail" className="shrink-0">
          {tail}
        </span>
      ) : null}
      {extension ? (
        <span
          data-testid="file-name-extension"
          className="max-w-[50%] shrink-0 overflow-hidden text-ellipsis"
        >
          {extension}
        </span>
      ) : null}
    </span>
  )
}

export { ExtensionPreservingFileName }
