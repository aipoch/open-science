import { EMPTY_PDF_ANNOTATIONS } from './pdf-annotation-index'
import { createContext, useContext } from 'react'
import type {
  PdfAnnotation,
  PdfAnnotationTarget,
  PdfAnnotationSource
} from '../../../../../shared/pdf-annotations'

type PdfAnnotationPort = Readonly<{
  sessionId?: string
  source?: PdfAnnotationSource
  scoped: boolean
  available: boolean
  annotations: readonly PdfAnnotation[]
  forSource: (source: PdfAnnotationSource | undefined) => readonly PdfAnnotation[]
  forPage: (source: PdfAnnotationSource | undefined, page: number) => readonly PdfAnnotation[]
  total: number
  loading: boolean
  loadError?: string
  history: (source: PdfAnnotationSource) => { canUndo: boolean; canRedo: boolean; busy: boolean }
  undo: (source: PdfAnnotationSource) => Promise<void>
  redo: (source: PdfAnnotationSource) => Promise<void>
  retryLoad: () => void
  create: (
    id: string,
    target: PdfAnnotationTarget,
    kind: PdfAnnotation['kind'],
    color: PdfAnnotation['color'],
    tagIds: readonly string[],
    note: string
  ) => Promise<PdfAnnotation>
  update: (
    id: string,
    input: { note?: string; color?: PdfAnnotation['color'] | null; tagIds?: readonly string[] }
  ) => Promise<PdfAnnotation>
  remove: (id: string) => Promise<boolean>
}>
const unavailableError = (): Error => new Error('PDF annotations require an available source.')
const unavailablePort: PdfAnnotationPort = {
  scoped: false,
  available: false,
  annotations: EMPTY_PDF_ANNOTATIONS,
  forSource: () => EMPTY_PDF_ANNOTATIONS,
  forPage: () => EMPTY_PDF_ANNOTATIONS,
  total: 0,
  loading: false,
  history: () => ({ canUndo: false, canRedo: false, busy: false }),
  undo: () => Promise.reject(unavailableError()),
  redo: () => Promise.reject(unavailableError()),
  retryLoad: () => {},
  create: () => Promise.reject(unavailableError()),
  update: () => Promise.reject(unavailableError()),
  remove: () => Promise.reject(unavailableError())
}
const PdfAnnotationsContext = createContext<PdfAnnotationPort>(unavailablePort)
const usePdfAnnotations = (): PdfAnnotationPort => useContext(PdfAnnotationsContext)
export { PdfAnnotationsContext, usePdfAnnotations, unavailableError }
export type { PdfAnnotationPort }
