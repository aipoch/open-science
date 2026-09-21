export const LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX = 'literature-attachment-version:'

export const createLiteratureAttachmentVersionReference = (versionId: string): string => {
  const normalized = versionId.trim()
  if (!normalized) throw new Error('Literature Attachment Version id is required.')
  return `${LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX}${encodeURIComponent(normalized)}`
}

export const parseLiteratureAttachmentVersionReference = (
  reference: string
): string | undefined => {
  if (!reference.startsWith(LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX)) return undefined
  const encoded = reference.slice(LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX.length)
  if (!encoded) return undefined
  try {
    const versionId = decodeURIComponent(encoded)
    return versionId && !versionId.includes('/') ? versionId : undefined
  } catch {
    return undefined
  }
}
