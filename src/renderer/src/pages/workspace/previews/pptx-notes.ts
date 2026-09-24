import { strFromU8, unzip } from 'fflate'

const NOTES_XML_PATTERN = /^ppt\/notesSlides\/notesSlide\d+\.xml$/
const NOTES_RELATIONSHIP_PATTERN = /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/
const MAX_NOTES_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_NOTES_TEXT_LENGTH = 128 * 1024

const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SLIDE_RELATIONSHIP_SUFFIX = '/slide'

export type PptxNotesBySlide = ReadonlyMap<number, string>

const parseXml = (source: string): XMLDocument | undefined => {
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0) return undefined
  return document
}

const readText = (paragraph: Element): string =>
  Array.from(paragraph.getElementsByTagNameNS(DRAWING_NS, 't'), (text) => text.textContent ?? '')
    .join('')
    .replace(/\s+$/u, '')

const readNotesText = (source: string): string => {
  const document = parseXml(source)
  if (!document) return ''

  const shapes = Array.from(document.getElementsByTagNameNS(PRESENTATION_NS, 'sp'))
  const bodyShapes = shapes.filter((shape) => {
    const placeholder = shape.getElementsByTagNameNS(PRESENTATION_NS, 'ph')[0]
    const type = placeholder?.getAttribute('type')
    return type === 'body' || type === 'obj'
  })
  const candidates = bodyShapes.length > 0 ? bodyShapes : [document.documentElement]
  const paragraphs = candidates.flatMap((shape) =>
    Array.from(shape.getElementsByTagNameNS(DRAWING_NS, 'p'), readText)
  )
  return paragraphs
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_NOTES_TEXT_LENGTH)
}

const readSlideNumber = (source: string): number | undefined => {
  const document = parseXml(source)
  if (!document) return undefined

  for (const relationship of Array.from(
    document.getElementsByTagNameNS(RELATIONSHIP_NS, 'Relationship')
  )) {
    const type = relationship.getAttribute('Type') ?? ''
    const target = relationship.getAttribute('Target') ?? ''
    if (!type.endsWith(SLIDE_RELATIONSHIP_SUFFIX)) continue
    const match = target.match(/(?:^|\/)slide(\d+)\.xml$/u)
    if (match) return Number(match[1])
  }
  return undefined
}

const isNotesPart = (name: string): boolean =>
  NOTES_XML_PATTERN.test(name) || NOTES_RELATIONSHIP_PATTERN.test(name)

const readNotesParts = (
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<Record<string, Uint8Array>> =>
  new Promise((resolve, reject) => {
    let settled = false
    let terminate: (() => void) | undefined
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
          filter: (file) => isNotesPart(file.name) && file.originalSize <= MAX_NOTES_ENTRY_BYTES
        },
        (error, files) => finish(error, files)
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

    for (const [name, bytes] of Object.entries(parts)) {
      if (!NOTES_XML_PATTERN.test(name)) continue
      const noteNumber = name.match(/notesSlide(\d+)\.xml$/u)?.[1]
      if (!noteNumber) continue
      const relationshipName = `ppt/notesSlides/_rels/notesSlide${noteNumber}.xml.rels`
      const slideNumber = parts[relationshipName]
        ? readSlideNumber(strFromU8(parts[relationshipName]))
        : Number(noteNumber)
      if (!slideNumber) continue
      const text = readNotesText(strFromU8(bytes))
      if (text) notes.set(slideNumber - 1, text)
    }
    return notes
  } catch (error) {
    if (signal.aborted) throw error
    // Notes are an optional enhancement. A malformed or unsupported notes part must not prevent
    // the slide preview from opening.
    return new Map()
  }
}
