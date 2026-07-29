import type { ManagedPreviewSource } from '../../../../../shared/preview-resources'

type PreviewResourceIdentity = {
  projectId?: string
  sessionId?: string
  source?: ManagedPreviewSource
  path: string
  mimeType?: string
  size?: number
  mtimeMs?: number
}

// Keeps managed-resource invalidation identical across panels, images, PDFs, and thumbnails.
const createPreviewResourceKey = (identity: PreviewResourceIdentity): string =>
  JSON.stringify([
    identity.projectId ?? null,
    identity.sessionId ?? null,
    identity.source ?? 'artifact',
    identity.path,
    identity.mimeType ?? null,
    identity.size ?? null,
    identity.mtimeMs ?? null
  ])

export { createPreviewResourceKey }
export type { PreviewResourceIdentity }
