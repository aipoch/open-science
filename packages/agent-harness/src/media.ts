import type { AgentModel, ContentBlock } from './session-types'

export type InputCapabilities = Partial<
  Pick<AgentModel['capabilities'], 'images' | 'files' | 'audio' | 'video'>
>
type MediaBlock = Exclude<ContentBlock, { type: 'text' }>
type Protocol = 'chat' | 'messages' | 'responses'

/** Transport bytes, not a provider's expanded media-token or duration budget. */
export function requestBody(value: unknown, maxBytes: number): string {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > maxBytes) throw new Error('Model request exceeds byte limit')
  return body
}
const invalid = (): never => {
  throw new Error('Unsupported or invalid native media input')
}
const images = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const files: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.text': 'odt'
}
const videos = [
  'video/mp4',
  'video/avi',
  'video/x-msvideo',
  'video/quicktime',
  'video/mov',
  'video/x-matroska'
]

/** Protocol support is an upper bound; the host narrows it for the selected model/account. */
export function mediaCapabilities(
  protocol: Protocol,
  input: InputCapabilities = {}
): AgentModel['capabilities'] {
  if (protocol !== 'chat' && input.audio) invalid()
  for (const value of Object.values(input)) if (typeof value !== 'boolean') invalid()
  return Object.freeze({
    tools: true,
    images: input.images ?? true,
    files: input.files ?? true,
    audio: protocol === 'chat' && (input.audio ?? true),
    video: input.video ?? false
  })
}

/** No fetching or uploading: only host-authorized inline data, URLs or identity-bound file IDs. */
export function nativeMedia(
  block: MediaBlock,
  protocol: Protocol,
  adapterId: string,
  capabilities: AgentModel['capabilities']
): Record<string, unknown> {
  const capability = { image: 'images', file: 'files', audio: 'audio', video: 'video' } as const
  if (!capabilities[capability[block.type]]) invalid()
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(block.mimeType)) invalid()
  if (block.type === 'image' && !images.includes(block.mimeType)) invalid()
  if (block.type === 'video' && !videos.includes(block.mimeType)) invalid()
  if (block.type === 'audio' && !['audio/wav', 'audio/mpeg', 'audio/mp3'].includes(block.mimeType))
    invalid()
  if (
    block.type === 'file' &&
    (protocol !== 'responses'
      ? block.mimeType !== 'application/pdf'
      : !Object.hasOwn(files, block.mimeType))
  )
    invalid()
  if (
    block.filename !== undefined &&
    (typeof block.filename !== 'string' ||
      !block.filename.trim() ||
      block.filename.length > 255 ||
      /[\r\n/\\]/.test(block.filename) ||
      block.filename.includes('\0'))
  )
    invalid()
  const src = block.source
  if (src && typeof src === 'object' && !Array.isArray(src) && 'fileId' in src) {
    if (
      block.type !== 'file' ||
      src.adapterId !== adapterId ||
      typeof src.fileId !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(src.fileId) ||
      Object.keys(src).some((k) => !['fileId', 'adapterId'].includes(k))
    )
      invalid()
    return protocol === 'chat'
      ? { type: 'file', file: { file_id: src.fileId } }
      : protocol === 'responses'
        ? { type: 'input_file', file_id: src.fileId }
        : { type: 'document', source: { type: 'file', file_id: src.fileId } }
  }
  const source =
    typeof src === 'string'
      ? src
      : src &&
          typeof src === 'object' &&
          !Array.isArray(src) &&
          Object.keys(src).every((k) => k === 'url')
        ? src.url
        : undefined
  if (typeof source !== 'string' || !source) return invalid()
  let data: string | undefined
  if (source.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source)
    if (!match || match[1] !== block.mimeType || match[2].length % 4 !== 0) return invalid()
    data = match[2]
  } else {
    let url: URL
    try {
      url = new URL(source)
    } catch {
      return invalid()
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid()
  }
  if (block.type === 'audio') {
    if (!data || protocol !== 'chat') return invalid()
    return {
      type: 'input_audio',
      input_audio: { data, format: block.mimeType === 'audio/wav' ? 'wav' : 'mp3' }
    }
  }
  if (block.type === 'file') {
    if (protocol === 'messages')
      return {
        type: 'document',
        source: data
          ? { type: 'base64', media_type: block.mimeType, data }
          : { type: 'url', url: source }
      }
    if (protocol === 'chat' && !data) return invalid()
    const file = data
      ? { file_data: source, filename: block.filename ?? `document.${files[block.mimeType]}` }
      : { file_url: source }
    return protocol === 'chat' ? { type: 'file', file } : { type: 'input_file', ...file }
  }
  if (protocol === 'messages')
    return {
      type: block.type,
      source: data
        ? { type: 'base64', media_type: block.mimeType, data }
        : { type: 'url', url: source }
    }
  const field = block.type === 'image' ? 'image_url' : 'video_url'
  return protocol === 'chat'
    ? { type: field, [field]: { url: source } }
    : { type: block.type === 'image' ? 'input_image' : 'input_video', [field]: source }
}
