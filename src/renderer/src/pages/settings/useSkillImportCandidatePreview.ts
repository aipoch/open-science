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
  openPreview: (load: () => Promise<SkillImportPreviewContent>) => void
  invalidatePreview: () => void
  previewProps: SkillImportCandidatePreviewState
}

const previewErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

// Owns the async candidate lifecycle for all source adapters. A close or a newer row click
// invalidates an in-flight result, so late IPC/network responses cannot reopen or replace the dialog.
const useSkillImportCandidatePreview = (): SkillImportCandidatePreviewController => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState<SkillImportPreviewContent | null>(null)
  const generation = useRef(0)

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
      else invalidatePreview()
    },
    [invalidatePreview]
  )

  const openPreview = useCallback((load: () => Promise<SkillImportPreviewContent>): void => {
    const request = generation.current + 1
    generation.current = request
    setOpen(true)
    setLoading(true)
    setError(null)
    setContent(null)

    void Promise.resolve()
      .then(load)
      .then((result) => {
        if (generation.current === request) setContent(result)
      })
      .catch((reason) => {
        if (generation.current === request) setError(previewErrorMessage(reason))
      })
      .finally(() => {
        if (generation.current === request) setLoading(false)
      })
  }, [])

  return {
    openPreview,
    invalidatePreview,
    previewProps: { open, onOpenChange, loading, error, content }
  }
}

export { useSkillImportCandidatePreview }
