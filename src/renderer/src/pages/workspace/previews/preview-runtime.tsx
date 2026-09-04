import { Fragment, useCallback, useMemo, useRef, useState } from 'react'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { createPreviewResourceKey } from './preview-resource-key'
import { PreviewRuntimeContext } from './preview-runtime-context'
import type { PreviewDownloadVersionContext } from './preview-runtime-context'

// Remounts the active renderer on retry so its existing lifecycle cleanup remains authoritative.
const PreviewAttemptBoundary = ({
  item,
  downloadVersionContext,
  onRetry,
  children
}: {
  item: PreviewFileItem
  downloadVersionContext?: PreviewDownloadVersionContext
  onRetry?: () => Promise<void>
  children: React.ReactNode
}): React.JSX.Element => {
  const [attempt, setAttempt] = useState(0)
  const retryPendingRef = useRef(false)
  const retry = useCallback(() => {
    if (retryPendingRef.current) return
    const restart = (): void => setAttempt((current) => current + 1)
    if (!onRetry) {
      restart()
      return
    }
    retryPendingRef.current = true
    // Managed retries refresh their logical identity first. A lookup failure still remounts the
    // renderer so transient read errors retain the existing retry behavior.
    void Promise.resolve()
      .then(onRetry)
      .catch(() => undefined)
      .finally(() => {
        retryPendingRef.current = false
        restart()
      })
  }, [onRetry])
  const runtime = useMemo(
    () => ({ attempt, item, retry, downloadVersionContext }),
    [attempt, downloadVersionContext, item, retry]
  )

  return (
    <PreviewRuntimeContext.Provider value={runtime}>
      <Fragment key={attempt}>{children}</Fragment>
    </PreviewRuntimeContext.Provider>
  )
}

// Resets retry state when the selected file identity or version changes.
const PreviewRuntimeBoundary = ({
  item,
  downloadVersionContext,
  onRetry,
  children
}: {
  item: PreviewFileItem
  downloadVersionContext?: PreviewDownloadVersionContext
  onRetry?: () => Promise<void>
  children: React.ReactNode
}): React.JSX.Element => {
  const resourceKey = createPreviewResourceKey(item)
  const boundaryKey = `${item.id}:${item.name}:${item.format}:${resourceKey}`

  return (
    <PreviewAttemptBoundary
      key={boundaryKey}
      item={item}
      downloadVersionContext={downloadVersionContext}
      onRetry={onRetry}
    >
      {children}
    </PreviewAttemptBoundary>
  )
}

export { PreviewRuntimeBoundary }
