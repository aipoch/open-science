const GENERATED_IMAGE_PATH =
  /(?:^|[\\/])(?:clipboard-images|workbuddy-clipboard-images)[\\/]clipboard-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.(?:png|jpe?g|gif|webp)$/i
const IMAGE_PATH_BLOCK = /<image_local_path>([^<>]+)<\/image_local_path>/gi

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stripGeneratedImagePaths = (text: string): string | undefined => {
  let removed = false
  const stripped = text.replace(IMAGE_PATH_BLOCK, (block, path: string) => {
    if (!GENERATED_IMAGE_PATH.test(path.trim())) return block
    removed = true
    return ''
  })
  return removed ? stripped.trim() : undefined
}

const adaptContent = (content: unknown): { changed: boolean; content: unknown } => {
  if (typeof content === 'string') {
    const stripped = stripGeneratedImagePaths(content)
    return stripped === undefined
      ? { changed: false, content }
      : { changed: true, content: stripped }
  }
  if (!Array.isArray(content)) return { changed: false, content }

  let changed = false
  const adapted = content.flatMap((part) => {
    if (!isRecord(part) || typeof part.text !== 'string') return [part]
    const text = stripGeneratedImagePaths(part.text)
    if (text === undefined) return [part]
    changed = true
    return text ? [{ ...part, text }] : []
  })
  return changed ? { changed: true, content: adapted } : { changed: false, content }
}

export const adaptCodeBuddyChatCompletionsRequest = (
  request: Record<string, unknown>
): Record<string, unknown> => {
  if (!Array.isArray(request.messages)) return request

  let changed = false
  const messages = request.messages.map((message) => {
    if (!isRecord(message) || message.role !== 'user') return message
    const adapted = adaptContent(message.content)
    if (!adapted.changed) return message
    changed = true
    return { ...message, content: adapted.content }
  })

  return changed ? { ...request, messages } : request
}
