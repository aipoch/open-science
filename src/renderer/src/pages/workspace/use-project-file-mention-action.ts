import { useCallback, useRef, useState } from 'react'
import { mentionProjectFile, type ProjectFileMentionTarget } from './project-file-mention'
import { useProjectFileMentionAvailability } from './use-project-file-mention-availability'

// Shared action state for every mention entry point (card overlay, drag drop, open artifact
// header): resolves availability from the composer owner, tracks the in-flight inspection, and
// keeps repeated clicks from stacking requests. Returns whether the mention was accepted so
// surfaces that navigate away (the open header) can close only on success.
export const useProjectFileMentionAction = (
  file: ProjectFileMentionTarget | undefined
): {
  available: boolean
  pending: boolean
  error: boolean
  dismissError: () => void
  mention: () => Promise<boolean>
} => {
  const availableInComposer = useProjectFileMentionAvailability(file?.projectId ?? '')
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState(false)
  const available = Boolean(file) && availableInComposer
  const mention = useCallback(async (): Promise<boolean> => {
    if (!file || inFlight.current || !availableInComposer) return false
    inFlight.current = true
    setPending(true)
    setError(false)
    try {
      const accepted = (await mentionProjectFile(file)) === 'mentioned'
      setError(!accepted)
      return accepted
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [availableInComposer, file])
  return { available, pending, error, dismissError: () => setError(false), mention }
}
