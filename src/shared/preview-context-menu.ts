export const PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL = 'preview-context-menu:requested'

export type PreviewContextMenuRequest = Readonly<{
  x: number
  y: number
  frameUrl: string
}>

const ALLOWED_FRAME_PROTOCOLS = new Set(['open-science-preview:', 'open-science-office-preview:'])

export const isAllowedPreviewContextMenuFrameUrl = (value: string): boolean => {
  try {
    return ALLOWED_FRAME_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

export const isPreviewContextMenuRequest = (value: unknown): value is PreviewContextMenuRequest => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PreviewContextMenuRequest>
  return (
    typeof candidate.x === 'number' &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === 'number' &&
    Number.isFinite(candidate.y) &&
    typeof candidate.frameUrl === 'string' &&
    isAllowedPreviewContextMenuFrameUrl(candidate.frameUrl)
  )
}
