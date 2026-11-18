import { chartPartOf, readChart, type ChartOutline } from './charts'
import { packageSource, relationshipsOf, type DocSource } from './context'
import {
  readPresentation,
  shapeChildren,
  shapeIdOf,
  shapeProps,
  slideTree,
  xfrmOf,
  type SlideRef
} from './deck'
import { NS, descendants, firstChild, loadPackage, resolveTarget } from './package'
import { notesPartOf } from './slides'
import { readTable, tableOf } from './tables'
import type { PptxParagraph } from './operations'
import { readTextBody, readTextParagraphs } from './text'
import { relType } from './parts'

export type ShapeOutline = {
  shapeId: number
  name: string
  kind: 'text' | 'picture' | 'table' | 'chart' | 'group' | 'connector' | 'other'
  frame?: { x: number; y: number; w: number; h: number; rotationDeg: number }
  text?: string
  paragraphs?: PptxParagraph[]
  textInsets?: { left: number; right: number; top: number; bottom: number }
  mediaPart?: string
  // Byte size of the embedded image, so version comparison notices a replaced image.
  mediaBytes?: number
  table?: string[][]
  chart?: ChartOutline
  children?: ShapeOutline[]
}

export type SlideOutline = {
  slideId: number
  index: number
  part: string
  layoutPart?: string
  notes: string
  shapes: ShapeOutline[]
}

export type DeckOutline = {
  slideSize: { cx: number; cy: number }
  layouts: { part: string; name: string }[]
  slides: SlideOutline[]
}

const frameOf = (shape: Element): ShapeOutline['frame'] => {
  const xfrm = xfrmOf(shape)
  const off = xfrm ? firstChild(xfrm, NS.a, 'off') : undefined
  const ext = xfrm ? firstChild(xfrm, NS.a, 'ext') : undefined
  if (!xfrm || !off || !ext) return undefined
  return {
    x: Number(off.getAttribute('x')),
    y: Number(off.getAttribute('y')),
    w: Number(ext.getAttribute('cx')),
    h: Number(ext.getAttribute('cy')),
    rotationDeg: Number(xfrm.getAttribute('rot') ?? 0) / 60_000
  }
}

type MediaFiles = ReadonlyMap<string, Uint8Array>

const outlineShape = (
  source: DocSource,
  files: MediaFiles,
  slide: SlideRef,
  shape: Element
): ShapeOutline => {
  const base = {
    shapeId: shapeIdOf(shape),
    name: shapeProps(shape)?.getAttribute('name') ?? '',
    frame: frameOf(shape)
  }
  switch (shape.localName) {
    case 'sp': {
      const body = firstChild(shape, NS.p, 'txBody')
      const bodyProps = body ? firstChild(body, NS.a, 'bodyPr') : undefined
      const inset = (name: string, fallback: number): number =>
        bodyProps?.hasAttribute(name) ? Number(bodyProps.getAttribute(name)) : fallback
      return body
        ? {
            ...base,
            kind: 'text',
            text: readTextBody(body),
            paragraphs: readTextParagraphs(body, source, slide.part),
            textInsets: {
              left: inset('lIns', 91440),
              right: inset('rIns', 91440),
              top: inset('tIns', 45720),
              bottom: inset('bIns', 45720)
            }
          }
        : { ...base, kind: 'other' }
    }
    case 'pic': {
      const embed = descendants(shape, NS.a, 'blip')[0]?.getAttributeNS(NS.r, 'embed')
      const rel = relationshipsOf(source, slide.part).find((r) => r.id === embed)
      const mediaPart = rel ? resolveTarget(slide.part, rel.target) : undefined
      const mediaBytes = mediaPart ? files.get(mediaPart)?.byteLength : undefined
      return { ...base, kind: 'picture', mediaPart, mediaBytes }
    }
    case 'graphicFrame': {
      const table = tableOf(shape)
      if (table) return { ...base, kind: 'table', table: readTable(table) }
      const chartPart = chartPartOf(source, slide.part, shape)
      if (chartPart) return { ...base, kind: 'chart', chart: readChart(source, chartPart) }
      return { ...base, kind: 'other' }
    }
    case 'grpSp':
      return {
        ...base,
        kind: 'group',
        children: shapeChildren(shape).map((child) => outlineShape(source, files, slide, child))
      }
    case 'cxnSp':
      return { ...base, kind: 'connector' }
    default:
      return { ...base, kind: 'other' }
  }
}

const notesText = (source: DocSource, notesPart: string | undefined): string => {
  if (!notesPart || !source.has(notesPart)) return ''
  const doc = source.doc(notesPart)
  const body = descendants(doc.documentElement, NS.p, 'sp').find(
    (sp) => descendants(sp, NS.p, 'ph')[0]?.getAttribute('type') === 'body'
  )
  const txBody = body ? firstChild(body, NS.p, 'txBody') : undefined
  return txBody ? readTextBody(txBody) : ''
}

export const readOutline = (bytes: Uint8Array): DeckOutline => {
  const pkg = loadPackage(bytes)
  const source = packageSource(pkg)
  const presentation = readPresentation(source)
  const size = firstChild(presentation.doc.documentElement, NS.p, 'sldSz')
  const slides = presentation.slides.map((slide, index): SlideOutline => {
    const layout = relationshipsOf(source, slide.part).find(
      (r) => r.type === relType('slideLayout')
    )
    return {
      slideId: slide.slideId,
      index,
      part: slide.part,
      layoutPart: layout ? resolveTarget(slide.part, layout.target) : undefined,
      notes: notesText(source, notesPartOf(source, slide.part)),
      shapes: shapeChildren(slideTree(source.doc(slide.part))).map((shape) =>
        outlineShape(source, pkg.files, slide, shape)
      )
    }
  })
  const layouts = Array.from(pkg.files.keys())
    .filter((name) => /^ppt\/slideLayouts\/[^/]+\.xml$/.test(name))
    .sort()
    .map((part) => ({
      part,
      name: firstChild(source.doc(part).documentElement, NS.p, 'cSld')?.getAttribute('name') ?? ''
    }))
  return {
    slideSize: {
      cx: Number(size?.getAttribute('cx') ?? 0),
      cy: Number(size?.getAttribute('cy') ?? 0)
    },
    layouts,
    slides
  }
}
