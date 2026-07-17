export type ManagedPreviewSource = 'artifact' | 'upload'

export const MANAGED_PREVIEW_LOAD_ERROR = 'open-science-preview-load-error'

export type AcquireManagedPreviewRequest = {
  source: ManagedPreviewSource
  path: string
  mimeType?: string
}

export type ManagedPreviewResource = {
  id: string
  url: string
  size: number
  mimeType: string
  version: number
}

export type ReadManagedPreviewRangeRequest = {
  resourceId: string
  begin: number
  end: number
}

export type ManagedPreviewRangeResult = {
  begin: number
  end: number
  total: number
  data: Uint8Array
}

export type ReleaseManagedPreviewRequest = {
  resourceId: string
}
