import { useCallback, useRef, useState } from 'react'

import type { SkillImportPreviewContent } from '../../../../shared/settings'

type SkillImportCandidatePreviewState = {
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  error: string | null
  content: SkillImportPreviewContent | null
}

type SkillImportCandidatePreviewController = {
  openPreview: (load: () => SkillImportPreviewContent | Promise<SkillImportPreviewContent>) => void
  invalidatePreview: () => void
  previewProps: SkillImportCandidatePreviewState
}

const previewErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

const isPromiseLike = (
  value: SkillImportPreviewContent | Promise<SkillImportPreviewContent>
): value is Promise<SkillImportPreviewContent> =>
  typeof (value as Promise<SkillImportPreviewContent>).then === 'function'

// Owns the async candidate lifecycle for all source adapters. A close or a newer row click
// invalidates an in-flight result, so late IPC/network responses cannot reopen or replace the dialog.
const useSkillImportCandidatePreview = (): SkillImportCandidatePreviewController => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState<SkillImportPreviewContent | null>(null)
  const generation = useRef(0)

  // Radix keeps the dialog mounted for its exit animation. Preserve the visible state until that
  // finishes so the panel cannot flash to an empty shell while closing.
  const closePreview = useCallback((): void => {
    generation.current += 1
    setOpen(false)
  }, [])

  const invalidatePreview = useCallback((): void => {
    generation.current += 1
    setOpen(false)
    setLoading(false)
    setError(null)
    setContent(null)
  }, [])

  const onOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (nextOpen) setOpen(true)
      else closePreview()
    },
    [closePreview]
  )

  const openPreview = useCallback(
    (load: () => SkillImportPreviewContent | Promise<SkillImportPreviewContent>): void => {
      const request = generation.current + 1
      generation.current = request
      setError(null)

      try {
        const result = load()
        // Upload candidates already carry their preview body. Render those synchronously instead of
        // briefly painting a loading state before an immediately-resolved promise settles.
        if (!isPromiseLike(result)) {
          setContent(result)
          setLoading(false)
          setOpen(true)
          return
        }

        setContent(null)
        setLoading(true)
        setOpen(true)
        void Promise.resolve(result)
          .then((nextContent) => {
            if (generation.current === request) setContent(nextContent)
          })
          .catch((reason) => {
            if (generation.current === request) setError(previewErrorMessage(reason))
          })
          .finally(() => {
            if (generation.current === request) setLoading(false)
          })
      } catch (reason) {
        setContent(null)
        setLoading(false)
        setError(previewErrorMessage(reason))
        setOpen(true)
      }
    },
    []
  )

  return {
    openPreview,
    invalidatePreview,
    previewProps: { open, onOpenChange, loading, error, content }
  }
}

export { useSkillImportCandidatePreview }
