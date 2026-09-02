// 'local' streams a file from an arbitrary absolute filesystem path (the "This computer" browser).
// Unlike artifact/upload it is not confined to a storage root; the resolver validates + realpaths it.
export type ManagedPreviewSource = 'artifact' | 'upload' | 'notebook-input' | 'local'

export const MANAGED_PREVIEW_LOAD_ERROR = 'open-science-preview-load-error'

type ManagedPreviewPresentation = {
  mimeType?: string
  maxBytes?: number
}

type AcquireManagedVersionPreviewRequest = ManagedPreviewPresentation & {
  projectId: string
  fileId: string
  versionId?: string
} & ({ source: 'artifact' } | { source: 'upload' })

type AcquirePathPreviewRequest = ManagedPreviewPresentation & {
  path: string
  projectId?: string
  sessionId?: string
} & ({ source: 'notebook-input' } | { source: 'local' })

export type AcquireManagedPreviewRequest =
  AcquireManagedVersionPreviewRequest | AcquirePathPreviewRequest

export type ManagedPreviewResource = {
  id: string
  url: string
  size: number
  mimeType: string
  version: number
  // Pixel dimensions for image resources, probed from the file header at acquire time.
  // Absent for non-images and for images whose header could not be parsed.
  width?: number
  height?: number
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
