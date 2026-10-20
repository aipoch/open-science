import { strFromU8, unzip } from 'fflate'

const NOTES_XML_PATTERN = /^ppt\/notesSlides\/notesSlide\d+\.xml$/
const NOTES_RELATIONSHIP_PATTERN = /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/
const PRESENTATION_XML = 'ppt/presentation.xml'
const PRESENTATION_RELATIONSHIPS = 'ppt/_rels/presentation.xml.rels'
const MAX_NOTES_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_NOTES_TEXT_LENGTH = 128 * 1024
const MAX_NOTES_PARTS = 512
const MAX_NOTES_TOTAL_BYTES = 16 * 1024 * 1024

const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const STRICT_PRESENTATION_NS = 'http://purl.oclc.org/ooxml/presentationml/main'
const STRICT_DRAWING_NS = 'http://purl.oclc.org/ooxml/drawingml/main'
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const STRICT_OFFICE_RELATIONSHIP_NS = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
const SLIDE_RELATIONSHIP_SUFFIX = '/slide'

export type PptxNotesBySlide = ReadonlyMap<number, string>

const parseXml = (source: string): XMLDocument | undefined => {
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0) return undefined
  return document
}

const readText = (paragraph: Element, drawingNamespace: string): string =>
  Array.from(
    paragraph.getElementsByTagNameNS(drawingNamespace, 't'),
    (text) => text.textContent ?? ''
  )
    .join('')
    .replace(/\s+$/u, '')

const readNotesText = (source: string): string => {
  const document = parseXml(source)
  if (!document) return ''
  const presentationNamespace = document.documentElement.namespaceURI
  if (presentationNamespace !== PRESENTATION_NS && presentationNamespace !== STRICT_PRESENTATION_NS)
    return ''
  const drawingNamespace =
    presentationNamespace === STRICT_PRESENTATION_NS ? STRICT_DRAWING_NS : DRAWING_NS

  const shapes = Array.from(document.getElementsByTagNameNS(presentationNamespace, 'sp'))
  const bodyShapes = shapes.filter((shape) => {
    const placeholder = shape.getElementsByTagNameNS(presentationNamespace, 'ph')[0]
    const type = placeholder?.getAttribute('type')
    return type === 'body' || type === 'obj'
  })
  const candidates = bodyShapes.length > 0 ? bodyShapes : [document.documentElement]
  const paragraphs = candidates.flatMap((shape) =>
    Array.from(shape.getElementsByTagNameNS(drawingNamespace, 'p'), (paragraph) =>
      readText(paragraph, drawingNamespace)
    )
  )
  return paragraphs
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_NOTES_TEXT_LENGTH)
}

const resolvePptxTarget = (sourcePart: string, target: string): string => {
  const segments = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1)
  for (const segment of target.replace(/^\/+/, '').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

const readSlideTarget = (sourcePart: string, source: string): string | undefined => {
  const document = parseXml(source)
  if (!document) return undefined

  for (const relationship of Array.from(
    document.getElementsByTagNameNS(RELATIONSHIP_NS, 'Relationship')
  )) {
    const type = relationship.getAttribute('Type') ?? ''
    const target = relationship.getAttribute('Target') ?? ''
    if (!type.endsWith(SLIDE_RELATIONSHIP_SUFFIX)) continue
    return resolvePptxTarget(sourcePart, target)
  }
  return undefined
}

const readPresentationSlideOrder = (
  presentationSource: string,
  relationshipsSource: string
): Map<string, number> => {
  const presentation = parseXml(presentationSource)
  const relationships = parseXml(relationshipsSource)
  if (!presentation || !relationships) return new Map()
  const presentationNamespace = presentation.documentElement.namespaceURI
  if (presentationNamespace !== PRESENTATION_NS && presentationNamespace !== STRICT_PRESENTATION_NS)
    return new Map()
  const relationshipNamespace =
    presentationNamespace === STRICT_PRESENTATION_NS
      ? STRICT_OFFICE_RELATIONSHIP_NS
      : OFFICE_RELATIONSHIP_NS

  const targetsById = new Map<string, string>()
  for (const relationship of Array.from(
    relationships.getElementsByTagNameNS(RELATIONSHIP_NS, 'Relationship')
  )) {
    const id = relationship.getAttribute('Id')
    const target = relationship.getAttribute('Target')
    if (id && target) targetsById.set(id, resolvePptxTarget(PRESENTATION_XML, target))
  }

  const order = new Map<string, number>()
  const slideIds = Array.from(presentation.getElementsByTagNameNS(presentationNamespace, 'sldId'))
  for (const [index, slideId] of slideIds.entries()) {
    const relationshipId = slideId.getAttributeNS(relationshipNamespace, 'id')
    const target = relationshipId ? targetsById.get(relationshipId) : undefined
    if (target) order.set(target, index)
  }
  return order
}

const isNotesPart = (name: string): boolean =>
  NOTES_XML_PATTERN.test(name) || NOTES_RELATIONSHIP_PATTERN.test(name)

const isPresentationPart = (name: string): boolean =>
  name === PRESENTATION_XML || name === PRESENTATION_RELATIONSHIPS

const readNotesParts = (
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<Record<string, Uint8Array>> =>
  new Promise((resolve, reject) => {
    let settled = false
    let terminate: (() => void) | undefined
    let acceptedParts = 0
    let acceptedBytes = 0
    let budgetExceeded = false
    const finish = (error: unknown, files?: Record<string, Uint8Array>): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(files ?? {})
    }
    const onAbort = (): void => {
      terminate?.()
      finish(signal.reason ?? new DOMException('PPTX notes extraction aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }

    try {
      terminate = unzip(
        bytes,
        {
          filter: (file) => {
            if (isPresentationPart(file.name)) return true
            if (!isNotesPart(file.name) || file.originalSize > MAX_NOTES_ENTRY_BYTES) return false
            if (
              acceptedParts >= MAX_NOTES_PARTS ||
              acceptedBytes + file.originalSize > MAX_NOTES_TOTAL_BYTES
            ) {
              budgetExceeded = true
              return false
            }
            acceptedParts += 1
            acceptedBytes += file.originalSize
            return true
          }
        },
        (error, files) =>
          finish(
            error ?? (budgetExceeded ? new Error('PPTX notes resource limit exceeded') : undefined),
            files
          )
      )
    } catch (error) {
      finish(error)
    }
  })

export const extractPptxNotes = async (
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<PptxNotesBySlide> => {
  try {
    const parts = await readNotesParts(bytes, signal)
    const notes = new Map<number, string>()
    const slideOrder =
      parts[PRESENTATION_XML] && parts[PRESENTATION_RELATIONSHIPS]
        ? readPresentationSlideOrder(
            strFromU8(parts[PRESENTATION_XML]),
            strFromU8(parts[PRESENTATION_RELATIONSHIPS])
          )
        : new Map<string, number>()

    for (const [name, bytes] of Object.entries(parts)) {
      if (!NOTES_XML_PATTERN.test(name)) continue
      const noteNumber = name.match(/notesSlide(\d+)\.xml$/u)?.[1]
      if (!noteNumber) continue
      const relationshipName = `ppt/notesSlides/_rels/notesSlide${noteNumber}.xml.rels`
      const notePartName = `ppt/notesSlides/notesSlide${noteNumber}.xml`
      const slideTarget = parts[relationshipName]
        ? readSlideTarget(notePartName, strFromU8(parts[relationshipName]))
        : undefined
      const slideIndex = slideTarget ? slideOrder.get(slideTarget) : undefined
      const fallbackSlideNumber = slideTarget?.match(/(?:^|\/)slide(\d+)\.xml$/u)?.[1]
      const index =
        slideIndex ??
        (fallbackSlideNumber ? Number(fallbackSlideNumber) - 1 : Number(noteNumber) - 1)
      if (index < 0) continue
      const text = readNotesText(strFromU8(bytes))
      if (text) notes.set(index, text)
    }
    return notes
  } catch (error) {
    if (signal.aborted) throw error
    // Notes are an optional enhancement. A malformed or unsupported notes part must not prevent
    // the slide preview from opening.
    return new Map()
  }
}
