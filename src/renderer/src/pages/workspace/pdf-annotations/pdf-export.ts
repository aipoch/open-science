import { PDFDocument, PDFHexString, PDFName, PDFDict, PDFRef, PDFString } from 'pdf-lib'
import {
  PDF_EXPORT_MAX_BYTES,
  PDF_EXPORT_MAX_MARKS,
  type PdfExportRequest
} from './pdf-export-contract'

const TYPES = {
  highlight: 'Highlight',
  underline: 'Underline',
  squiggly: 'Squiggly',
  strikethrough: 'StrikeOut',
  area: 'Square',
  'page-note': 'Text',
  'document-note': 'Text'
} as const
const COLORS = {
  yellow: [1, 0.84, 0.16],
  blue: [0.25, 0.55, 1],
  green: [0.22, 0.75, 0.38],
  pink: [0.96, 0.38, 0.62],
  purple: [0.64, 0.42, 0.94]
} as const
const op = (values: number[], operator: string): string =>
  `${values.map((value) => Number(value.toFixed(5))).join(' ')} ${operator}`
const pdfDate = (date: string): string => {
  const time = new Date(date)
  if (!Number.isFinite(time.getTime())) throw new Error('invalid-annotations')
  return `D:${time.toISOString().slice(0, 19).replace(/[-:T]/gu, '')}Z`
}

/** Runs only inside the disposable export Worker; never on the scrolling/rendering path. */
export const exportAnnotatedPdf = async (request: PdfExportRequest): Promise<ArrayBuffer> => {
  if (!request.data.byteLength || request.data.byteLength > PDF_EXPORT_MAX_BYTES)
    throw new Error('too-large')
  if (request.marks.length > PDF_EXPORT_MAX_MARKS || (request.nativeRefs?.length ?? 0) > 500)
    throw new Error('invalid-annotations')
  const checksum = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', request.data)),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
  if (checksum !== request.checksum) throw new Error('source-changed')

  let document: Awaited<ReturnType<typeof PDFDocument.load>>
  try {
    document = await PDFDocument.load(request.data, { updateMetadata: false })
  } catch (error) {
    if (error instanceof Error && error.name === 'EncryptedPDFError') throw new Error('encrypted')
    throw error
  }
  const context = document.context
  // Rewriting invalidates signatures. Fail before generating any output, including signed forms.
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue
    if (
      object.get(PDFName.of('Type')) === PDFName.of('Sig') ||
      (object.get(PDFName.of('ByteRange')) && object.get(PDFName.of('Contents')))
    )
      throw new Error('signed')
  }
  const pages = document.getPages()
  const nativeRefs = new Map<number, Set<string>>()
  for (const ref of request.nativeRefs ?? []) {
    if (
      !Number.isInteger(ref.pageNumber) ||
      !pages[ref.pageNumber - 1] ||
      !/^\d+R\d*$/.test(ref.id)
    )
      throw new Error('invalid-annotations')
    const refs = nativeRefs.get(ref.pageNumber) ?? new Set<string>()
    refs.add(ref.id)
    nativeRefs.set(ref.pageNumber, refs)
  }
  const managedNames = new Set(request.marks.map((mark) => `open-science:${mark.id}`))
  const nativeId = (ref: PDFRef): string => `${ref.objectNumber}R${ref.generationNumber || ''}`
  for (const [index, page] of pages.entries()) {
    const annots = page.node.Annots()
    if (!annots) continue
    const originals = nativeRefs.get(index + 1)
    // Remove only originals recorded by a committed import, and their popup windows.
    // Unsupported annotations and those beyond the import limit stay byte-semantically intact.
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i)
      const object = context.lookup(ref)
      if (!(object instanceof PDFDict)) continue
      const name = object.get(PDFName.of('NM'))
      const parent = object.get(PDFName.of('Parent'))
      if (
        (ref instanceof PDFRef && originals?.has(nativeId(ref))) ||
        (object.get(PDFName.of('Subtype')) === PDFName.of('Popup') &&
          parent instanceof PDFRef &&
          originals?.has(nativeId(parent))) ||
        ((name instanceof PDFString || name instanceof PDFHexString) &&
          managedNames.has(name.decodeText()))
      )
        annots.remove(i)
    }
  }
  const ids = new Set<string>()
  for (const mark of request.marks) {
    const page = pages[mark.pageNumber - 1]
    const color = COLORS[mark.color ?? 'yellow']
    if (
      !Number.isInteger(mark.pageNumber) ||
      !page ||
      !TYPES[mark.kind] ||
      !color ||
      ids.has(mark.id) ||
      !mark.quads.length ||
      mark.quads.length > 256 ||
      mark.quads.some((quad) => quad.length !== 8 || !quad.every(Number.isFinite))
    )
      throw new Error('invalid-annotations')
    ids.add(mark.id)
    const xs = mark.quads.flatMap((q) => [q[0], q[2], q[4], q[6]])
    const ys = mark.quads.flatMap((q) => [q[1], q[3], q[5], q[7]])
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Error('invalid-annotations')
    const margin = 1
    const rect = bounds.map((value, i) => value + (i < 2 ? -margin : margin))
    const width = rect[2] - rect[0],
      height = rect[3] - rect[1]
    const opacity = mark.kind === 'highlight' ? 0.4 : mark.kind === 'area' ? 0.25 : 1
    const commands = ['q', '/GS0 gs', op([...color], 'rg'), op([...color], 'RG'), '1 w']
    for (const quad of mark.quads) {
      const q = quad.map((value, i) => value - rect[i % 2])
      const [tx, ty, rx, ry, bx, by, ex, ey] = q
      if (mark.kind === 'highlight' || mark.kind === 'area') {
        commands.push(
          op([tx, ty], 'm'),
          op([rx, ry], 'l'),
          op([ex, ey], 'l'),
          op([bx, by], 'l'),
          'h',
          mark.kind === 'area' ? 'B' : 'f'
        )
      } else if (mark.kind === 'underline' || mark.kind === 'strikethrough') {
        const fraction = mark.kind === 'underline' ? 0.1 : 0.5
        commands.push(
          op([bx + (tx - bx) * fraction, by + (ty - by) * fraction], 'm'),
          op([ex + (rx - ex) * fraction, ey + (ry - ey) * fraction], 'l'),
          'S'
        )
      } else if (mark.kind === 'squiggly') {
        const length = Math.hypot(ex - bx, ey - by)
        const lineHeight = Math.hypot(tx - bx, ty - by)
        if (!length || !lineHeight) throw new Error('invalid-annotations')
        const amplitude = Math.min(1, lineHeight / 8)
        const segments = Math.min(100_000, Math.max(2, Math.ceil(length / (2 * amplitude))))
        const dx = ((tx - bx) / lineHeight) * amplitude
        const dy = ((ty - by) / lineHeight) * amplitude
        commands.push(op([bx + dx, by + dy], 'm'))
        for (let i = 1; i <= segments; i++)
          commands.push(
            op(
              [
                bx + ((ex - bx) * i) / segments + (i % 2 ? 0 : dx),
                by + ((ey - by) * i) / segments + (i % 2 ? 0 : dy)
              ],
              'l'
            )
          )
        commands.push('S')
      } else {
        commands.push(op([margin, margin, width - 2, height - 2], 're'), 'f', '0.2 G')
        for (const fraction of [0.3, 0.5, 0.7])
          commands.push(
            op([width * 0.2, height * fraction], 'm'),
            op([width * 0.8, height * fraction], 'l'),
            'S'
          )
      }
    }
    commands.push('Q')
    const appearanceCommands = commands.join('\n')
    // Small paths do not justify a compressor's workspace for every annotation.
    const appearance = context.register(
      context[appearanceCommands.length < 1024 ? 'stream' : 'flateStream'](appearanceCommands, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [0, 0, width, height],
        Resources: {
          ExtGState: {
            GS0: {
              Type: 'ExtGState',
              ca: opacity,
              CA: opacity,
              BM: mark.kind === 'highlight' ? 'Multiply' : 'Normal'
            }
          }
        }
      })
    )
    const isMarkup = !['area', 'page-note', 'document-note'].includes(mark.kind)
    const annotation = context.obj({
      Type: 'Annot',
      Subtype: TYPES[mark.kind],
      P: page.ref,
      NM: PDFHexString.fromText(`open-science:${mark.id}`),
      T: PDFHexString.fromText('Open-Science'),
      Subj: PDFHexString.fromText(mark.kind),
      Contents: PDFHexString.fromText(mark.note),
      CreationDate: PDFHexString.fromText(pdfDate(mark.createdAt)),
      M: PDFHexString.fromText(pdfDate(mark.updatedAt)),
      F: 4,
      C: [...color],
      CA: opacity,
      Rect: rect,
      AP: { N: appearance },
      ...(isMarkup ? { QuadPoints: mark.quads.flat() } : {}),
      ...(mark.kind === 'area' ? { IC: [...color], RD: [1, 1, 1, 1], BS: { W: 1, S: 'S' } } : {}),
      ...(TYPES[mark.kind] === 'Text' ? { Name: 'Note', Open: false } : {})
    })
    // addAnnot normalizes page contents; append directly to preserve original streams.
    let annotations = page.node.Annots()
    if (!annotations) {
      annotations = context.obj([])
      page.node.set(PDFName.of('Annots'), annotations)
    }
    annotations.push(context.register(annotation))
  }
  const bytes = await document.save({ useObjectStreams: true, updateFieldAppearances: false })
  if (bytes.byteLength > PDF_EXPORT_MAX_BYTES) throw new Error('too-large')
  return bytes.buffer as ArrayBuffer
}
