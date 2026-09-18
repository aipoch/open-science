import { createContext, useContext, useLayoutEffect, useRef, type DragEvent } from 'react'
import type { Annotation } from '../../../../../shared/annotations'
import { annotationTransfers, ANNOTATION_DRAG_TYPE } from './annotation-transfer'
export type SourceContext = {
  sourceId: string
  projectId: string
  parentSessionId: string
  annotations: readonly Annotation[]
  disabled: boolean
  onRemove: (id: string) => void
  select?: (token: string) => void
}
export const TransferSourceContext = createContext<SourceContext | undefined>(undefined)
export function useAnnotationDrag(annotation: Annotation): {
  draggable: boolean
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
} {
  const source = useContext(TransferSourceContext)
  const current = useRef({ source, annotation })
  useLayoutEffect(() => {
    current.current = { source, annotation }
  })
  const id = source ? `${source.sourceId}:${annotation.id}` : undefined
  useLayoutEffect(() => {
    if (!id) return
    return annotationTransfers.register(id, {
      read: () => {
        const { source, annotation } = current.current
        if (
          !source ||
          source.disabled ||
          !source.annotations.some((item) => item.id === annotation.id)
        )
          return undefined
        return {
          originId: source.sourceId,
          projectId: source.projectId,
          parentSessionId: source.parentSessionId,
          annotation
        }
      },
      remove: () => current.current.source?.onRemove(current.current.annotation.id)
    })
  }, [id])
  return {
    draggable: Boolean(source && !source.disabled),
    onDragStart: (event) => {
      const token = id ? annotationTransfers.begin(id) : undefined
      if (!token) {
        event.preventDefault()
        return
      }
      event.dataTransfer.setData(ANNOTATION_DRAG_TYPE, token)
      event.dataTransfer.effectAllowed = 'move'
    },
    onDragEnd: () => annotationTransfers.cancel()
  }
}
