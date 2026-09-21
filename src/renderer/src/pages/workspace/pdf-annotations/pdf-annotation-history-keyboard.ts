import type { KeyboardEvent } from 'react'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'
import type { PdfAnnotationPort } from './pdf-annotations-context'

export const handlePdfAnnotationHistoryKey = (
  event: KeyboardEvent,
  annotations: PdfAnnotationPort,
  source: PdfAnnotationSource,
  onError: () => void
): boolean => {
  if (
    event.defaultPrevented ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.nativeEvent.isComposing
  )
    return false
  if (
    event.target instanceof Element &&
    event.target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
    )
  )
    return false
  const key = event.key.toLowerCase()
  const direction =
    key === 'z'
      ? event.shiftKey
        ? 'redo'
        : 'undo'
      : key === 'y' && !event.shiftKey
        ? 'redo'
        : undefined
  if (!direction || !annotations.available) return false
  const history = annotations.history(source)
  if (!history[direction === 'undo' ? 'canUndo' : 'canRedo']) return false
  event.preventDefault()
  event.stopPropagation()
  if (!history.busy && !event.repeat) void annotations[direction](source).catch(onError)
  return true
}
