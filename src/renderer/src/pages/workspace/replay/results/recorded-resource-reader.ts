import type { ReplayResource } from '../../../../../../shared/replay'
import { createArtifactVersionLocator } from '../../../../../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../../../../../shared/uploads'

export type RecordedResourceContent = {
  /** Images use base64; text (including saved HTML) uses UTF-8. Never a service URL. */
  content: string
  mimeType: string
  truncated: boolean
}
export type RecordedResourceReader = (
  resource: ReplayResource,
  signal?: AbortSignal
) => Promise<RecordedResourceContent>
const EXTENSION_MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/** Presentation eligibility only. The storage owner still authorizes this exact immutable Version. */
export function fixedReplayResource(resource: ReplayResource): ReplayResource | undefined {
  const fileId = resource.source === 'upload' ? resource.fileId : resource.artifactId
  if (
    resource.availability !== 'recorded' ||
    !fileId ||
    !resource.versionId ||
    !resource.projectId ||
    !resource.sessionId
  )
    return undefined
  const locator =
    resource.source === 'upload'
      ? createUploadVersionReference(resource.versionId, {
          projectId: resource.projectId,
          sessionId: resource.sessionId,
          fileId
        })
      : createArtifactVersionLocator({
          projectId: resource.projectId,
          appSessionId: resource.sessionId,
          artifactId: fileId,
          versionId: resource.versionId
        })
  // A conflicting locator must not be silently repaired into a different evidence reference.
  if (resource.locator && resource.locator !== locator) return undefined
  return { ...resource, locator }
}

/** Desktop adapter for static previews. No latest-version lookup, path fallback, or execution. */
export const readRecordedResource: RecordedResourceReader = async (requested, signal) => {
  signal?.throwIfAborted()
  const resource = fixedReplayResource(requested)
  if (!resource) throw new Error('Recorded resource unavailable.')
  const mimeType =
    resource.mimeType ??
    EXTENSION_MIME[resource.name.split('.').at(-1)?.toLowerCase() ?? ''] ??
    'application/octet-stream'
  const image = mimeType.startsWith('image/')
  const maxBytes = image ? 16 * 1024 * 1024 : 192 * 1024
  if (image && resource.size !== undefined && resource.size > maxBytes)
    throw new Error('Recorded resource unavailable.')
  const read =
    resource.source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview
  const result = await read({
    path: resource.locator!,
    projectId: resource.projectId,
    sessionId: resource.sessionId,
    fileId: resource.source === 'upload' ? resource.fileId : resource.artifactId,
    versionId: resource.versionId,
    maxBytes,
    encoding: image ? 'base64' : 'utf8'
  })
  signal?.throwIfAborted()
  if (result.encoding !== (image ? 'base64' : 'utf8') || (image && result.truncated))
    throw new Error('Recorded resource unavailable.')
  return { content: result.content, mimeType, truncated: result.truncated }
}
