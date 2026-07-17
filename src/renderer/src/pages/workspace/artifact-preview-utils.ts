import type { ChatSession } from '@/stores/session-store'
import type { PreviewFileFormat } from '@/stores/preview-workbench-store'

import {
  getFileExtension,
  getPreviewFormatForFile,
  getPreviewThumbnailReadEncoding
} from './preview-support'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
export const ARTIFACT_PREVIEW_BYTES = 32768

export const getArtifactName = (artifact: MessageArtifact): string => artifact.name ?? artifact.path

export const getArtifactExtension = (artifact: MessageArtifact): string =>
  getFileExtension(getArtifactName(artifact)) || 'file'

// Adapts artifact metadata to the same source-neutral capability resolver used for uploads.
export const getArtifactPreviewFormat = (artifact: MessageArtifact): PreviewFileFormat =>
  getPreviewFormatForFile({ name: getArtifactName(artifact), mimeType: artifact.mimeType })

// Keeps image-specific size limits aligned with the central format decision.
export const isImageArtifact = (artifact: MessageArtifact): boolean =>
  getArtifactPreviewFormat(artifact) === 'image'

// Derives thumbnail eligibility from the shared encoding policy instead of a second allowlist.
export const shouldReadArtifactPreview = (artifact: MessageArtifact): boolean =>
  getPreviewThumbnailReadEncoding(getArtifactPreviewFormat(artifact)) !== undefined
