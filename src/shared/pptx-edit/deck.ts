import { relationshipsOf, type DocSource } from './context'
import { PptxEditError } from './errors'
import { NS, children, descendants, firstChild, resolveTarget } from './package'

export type SlideRef = { slideId: number; relId: string; part: string }

export type Presentation = {
  doc: Document
  idList: Element
  slides: SlideRef[]
}

export const readPresentation = (source: DocSource): Presentation => {
  const doc = source.doc('ppt/presentation.xml')
  const idList = firstChild(doc.documentElement, NS.p, 'sldIdLst')
  const rels = new Map(relationshipsOf(source, 'ppt/presentation.xml').map((r) => [r.id, r]))
  const slides: SlideRef[] = []
  for (const entry of idList ? children(idList, NS.p, 'sldId') : []) {
    const relId = entry.getAttributeNS(NS.r, 'id') ?? ''
    const rel = rels.get(relId)
    const slideId = Number(entry.getAttribute('id'))
    if (!rel || !Number.isInteger(slideId)) {
      throw new PptxEditError('INVALID_PACKAGE', 'Slide list references a missing slide part.')
    }
    slides.push({ slideId, relId, part: resolveTarget('ppt/presentation.xml', rel.target) })
  }
  return { doc, idList: idList ?? doc.documentElement, slides }
}

export const requireSlide = (presentation: Presentation, slideId: number): SlideRef => {
  const slide = presentation.slides.find((entry) => entry.slideId === slideId)
  if (!slide) throw new PptxEditError('SLIDE_NOT_FOUND', `Slide ${slideId} does not exist.`)
  return slide
}

const SHAPE_NAMES = ['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'] as const
const PROPS_NAMES: Record<string, string> = {
  sp: 'nvSpPr',
  pic: 'nvPicPr',
  graphicFrame: 'nvGraphicFramePr',
  grpSp: 'nvGrpSpPr',
  cxnSp: 'nvCxnSpPr'
}

export type ShapeKind = (typeof SHAPE_NAMES)[number]

export const isShapeElement = (node: Node): node is Element =>
  node.nodeType === 1 &&
  (node as Element).namespaceURI === NS.p &&
  (SHAPE_NAMES as readonly string[]).includes((node as Element).localName)

export const shapeKindOf = (shape: Element): ShapeKind => shape.localName as ShapeKind

export const shapeProps = (shape: Element): Element | undefined => {
  const container = firstChild(shape, NS.p, PROPS_NAMES[shape.localName] ?? '')
  return container ? firstChild(container, NS.p, 'cNvPr') : undefined
}

export const shapeIdOf = (shape: Element): number => Number(shapeProps(shape)?.getAttribute('id'))

export const shapeChildren = (container: Element): Element[] =>
  Array.from(container.childNodes).filter(isShapeElement)

export const slideTree = (doc: Document): Element => {
  const cSld = firstChild(doc.documentElement, NS.p, 'cSld')
  const tree = cSld ? firstChild(cSld, NS.p, 'spTree') : undefined
  if (!tree) throw new PptxEditError('INVALID_PACKAGE', 'Slide has no shape tree.')
  return tree
}

export const findShape = (doc: Document, shapeId: number): Element => {
  for (const name of SHAPE_NAMES) {
    for (const shape of descendants(doc.documentElement, NS.p, name)) {
      if (shapeIdOf(shape) === shapeId) return shape
    }
  }
  throw new PptxEditError('SHAPE_NOT_FOUND', `Shape ${shapeId} does not exist on the slide.`)
}

export const xfrmOf = (shape: Element): Element | undefined => {
  if (shape.localName === 'graphicFrame') return firstChild(shape, NS.p, 'xfrm')
  const propsName = shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr'
  const props = firstChild(shape, NS.p, propsName)
  return props ? firstChild(props, NS.a, 'xfrm') : undefined
}

export const nextShapeId = (doc: Document): number => {
  let max = 1 // the shape tree root group always owns id 1
  for (const name of SHAPE_NAMES) {
    for (const shape of descendants(doc.documentElement, NS.p, name)) {
      const value = shapeIdOf(shape)
      if (Number.isInteger(value) && value > max) max = value
    }
  }
  return max + 1
}
