import { memo, useEffect, useRef, useState } from 'react'

// Count updates must not rerender the library table or its PDF preview.
export const LiteratureLibraryCount = memo(function LiteratureLibraryCount({
  revision,
  hidden
}: {
  revision: number
  hidden: boolean
}): React.JSX.Element | null {
  const [count, setCount] = useState<number>()
  const pending = useRef<{ revision: number; result: Promise<number | undefined> } | undefined>(
    undefined
  )
  useEffect(() => {
    let cancelled = false
    if (pending.current?.revision !== revision) {
      pending.current = {
        revision,
        result: window.api.literature
          .search({ scope: 'library', lifecycle: 'active', countOnly: true })
          .then((page) => page.totalCount)
      }
    }
    void pending.current.result
      .then((total) => {
        if (!cancelled && total !== undefined) setCount(total)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [revision])
  return hidden || count === undefined ? null : (
    <span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span>
  )
})
