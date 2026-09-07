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
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/iu

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

  const pathMatch = artifacts.find((artifact) => artifact.path === normalizedReference)
  if (pathMatch) return pathMatch

  if (
    (EXTERNAL_SCHEME_PATTERN.test(normalizedReference) &&
      !WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedReference)) ||
    normalizedReference.startsWith('//')
  ) {
    return undefined
  }

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

const stripBlockquotePrefixes = (
  line: string,
  maxDepth = Number.POSITIVE_INFINITY
): { content: string; depth: number } => {
  let content = line
  let depth = 0
  while (depth < maxDepth) {
    const prefix = content.match(/^\s{0,3}>\s?/u)?.[0]
    if (!prefix) break
    content = content.slice(prefix.length)
    depth += 1
  }
  return { content, depth }
}

const stripListMarker = (line: string): string => line.replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/u, '')

// Artifact reference rewriting operates on raw streaming Markdown before Streamdown parses it.
// Fenced and indented code stay byte-for-byte intact; Marked's inline lexer protects code spans
// and gives link/image structure without reserializing unrelated Markdown.
const transformMarkdownOutsideCode = (
  content: string,
  transform: (markdown: string) => string
): string => {
  const fenceTracker = createCodeFenceTracker()
  let fenceBlockquoteDepth = 0
  const lines = content.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? []

  return lines
    .map((rawLine) => {
      const hasNewline = rawLine.endsWith('\n')
      const line = hasNewline ? rawLine.slice(0, -1) : rawLine
      const fenceWasOpen = fenceTracker.isOpen()
      const blockquote = stripBlockquotePrefixes(line)
      const fenceContent = fenceWasOpen
        ? stripBlockquotePrefixes(line, fenceBlockquoteDepth).content
        : stripListMarker(blockquote.content)
      const fenceIsOpen = fenceTracker.feed(fenceContent)
      if (!fenceWasOpen && fenceIsOpen) fenceBlockquoteDepth = blockquote.depth
      if (fenceWasOpen && !fenceIsOpen) fenceBlockquoteDepth = 0
      const isCodeLine = fenceWasOpen || fenceIsOpen || /^(?: {4}|\t)/u.test(blockquote.content)
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
  const previewFormat = artifact ? getArtifactPreviewFormat(artifact) : undefined
  if (
    !artifact ||
    artifact.kind !== 'managed-file' ||
    (previewFormat !== 'image' && previewFormat !== 'tiff')
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

// Incremental `normalizeSessionArtifactReferences` for append-only streaming, mirroring
// `createAgentMarkdownNormalizer`. The transform splits safely at any newline where the fence
// tracker sits outside a fence (a closed fence also resets `fenceBlockquoteDepth` to its initial
// state), so a growing message reprocesses only the tail past the last such boundary. Anything
// else — edits, replacement, a new artifacts array — falls back to a full pass.
const createSessionArtifactReferenceNormalizer = (): ((
  content: string,
  artifacts: readonly MessageArtifact[]
) => string) => {
  let cachedArtifacts: readonly MessageArtifact[] | null = null
  let cachedInput: string | null = null
  let cachedOutput = ''
  // Invariant: boundaryOutput === normalizeSessionArtifactReferences(cachedInput.slice(0, boundary), cachedArtifacts).
  let boundary = 0
  let boundaryOutput = ''
  let fenceTracker = createCodeFenceTracker()
  let fenceBlockquoteDepth = 0
  let scanPosition = 0

  const resetScan = (): void => {
    fenceTracker = createCodeFenceTracker()
    fenceBlockquoteDepth = 0
    scanPosition = 0
    boundary = 0
    boundaryOutput = ''
  }

  // Feeds only newline-terminated lines so the trailing partial line — which a later append can
  // still turn into a fence marker — is re-evaluated on the next call. Returns the latest
  // fence-closed line end.
  const advanceBoundary = (content: string): number => {
    for (;;) {
      const newlineIndex = content.indexOf('\n', scanPosition)
      if (newlineIndex === -1) return boundary
      const line = content.slice(scanPosition, newlineIndex)
      const fenceWasOpen = fenceTracker.isOpen()
      const blockquote = stripBlockquotePrefixes(line)
      const fenceContent = fenceWasOpen
        ? stripBlockquotePrefixes(line, fenceBlockquoteDepth).content
        : stripListMarker(blockquote.content)
      const fenceIsOpen = fenceTracker.feed(fenceContent)
      if (!fenceWasOpen && fenceIsOpen) fenceBlockquoteDepth = blockquote.depth
      if (fenceWasOpen && !fenceIsOpen) fenceBlockquoteDepth = 0
      if (!fenceIsOpen) boundary = newlineIndex + 1
      scanPosition = newlineIndex + 1
    }
  }

  return (content, artifacts) => {
    // Only managed-file artifacts can rewrite a reference; without one every token passes
    // through untouched, so skip the lexing entirely.
    if (!artifacts.some((artifact) => artifact.kind === 'managed-file')) return content
    if (content === cachedInput && artifacts === cachedArtifacts) return cachedOutput

    const isAppend =
      artifacts === cachedArtifacts && cachedInput !== null && content.startsWith(cachedInput)
    if (!isAppend) resetScan()

    const previousBoundary = boundary
    const output = isAppend
      ? boundaryOutput +
        normalizeSessionArtifactReferences(content.slice(previousBoundary), artifacts)
      : normalizeSessionArtifactReferences(content, artifacts)

    const nextBoundary = advanceBoundary(content)
    if (nextBoundary > previousBoundary) {
      // Extend the cached prefix without reprocessing it; both split points are fence-closed.
      boundaryOutput += normalizeSessionArtifactReferences(
        content.slice(previousBoundary, nextBoundary),
        artifacts
      )
      boundary = nextBoundary
    }

    cachedArtifacts = artifacts
    cachedInput = content
    cachedOutput = output
    return output
  }
}

export {
  createSessionArtifactReferenceNormalizer,
  normalizeSessionArtifactImages,
  normalizeSessionArtifactLinks,
  normalizeSessionArtifactReferences,
  resolveMessageArtifactReference
}
export type { MessageArtifact }
