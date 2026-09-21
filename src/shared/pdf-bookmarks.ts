import {
  ANNOTATION_LIMITS,
  type PdfNormalizedQuad,
  type PdfRegionSelector,
  type PdfTextSelector
} from './annotations'

export type PdfDocumentSource = Readonly<{
  kind: 'artifact-version' | 'upload-version' | 'literature-attachment-version'
  projectId?: string
  sourceFileId: string
  versionId: string
  sessionId?: string
  checksum: string
  name: string
  path: string
}>

export type PdfBookmarkSource = PdfDocumentSource & Readonly<{ projectId: string }>

export const PDF_MARK_KINDS = [
  'highlight',
  'underline',
  'squiggly',
  'strikethrough',
  'area'
] as const
export type PdfMarkKind = (typeof PDF_MARK_KINDS)[number]
export const PDF_MARK_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple'] as const
export type PdfMarkColor = (typeof PDF_MARK_COLORS)[number]
export const PDF_MARK_TAG_LIMIT = 64
export const PDF_MARK_TAG_COUNT = 12

export type PdfBookmarkMark = Readonly<{
  markKind?: PdfMarkKind
  color?: PdfMarkColor
  tags?: readonly string[]
}>

export type PdfBookmarkTextSelector = PdfTextSelector &
  Readonly<{ pageRotation: number; coordinateVersion: 1 } & PdfBookmarkMark>

export type PdfBookmarkRegionSelector = Omit<PdfRegionSelector, 'image' | 'imageOmissionReason'> &
  Readonly<{ coordinateVersion: 1 } & PdfBookmarkMark>

export type PdfBookmarkPageNoteSelector = Readonly<{
  kind: 'page-note'
  pageNumber: number
  pageRotation: 0 | 90 | 180 | 270
  coordinateVersion: 1
}>

export type PdfBookmarkDocumentNoteSelector = Readonly<{
  kind: 'document-note'
  coordinateVersion: 1
}>

export type PdfBookmarkSelector =
  | PdfBookmarkTextSelector
  | PdfBookmarkRegionSelector
  | PdfBookmarkPageNoteSelector
  | PdfBookmarkDocumentNoteSelector

export type PdfBookmarkTarget = Readonly<{
  kind: 'pdf'
  source: PdfBookmarkSource
  selector: PdfBookmarkSelector
}>

export const pdfBookmarkSelectorMatchesPage = (
  selector: PdfBookmarkTarget['selector'],
  pageNumber: number,
  intrinsicPageRotation: number
): boolean => {
  if (selector.kind === 'page-note') {
    return selector.coordinateVersion === 1 && selector.pageNumber === pageNumber
  }
  return (
    (selector.kind === 'text' || selector.kind === 'region') &&
    selector.coordinateVersion === 1 &&
    selector.pageNumber === pageNumber &&
    selector.pageRotation === intrinsicPageRotation
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key))

const TARGET_KEYS = new Set(['kind', 'source', 'selector'])
const SOURCE_KEYS = new Set([
  'kind',
  'projectId',
  'sourceFileId',
  'versionId',
  'sessionId',
  'checksum',
  'name',
  'path'
])
const TEXT_SELECTOR_KEYS = new Set([
  'kind',
  'pageNumber',
  'exact',
  'prefix',
  'suffix',
  'position',
  'quads',
  'extractorVersion',
  'pageRotation',
  'coordinateVersion',
  'markKind',
  'color',
  'tags'
])
const REGION_SELECTOR_KEYS = new Set([
  'kind',
  'pageNumber',
  'rect',
  'pageRotation',
  'text',
  'coordinateVersion',
  'markKind',
  'color',
  'tags'
])
const PAGE_NOTE_SELECTOR_KEYS = new Set(['kind', 'pageNumber', 'pageRotation', 'coordinateVersion'])
const DOCUMENT_NOTE_SELECTOR_KEYS = new Set(['kind', 'coordinateVersion'])
const POSITION_KEYS = new Set(['start', 'end'])
const RECT_KEYS = new Set(['x', 'y', 'width', 'height'])

const PDF_BOOKMARK_LIMITS = Object.freeze({
  id: 512,
  name: 1_024,
  path: 4_096,
  extractorVersion: 128,
  quads: 256
})

const boundedString = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined

const normalizedQuad = (value: unknown): PdfNormalizedQuad | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, RECT_KEYS)) return undefined
  const { x, y, width, height } = value
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > 1.000_001 ||
    y + height > 1.000_001
  ) {
    return undefined
  }
  return { x, y, width, height }
}

const pageRotation = (value: unknown): 0 | 90 | 180 | 270 | undefined =>
  value === 0 || value === 90 || value === 180 || value === 270 ? value : undefined

const markKind = (value: unknown, region: boolean): PdfMarkKind | undefined => {
  if (value === undefined) return region ? 'area' : 'highlight'
  return PDF_MARK_KINDS.includes(value as PdfMarkKind) && (!region || value === 'area')
    ? (value as PdfMarkKind)
    : undefined
}

const markColor = (value: unknown): PdfMarkColor | undefined =>
  value === undefined
    ? 'yellow'
    : PDF_MARK_COLORS.includes(value as PdfMarkColor)
      ? (value as PdfMarkColor)
      : undefined

const markTags = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > PDF_MARK_TAG_COUNT) return undefined
  const tags = value.map((tag) =>
    typeof tag === 'string' ? tag.trim().slice(0, PDF_MARK_TAG_LIMIT) : ''
  )
  if (tags.some((tag) => !tag)) return undefined
  return [...new Set(tags)]
}

const markMetadata = (
  selector: Record<string, unknown>,
  region: boolean
): PdfBookmarkMark | undefined => {
  const hasMetadata =
    selector.markKind !== undefined || selector.color !== undefined || selector.tags !== undefined
  if (!hasMetadata) return {}
  const kind = markKind(selector.markKind, region)
  const color = markColor(selector.color)
  const tags = markTags(selector.tags)
  if (!kind || !color || (selector.tags !== undefined && !tags)) return undefined
  return { markKind: kind, color, ...(tags?.length ? { tags } : {}) }
}

export const sanitizePdfDocumentSource = (value: unknown): PdfDocumentSource | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, SOURCE_KEYS)) return undefined
  const kind = value.kind
  if (
    kind !== 'artifact-version' &&
    kind !== 'upload-version' &&
    kind !== 'literature-attachment-version'
  ) {
    return undefined
  }
  const projectId = boundedString(value.projectId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const sourceFileId = boundedString(value.sourceFileId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const versionId = boundedString(value.versionId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const sessionId =
    value.sessionId === undefined
      ? undefined
      : boundedString(value.sessionId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const name = boundedString(value.name, PDF_BOOKMARK_LIMITS.name)?.trim()
  const path = boundedString(value.path, PDF_BOOKMARK_LIMITS.path)?.trim()
  if (
    (!projectId && kind !== 'literature-attachment-version') ||
    (value.projectId !== undefined && !projectId) ||
    !sourceFileId ||
    !versionId ||
    !name ||
    !path ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.checksum) ||
    (value.sessionId !== undefined && !sessionId)
  ) {
    return undefined
  }
  return {
    kind,
    projectId,
    sourceFileId,
    versionId,
    ...(sessionId ? { sessionId } : {}),
    checksum: value.checksum,
    name,
    path
  }
}

export const sanitizePdfDocumentTarget = (
  value: unknown
): (Omit<PdfBookmarkTarget, 'source'> & { source: PdfDocumentSource }) | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, TARGET_KEYS) ||
    value.kind !== 'pdf' ||
    !isRecord(value.selector)
  )
    return undefined
  const source = sanitizePdfDocumentSource(value.source)
  if (!source) return undefined
  const selector = value.selector

  if (selector.kind === 'document-note') {
    return hasOnlyKeys(selector, DOCUMENT_NOTE_SELECTOR_KEYS) && selector.coordinateVersion === 1
      ? { kind: 'pdf', source, selector: { kind: 'document-note', coordinateVersion: 1 } }
      : undefined
  }

  const rotation = pageRotation(selector.pageRotation)
  const pageNumber = selector.pageNumber
  if (
    rotation === undefined ||
    selector.coordinateVersion !== 1 ||
    typeof pageNumber !== 'number' ||
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1
  ) {
    return undefined
  }

  if (selector.kind === 'page-note') {
    return hasOnlyKeys(selector, PAGE_NOTE_SELECTOR_KEYS)
      ? {
          kind: 'pdf',
          source,
          selector: { kind: 'page-note', pageNumber, pageRotation: rotation, coordinateVersion: 1 }
        }
      : undefined
  }

  if (selector.kind === 'region') {
    if (!hasOnlyKeys(selector, REGION_SELECTOR_KEYS)) return undefined
    const rect = normalizedQuad(selector.rect)
    const selectedText =
      selector.text === undefined
        ? undefined
        : boundedString(selector.text, ANNOTATION_LIMITS.quote)
    const metadata = markMetadata(selector, true)
    if (
      !metadata ||
      !rect ||
      selector.image !== undefined ||
      selector.imageOmissionReason !== undefined ||
      (selector.text !== undefined && !selectedText)
    )
      return undefined
    return {
      kind: 'pdf',
      source,
      selector: {
        kind: 'region',
        pageNumber,
        rect,
        pageRotation: rotation,
        ...(selectedText ? { text: selectedText } : {}),
        ...metadata,
        coordinateVersion: 1
      }
    }
  }

  const exact = boundedString(selector.exact, ANNOTATION_LIMITS.quote)
  const prefix = selector.prefix === undefined ? undefined : boundedString(selector.prefix, 256)
  const suffix = selector.suffix === undefined ? undefined : boundedString(selector.suffix, 256)
  const position = selector.position
  const quads = Array.isArray(selector.quads) ? selector.quads.map(normalizedQuad) : undefined
  if (
    selector.kind !== 'text' ||
    !hasOnlyKeys(selector, TEXT_SELECTOR_KEYS) ||
    !exact ||
    (selector.prefix !== undefined && !prefix) ||
    (selector.suffix !== undefined && !suffix) ||
    !isRecord(position) ||
    !hasOnlyKeys(position, POSITION_KEYS) ||
    typeof position.start !== 'number' ||
    typeof position.end !== 'number' ||
    !Number.isSafeInteger(position.start) ||
    !Number.isSafeInteger(position.end) ||
    position.start < 0 ||
    position.end !== position.start + exact.length ||
    !quads ||
    quads.length === 0 ||
    quads.length > PDF_BOOKMARK_LIMITS.quads ||
    quads.some((quad) => !quad) ||
    !boundedString(selector.extractorVersion, PDF_BOOKMARK_LIMITS.extractorVersion)?.trim()
  ) {
    return undefined
  }
  const metadata = markMetadata(selector, false)
  if (!metadata) return undefined
  return {
    kind: 'pdf',
    source,
    selector: {
      kind: 'text',
      pageNumber,
      exact,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
      position: { start: position.start, end: position.end },
      quads: quads as PdfNormalizedQuad[],
      extractorVersion: boundedString(
        selector.extractorVersion,
        PDF_BOOKMARK_LIMITS.extractorVersion
      )!.trim(),
      pageRotation: rotation,
      ...metadata,
      coordinateVersion: 1
    }
  }
}

export const sanitizePdfBookmarkSource = (value: unknown): PdfBookmarkSource | undefined => {
  const source = sanitizePdfDocumentSource(value)
  return source?.projectId ? { ...source, projectId: source.projectId } : undefined
}
export const sanitizePdfBookmarkTarget = (value: unknown): PdfBookmarkTarget | undefined => {
  const target = sanitizePdfDocumentTarget(value)
  return target?.source.projectId
    ? { ...target, source: { ...target.source, projectId: target.source.projectId } }
    : undefined
}
