import { useCallback, useRef, useState } from 'react'

type FileDropZoneProps = {
  onDragEnter: (event: React.DragEvent<HTMLElement>) => void
  onDragOver: (event: React.DragEvent<HTMLElement>) => void
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void
  onDrop: (event: React.DragEvent<HTMLElement>) => void
}

type UseFileDropZoneOptions = {
  enabled: boolean
  onFiles: (files: File[]) => void
}

type UseFileDropZoneResult = {
  isDragging: boolean
  dropZoneProps: FileDropZoneProps
}

// Only file drags should activate the composer overlay; text or element drags are ignored.
const isFileDrag = (event: React.DragEvent<HTMLElement>): boolean =>
  Array.from(event.dataTransfer.types).includes('Files')

// Adds drag-and-drop file intake to a container while ignoring non-file drags and flicker.
const useFileDropZone = ({ enabled, onFiles }: UseFileDropZoneOptions): UseFileDropZoneResult => {
  const [isDragging, setIsDragging] = useState(false)
  // Counter offsets dragenter/dragleave pairs from child elements so the overlay never flickers.
  const dragDepthRef = useRef(0)

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (!enabled || !isFileDrag(event)) return

      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      dragDepthRef.current += 1
      setIsDragging(true)
    },
    [enabled]
  )

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (!enabled || !isFileDrag(event)) return

      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setIsDragging(true)
    },
    [enabled]
  )

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (!enabled || !isFileDrag(event)) return

      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) {
        setIsDragging(false)
      }
    },
    [enabled]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      if (!enabled || !isFileDrag(event)) return

      event.preventDefault()
      dragDepthRef.current = 0
      setIsDragging(false)

      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) {
        onFiles(files)
      }
    },
    [enabled, onFiles]
  )

  return {
    isDragging: enabled && isDragging,
    dropZoneProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop
    }
  }
}

export { useFileDropZone }
