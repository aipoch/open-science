import type { ChatSession } from '@/stores/session-store'

import { getArtifactName, getArtifactPreviewFormat } from './artifact-preview-utils'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  resolvedProjectId?: string
  resolvedSessionId?: string
}

const ARTIFACT_REFERENCE_PATTERN = /^\{\{artifact:([^}\s]+)\}\}$/u
const MARKDOWN_IMAGE_PATTERN =
  /!\[([^\]]*)\]\(\s*(<[^>\n]+>|\{\{artifact:[^}\s]+\}\}|[^\s)]+)\s*(?:["'][^"']*["'])?\s*\)/gu
const EXTERNAL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu

const decodeReference = (reference: string): string => {
  try {
    return decodeURIComponent(reference)
  } catch {
    return reference
  }
}

const getPathName = (path: string): string => path.split(/[\\/]/u).at(-1) ?? path

const normalizeFileReference = (reference: string): string =>
  decodeReference(reference.trim()).replace(/^\.\//u, '')

const resolveMessageArtifactReference = (
  reference: string | undefined,
  artifacts: readonly MessageArtifact[]
): MessageArtifact | undefined => {
  if (!reference) return undefined

  const normalizedReference = normalizeFileReference(reference)
  const artifactReference = normalizedReference.match(ARTIFACT_REFERENCE_PATTERN)?.[1]
  const identity = artifactReference ?? normalizedReference
  const identityMatch = artifacts.find(
    (artifact) =>
      artifact.id === identity ||
      artifact.artifactId === identity ||
      artifact.versionId === identity ||
      artifact.fileUrl === identity
  )
  if (identityMatch) return identityMatch

  if (EXTERNAL_SCHEME_PATTERN.test(normalizedReference) || normalizedReference.startsWith('//')) {
    return undefined
  }

  const pathMatch = artifacts.find((artifact) => artifact.path === normalizedReference)
  if (pathMatch) return pathMatch

  const referenceName = getPathName(normalizedReference)
  const nameMatches = artifacts.filter(
    (artifact) =>
      getArtifactName(artifact) === referenceName || getPathName(artifact.path) === referenceName
  )
  return nameMatches.length === 1 ? nameMatches[0] : undefined
}

const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')

// Converts only images that resolve to a managed artifact attached to this message. Remote and
// unresolved Markdown images stay owned by Streamdown with their existing controls.
const normalizeSessionArtifactImages = (
  content: string,
  artifacts: readonly MessageArtifact[]
): string =>
  content.replace(MARKDOWN_IMAGE_PATTERN, (match, alt: string, destination: string) => {
    const reference =
      destination.startsWith('<') && destination.endsWith('>')
        ? destination.slice(1, -1)
        : destination
    const artifact = resolveMessageArtifactReference(reference, artifacts)
    if (
      !artifact ||
      artifact.kind !== 'managed-file' ||
      getArtifactPreviewFormat(artifact) !== 'image'
    ) {
      return match
    }

    const artifactRef = artifact.versionId ?? artifact.id
    return `<session-artifact-image artifact_ref="${escapeHtmlAttribute(artifactRef)}" alt_text="${escapeHtmlAttribute(alt)}"></session-artifact-image>`
  })

export { normalizeSessionArtifactImages, resolveMessageArtifactReference }
export type { MessageArtifact }
