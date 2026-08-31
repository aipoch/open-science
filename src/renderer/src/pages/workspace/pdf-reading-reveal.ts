import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { SessionPdfBinding } from '../../../../shared/session-persistence'

import { createPreviewFileItemFromPdfContext } from './preview-file-item'

type PdfReadingRevealTarget = Readonly<{
  projectId: string
  path: string
  pageNumber: number
}>

const REVEAL_EVENT = 'pdf-reading-reveal'
let pendingReveal: PdfReadingRevealTarget | undefined

const requestPdfReadingReveal = (
  projectId: string,
  binding: SessionPdfBinding,
  pageNumber: number
): void => {
  const item = createPreviewFileItemFromPdfContext(binding, projectId)
  pendingReveal = { projectId, path: item.path, pageNumber }
  usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
  document.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: pendingReveal }))
}

const subscribePdfReadingReveal = (
  listener: (target: PdfReadingRevealTarget) => boolean | void
): (() => void) => {
  const deliver = (target: PdfReadingRevealTarget): void => {
    if (listener(target) && pendingReveal === target) pendingReveal = undefined
  }
  const handler = (event: Event): void =>
    deliver((event as CustomEvent<PdfReadingRevealTarget>).detail)
  document.addEventListener(REVEAL_EVENT, handler)
  if (pendingReveal) deliver(pendingReveal)
  return () => document.removeEventListener(REVEAL_EVENT, handler)
}

export { requestPdfReadingReveal, subscribePdfReadingReveal }
