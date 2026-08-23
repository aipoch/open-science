import type { ChatSession } from '@/stores/session-store'
import { createCodeFenceTracker } from '@/components/streamdown/code-fence'
import { Lexer, type Token, type Tokens } from 'marked'

import { getArtifactName, getArtifactPreviewFormat } from './artifact-preview-utils'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  resolvedProjectId?: string
  resolvedSessionId?: string
}

const ARTIFACT_REFERENCE_PATTERN = /^\{\{artifact:([^}\s]+)\}\}$/u
const INTERNAL_ARTIFACT_REFERENCE_PREFIX = '/.open-science/artifact/'
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
  const internalArtifactReference = normalizedReference.startsWith(
    INTERNAL_ARTIFACT_REFERENCE_PREFIX
  )
    ? normalizedReference.slice(INTERNAL_ARTIFACT_REFERENCE_PREFIX.length)
    : undefined
  const identity = artifactReference ?? internalArtifactReference ?? normalizedReference
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

// Artifact reference rewriting operates on raw streaming Markdown before Streamdown parses it.
// Fenced and indented code stay byte-for-byte intact; Marked's inline lexer protects code spans
// and gives link/image structure without reserializing unrelated Markdown.
const transformMarkdownOutsideCode = (
  content: string,
  transform: (markdown: string) => string
): string => {
  const fenceTracker = createCodeFenceTracker()
  const lines = content.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? []

  return lines
    .map((rawLine) => {
      const hasNewline = rawLine.endsWith('\n')
      const line = hasNewline ? rawLine.slice(0, -1) : rawLine
      const fenceWasOpen = fenceTracker.isOpen()
      const fenceIsOpen = fenceTracker.feed(line)
      const isCodeLine = fenceWasOpen || fenceIsOpen || /^(?: {4}|\t)/u.test(line)
      const normalizedLine = isCodeLine ? line : transform(line)
      return hasNewline ? `${normalizedLine}\n` : normalizedLine
    })
    .join('')
}

const createArtifactImageMarkup = (
  image: Tokens.Image,
  artifacts: readonly MessageArtifact[]
): string | undefined => {
  const artifact = resolveMessageArtifactReference(image.href, artifacts)
  if (
    !artifact ||
    artifact.kind !== 'managed-file' ||
    getArtifactPreviewFormat(artifact) !== 'image'
  ) {
    return undefined
  }

  const artifactRef = artifact.versionId ?? artifact.id
  return `<session-artifact-image artifact_ref="${escapeHtmlAttribute(artifactRef)}" alt_text="${escapeHtmlAttribute(image.text)}"></session-artifact-image>`
}

type ArtifactTransformMode = 'all' | 'images' | 'links'

const getTokenChildren = (token: Token): Token[] =>
  'tokens' in token && Array.isArray(token.tokens) ? token.tokens : []

const hasImageToken = (token: Token): boolean =>
  token.type === 'image' || getTokenChildren(token).some(hasImageToken)

const transformTokenChildren = (
  token: Token,
  artifacts: readonly MessageArtifact[],
  mode: ArtifactTransformMode
): string => {
  const children = getTokenChildren(token)
  if (children.length === 0) return token.raw

  let output = ''
  let cursor = 0
  for (const child of children) {
    const childStart = token.raw.indexOf(child.raw, cursor)
    if (childStart === -1) return token.raw
    output += token.raw.slice(cursor, childStart)
    output += transformInlineToken(child, artifacts, mode)
    cursor = childStart + child.raw.length
  }
  return output + token.raw.slice(cursor)
}

const transformInlineToken = (
  token: Token,
  artifacts: readonly MessageArtifact[],
  mode: ArtifactTransformMode
): string => {
  if (token.type === 'image') {
    return mode !== 'links'
      ? (createArtifactImageMarkup(token as Tokens.Image, artifacts) ?? token.raw)
      : token.raw
  }

  if (token.type === 'link') {
    const link = token as Tokens.Link
    const linkedImage = link.tokens.length === 1 && link.tokens[0].type === 'image'
    if (linkedImage && mode !== 'links') {
      return createArtifactImageMarkup(link.tokens[0] as Tokens.Image, artifacts) ?? token.raw
    }
    if (mode === 'images') return token.raw

    // Keep any other linked image atomic so custom link and image buttons can never nest.
    if (hasImageToken(link)) return token.raw

    const artifact = resolveMessageArtifactReference(link.href, artifacts)
    if (artifact?.kind !== 'managed-file') return token.raw
    const artifactRef = artifact.versionId ?? artifact.id
    const label = link.tokens.map((child) => child.raw).join('')
    const title = link.title ? ` ${JSON.stringify(link.title)}` : ''
    return `[${label}](${INTERNAL_ARTIFACT_REFERENCE_PREFIX}${encodeURIComponent(artifactRef)}${title})`
  }

  return transformTokenChildren(token, artifacts, mode)
}

const transformInlineMarkdown = (
  markdown: string,
  artifacts: readonly MessageArtifact[],
  mode: ArtifactTransformMode
): string =>
  Lexer.lexInline(markdown)
    .map((token) => transformInlineToken(token, artifacts, mode))
    .join('')

// Converts only images that resolve to a managed artifact attached to this message. Remote and
// unresolved Markdown images stay owned by Streamdown with their existing controls.
const normalizeSessionArtifactImages = (
  content: string,
  artifacts: readonly MessageArtifact[]
): string =>
  transformMarkdownOutsideCode(content, (markdown) =>
    transformInlineMarkdown(markdown, artifacts, 'images')
  )

// Rewrites only links already proven to reference a same-message managed artifact. Streamdown's
// security sanitizer intentionally drops bare filenames, artifact tokens, and file URLs; an
// internal root-relative target preserves the Markdown label while keeping the destination inert.
const normalizeSessionArtifactLinks = (
  content: string,
  artifacts: readonly MessageArtifact[]
): string =>
  transformMarkdownOutsideCode(content, (markdown) =>
    transformInlineMarkdown(markdown, artifacts, 'links')
  )

const normalizeSessionArtifactReferences = (
  content: string,
  artifacts: readonly MessageArtifact[]
): string =>
  transformMarkdownOutsideCode(content, (markdown) =>
    transformInlineMarkdown(markdown, artifacts, 'all')
  )

export {
  normalizeSessionArtifactImages,
  normalizeSessionArtifactLinks,
  normalizeSessionArtifactReferences,
  resolveMessageArtifactReference
}
export type { MessageArtifact }
