import type { ChatSession } from '@/stores/session-store'

import { getFileExtension } from './preview-support'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
type ArtifactPreviewCache = Record<string, unknown | undefined>

export const ARTIFACT_PREVIEW_BYTES = 32768
export const ARTIFACT_IMAGE_PREVIEW_BYTES = 1024 * 1024

export const getArtifactName = (artifact: MessageArtifact): string => artifact.name ?? artifact.path

export const getArtifactExtension = (artifact: MessageArtifact): string =>
  getFileExtension(getArtifactName(artifact)) || 'file'

export const isImageArtifact = (artifact: MessageArtifact): boolean => {
  if (artifact.mimeType?.startsWith('image/')) return true

  return /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(getArtifactName(artifact))
}

export const shouldReadArtifactPreview = (artifact: MessageArtifact): boolean => {
  const extension = getArtifactExtension(artifact)
  const mimeType = artifact.mimeType ?? ''

  return (
    isImageArtifact(artifact) ||
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    [
      'bash',
      'conf',
      'config',
      'css',
      'csv',
      'fa',
      'faa',
      'fasta',
      'fna',
      'html',
      'ini',
      'iqtree',
      'js',
      'json',
      'log',
      'md',
      'nwk',
      'pdb',
      'py',
      'sh',
      'state',
      'toml',
      'tree',
      'treefile',
      'ts',
      'tsx',
      'tsv',
      'txt',
      'xml',
      'yaml',
      'yml'
    ].includes(extension)
  )
}

export const getArtifactPreviewCacheKey = (artifacts: MessageArtifact[]): string =>
  artifacts
    .map((artifact) => `${artifact.id}:${artifact.path}:${artifact.size}:${artifact.mtimeMs}`)
    .join('|')

export const getArtifactsForPreviewRead = ({
  artifacts,
  cachedPreviews,
  visibleCount
}: {
  artifacts: MessageArtifact[]
  cachedPreviews: ArtifactPreviewCache
  visibleCount: number
}): MessageArtifact[] =>
  artifacts
    .slice(0, visibleCount)
    .filter(shouldReadArtifactPreview)
    .filter((artifact) => !Object.prototype.hasOwnProperty.call(cachedPreviews, artifact.id))
    .filter(
      (artifact) =>
        !isImageArtifact(artifact) ||
        (typeof artifact.size === 'number' && artifact.size <= ARTIFACT_IMAGE_PREVIEW_BYTES)
    )
