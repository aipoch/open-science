import type { ArtifactReference, FileReference } from './artifacts'
import {
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  sanitizeAcpMessageImage,
  type AcpMessageImage
} from './acp'
import { parseArtifactVersionLocator } from './artifact-provenance'
import { parseUploadVersionReference } from './uploads'

export const ANNOTATION_LIMITS = Object.freeze({
  count: 10,
  quote: 4_000,
  note: 2_000,
  payload: 10_000,
  messagePayload: 100_000
})

export type SessionTextAnnotationItemType =
  'tool-activity' | 'plan' | 'elicitation' | 'delegated-elicitation' | 'subagent-message'

const SESSION_TEXT_ANNOTATION_ITEM_TYPES = new Set<SessionTextAnnotationItemType>([
  'tool-activity',
  'plan',
  'elicitation',
  'delegated-elicitation',
  'subagent-message'
])

export type TextAnnotationSource =
  | Readonly<{
      kind: 'agent-message'
      sessionId: string
      messageId: string
    }>
  | Readonly<{
      kind: 'project-file'
      projectId: string
      path: string
      name?: string
      versionId?: string
      sessionId?: string
    }>
  | Readonly<{
      kind: 'session-item'
      sessionId: string
      itemId: string
      itemType: SessionTextAnnotationItemType
      sectionId?: string
    }>

export type SessionTextAnnotationSource = Exclude<
  TextAnnotationSource,
  Readonly<{ kind: 'project-file'; projectId: string; path: string }>
>

export type TextAnnotation = Readonly<{
  id: string
  kind: 'text'
  target: 'agent'
  quote: string
  note?: string
  source: TextAnnotationSource
}>

export type ImagePointAnnotation = Readonly<{
  id: string
  kind: 'image-point'
  target: 'agent'
  note: string
  source: Readonly<{
    kind: 'artifact-version' | 'upload-version'
    projectId: string
    sessionId: string
    versionId: string
    name: string
    path: string
    mimeType: string
  }>
  point: Readonly<{ x: number; y: number }>
  naturalSize: Readonly<{ width: number; height: number }>
}>

export type PdfNormalizedQuad = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

export type PdfNormalizedRect = PdfNormalizedQuad

export type PdfTextSelector = Readonly<{
  kind: 'text'
  pageNumber: number
  exact: string
  prefix?: string
  suffix?: string
  position: Readonly<{ start: number; end: number }>
  quads: readonly PdfNormalizedQuad[]
  extractorVersion: string
}>

export type PdfRegionSelector = Readonly<{
  kind: 'region'
  pageNumber: number
  rect: PdfNormalizedRect
  pageRotation: number
  text?: string
  image: AcpMessageImage
}>

export type PdfAnnotation = Readonly<{
  id: string
  kind: 'pdf'
  target: 'agent'
  note?: string
  source: Readonly<{
    kind: 'artifact-version' | 'upload-version'
    projectId: string
    sessionId: string
    versionId: string
    name: string
    path: string
    checksum: string
  }>
  selector: PdfTextSelector | PdfRegionSelector
}>

export type Annotation = TextAnnotation | ImagePointAnnotation | PdfAnnotation

export const annotationRequiresImageInput = (annotation: Annotation): boolean =>
  annotation.kind === 'image-point' ||
  (annotation.kind === 'pdf' && annotation.selector.kind === 'region')

export type PreparedImagePoint = Readonly<{
  annotationId: string
  number: number
  attachment: number
  note: string
  sourceKind: ImagePointAnnotation['source']['kind']
  versionId: string
  name: string
  mimeType: string
  x: number
  y: number
  imageWidth: number
  imageHeight: number
}>

export type PreparedImagePointAnnotations = Readonly<{
  attachments: ArtifactReference[]
  points: PreparedImagePoint[]
}>

export type PreparedAnnotationsForAgent = Readonly<{
  promptText: string
  referencedArtifacts?: FileReference[]
  images?: AcpMessageImage[]
}>

export type SideChatAnnotationItem =
  | Readonly<{
      type: 'quote'
      content: string
      source?: Readonly<{
        kind: 'pdf'
        versionId: string
        name: string
        checksum: string
        page: number
        selector: Omit<PdfTextSelector, 'kind' | 'pageNumber' | 'exact'>
      }>
      instruction?: string
    }>
  | Readonly<{
      type: 'image-point'
      source:
        | Readonly<{
            kind: 'artifact-version'
            artifactId: string
            versionId: string
            name: string
          }>
        | Readonly<{ kind: 'upload-version'; versionId: string; name: string }>
      x: number
      y: number
      instruction: string
    }>

export type ParsedSideChatAnnotationText = Readonly<{
  text: string
  items: readonly SideChatAnnotationItem[]
}>

export type AnnotationValidationError =
  | 'too-many'
  | 'quote-too-long'
  | 'note-too-long'
  | 'payload-too-large'
  | 'visual-model-required'
  | 'invalid'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const result = value.trim()
  return result || undefined
}

const boundedString = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined

const normalizedQuad = (value: unknown): PdfNormalizedQuad | undefined => {
  if (!isRecord(value)) return undefined
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

const sanitizePdfAnnotation = (
  value: Record<string, unknown>,
  id: string
): PdfAnnotation | undefined => {
  if (!isRecord(value.source) || !isRecord(value.selector)) return undefined
  const source = value.source
  const selector = value.selector
  const sourceKind = source.kind
  const pageNumber = selector.pageNumber
  if (
    (sourceKind !== 'artifact-version' && sourceKind !== 'upload-version') ||
    !trimmed(source.projectId) ||
    !trimmed(source.sessionId) ||
    !trimmed(source.versionId) ||
    !trimmed(source.name) ||
    !trimmed(source.path) ||
    typeof source.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(source.checksum) ||
    typeof pageNumber !== 'number' ||
    !Number.isInteger(pageNumber) ||
    pageNumber < 1
  ) {
    return undefined
  }
  const sanitizedSource: PdfAnnotation['source'] = {
    kind: sourceKind,
    projectId: trimmed(source.projectId)!,
    sessionId: trimmed(source.sessionId)!,
    versionId: trimmed(source.versionId)!,
    name: trimmed(source.name)!,
    path: trimmed(source.path)!,
    checksum: source.checksum
  }
  const note = trimmed(value.note)
  if (selector.kind === 'region') {
    const rect = normalizedQuad(selector.rect)
    const text =
      selector.text === undefined
        ? undefined
        : boundedString(selector.text, ANNOTATION_LIMITS.quote)
    const image = sanitizeAcpMessageImage(selector.image)
    if (
      !rect ||
      typeof selector.pageRotation !== 'number' ||
      ![0, 90, 180, 270].includes(selector.pageRotation) ||
      (selector.text !== undefined && !text) ||
      !image
    ) {
      return undefined
    }
    return {
      id,
      kind: 'pdf',
      target: 'agent',
      ...(note ? { note } : {}),
      source: sanitizedSource,
      selector: {
        kind: 'region',
        pageNumber,
        rect,
        pageRotation: selector.pageRotation,
        ...(text ? { text } : {}),
        image
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
    !exact ||
    (selector.prefix !== undefined && !prefix) ||
    (selector.suffix !== undefined && !suffix) ||
    !isRecord(position) ||
    typeof position.start !== 'number' ||
    typeof position.end !== 'number' ||
    !Number.isInteger(position.start) ||
    !Number.isInteger(position.end) ||
    position.start < 0 ||
    position.end !== position.start + exact.length ||
    !quads ||
    quads.length === 0 ||
    quads.some((quad) => !quad) ||
    !trimmed(selector.extractorVersion)
  ) {
    return undefined
  }
  return {
    id,
    kind: 'pdf',
    target: 'agent',
    ...(note ? { note } : {}),
    source: sanitizedSource,
    selector: {
      kind: 'text',
      pageNumber,
      exact,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
      position: { start: position.start, end: position.end },
      quads: quads as PdfNormalizedQuad[],
      extractorVersion: trimmed(selector.extractorVersion)!
    }
  }
}

const sanitizeTextSource = (value: unknown): TextAnnotationSource | undefined => {
  if (!isRecord(value)) return undefined
  const kind = value.kind
  if (kind === 'agent-message') {
    const sessionId = trimmed(value.sessionId)
    const messageId = trimmed(value.messageId)
    return sessionId && messageId ? { kind, sessionId, messageId } : undefined
  }
  if (kind === 'project-file') {
    const projectId = trimmed(value.projectId)
    const path = trimmed(value.path)
    if (!projectId || !path) return undefined
    const name = trimmed(value.name)
    const versionId = trimmed(value.versionId)
    return {
      kind,
      projectId,
      path,
      ...(name ? { name } : {}),
      ...(versionId ? { versionId } : {}),
      ...(trimmed(value.sessionId) ? { sessionId: trimmed(value.sessionId) } : {})
    }
  }
  if (kind === 'session-item') {
    const sessionId = trimmed(value.sessionId)
    const itemId = trimmed(value.itemId)
    const itemType = trimmed(value.itemType)
    if (
      !sessionId ||
      !itemId ||
      !itemType ||
      !SESSION_TEXT_ANNOTATION_ITEM_TYPES.has(itemType as SessionTextAnnotationItemType)
    ) {
      return undefined
    }
    return {
      kind,
      sessionId,
      itemId,
      itemType: itemType as SessionTextAnnotationItemType,
      ...(trimmed(value.sectionId) ? { sectionId: trimmed(value.sectionId) } : {})
    }
  }
  return undefined
}

export const sanitizeAnnotation = (value: unknown): Annotation | undefined => {
  if (!isRecord(value) || value.target !== 'agent') return undefined
  const id = trimmed(value.id)
  if (!id) return undefined
  if (value.kind === 'text') {
    const quote = trimmed(value.quote)
    const source = sanitizeTextSource(value.source)
    const note = trimmed(value.note)
    if (!quote || !source) return undefined
    return { id, kind: 'text', target: 'agent', quote, source, ...(note ? { note } : {}) }
  }
  if (value.kind === 'pdf') return sanitizePdfAnnotation(value, id)
  if (value.kind === 'image-point' && isRecord(value.source) && isRecord(value.point)) {
    const note = trimmed(value.note)
    const source = value.source
    const naturalSize = value.naturalSize
    const x = value.point.x
    const y = value.point.y
    const width = isRecord(naturalSize) ? naturalSize.width : undefined
    const height = isRecord(naturalSize) ? naturalSize.height : undefined
    const sourceKind = source.kind
    const mimeType = trimmed(source.mimeType)
    if (
      !note ||
      (sourceKind !== 'artifact-version' && sourceKind !== 'upload-version') ||
      !trimmed(source.projectId) ||
      !trimmed(source.sessionId) ||
      !trimmed(source.versionId) ||
      !trimmed(source.name) ||
      !trimmed(source.path) ||
      !mimeType ||
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 1 ||
      y < 0 ||
      y > 1 ||
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return undefined
    }
    return {
      id,
      kind: 'image-point',
      target: 'agent',
      note,
      source: {
        kind: sourceKind,
        projectId: trimmed(source.projectId)!,
        sessionId: trimmed(source.sessionId)!,
        versionId: trimmed(source.versionId)!,
        name: trimmed(source.name)!,
        path: trimmed(source.path)!,
        mimeType
      },
      point: { x, y },
      naturalSize: { width, height }
    }
  }
  return undefined
}

export const pdfAnnotationSourceIsFixed = (source: PdfAnnotation['source']): boolean => {
  if (source.kind === 'artifact-version') {
    const identity = parseArtifactVersionLocator(source.path)
    return (
      identity?.projectId === source.projectId &&
      identity.appSessionId === source.sessionId &&
      identity.versionId === source.versionId
    )
  }
  const identity = parseUploadVersionReference(source.path)
  return (
    identity?.projectId === source.projectId &&
    identity.sessionId === source.sessionId &&
    identity.versionId === source.versionId
  )
}

export const sanitizeAnnotations = (value: unknown): Annotation[] => {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const annotations: Annotation[] = []
  for (const candidate of value) {
    const annotation = sanitizeAnnotation(candidate)
    if (!annotation || ids.has(annotation.id)) continue
    ids.add(annotation.id)
    annotations.push(annotation)
    if (annotations.length >= ANNOTATION_LIMITS.count) break
  }
  return validateAnnotations(annotations) ? [] : annotations
}

export const imageVersionKey = (source: ImagePointAnnotation['source']): string =>
  [source.kind, source.projectId, source.sessionId, source.versionId].join('\u0000')

const SUPPORTED_ANNOTATION_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif'
])

export const imageAnnotationSourceIsFixed = (source: ImagePointAnnotation['source']): boolean => {
  if (!SUPPORTED_ANNOTATION_IMAGE_MIME_TYPES.has(source.mimeType.toLowerCase())) return false
  if (source.kind === 'artifact-version') {
    const identity = parseArtifactVersionLocator(source.path)
    return (
      identity?.projectId === source.projectId &&
      identity.appSessionId === source.sessionId &&
      identity.versionId === source.versionId
    )
  }
  const identity = parseUploadVersionReference(source.path)
  return (
    identity?.projectId === source.projectId &&
    identity.sessionId === source.sessionId &&
    identity.versionId === source.versionId
  )
}

export const imageAnnotationFileReference = (
  source: ImagePointAnnotation['source']
): ArtifactReference => ({
  id:
    source.kind === 'artifact-version'
      ? (parseArtifactVersionLocator(source.path)?.artifactId ?? source.versionId)
      : source.versionId,
  name: source.name,
  path: source.path,
  source: source.kind === 'artifact-version' ? 'artifact' : 'upload',
  mimeType: source.mimeType,
  versionId: source.versionId
})

export const prepareImagePointAnnotations = (
  annotations: readonly Annotation[]
): PreparedImagePointAnnotations => {
  const attachments: ArtifactReference[] = []
  const attachmentByVersion = new Map<string, number>()
  const points: PreparedImagePoint[] = []
  for (const annotation of annotations) {
    if (annotation.kind !== 'image-point') continue
    const key = imageVersionKey(annotation.source)
    let attachment = attachmentByVersion.get(key)
    if (attachment === undefined) {
      attachments.push(imageAnnotationFileReference(annotation.source))
      attachment = attachments.length
      attachmentByVersion.set(key, attachment)
    }
    points.push({
      annotationId: annotation.id,
      number: points.length + 1,
      attachment,
      note: annotation.note,
      sourceKind: annotation.source.kind,
      versionId: annotation.source.versionId,
      name: annotation.source.name,
      mimeType: annotation.source.mimeType,
      x: Math.round(
        Math.min(1, Math.max(0, annotation.point.x)) * (annotation.naturalSize.width - 1)
      ),
      y: Math.round(
        Math.min(1, Math.max(0, annotation.point.y)) * (annotation.naturalSize.height - 1)
      ),
      imageWidth: annotation.naturalSize.width,
      imageHeight: annotation.naturalSize.height
    })
  }
  return { attachments, points }
}

const fileReferenceVersionKey = (reference: FileReference): string | undefined =>
  reference.source === 'linked-folder' || !reference.versionId
    ? undefined
    : [reference.source, reference.versionId].join('\u0000')

const mergeImageAnnotationReferences = (
  referencedArtifacts: readonly FileReference[] | undefined,
  imageReferences: readonly ArtifactReference[]
): FileReference[] | undefined => {
  const merged: FileReference[] = [...imageReferences]
  const keys = new Set(merged.map(fileReferenceVersionKey).filter((key): key is string => !!key))
  for (const reference of referencedArtifacts ?? []) {
    const key = fileReferenceVersionKey(reference)
    if (key && keys.has(key)) continue
    if (key) keys.add(key)
    merged.push(reference)
  }
  return merged.length > 0 ? merged : undefined
}

const payloadItem = (
  annotation: Annotation,
  imagePoints: ReadonlyMap<string, PreparedImagePoint>,
  pdfRegionImages: ReadonlyMap<string, number>
):
  | Extract<SideChatAnnotationItem, Readonly<{ type: 'quote' }>>
  | Readonly<{
      type: 'pdf-region'
      source: Readonly<{
        kind: 'pdf'
        versionId: string
        name: string
        checksum: string
        page: number
      }>
      rect: PdfNormalizedRect
      pageRotation: number
      image: number
      content?: string
      instruction?: string
    }>
  | Readonly<{
      type: 'image-point'
      source:
        | Readonly<{
            kind: 'artifact-version'
            artifactId: string
            versionId: string
            name: string
          }>
        | Readonly<{
            kind: 'upload-version'
            versionId: string
            name: string
          }>
      imageAttachment: number
      x: number
      y: number
      instruction: string
    }> => {
  if (annotation.kind === 'text') {
    return {
      type: 'quote',
      content: annotation.quote,
      ...(annotation.note ? { instruction: annotation.note } : {})
    }
  }
  if (annotation.kind === 'pdf') {
    const { selector } = annotation
    if (selector.kind === 'region') {
      const image = pdfRegionImages.get(annotation.id)
      if (image === undefined) {
        throw new Error(
          `PDF region annotation ${annotation.id} was not prepared for Agent context.`
        )
      }
      return {
        type: 'pdf-region',
        source: {
          kind: 'pdf',
          versionId: annotation.source.versionId,
          name: annotation.source.name,
          checksum: annotation.source.checksum,
          page: selector.pageNumber
        },
        rect: selector.rect,
        pageRotation: selector.pageRotation,
        image,
        ...(selector.text ? { content: selector.text } : {}),
        ...(annotation.note ? { instruction: annotation.note } : {})
      }
    }
    return {
      type: 'quote',
      content: selector.exact,
      source: {
        kind: 'pdf',
        versionId: annotation.source.versionId,
        name: annotation.source.name,
        checksum: annotation.source.checksum,
        page: selector.pageNumber,
        selector: {
          ...(selector.prefix ? { prefix: selector.prefix } : {}),
          ...(selector.suffix ? { suffix: selector.suffix } : {}),
          position: selector.position,
          quads: selector.quads,
          extractorVersion: selector.extractorVersion
        }
      },
      ...(annotation.note ? { instruction: annotation.note } : {})
    }
  }
  const point = imagePoints.get(annotation.id)
  if (!point)
    throw new Error(`Image annotation ${annotation.id} was not prepared for Agent context.`)
  const reference = imageAnnotationFileReference(annotation.source)
  const source =
    annotation.source.kind === 'artifact-version'
      ? {
          kind: annotation.source.kind,
          artifactId: reference.id,
          versionId: annotation.source.versionId,
          name: annotation.source.name
        }
      : {
          kind: annotation.source.kind,
          versionId: annotation.source.versionId,
          name: annotation.source.name
        }
  return {
    type: 'image-point',
    source,
    imageAttachment: point.attachment,
    x: point.x,
    y: point.y,
    instruction: point.note
  }
}

const annotationPayloadTextFromPrepared = (
  annotations: readonly Annotation[],
  prepared: PreparedImagePointAnnotations,
  pdfRegionImages: readonly AcpMessageImage[]
): string => {
  if (annotations.length === 0) return ''
  const imagePoints = new Map(prepared.points.map((point) => [point.annotationId, point]))
  let regionImage = 0
  const regionImageByAnnotation = new Map<string, number>()
  for (const annotation of annotations) {
    if (annotation.kind === 'pdf' && annotation.selector.kind === 'region') {
      regionImage += 1
      regionImageByAnnotation.set(annotation.id, regionImage)
    }
  }
  if (regionImage !== pdfRegionImages.length) {
    throw new Error('PDF region annotations were not prepared for Agent context.')
  }
  return `[Annotations]\n${JSON.stringify({
    items: annotations.map((annotation) =>
      payloadItem(annotation, imagePoints, regionImageByAnnotation)
    )
  })}`
}

const preparePdfRegionImages = (annotations: readonly Annotation[]): AcpMessageImage[] =>
  annotations.flatMap((annotation) =>
    annotation.kind === 'pdf' && annotation.selector.kind === 'region'
      ? [annotation.selector.image]
      : []
  )

export const annotationPayloadText = (annotations: readonly Annotation[]): string =>
  annotationPayloadTextFromPrepared(
    annotations,
    prepareImagePointAnnotations(annotations),
    preparePdfRegionImages(annotations)
  )

const sideChatPayloadItem = (
  annotation: Annotation,
  imagePoints: ReadonlyMap<string, PreparedImagePoint>
): SideChatAnnotationItem => {
  if (annotation.kind === 'pdf' && annotation.selector.kind === 'region') {
    return {
      type: 'quote',
      content:
        annotation.selector.text ??
        `Selected PDF region on page ${annotation.selector.pageNumber}.`,
      ...(annotation.note ? { instruction: annotation.note } : {})
    }
  }
  const item = payloadItem(annotation, imagePoints, new Map())
  if (item.type === 'quote') return item
  if (item.type === 'pdf-region') {
    throw new Error('PDF region annotations must be converted before Side chat serialization.')
  }
  return {
    type: item.type,
    source: item.source,
    x: item.x,
    y: item.y,
    instruction: item.instruction
  }
}

const SIDE_CHAT_ANNOTATION_MARKER = '[Annotations]\n'

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

const sideChatAnnotationItem = (value: unknown): SideChatAnnotationItem | undefined => {
  if (!isRecord(value)) return undefined
  if (value.type === 'quote') {
    const keys = [
      'type',
      'content',
      ...(value.source === undefined ? [] : ['source']),
      ...(value.instruction === undefined ? [] : ['instruction'])
    ]
    const source = value.source
    if (
      !hasExactKeys(value, keys) ||
      typeof value.content !== 'string' ||
      !value.content ||
      value.content.length > ANNOTATION_LIMITS.quote ||
      (value.instruction !== undefined &&
        (typeof value.instruction !== 'string' ||
          !value.instruction ||
          value.instruction.length > ANNOTATION_LIMITS.note)) ||
      (source !== undefined &&
        (!isRecord(source) ||
          !hasExactKeys(source, ['kind', 'versionId', 'name', 'checksum', 'page', 'selector']) ||
          source.kind !== 'pdf' ||
          typeof source.versionId !== 'string' ||
          !source.versionId ||
          typeof source.name !== 'string' ||
          !source.name ||
          typeof source.checksum !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(source.checksum) ||
          typeof source.page !== 'number' ||
          !Number.isInteger(source.page) ||
          source.page < 1 ||
          !isRecord(source.selector) ||
          !hasExactKeys(source.selector, [
            ...(source.selector.prefix === undefined ? [] : ['prefix']),
            ...(source.selector.suffix === undefined ? [] : ['suffix']),
            'position',
            'quads',
            'extractorVersion'
          ]) ||
          (source.selector.prefix !== undefined && !boundedString(source.selector.prefix, 256)) ||
          (source.selector.suffix !== undefined && !boundedString(source.selector.suffix, 256)) ||
          !isRecord(source.selector.position) ||
          typeof source.selector.position.start !== 'number' ||
          !Number.isInteger(source.selector.position.start) ||
          source.selector.position.start < 0 ||
          typeof source.selector.position.end !== 'number' ||
          source.selector.position.end !== source.selector.position.start + value.content.length ||
          !Array.isArray(source.selector.quads) ||
          source.selector.quads.length === 0 ||
          source.selector.quads.some((quad) => !normalizedQuad(quad)) ||
          !trimmed(source.selector.extractorVersion)))
    ) {
      return undefined
    }
    return value as SideChatAnnotationItem
  }
  if (
    value.type !== 'image-point' ||
    !hasExactKeys(value, ['type', 'source', 'x', 'y', 'instruction']) ||
    !isRecord(value.source) ||
    typeof value.x !== 'number' ||
    !Number.isInteger(value.x) ||
    value.x < 0 ||
    typeof value.y !== 'number' ||
    !Number.isInteger(value.y) ||
    value.y < 0 ||
    typeof value.instruction !== 'string' ||
    !value.instruction ||
    value.instruction.length > ANNOTATION_LIMITS.note
  ) {
    return undefined
  }
  const source = value.source
  const sourceKeys =
    source.kind === 'artifact-version'
      ? ['kind', 'artifactId', 'versionId', 'name']
      : ['kind', 'versionId', 'name']
  if (
    (source.kind !== 'artifact-version' && source.kind !== 'upload-version') ||
    !hasExactKeys(source, sourceKeys) ||
    (source.kind === 'artifact-version' &&
      (typeof source.artifactId !== 'string' || !source.artifactId)) ||
    typeof source.versionId !== 'string' ||
    !source.versionId ||
    typeof source.name !== 'string' ||
    !source.name
  ) {
    return undefined
  }
  return value as SideChatAnnotationItem
}

export const sideChatAnnotationText = (
  text: string,
  annotations: readonly Annotation[]
): string => {
  if (annotations.length === 0) return text.trim()
  const prepared = prepareImagePointAnnotations(annotations)
  const imagePoints = new Map(prepared.points.map((point) => [point.annotationId, point]))
  const suffix = `${SIDE_CHAT_ANNOTATION_MARKER}${JSON.stringify({
    items: annotations.map((annotation) => sideChatPayloadItem(annotation, imagePoints))
  })}`
  return [text.trim(), suffix].filter(Boolean).join('\n\n')
}

export const parseSideChatAnnotationText = (
  value: string
): ParsedSideChatAnnotationText | undefined => {
  const markerIndex = value.lastIndexOf(SIDE_CHAT_ANNOTATION_MARKER)
  if (
    markerIndex < 0 ||
    (markerIndex > 0 && value.slice(markerIndex - 2, markerIndex) !== '\n\n')
  ) {
    return undefined
  }
  const text = markerIndex === 0 ? '' : value.slice(0, markerIndex - 2)
  const json = value.slice(markerIndex + SIDE_CHAT_ANNOTATION_MARKER.length)
  if (
    text.trim() !== text ||
    SIDE_CHAT_ANNOTATION_MARKER.length + json.length > ANNOTATION_LIMITS.payload
  ) {
    return undefined
  }
  try {
    const payload: unknown = JSON.parse(json)
    if (!isRecord(payload) || !hasExactKeys(payload, ['items']) || !Array.isArray(payload.items)) {
      return undefined
    }
    if (payload.items.length === 0 || payload.items.length > ANNOTATION_LIMITS.count)
      return undefined
    const items = payload.items.map(sideChatAnnotationItem)
    if (items.some((item) => item === undefined)) return undefined
    if (JSON.stringify(payload) !== json) return undefined
    return { text, items: items as SideChatAnnotationItem[] }
  } catch {
    return undefined
  }
}

export const prepareAnnotationsForAgent = (
  text: string,
  annotations: readonly Annotation[],
  referencedArtifacts?: readonly FileReference[]
): PreparedAnnotationsForAgent => {
  const preparedImages = prepareImagePointAnnotations(annotations)
  const regionImages = preparePdfRegionImages(annotations)
  const annotationText = annotationPayloadTextFromPrepared(
    annotations,
    preparedImages,
    regionImages
  )
  const promptText = [text.trim(), annotationText].filter(Boolean).join('\n\n')
  return {
    promptText,
    referencedArtifacts: mergeImageAnnotationReferences(
      referencedArtifacts,
      preparedImages.attachments
    ),
    ...(regionImages.length > 0 ? { images: regionImages } : {})
  }
}

export const validateAnnotations = (
  annotations: readonly Annotation[],
  messageText = ''
): AnnotationValidationError | undefined => {
  if (annotations.length > ANNOTATION_LIMITS.count) return 'too-many'
  let regionImageCount = 0
  let regionImageBytes = 0
  for (const annotation of annotations) {
    if (!sanitizeAnnotation(annotation)) return 'invalid'
    if (annotation.kind === 'image-point' && !imageAnnotationSourceIsFixed(annotation.source)) {
      return 'invalid'
    }
    if (annotation.kind === 'pdf' && !pdfAnnotationSourceIsFixed(annotation.source))
      return 'invalid'
    if (
      (annotation.kind === 'text' && annotation.quote.length > ANNOTATION_LIMITS.quote) ||
      (annotation.kind === 'pdf' &&
        annotation.selector.kind === 'text' &&
        annotation.selector.exact.length > ANNOTATION_LIMITS.quote)
    ) {
      return 'quote-too-long'
    }
    if (annotation.kind === 'pdf' && annotation.selector.kind === 'region') {
      regionImageCount += 1
      regionImageBytes += annotation.selector.image.byteLength
    }
    if (annotation.note && annotation.note.length > ANNOTATION_LIMITS.note) return 'note-too-long'
  }
  if (
    regionImageCount > MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE ||
    regionImageBytes > MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE
  ) {
    return 'payload-too-large'
  }
  if (annotationPayloadText(annotations).length > ANNOTATION_LIMITS.payload) {
    return 'payload-too-large'
  }
  if (
    annotations.length > 0 &&
    [messageText.trim(), annotationPayloadText(annotations)].filter(Boolean).join('\n\n').length >
      ANNOTATION_LIMITS.messagePayload
  ) {
    return 'payload-too-large'
  }
  return undefined
}
