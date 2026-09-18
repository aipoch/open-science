import { useState, type DragEventHandler } from 'react'
import {
  annotationTransfers,
  ANNOTATION_DRAG_TYPE,
  type AnnotationTransfer
} from './annotation-transfer'

export function useAnnotationDrop({
  targetId,
  projectId,
  parentSessionId,
  disabled,
  receive
}: {
  targetId: string
  projectId: string
  parentSessionId: string
  disabled?: boolean
  receive: (transfer: AnnotationTransfer) => boolean
}): {
  over: boolean
  error: boolean
  props: {
    onDragOverCapture: DragEventHandler
    onDragLeaveCapture: DragEventHandler
    onDropCapture: DragEventHandler
  }
} {
  const [over, setOver] = useState(false)
  const [error, setError] = useState(false)
  const matches = (): boolean => {
    const transfer = annotationTransfers.read()
    return Boolean(
      !disabled &&
      transfer &&
      transfer.originId !== targetId &&
      transfer.projectId === projectId &&
      transfer.parentSessionId === parentSessionId
    )
  }
  return {
    over,
    error,
    props: {
      onDragOverCapture: (event) => {
        if (!event.dataTransfer.types.includes(ANNOTATION_DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = matches() ? 'move' : 'none'
        setOver(matches())
      },
      onDragLeaveCapture: (event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOver(false)
      },
      onDropCapture: (event) => {
        if (!event.dataTransfer.types.includes(ANNOTATION_DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        const accepted =
          matches() &&
          annotationTransfers.commit(event.dataTransfer.getData(ANNOTATION_DRAG_TYPE), receive)
        setError(!accepted)
      }
    }
  }
}
