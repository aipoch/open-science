import type { DocSource, EditContext } from './context'
import { relationshipsOf } from './context'
import { readPresentation, requireSlide, slideTree } from './deck'
import { el } from './shapes'
import { createTextBody, writeTextBody } from './text'
import { PptxEditError } from './errors'
import type { PptxOperation } from './operations'
import { NS, children, relsPathFor, resolveTarget } from './package'
import { XMLSerializer } from '@xmldom/xmldom'
import {
  addOverride,
  addRelationship,
  freePartName,
  relType,
  removeOverride,
  removeRelationship
} from './parts'

type Op<T extends PptxOperation['op']> = Extract<PptxOperation, { op: T }>

export const SLIDE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
export const NOTES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'

const slideEntry = (idList: Element, slideId: number): Element | undefined =>
  children(idList, NS.p, 'sldId').find((node) => node.getAttribute('id') === String(slideId))

export const notesPartOf = (ctx: DocSource, slidePart: string): string | undefined => {
  const rel = relationshipsOf(ctx, slidePart).find((r) => r.type === relType('notesSlide'))
  return rel ? resolveTarget(slidePart, rel.target) : undefined
}

export const moveSlide = (ctx: EditContext, op: Op<'moveSlide'>): void => {
  const presentation = readPresentation(ctx)
  requireSlide(presentation, op.slideId)
  ctx.edit('ppt/presentation.xml')
  const node = slideEntry(presentation.idList, op.slideId)
  if (!node) return
  presentation.idList.removeChild(node)
  const rest = children(presentation.idList, NS.p, 'sldId')
  presentation.idList.insertBefore(node, rest[Math.min(op.toIndex, rest.length)] ?? null)
}

const removePart = (ctx: EditContext, part: string): void => {
  ctx.remove(part)
  ctx.remove(relsPathFor(part))
  removeOverride(ctx, part)
}

export const deleteSlide = (ctx: EditContext, op: Op<'deleteSlide'>): void => {
  const presentation = readPresentation(ctx)
  const slide = requireSlide(presentation, op.slideId)
  if (presentation.slides.length === 1) {
    throw new PptxEditError('INVALID_OPERATION', 'A presentation must keep at least one slide.')
  }
  ctx.edit('ppt/presentation.xml')
  const node = slideEntry(presentation.idList, op.slideId)
  if (node) presentation.idList.removeChild(node)
  for (const other of Array.from(presentation.doc.getElementsByTagName('*'))) {
    if (other.localName === 'sldId' && other.getAttribute('id') === String(op.slideId)) {
      other.parentNode?.removeChild(other)
    }
  }
  const notes = notesPartOf(ctx, slide.part)
  removeRelationship(ctx, 'ppt/presentation.xml', slide.relId)
  if (notes) removePart(ctx, notes)
  removePart(ctx, slide.part)
}

const serialize = (doc: Document): string => new XMLSerializer().serializeToString(doc)

const baseName = (part: string): string => part.slice(part.lastIndexOf('/') + 1)

const registerSlide = (
  ctx: EditContext,
  part: string,
  afterSlideId: number | undefined
): number => {
  const presentation = readPresentation(ctx)
  const relId = addRelationship(
    ctx,
    'ppt/presentation.xml',
    relType('slide'),
    `slides/${baseName(part)}`
  )
  const doc = ctx.edit('ppt/presentation.xml')
  const slideId = Math.max(255, ...presentation.slides.map((s) => s.slideId)) + 1
  const entry = doc.createElementNS(NS.p, 'p:sldId')
  entry.setAttribute('id', String(slideId))
  entry.setAttributeNS(NS.r, 'r:id', relId)
  const anchor = afterSlideId === undefined ? null : slideEntry(presentation.idList, afterSlideId)
  presentation.idList.insertBefore(entry, anchor ? anchor.nextSibling : null)
  addOverride(ctx, part, SLIDE_CONTENT_TYPE)
  return slideId
}

const copyRelationships = (ctx: EditContext, from: string, to: string): Document => {
  const source = ctx.has(relsPathFor(from)) ? serialize(ctx.doc(relsPathFor(from))) : undefined
  return ctx.create(relsPathFor(to), source ?? `<Relationships xmlns="${NS.rel}"/>`)
}

export const duplicateSlide = (ctx: EditContext, op: Op<'duplicateSlide'>): void => {
  const slide = requireSlide(readPresentation(ctx), op.slideId)
  const part = freePartName(ctx, 'ppt/slides/', 'slide', 'xml')
  ctx.create(part, serialize(ctx.doc(slide.part)))
  const rels = copyRelationships(ctx, slide.part, part)
  for (const rel of children(rels.documentElement, NS.rel, 'Relationship')) {
    if (rel.getAttribute('Type') === relType('notesSlide')) rels.documentElement.removeChild(rel)
  }
  const notes = notesPartOf(ctx, slide.part)
  if (notes) {
    const copy = freePartName(ctx, 'ppt/notesSlides/', 'notesSlide', 'xml')
    ctx.create(copy, serialize(ctx.doc(notes)))
    const notesRels = copyRelationships(ctx, notes, copy)
    for (const rel of children(notesRels.documentElement, NS.rel, 'Relationship')) {
      if (rel.getAttribute('Type') === relType('slide')) {
        rel.setAttribute('Target', `../slides/${baseName(part)}`)
      }
    }
    addOverride(ctx, copy, NOTES_CONTENT_TYPE)
    addRelationship(ctx, part, relType('notesSlide'), `../notesSlides/${baseName(copy)}`)
  }
  registerSlide(ctx, part, op.slideId)
}

const LAYOUT_SKIPPED = new Set(['dt', 'ftr', 'sldNum'])

const placeholdersFrom = (layout: Document, target: Document): Element[] => {
  const result: Element[] = []
  let id = 2
  for (const sp of Array.from(layout.getElementsByTagNameNS(NS.p, 'sp'))) {
    const ph = sp.getElementsByTagNameNS(NS.p, 'ph')[0]
    if (!ph || LAYOUT_SKIPPED.has(ph.getAttribute('type') ?? '')) continue
    const shape = el(target, NS.p, 'p:sp')
    const nv = el(target, NS.p, 'p:nvSpPr')
    nv.appendChild(el(target, NS.p, 'p:cNvPr', { id, name: `Placeholder ${id}` }))
    const locks = el(target, NS.p, 'p:cNvSpPr')
    locks.appendChild(el(target, NS.a, 'a:spLocks', { noGrp: 1 }))
    nv.appendChild(locks)
    const nvPr = el(target, NS.p, 'p:nvPr')
    nvPr.appendChild(target.importNode(ph, true))
    nv.appendChild(nvPr)
    shape.appendChild(nv)
    shape.appendChild(el(target, NS.p, 'p:spPr'))
    shape.appendChild(createTextBody(target, NS.p, 'p', []))
    result.push(shape)
    id += 1
  }
  return result
}

const LAYOUT_PATTERN = /^ppt\/slideLayouts\/[^/]+\.xml$/

const defaultLayout = (ctx: EditContext, afterSlideId: number | undefined): string => {
  const { slides } = readPresentation(ctx)
  const reference =
    afterSlideId === undefined
      ? slides[slides.length - 1]
      : requireSlide(readPresentation(ctx), afterSlideId)
  const rel = reference
    ? relationshipsOf(ctx, reference.part).find((r) => r.type === relType('slideLayout'))
    : undefined
  const chosen = rel
    ? resolveTarget(reference!.part, rel.target)
    : Array.from(ctx.pkg.files.keys()).find((name) => LAYOUT_PATTERN.test(name))
  if (!chosen) throw new PptxEditError('INVALID_OPERATION', 'The presentation has no slide layout.')
  return chosen
}

export const addSlide = (ctx: EditContext, op: Op<'addSlide'>): void => {
  const layout = op.layoutPart ?? defaultLayout(ctx, op.afterSlideId)
  if (!LAYOUT_PATTERN.test(layout) || !ctx.has(layout)) {
    throw new PptxEditError('INVALID_OPERATION', `Layout ${layout} does not exist.`)
  }
  const part = freePartName(ctx, 'ppt/slides/', 'slide', 'xml')
  const doc = ctx.create(
    part,
    `<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  )
  const tree = slideTree(doc)
  for (const shape of placeholdersFrom(ctx.doc(layout), doc)) tree.appendChild(shape)
  addRelationship(ctx, part, relType('slideLayout'), `../slideLayouts/${baseName(layout)}`)
  registerSlide(ctx, part, op.afterSlideId)
}

const createNotes = (ctx: EditContext, slidePart: string): string => {
  const master = relationshipsOf(ctx, 'ppt/presentation.xml').find(
    (rel) => rel.type === relType('notesMaster')
  )
  if (!master) {
    throw new PptxEditError('UNSUPPORTED_SHAPE', 'The presentation has no notes master.')
  }
  const part = freePartName(ctx, 'ppt/notesSlides/', 'notesSlide', 'xml')
  ctx.create(
    part,
    `<p:notes xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
  )
  addRelationship(ctx, part, relType('notesMaster'), `../notesMasters/${baseName(master.target)}`)
  addRelationship(ctx, part, relType('slide'), `../slides/${baseName(slidePart)}`)
  addOverride(ctx, part, NOTES_CONTENT_TYPE)
  addRelationship(ctx, slidePart, relType('notesSlide'), `../notesSlides/${baseName(part)}`)
  return part
}

export const setNotes = (ctx: EditContext, op: Op<'setNotes'>): void => {
  const slide = requireSlide(readPresentation(ctx), op.slideId)
  const part = notesPartOf(ctx, slide.part) ?? createNotes(ctx, slide.part)
  const doc = ctx.edit(part)
  const body = Array.from(doc.getElementsByTagNameNS(NS.p, 'sp')).find(
    (sp) => sp.getElementsByTagNameNS(NS.p, 'ph')[0]?.getAttribute('type') === 'body'
  )
  const txBody = body ? children(body, NS.p, 'txBody')[0] : undefined
  if (!txBody)
    throw new PptxEditError('UNSUPPORTED_SHAPE', 'The notes page has no body placeholder.')
  const lines = op.text === '' ? [] : op.text.split('\n')
  writeTextBody(
    txBody,
    lines.map((text) => ({ runs: [{ text }] }))
  )
}
