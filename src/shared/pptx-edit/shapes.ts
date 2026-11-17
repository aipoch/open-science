import type { EditContext } from './context'
import { findShape, nextShapeId, readPresentation, requireSlide, slideTree, xfrmOf } from './deck'
import { PptxEditError } from './errors'
import type { PptxOperation } from './operations'
import { NS, firstChild } from './package'
import { createTextBody, writeTextBody } from './text'

type Op<T extends PptxOperation['op']> = Extract<PptxOperation, { op: T }>

export const el = (
  doc: Document,
  ns: string,
  qname: string,
  attrs: Record<string, string | number> = {}
): Element => {
  const node = doc.createElementNS(ns, qname)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

export const slideDocFor = (ctx: EditContext, slideId: number): Document =>
  ctx.edit(requireSlide(readPresentation(ctx), slideId).part)

export const setText = (ctx: EditContext, op: Op<'setText'>): void => {
  const shape = findShape(slideDocFor(ctx, op.slideId), op.shapeId)
  const txBody = shape.localName === 'sp' ? firstChild(shape, NS.p, 'txBody') : undefined
  if (!txBody) {
    throw new PptxEditError('UNSUPPORTED_SHAPE', `Shape ${op.shapeId} has no editable text body.`)
  }
  writeTextBody(txBody, op.paragraphs, {
    ctx,
    part: requireSlide(readPresentation(ctx), op.slideId).part
  })
  if (op.frame)
    setFrame(ctx, { op: 'setFrame', slideId: op.slideId, shapeId: op.shapeId, ...op.frame })
}

const buildXfrm = (doc: Document, ns: string, qname: string, isGroup: boolean): Element => {
  const xfrm = el(doc, ns, qname)
  xfrm.appendChild(el(doc, NS.a, 'a:off', { x: 0, y: 0 }))
  xfrm.appendChild(el(doc, NS.a, 'a:ext', { cx: 0, cy: 0 }))
  if (isGroup) {
    xfrm.appendChild(el(doc, NS.a, 'a:chOff', { x: 0, y: 0 }))
    xfrm.appendChild(el(doc, NS.a, 'a:chExt', { cx: 0, cy: 0 }))
  }
  return xfrm
}

const ensureXfrm = (shape: Element): Element => {
  const existing = xfrmOf(shape)
  if (existing) return existing
  const doc = shape.ownerDocument
  if (shape.localName === 'graphicFrame') {
    const xfrm = buildXfrm(doc, NS.p, 'p:xfrm', false)
    const anchor = firstChild(shape, NS.a, 'graphic')
    shape.insertBefore(xfrm, anchor ?? null)
    return xfrm
  }
  const isGroup = shape.localName === 'grpSp'
  const props = firstChild(shape, NS.p, isGroup ? 'grpSpPr' : 'spPr')
  if (!props) {
    throw new PptxEditError('UNSUPPORTED_SHAPE', 'Shape has no geometry properties.')
  }
  const xfrm = buildXfrm(doc, NS.a, 'a:xfrm', isGroup)
  props.insertBefore(xfrm, props.firstChild)
  return xfrm
}

export const setFrame = (ctx: EditContext, op: Op<'setFrame'>): void => {
  const shape = findShape(slideDocFor(ctx, op.slideId), op.shapeId)
  const xfrm = ensureXfrm(shape)
  const off = firstChild(xfrm, NS.a, 'off')
  const ext = firstChild(xfrm, NS.a, 'ext')
  off?.setAttribute('x', String(op.x))
  off?.setAttribute('y', String(op.y))
  ext?.setAttribute('cx', String(op.w))
  ext?.setAttribute('cy', String(op.h))
  if (shape.localName === 'grpSp') {
    const chExt = firstChild(xfrm, NS.a, 'chExt')
    const chOff = firstChild(xfrm, NS.a, 'chOff')
    if (chExt && chOff && chExt.getAttribute('cx') === '0' && chExt.getAttribute('cy') === '0') {
      chOff.setAttribute('x', String(op.x))
      chOff.setAttribute('y', String(op.y))
      chExt.setAttribute('cx', String(op.w))
      chExt.setAttribute('cy', String(op.h))
    }
  }
  if (op.rotationDeg !== undefined) {
    xfrm.setAttribute('rot', String(Math.round(op.rotationDeg * 60_000)))
  }
}

export const addTextbox = (ctx: EditContext, op: Op<'addTextbox'>): void => {
  const doc = slideDocFor(ctx, op.slideId)
  const id = nextShapeId(doc)
  const sp = el(doc, NS.p, 'p:sp')
  const nv = el(doc, NS.p, 'p:nvSpPr')
  nv.appendChild(el(doc, NS.p, 'p:cNvPr', { id, name: `TextBox ${id}` }))
  nv.appendChild(el(doc, NS.p, 'p:cNvSpPr', { txBox: 1 }))
  nv.appendChild(el(doc, NS.p, 'p:nvPr'))
  sp.appendChild(nv)
  const props = el(doc, NS.p, 'p:spPr')
  const xfrm = el(doc, NS.a, 'a:xfrm')
  xfrm.appendChild(el(doc, NS.a, 'a:off', { x: op.x, y: op.y }))
  xfrm.appendChild(el(doc, NS.a, 'a:ext', { cx: op.w, cy: op.h }))
  props.appendChild(xfrm)
  const geometry = el(doc, NS.a, 'a:prstGeom', { prst: 'rect' })
  geometry.appendChild(el(doc, NS.a, 'a:avLst'))
  props.appendChild(geometry)
  props.appendChild(el(doc, NS.a, 'a:noFill'))
  sp.appendChild(props)
  sp.appendChild(
    createTextBody(doc, NS.p, 'p', op.paragraphs, {
      ctx,
      part: requireSlide(readPresentation(ctx), op.slideId).part
    })
  )
  slideTree(doc).appendChild(sp)
}

export const deleteShape = (ctx: EditContext, op: Op<'deleteShape'>): void => {
  const shape = findShape(slideDocFor(ctx, op.slideId), op.shapeId)
  shape.parentNode?.removeChild(shape)
}
