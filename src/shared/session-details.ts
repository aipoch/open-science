import {
  SESSION_DETAILS_DESCRIPTION_MAX_LENGTH,
  isHiddenControlMessage,
  isHumanUserMessage,
  type MessagePart,
  type PersistedChatMessage,
  type PersistedUploadedAttachment
} from './session-persistence'

const collapseTitleWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const collapseDescriptionWhitespace = (value: string): string =>
  value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

const safePathSegments = (value: string): string[] =>
  value
    .split(/[\\/]+/u)
    .map((segment) => collapseTitleWhitespace(segment))
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

const safeBaseName = (value: string): string => safePathSegments(value).at(-1) ?? ''

const safeRelativePath = (value: string): string | undefined => {
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    /^[\\/]/u.test(trimmed) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed) ||
    trimmed.includes('\0')
  ) {
    return undefined
  }

  const segments = trimmed.split(/[\\/]+/u).map((segment) => collapseTitleWhitespace(segment))
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return undefined
  }

  return segments.join('/')
}

const linkedFolderDisplayName = (relativePath: string, name: string): string =>
  safeRelativePath(relativePath) || safeBaseName(name) || safeBaseName(relativePath)

const displayNameForPart = (part: MessagePart): string => {
  switch (part.type) {
    case 'text':
      return part.text
    case 'skill':
      return `/${part.name.replace(/^\/+/, '')}`
    case 'session':
      return `#${collapseTitleWhitespace(part.title)}`
    case 'artifact':
      return `@${
        part.source === 'linked-folder'
          ? linkedFolderDisplayName(part.relativePath, part.name)
          : safeBaseName(part.name)
      }`
  }
}

const uploadDisplayName = (upload: PersistedUploadedAttachment): string =>
  safeBaseName(upload.originalName || upload.name)

const formatSessionDetailsGenerationSource = (
  message: Pick<PersistedChatMessage, 'content' | 'parts' | 'uploads'>
): string => {
  const structured = message.parts?.map(displayNameForPart).join(' ')
  let description = collapseDescriptionWhitespace(structured || message.content)

  for (const upload of message.uploads ?? []) {
    const name = uploadDisplayName(upload)
    if (!name || description.includes(name)) continue
    description = collapseDescriptionWhitespace(`${description}${description ? '\n' : ''}@${name}`)
  }

  return description.slice(0, SESSION_DETAILS_DESCRIPTION_MAX_LENGTH).trimEnd()
}

const formatSessionDetailsTitle = (
  message: Pick<PersistedChatMessage, 'content' | 'uploads'>
): string => {
  const content = collapseTitleWhitespace(message.content)
  if (content) return content.length > 48 ? `${content.slice(0, 48)}...` : content
  const uploads = message.uploads ?? []
  if (uploads.length === 1) return `Attached ${uploadDisplayName(uploads[0])}`
  if (uploads.length > 1) return `Attached ${uploads.length} files`
  return ''
}

const formatFallbackSessionDetails = (
  message: Pick<PersistedChatMessage, 'content' | 'parts' | 'uploads'>
): Readonly<{ title: string; description: string }> => ({
  title: formatSessionDetailsTitle(message),
  description: ''
})

const findFirstSessionDetailsMessage = (
  messages: readonly PersistedChatMessage[]
): PersistedChatMessage | undefined =>
  messages.find((message) => isHumanUserMessage(message) && !isHiddenControlMessage(message))

export {
  findFirstSessionDetailsMessage,
  formatFallbackSessionDetails,
  formatSessionDetailsGenerationSource,
  formatSessionDetailsTitle
}
