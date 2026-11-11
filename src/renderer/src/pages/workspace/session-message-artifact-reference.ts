import type { ChatSession } from '@/stores/session-store-contract'
import { createCodeFenceTracker } from '@/components/streamdown/code-fence'
import { Lexer, type Token, type Tokens } from 'marked'

import { getArtifactName, getArtifactPreviewFormat } from './artifact-preview-utils'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  resolvedProjectId?: string
  referencePath?: string
  resolvedSessionId?: string
}

const ARTIFACT_REFERENCE_PATTERN = /^\{\{artifact:([^}\s]+)\}\}$/u
const INTERNAL_ARTIFACT_REFERENCE_PREFIX = '/.open-science/artifact/'
const INTERNAL_SESSION_DATA_REFERENCE_PREFIX = '/.open-science/notebook-data/'
const LOCAL_REFERENCE_PREFIX = '/.open-science/local-file/'
const UNRESOLVED_REFERENCE_PREFIX = '/.open-science/unresolved-file/'
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

const windowsPath = (path: string): boolean =>
  WINDOWS_ABSOLUTE_PATH_PATTERN.test(path) || /^[\\/]{2}/u.test(path)

const pathKey = (path: string): string =>
  windowsPath(path) ? path.replace(/\\/gu, '/').toLowerCase() : path

// Read the original file URL before URL parsers normalize dot segments or escaped separators.
const absoluteFilePath = (reference: string, dataRoot?: string): string | undefined => {
  let path: string
  try {
    if (/^file:/iu.test(reference)) {
      const file = reference.match(/^file:\/\/([^/]*)(\/.*)$/iu)
      if (!file || /[?#\\]/u.test(reference) || /%2f|%5c/iu.test(file[2])) return undefined
      path = decodeURIComponent(file[2])
      if (file[1] && file[1].toLowerCase() !== 'localhost') {
        if (!/^[a-z\d._-]+$/iu.test(file[1])) return undefined
        path = `\\\\${file[1]}${path.replace(/\//gu, '\\')}`
      } else if (path.startsWith('//')) return undefined
      else if (
        (!dataRoot || windowsPath(dataRoot)) &&
        WINDOWS_ABSOLUTE_PATH_PATTERN.test(path.slice(1))
      )
        path = path.slice(1)
    } else {
      if (reference.startsWith('//') && !isNotebookDataPath(reference, dataRoot)) return undefined
      path = decodeURIComponent(reference)
    }
  } catch {
    return undefined
  }
  const windows = windowsPath(path)
  if (!windows && (!path.startsWith('/') || path.includes('\\'))) return undefined
  const normalized = windows ? path.replace(/\\/gu, '/') : path
  if (
    normalized.endsWith('/') ||
    normalized.split('/').some((part) => part === '..' || part === '.') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(path) ||
    (windows &&
      (normalized.startsWith('//?/') ||
        normalized.startsWith('//./') ||
        normalized
          .slice(WINDOWS_ABSOLUTE_PATH_PATTERN.test(path) ? 2 : 0)
          .split('/')
          .some((part) => /[:<>"|?*]/u.test(part) || /[. ]$/u.test(part))))
  )
    return undefined
  return /^file:/iu.test(reference) && windows && dataRoot?.includes('\\')
    ? path.replace(/\//gu, '\\')
    : path
}

const isNotebookDataPath = (path: string, dataRoot?: string): boolean =>
  !!dataRoot && pathKey(path).startsWith(`${pathKey(dataRoot).replace(/\/+$/u, '')}/`)

const decodeLocalReference = (href: string | undefined, prefix: string): string | undefined =>
  href?.startsWith(prefix) ? decodeReference(href.slice(prefix.length)) : undefined

const resolveSessionDataFileReference = (
  href: string | undefined,
  root?: string
): string | undefined => {
  if (!href) return undefined
  const path =
    decodeLocalReference(href, INTERNAL_SESSION_DATA_REFERENCE_PREFIX) ??
    absoluteFilePath(href, root)
  return path && isNotebookDataPath(path, root) ? path : undefined
}

const externalFilePath = (href?: string): string | undefined =>
  decodeLocalReference(href, LOCAL_REFERENCE_PREFIX)
const unresolvedFileReference = (href?: string): string | undefined =>
  decodeLocalReference(href, UNRESOLVED_REFERENCE_PREFIX)

const resolveRelativeReplyPath = (
  reference: string | undefined,
  cwd?: string,
  dataRoot?: string
): string | undefined => {
  if (
    !reference ||
    !/[\\/]/u.test(reference) ||
    /^[\\/]/u.test(reference) ||
    EXTERNAL_SCHEME_PATTERN.test(reference)
  )
    return undefined
  const relative = reference.replace(/^\.\//u, '').replace(/\\/gu, '/')
  if (relative.split('/').some((part) => !part || part === '..' || part === '.')) return undefined
  const notebookData = relative.startsWith('data/') && !!dataRoot
  const root = notebookData ? dataRoot : cwd
  if (!root || (!root.startsWith('/') && !windowsPath(root))) return undefined
  const child = notebookData ? relative.slice('data/'.length) : relative
  const separator = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/u, '') + separator + child.replace(/\//gu, separator)
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

// Tool records and an attached Artifact can describe the same physical file.
const uniqueFile = (matches: readonly MessageArtifact[]): MessageArtifact | undefined => {
  const first = matches[0]
  if (!first || !matches.every((file) => pathKey(file.path) === pathKey(first.path)))
    return undefined
  return matches.find((file) => file.kind === 'managed-file') ?? first
}

const resolveMessageArtifactReference = (
  reference: string | undefined,
  artifacts: readonly MessageArtifact[]
): MessageArtifact | undefined => {
  if (
    !reference ||
    [
      INTERNAL_SESSION_DATA_REFERENCE_PREFIX,
      LOCAL_REFERENCE_PREFIX,
      UNRESOLVED_REFERENCE_PREFIX
    ].some((prefix) => reference.startsWith(prefix))
  )
    return undefined

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

  const path = absoluteFilePath(reference) ?? normalizedReference
  const pathMatches = artifacts.filter(
    (artifact) =>
      pathKey(artifact.path) === pathKey(path) ||
      (artifact.referencePath &&
        /[\\/]/u.test(path) &&
        artifact.referencePath.replace(/\\/gu, '/') === path.replace(/\\/gu, '/'))
  )
  if (pathMatches.length) return uniqueFile(pathMatches)
  if (/[\\/]/u.test(path) || EXTERNAL_SCHEME_PATTERN.test(path)) return undefined

  const referenceName = getPathName(normalizedReference)
  const nameMatches = artifacts.filter(
    (artifact) =>
      getArtifactName(artifact) === referenceName || getPathName(artifact.path) === referenceName
  )
  return uniqueFile(nameMatches)
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
    const path =
      resolveSessionDataFileReference(reference, dataRoot) ??
      resolveSessionDataFileReference(link.href, dataRoot) ??
      absoluteFilePath(reference, dataRoot)
    const artifact = resolveMessageArtifactReference(reference, artifacts)
    const encode = (value: string): string =>
      encodeURIComponent(value).replace(/\(/gu, '%28').replace(/\)/gu, '%29')
    let target: string
    if (artifact?.kind === 'managed-file') {
      target = INTERNAL_ARTIFACT_REFERENCE_PREFIX + encode(artifact.versionId ?? artifact.id)
    } else {
      const file = path ?? artifact?.path
      if (file) {
        const prefix = isNotebookDataPath(file, dataRoot)
          ? INTERNAL_SESSION_DATA_REFERENCE_PREFIX
          : LOCAL_REFERENCE_PREFIX
        target = prefix + encode(file)
      } else {
        if (
          EXTERNAL_SCHEME_PATTERN.test(reference) ||
          /^[#?/]/u.test(reference) ||
          reference.startsWith('\\')
        )
          return token.raw
        target = UNRESOLVED_REFERENCE_PREFIX + encode(decodeReference(reference))
      }
    }
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

// Preserve local destinations across Markdown sanitization so the renderer can route clicks.
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
    if (
      !artifacts.some((artifact) => artifact.kind === 'managed-file') &&
      !content.includes('](') &&
      !content.includes('<')
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
  resolveSessionDataFileReference,
  externalFilePath,
  resolveRelativeReplyPath,
  isNotebookDataPath,
  unresolvedFileReference
}
export type { MessageArtifact }
