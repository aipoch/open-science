import type {
  ArtifactPreviewResult,
  ReadArtifactPreviewRequest
} from '../../../../../shared/artifacts'
import type { AcquireManagedPreviewRequest } from '../../../../../shared/preview-resources'

type PreviewSource = AcquireManagedPreviewRequest['source']

type ManagedPreviewTestTransportOptions = {
  read: (
    source: PreviewSource,
    request: ReadArtifactPreviewRequest
  ) => Promise<ArtifactPreviewResult>
  encoding?: 'utf8' | 'base64'
}

const decodeBase64 = (content: string): ArrayBuffer => {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

// Adapts the existing content fixtures in renderer tests to the managed streaming boundary.
// Production code does not import this file.
export const createManagedPreviewTestTransport = ({
  read,
  encoding = 'utf8'
}: ManagedPreviewTestTransportOptions): {
  acquire: Window['api']['previewResources']['acquire']
  release: Window['api']['previewResources']['release']
  fetch: typeof fetch
} => {
  let nextResourceId = 1
  const requests = new Map<string, AcquireManagedPreviewRequest>()

  return {
    acquire: async (request) => {
      const id = `resource-${nextResourceId++}`
      const sourcePath =
        request.source === 'artifact' || request.source === 'upload' ? request.fileId : request.path
      const filename = sourcePath.split('/').at(-1) ?? 'preview'
      const url = `open-science-preview://${id}/${filename}`
      requests.set(url, request)
      return {
        id,
        url,
        // The response Content-Range supplies the fixture's real size. This only keeps the
        // renderer's bounded Range request open until that response arrives.
        size: 64 * 1024 * 1024,
        mimeType: 'application/octet-stream',
        version: 1
      }
    },
    release: async ({ resourceId }) => {
      for (const [url] of requests) {
        if (url.includes(`://${resourceId}/`)) requests.delete(url)
      }
    },
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const acquired = requests.get(url)
      if (!acquired) throw new Error(`Unknown managed preview URL: ${url}`)

      const rangeHeader = new Headers(init?.headers).get('range')
      const range = rangeHeader?.match(/^bytes=(\d+)-(\d+)$/u)
      if (!range) throw new Error('Managed preview test request is missing a byte Range.')

      const offset = Number(range[1])
      const requestedBytes = Number(range[2]) - offset + 1
      const result = await read(acquired.source, {
        path:
          acquired.source === 'artifact' || acquired.source === 'upload'
            ? acquired.fileId
            : acquired.path,
        ...(acquired.projectId ? { projectId: acquired.projectId } : {}),
        ...('sessionId' in acquired && acquired.sessionId ? { sessionId: acquired.sessionId } : {}),
        maxBytes: Math.max(1, requestedBytes - (encoding === 'utf8' ? 3 : 0)),
        encoding,
        offset
      })
      const body: BodyInit =
        result.encoding === 'base64' ? decodeBase64(result.content) : result.content
      const bytesRead =
        result.encoding === 'base64'
          ? (body as ArrayBuffer).byteLength
          : new Blob([result.content]).size
      const responseEnd = offset + Math.max(0, bytesRead - 1)
      const responseSize = result.truncated
        ? Math.max(result.size, offset + bytesRead + 1)
        : offset + bytesRead

      return new Response(body, {
        status: 206,
        headers: { 'Content-Range': `bytes ${offset}-${responseEnd}/${responseSize}` }
      })
    }
  }
}
