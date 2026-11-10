import type { ChatSession } from '@/stores/session-store-contract'
import { createCodeFenceTracker } from '@/components/streamdown/code-fence'
import { Lexer, type Token, type Tokens } from 'marked'

import { getArtifactName, getArtifactPreviewFormat } from './artifact-preview-utils'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  resolvedProjectId?: string
  resolvedSessionId?: string
}

const ARTIFACT_REFERENCE_PATTERN = /^\{\{artifact:([^}\s]+)\}\}$/u
const INTERNAL_ARTIFACT_REFERENCE_PREFIX = '/.open-science/artifact/'
const INTERNAL_SESSION_DATA_REFERENCE_PREFIX = '/.open-science/notebook-data/'
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

// Resolve lexically before Markdown/URL sanitization can erase a drive prefix, backslashes or
// dot segments. Main repeats containment using canonical paths before reading any bytes.
const containSessionDataPath = (path: string, dataRoot: string): string | undefined => {
  const windows = WINDOWS_ABSOLUTE_PATH_PATTERN.test(dataRoot) || /^[\\/]{2}/u.test(dataRoot)
  const normalize = (value: string): string => (windows ? value.replace(/\\/gu, '/') : value)
  const root = normalize(dataRoot).replace(/\/+$/u, '')
  const target = normalize(path)
  const absolute = windows
    ? /^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/)/iu.test(target)
    : target.startsWith('/') && !target.startsWith('//')
  const comparableRoot = windows ? root.toLowerCase() : root
  const comparableTarget = windows ? target.toLowerCase() : target
  if (
    !absolute ||
    !comparableTarget.startsWith(`${comparableRoot}/`) ||
    target.endsWith('/') ||
    target.split('/').some((segment) => segment === '.' || segment === '..') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(path) ||
    (!windows && path.includes('\\')) ||
    // Device namespaces, alternate streams and Win32 trailing-dot/space aliases are not files
    // this surface can identify unambiguously.
    (windows &&
      (target.startsWith('//?/') ||
        target.startsWith('//./') ||
        target
          .slice(WINDOWS_ABSOLUTE_PATH_PATTERN.test(target) ? 2 : 0)
          .split('/')
          .some((segment) => /[:<>"|?*]/u.test(segment) || /[. ]$/u.test(segment))))
  )
    return undefined
  return path
}

const resolveSessionDataFileReference = (
  reference: string | undefined,
  dataRoot: string | undefined
): string | undefined => {
  if (!reference || !dataRoot) return undefined
  const target = reference.trim()
  const internal = target.startsWith(INTERNAL_SESSION_DATA_REFERENCE_PREFIX)
  try {
    if (internal) {
      return containSessionDataPath(
        decodeURIComponent(target.slice(INTERNAL_SESSION_DATA_REFERENCE_PREFIX.length)),
        dataRoot
      )
    }
    if (/^file:/iu.test(target)) {
      // Parse the authority without WHATWG URL, which normalizes traversal before validation.
      const file = target.match(/^file:\/\/([^/]*)(\/.*)$/iu)
      if (!file || /[?#\\]/u.test(target) || /%2f|%5c/iu.test(file[2])) return undefined
      let path = decodeURIComponent(file[2])
      if (file[1] && file[1].toLowerCase() !== 'localhost') {
        if (!/^[\\/]{2}/u.test(dataRoot) || !/^[a-z\d._-]+$/iu.test(file[1])) return undefined
        path = `//${file[1]}${path}`
      } else if (
        WINDOWS_ABSOLUTE_PATH_PATTERN.test(dataRoot) &&
        WINDOWS_ABSOLUTE_PATH_PATTERN.test(path.slice(1))
      ) {
        path = path.slice(1)
      }
      if (dataRoot.includes('\\')) path = path.replace(/\//gu, '\\')
      return containSessionDataPath(path, dataRoot)
    }
    return containSessionDataPath(decodeReference(target), dataRoot)
  } catch {
    return undefined
  }
}

// Marked unescapes Markdown punctuation in link.href, including the first two UNC slashes and
// Windows separators before underscores/parentheses. Recover the native destination from its
// source token before handing it to the single URI-decoding boundary above.
const getLocalLinkReference = (link: Tokens.Link): string => {
  const destination = link.raw.match(/\]\((.*)\)$/u)?.[1]
  if (!destination) return link.href
  let raw = destination.trim()
  if (link.title)
    raw = raw.replace(/\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))$/u, '')
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1)
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(raw) || raw.startsWith('\\\\') ? raw : link.href
}

const resolveMessageArtifactReference = (
  reference: string | undefined,
  artifacts: readonly MessageArtifact[]
): MessageArtifact | undefined => {
  if (!reference || reference.startsWith(INTERNAL_SESSION_DATA_REFERENCE_PREFIX)) return undefined

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
  mode: ArtifactTransformMode,
  dataRoot?: string
): string => {
  const children = getTokenChildren(token)
  if (children.length === 0) return token.raw

  let output = ''
  let cursor = 0
  for (const child of children) {
    const childStart = token.raw.indexOf(child.raw, cursor)
    if (childStart === -1) return token.raw
    output += token.raw.slice(cursor, childStart)
    output += transformInlineToken(child, artifacts, mode, dataRoot)
    cursor = childStart + child.raw.length
  }
  return output + token.raw.slice(cursor)
}

const transformInlineToken = (
  token: Token,
  artifacts: readonly MessageArtifact[],
  mode: ArtifactTransformMode,
  dataRoot?: string
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

    const reference = getLocalLinkReference(link)
    const dataFile =
      resolveSessionDataFileReference(reference, dataRoot) ??
      (reference !== link.href ? resolveSessionDataFileReference(link.href, dataRoot) : undefined)
    // A file URL may identify the exact managed path even when fileUrl metadata is absent.
    // Never allow the basename fallback for this lookup.
    const samePath = (candidate: string, path: string): boolean => {
      const windows =
        WINDOWS_ABSOLUTE_PATH_PATTERN.test(dataRoot ?? '') || /^[\\/]{2}/u.test(dataRoot ?? '')
      return windows
        ? candidate.replace(/\\/gu, '/').toLowerCase() === path.replace(/\\/gu, '/').toLowerCase()
        : candidate === path
    }
    const artifact = dataFile
      ? artifacts.find((candidate) => samePath(candidate.path, dataFile))
      : resolveMessageArtifactReference(reference, artifacts)
    if (artifact?.kind !== 'managed-file' && !dataFile) return token.raw
    const target =
      artifact?.kind === 'managed-file'
        ? `${INTERNAL_ARTIFACT_REFERENCE_PREFIX}${encodeURIComponent(artifact.versionId ?? artifact.id)}`
        : `${INTERNAL_SESSION_DATA_REFERENCE_PREFIX}${encodeURIComponent(dataFile!).replace(/\(/gu, '%28').replace(/\)/gu, '%29')}`
    const label = link.tokens.map((child) => child.raw).join('')
    const title = link.title ? ` ${JSON.stringify(link.title)}` : ''
    return `[${label}](${target}${title})`
  }

  return transformTokenChildren(token, artifacts, mode, dataRoot)
}

const transformInlineMarkdown = (
  markdown: string,
  artifacts: readonly MessageArtifact[],
  mode: ArtifactTransformMode,
  dataRoot?: string
): string =>
  Lexer.lexInline(markdown)
    .map((token) => transformInlineToken(token, artifacts, mode, dataRoot))
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

// Streamdown drops bare filenames, artifact tokens, and file URLs. Managed artifacts use an inert
// internal target; Notebook data file links carry their validated absolute path under a
// separate prefix so basename artifact matching cannot claim them. The data resolver repeats the
// root check before rendering import confirmation. Unresolved URLs stay with the sanitizer.
const normalizeSessionArtifactLinks = (
  content: string,
  artifacts: readonly MessageArtifact[],
  dataRoot?: string
): string =>
  transformMarkdownOutsideCode(content, (markdown) =>
    transformInlineMarkdown(markdown, artifacts, 'links', dataRoot)
  )

const normalizeSessionArtifactReferences = (
  content: string,
  artifacts: readonly MessageArtifact[],
  dataRoot?: string
): string =>
  transformMarkdownOutsideCode(content, (markdown) =>
    transformInlineMarkdown(markdown, artifacts, 'all', dataRoot)
  )

// Incremental `normalizeSessionArtifactReferences` for append-only streaming, mirroring
// `createAgentMarkdownNormalizer`. The transform splits safely at any newline where the fence
// tracker sits outside a fence (a closed fence also resets `fenceBlockquoteDepth` to its initial
// state), so a growing message reprocesses only the tail past the last such boundary. Anything
// else — edits, replacement, a new artifacts array or Notebook data root — runs a full pass.
const createSessionArtifactReferenceNormalizer = (): ((
  content: string,
  artifacts: readonly MessageArtifact[],
  dataRoot?: string
) => string) => {
  let cachedArtifacts: readonly MessageArtifact[] | null = null
  let cachedDataRoot: string | undefined
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

  return (content, artifacts, dataRoot) => {
    // A Notebook root also enables native paths, including drive paths removed by sanitizers.
    if (
      !artifacts.some((artifact) => artifact.kind === 'managed-file') &&
      (!dataRoot || (!content.includes('](') && !content.includes('<')))
    ) {
      return content
    }
    if (content === cachedInput && artifacts === cachedArtifacts && dataRoot === cachedDataRoot) {
      return cachedOutput
    }

    const isAppend =
      artifacts === cachedArtifacts &&
      dataRoot === cachedDataRoot &&
      cachedInput !== null &&
      content.startsWith(cachedInput)
    if (!isAppend) resetScan()

    const previousBoundary = boundary
    const output = isAppend
      ? boundaryOutput +
        normalizeSessionArtifactReferences(content.slice(previousBoundary), artifacts, dataRoot)
      : normalizeSessionArtifactReferences(content, artifacts, dataRoot)

    const nextBoundary = advanceBoundary(content)
    if (nextBoundary > previousBoundary) {
      // Extend the cached prefix without reprocessing it; both split points are fence-closed.
      boundaryOutput += normalizeSessionArtifactReferences(
        content.slice(previousBoundary, nextBoundary),
        artifacts,
        dataRoot
      )
      boundary = nextBoundary
    }

    cachedArtifacts = artifacts
    cachedDataRoot = dataRoot
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
  resolveMessageArtifactReference,
  resolveSessionDataFileReference
}
export type { MessageArtifact }
