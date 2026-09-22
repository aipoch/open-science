import { useEffect, useRef, useState } from 'react'

type Progress = { collectionId: string; done: number; total: number; stopping: boolean }
type Result = { done: number; failed: string[]; remaining: string[] }

// Stop only between atomic chunks: an acknowledged chunk must never be reported as unsaved.
export async function saveSmartDecisionChunks(
  ids: string[],
  save: (ids: string[]) => Promise<{ saved: string[]; failed: string[] }>,
  signal: AbortSignal,
  progress: (processed: number) => void
): Promise<Result> {
  const result: Result = { done: 0, failed: [], remaining: [] }
  for (let offset = 0; offset < ids.length; offset += 50) {
    if (signal.aborted) {
      result.remaining = ids.slice(offset)
      break
    }
    const chunk = ids.slice(offset, offset + 50)
    try {
      const receipt = await save(chunk)
      result.done += receipt.saved.length
      result.failed.push(...receipt.failed)
    } catch {
      result.failed.push(...chunk)
    }
    progress(offset + chunk.length)
  }
  return result
}

export function useSmartDecisionBatch(): {
  progress: Progress | undefined
  active: React.RefObject<string | undefined>
  stop: () => void
  run: (
    collectionId: string,
    ids: string[],
    decision: 'include' | 'exclude' | 'automatic'
  ) => Promise<Result>
} {
  const [progress, setProgress] = useState<Progress>()
  const controller = useRef<AbortController | undefined>(undefined)
  const active = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  return {
    progress,
    active,
    stop: () => {
      controller.current?.abort()
      setProgress((value) => value && { ...value, stopping: true })
    },
    run: async (collectionId, ids, decision) => {
      // A selection lookup can settle after its page has already unmounted.
      if (!mounted.current) return { done: 0, failed: [], remaining: ids }
      if (controller.current) throw new Error('A decision batch is already running.')
      const abort = new AbortController()
      controller.current = abort
      active.current = collectionId
      setProgress({ collectionId, done: 0, total: ids.length, stopping: false })
      try {
        return await saveSmartDecisionChunks(
          ids,
          async (itemIds) => {
            const receipt = await window.api.literature.transact({
              kind: 'smart-collection',
              collectionId,
              action: 'override',
              itemIds,
              decision,
              offset: 0
            })
            if (!receipt.smartDecisionBatch)
              throw new Error('Decision acknowledgement is unavailable.')
            return receipt.smartDecisionBatch
          },
          abort.signal,
          (done) => {
            if (mounted.current) setProgress((value) => value && { ...value, done })
          }
        )
      } finally {
        controller.current = undefined
        active.current = undefined
        if (mounted.current) setProgress(undefined)
      }
    }
  }
}
