import { useLayoutEffect, useRef, type DragEvent } from 'react'
import type { ProjectFileItem } from '../../../../shared/project-files'
import {
  FILE_MENTION_DRAG_TYPE,
  projectFileMentionTransfers
} from './project-file-mention-transfer'

export function useProjectFileMentionDrag(
  file: ProjectFileItem,
  options?: { disabled?: boolean }
): {
  draggable: boolean
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
} {
  const disabled = Boolean(options?.disabled)
  const current = useRef({ file, disabled })
  useLayoutEffect(() => {
    current.current = { file, disabled }
  })
  const id = `${file.projectId}:${file.source}:${file.sourceFileId}`
  useLayoutEffect(
    () =>
      projectFileMentionTransfers.register(id, {
        read: () => {
          const { file, disabled } = current.current
          return disabled ? undefined : { projectId: file.projectId, file }
        }
      }),
    [id]
  )
  return {
    draggable: !disabled,
    onDragStart: (event) => {
      const token = projectFileMentionTransfers.begin(id)
      if (!token) {
        event.preventDefault()
        return
      }
      event.dataTransfer.setData(FILE_MENTION_DRAG_TYPE, token)
      event.dataTransfer.effectAllowed = 'copy'
    },
    onDragEnd: () => projectFileMentionTransfers.cancel()
  }
}
