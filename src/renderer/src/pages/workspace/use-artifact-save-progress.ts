import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArtifactSaveProgress } from '../../../../shared/file-save'

// The host owns the transfer; the dialog observes it until the save promise settles.
export const useArtifactSaveProgress = (): {
  begin: (totalFiles: number) => string
  end: () => void
  cancel: () => Promise<void>
  progress: ArtifactSaveProgress | undefined
  cancelPending: boolean
  cancelError: boolean
  progressUnavailable: boolean
} => {
  const activeId = useRef<string | undefined>(undefined)
  const [operationId, setOperationId] = useState<string>()
  const [progress, setProgress] = useState<ArtifactSaveProgress>()
  const [cancelPending, setCancelPending] = useState(false)
  const cancelInFlight = useRef(false)
  const [cancelError, setCancelError] = useState(false)
  const [progressUnavailable, setProgressUnavailable] = useState(false)

  const begin = useCallback((totalFiles: number): string => {
    const id = crypto.randomUUID()
    activeId.current = id
    cancelInFlight.current = false
    setOperationId(id)
    setProgress({ phase: 'preparing', completedFiles: 0, totalFiles })
    setCancelPending(false)
    setCancelError(false)
    setProgressUnavailable(false)
    return id
  }, [])

  const end = useCallback((): void => {
    activeId.current = undefined
    setOperationId(undefined)
    setProgress(undefined)
    setCancelPending(false)
    setCancelError(false)
    setProgressUnavailable(false)
  }, [])

  useEffect(() => {
    if (!operationId || !window.api.getArtifactSaveProgress) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await window.api.getArtifactSaveProgress({ operationId })
        if (disposed || activeId.current !== operationId) return
        if (next) setProgress(next)
        setProgressUnavailable(false)
      } catch {
        if (!disposed && activeId.current === operationId) setProgressUnavailable(true)
      } finally {
        if (!disposed && activeId.current === operationId)
          timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [operationId])

  const cancel = useCallback(async (): Promise<void> => {
    const id = activeId.current
    if (!id || cancelInFlight.current) return
    cancelInFlight.current = true
    setCancelPending(true)
    setCancelError(false)
    try {
      await window.api.cancelArtifactSave({ operationId: id })
      // Acknowledgement is not completion; keep the dialog until the save promise settles.
      if (activeId.current === id) {
        setProgress((current) => current && { ...current, phase: 'cancelling' })
      }
    } catch {
      if (activeId.current === id) {
        cancelInFlight.current = false
        setCancelPending(false)
        setCancelError(true)
      }
    }
  }, [])

  return { begin, end, cancel, progress, cancelPending, cancelError, progressUnavailable }
}
