import { useState, type DragEventHandler } from 'react'
import {
  FILE_MENTION_DRAG_TYPE,
  projectFileMentionTransfers,
  type ProjectFileMentionTransfer
} from './project-file-mention-transfer'

export function useProjectFileMentionDrop({
  disabled,
  receive
}: {
  disabled?: boolean
  receive: (transfer: ProjectFileMentionTransfer) => boolean | Promise<boolean>
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
  const matches = (): boolean => !disabled && projectFileMentionTransfers.read() !== undefined
  return {
    over,
    error,
    props: {
      onDragOverCapture: (event) => {
        if (disabled) return
        if (!event.dataTransfer.types.includes(FILE_MENTION_DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        const matched = matches()
        event.dataTransfer.dropEffect = matched ? 'copy' : 'none'
        setOver(matched)
        if (matched) setError(false)
      },
      onDragLeaveCapture: (event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOver(false)
      },
      onDropCapture: (event) => {
        if (disabled) return
        if (!event.dataTransfer.types.includes(FILE_MENTION_DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        const transfer = matches()
          ? projectFileMentionTransfers.read(event.dataTransfer.getData(FILE_MENTION_DRAG_TYPE))
          : undefined
        projectFileMentionTransfers.cancel()
        if (!transfer) {
          setError(true)
          return
        }
        void Promise.resolve(receive(transfer)).then(
          (accepted) => setError(!accepted),
          () => setError(true)
        )
      }
    }
  }
}
