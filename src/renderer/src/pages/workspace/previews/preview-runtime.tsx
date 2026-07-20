import { createContext, Fragment, useCallback, useContext, useMemo, useState } from 'react'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { createPreviewResourceKey } from './preview-resource-key'

type PreviewRuntime = {
  attempt: number
  item: PreviewFileItem
  retry: () => void
}

const PreviewRuntimeContext = createContext<PreviewRuntime | undefined>(undefined)

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

const usePreviewRuntime = (): PreviewRuntime | undefined => useContext(PreviewRuntimeContext)

export { PreviewRuntimeBoundary, usePreviewRuntime }
export type { PreviewRuntime }
