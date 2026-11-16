import type { EditContext } from './context'
import { findShape, readPresentation, requireSlide } from './deck'
import { PptxEditError } from './errors'
import type { PptxOperation } from './operations'
import { NS, children, descendants } from './package'
import { addRelationship, freePartName, relType } from './parts'
import { slideDocFor } from './shapes'

type ReplaceImage = Extract<PptxOperation, { op: 'replaceImage' }>

const EXTENSIONS: Record<ReplaceImage['mime'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif'
}

const SIGNATURES: Record<ReplaceImage['mime'], number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38]
}

const decodeBase64 = (value: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  } catch {
    throw new PptxEditError('INVALID_OPERATION', 'Image data is not valid base64.')
  }
}

const ensureDefaultType = (ctx: EditContext, extension: string, mime: string): void => {
  const doc = ctx.edit('[Content_Types].xml')
  const known = children(doc.documentElement, NS.ct, 'Default').some(
    (node) => node.getAttribute('Extension')?.toLowerCase() === extension
  )
  if (known) return
  const node = doc.createElementNS(NS.ct, 'Default')
  node.setAttribute('Extension', extension)
  node.setAttribute('ContentType', mime)
  doc.documentElement.insertBefore(node, doc.documentElement.firstChild)
}

export const replaceImage = (ctx: EditContext, op: ReplaceImage): void => {
  const slide = requireSlide(readPresentation(ctx), op.slideId)
  const shape = findShape(slideDocFor(ctx, op.slideId), op.shapeId)
  const blip = shape.localName === 'pic' ? descendants(shape, NS.a, 'blip')[0] : undefined
  if (!blip) throw new PptxEditError('UNSUPPORTED_SHAPE', `Shape ${op.shapeId} is not a picture.`)
  const bytes = decodeBase64(op.dataBase64)
  if (!SIGNATURES[op.mime].every((byte, index) => bytes[index] === byte)) {
    throw new PptxEditError('INVALID_OPERATION', 'Image bytes do not match the declared type.')
  }
  const extension = EXTENSIONS[op.mime]
  const part = freePartName(ctx, 'ppt/media/', 'image', extension)
  ctx.putBytes(part, bytes)
  ensureDefaultType(ctx, extension, op.mime)
  const relId = addRelationship(ctx, slide.part, relType('image'), `../media/${part.slice(10)}`)
  blip.setAttributeNS(NS.r, 'r:embed', relId)
}
