import { useEffect, useMemo, useState } from 'react'
import type { LocalModelSnapshot } from '../../../../../../shared/local-models'
import { createPdfTranslationAgentExecutor } from './pdf-translation-agent'
import type { PdfTranslationExecutor } from './use-pdf-translation-job'

export function usePdfTranslationAgent(): PdfTranslationExecutor | undefined {
  const runtime = typeof window === 'undefined' ? undefined : window.api?.pdfTranslation
  return useMemo(
    () => (runtime ? createPdfTranslationAgentExecutor(runtime) : undefined),
    [runtime]
  )
}

type LocalTranslationModelState = Readonly<{
  snapshot?: LocalModelSnapshot
  requestFailed: boolean
  pending: boolean
  run: (action: 'install' | 'cancel' | 'remove') => Promise<void>
}>

export function useLocalPdfTranslationModel(enabled: boolean): LocalTranslationModelState {
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot>()
  const [requestFailed, setRequestFailed] = useState(false)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      let installing = false
      try {
        const next = await window.api.localModels.getSnapshot('pdf-translation')
        installing = next.availability === 'installing'
        if (live) {
          setSnapshot(next)
          setRequestFailed(false)
        }
      } catch {
        if (live) setRequestFailed(true)
      }
      if (live) timer = setTimeout(() => void poll(), installing ? 750 : 2500)
    }
    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [enabled])
  const run = async (action: 'install' | 'cancel' | 'remove'): Promise<void> => {
    setPending(true)
    setRequestFailed(false)
    try {
      setSnapshot(await window.api.localModels[action]('pdf-translation'))
    } catch {
      setRequestFailed(true)
    } finally {
      setPending(false)
    }
  }
  return { snapshot, requestFailed, pending, run }
}
