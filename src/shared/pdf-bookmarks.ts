import {
  ANNOTATION_LIMITS,
  type PdfNormalizedQuad,
  type PdfRegionSelector,
  type PdfTextSelector
} from './annotations'

export type PdfBookmarkSource = Readonly<{
  kind: 'artifact-version' | 'upload-version' | 'literature-attachment-version'
  projectId: string
  sourceFileId: string
  versionId: string
  sessionId?: string
  checksum: string
  name: string
  path: string
}>

export type PdfBookmarkTextSelector = PdfTextSelector &
  Readonly<{ pageRotation: number; coordinateVersion: 1 }>

export type PdfBookmarkRegionSelector = Omit<PdfRegionSelector, 'image' | 'imageOmissionReason'> &
  Readonly<{ coordinateVersion: 1 }>

export type PdfBookmarkTarget = Readonly<{
  kind: 'pdf'
  source: PdfBookmarkSource
  selector: PdfBookmarkTextSelector | PdfBookmarkRegionSelector
}>

export const pdfBookmarkSelectorMatchesPage = (
  selector: PdfBookmarkTarget['selector'],
  pageNumber: number,
  intrinsicPageRotation: number
): boolean =>
  selector.coordinateVersion === 1 &&
  selector.pageNumber === pageNumber &&
  selector.pageRotation === intrinsicPageRotation

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
  'coordinateVersion'
])
const REGION_SELECTOR_KEYS = new Set([
  'kind',
  'pageNumber',
  'rect',
  'pageRotation',
  'text',
  'coordinateVersion'
])
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

export const sanitizePdfBookmarkSource = (value: unknown): PdfBookmarkSource | undefined => {
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
    !projectId ||
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

export const sanitizePdfBookmarkTarget = (value: unknown): PdfBookmarkTarget | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, TARGET_KEYS) ||
    value.kind !== 'pdf' ||
    !isRecord(value.selector)
  )
    return undefined
  const source = sanitizePdfBookmarkSource(value.source)
  if (!source) return undefined
  const selector = value.selector
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

  if (selector.kind === 'region') {
    if (!hasOnlyKeys(selector, REGION_SELECTOR_KEYS)) return undefined
    const rect = normalizedQuad(selector.rect)
    const selectedText =
      selector.text === undefined
        ? undefined
        : boundedString(selector.text, ANNOTATION_LIMITS.quote)
    if (
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
      coordinateVersion: 1
    }
  }
}
