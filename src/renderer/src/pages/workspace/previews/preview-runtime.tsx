import { Fragment, useCallback, useMemo, useState } from 'react'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { createPreviewResourceKey } from './preview-resource-key'
import { PreviewRuntimeContext } from './preview-runtime-context'

// Remounts the active renderer on retry so its existing lifecycle cleanup remains authoritative.
const PreviewAttemptBoundary = ({
  item,
  children
}: {
  item: PreviewFileItem
  children: React.ReactNode
}): React.JSX.Element => {
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  const runtime = useMemo(() => ({ attempt, item, retry }), [attempt, item, retry])

  return (
    <PreviewRuntimeContext.Provider value={runtime}>
      <Fragment key={attempt}>{children}</Fragment>
    </PreviewRuntimeContext.Provider>
  )
}

// Resets retry state when the selected file identity or version changes.
const PreviewRuntimeBoundary = ({
  item,
  children
}: {
  item: PreviewFileItem
  children: React.ReactNode
}): React.JSX.Element => {
  const resourceKey = createPreviewResourceKey(item)
  const boundaryKey = `${item.id}:${item.name}:${item.format}:${resourceKey}`

  return (
    <PreviewAttemptBoundary key={boundaryKey} item={item}>
      {children}
    </PreviewAttemptBoundary>
  )
}

export { PreviewRuntimeBoundary }
