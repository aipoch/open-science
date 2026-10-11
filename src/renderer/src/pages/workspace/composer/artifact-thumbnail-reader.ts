import { createKeyedRequestReader, type KeyedRequestReader } from '../project-file-preview-queue'
import type { ArtifactPreviewResult } from '../../../../../shared/artifacts'

type ThumbnailRequest = { path: string; source: 'upload' | 'artifact' | 'literature' }
export type ArtifactThumbnailReader = KeyedRequestReader<
  ThumbnailRequest,
  ArtifactPreviewResult | undefined
>
export const thumbnailRequestKey = ({ source, path }: ThumbnailRequest): string =>
  `${source}:${path}`

// One reader belongs to the popup, so all rows share the same bounded queue.
export const createArtifactThumbnailReader = (): ArtifactThumbnailReader =>
  createKeyedRequestReader(
    async ({ source, path }) => {
      const read =
        source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview
      return read({ path, maxBytes: THUMBNAIL_MAX_BYTES, encoding: 'base64' })
    },
    thumbnailRequestKey,
    4,
    { getGenerationKey: () => '', createCanceledResult: () => undefined }
  )

// Keep the per-row thumbnail read tiny; the popup only needs a small preview image.
const THUMBNAIL_MAX_BYTES = 256 * 1024
