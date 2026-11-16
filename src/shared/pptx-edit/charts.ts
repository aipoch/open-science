import { relationshipsOf, type DocSource } from './context'
import { PptxEditError } from './errors'
import { findShape, readPresentation, requireSlide } from './deck'
import type { PptxOperation } from './operations'
import { NS, children, descendants, firstChild, resolveTarget } from './package'
import { el, slideDocFor } from './shapes'
import type { EditContext } from './context'

export const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'

export type ChartOutline = {
  title?: string
  categoryAxisTitle?: string
  valueAxisTitle?: string
  series: { name?: string; categories: string[] }[]
}

export const chartPartOf = (
  source: DocSource,
  slidePart: string,
  frame: Element
): string | undefined => {
  const ref = descendants(frame, CHART_NS, 'chart')[0]
  const relId = ref?.getAttributeNS(NS.r, 'id')
  if (!relId) return undefined
  const rel = relationshipsOf(source, slidePart).find((r) => r.id === relId)
  return rel ? resolveTarget(slidePart, rel.target) : undefined
}

const richText = (title: Element | undefined): string | undefined => {
  if (!title) return undefined
  const texts = descendants(title, NS.a, 't').map((t) => t.textContent ?? '')
  return texts.length > 0 ? texts.join('') : undefined
}

const cachePoints = (container: Element | undefined): Element[] => {
  const cache = container ? descendants(container, CHART_NS, 'strCache')[0] : undefined
  return cache ? children(cache, CHART_NS, 'pt') : []
}

const axisOf = (plot: Element, kind: 'category' | 'value'): Element | undefined =>
  kind === 'value'
    ? firstChild(plot, CHART_NS, 'valAx')
    : (firstChild(plot, CHART_NS, 'catAx') ?? firstChild(plot, CHART_NS, 'dateAx'))

export const readChart = (source: DocSource, chartPart: string): ChartOutline => {
  const space = source.doc(chartPart).documentElement
  const chart = firstChild(space, CHART_NS, 'chart')
  const plot = chart ? firstChild(chart, CHART_NS, 'plotArea') : undefined
  const outline: ChartOutline = { series: [] }
  if (!chart || !plot) return outline
  outline.title = richText(firstChild(chart, CHART_NS, 'title'))
  const cat = axisOf(plot, 'category')
  const val = axisOf(plot, 'value')
  outline.categoryAxisTitle = richText(cat ? firstChild(cat, CHART_NS, 'title') : undefined)
  outline.valueAxisTitle = richText(val ? firstChild(val, CHART_NS, 'title') : undefined)
  for (const ser of descendants(plot, CHART_NS, 'ser')) {
    const tx = firstChild(ser, CHART_NS, 'tx')
    const name = tx
      ? (cachePoints(tx)[0]?.textContent ?? firstChild(tx, CHART_NS, 'v')?.textContent ?? undefined)
      : undefined
    const categories = cachePoints(firstChild(ser, CHART_NS, 'cat')).map(
      (pt) => pt.textContent ?? ''
    )
    outline.series.push({ name: name ?? undefined, categories })
  }
  return outline
}

const setRich = (owner: Element, text: string): void => {
  const doc = owner.ownerDocument
  let tx = firstChild(owner, CHART_NS, 'tx')
  if (!tx) {
    tx = el(doc, CHART_NS, 'c:tx')
    owner.insertBefore(tx, owner.firstChild)
  }
  let rich = firstChild(tx, CHART_NS, 'rich')
  if (!rich) {
    while (tx.firstChild) tx.removeChild(tx.firstChild)
    rich = el(doc, CHART_NS, 'c:rich')
    rich.appendChild(el(doc, NS.a, 'a:bodyPr'))
    rich.appendChild(el(doc, NS.a, 'a:lstStyle'))
    tx.appendChild(rich)
  }
  const [first, ...extra] = children(rich, NS.a, 'p')
  for (const p of extra) rich.removeChild(p)
  const paragraph = first ?? rich.appendChild(el(doc, NS.a, 'a:p'))
  const [run, ...extraRuns] = children(paragraph, NS.a, 'r')
  for (const r of extraRuns) paragraph.removeChild(r)
  const target = run ?? paragraph.appendChild(el(doc, NS.a, 'a:r'))
  const t = firstChild(target, NS.a, 't') ?? target.appendChild(el(doc, NS.a, 'a:t'))
  t.textContent = text
}

const ensureTitle = (owner: Element, after: string[]): Element => {
  const existing = firstChild(owner, CHART_NS, 'title')
  if (existing) return existing
  const doc = owner.ownerDocument
  const title = el(doc, CHART_NS, 'c:title')
  title.appendChild(el(doc, CHART_NS, 'c:overlay', { val: 0 }))
  const anchors = after.flatMap((name) => children(owner, CHART_NS, name))
  const last = anchors[anchors.length - 1]
  owner.insertBefore(title, last ? last.nextSibling : owner.firstChild)
  return title
}

const setSeriesName = (ser: Element, text: string): void => {
  const doc = ser.ownerDocument
  const tx = firstChild(ser, CHART_NS, 'tx')
  const pt = cachePoints(tx)[0]
  const direct = tx ? firstChild(tx, CHART_NS, 'v') : undefined
  const value = pt ? firstChild(pt, CHART_NS, 'v') : direct
  if (value) {
    value.textContent = text
    return
  }
  const created = el(doc, CHART_NS, 'c:tx')
  const v = el(doc, CHART_NS, 'c:v')
  v.textContent = text
  created.appendChild(v)
  if (tx) ser.replaceChild(created, tx)
  else ser.insertBefore(created, children(ser, CHART_NS, 'order')[0]?.nextSibling ?? ser.firstChild)
}

const setCategory = (plot: Element, index: number, text: string): void => {
  let changed = false
  for (const ser of descendants(plot, CHART_NS, 'ser')) {
    const cat = firstChild(ser, CHART_NS, 'cat')
    if (cat && descendants(cat, CHART_NS, 'numCache').length > 0) {
      throw new PptxEditError(
        'UNSUPPORTED_SHAPE',
        'Numeric chart categories cannot be edited as text.'
      )
    }
    const pt = cachePoints(cat).find((node) => node.getAttribute('idx') === String(index))
    const value = pt ? firstChild(pt, CHART_NS, 'v') : undefined
    if (value) {
      value.textContent = text
      changed = true
    }
  }
  if (!changed)
    throw new PptxEditError('SHAPE_NOT_FOUND', `Chart category ${index} does not exist.`)
}

export const setChartText = (
  ctx: EditContext,
  op: Extract<PptxOperation, { op: 'setChartText' }>
): void => {
  const slide = requireSlide(readPresentation(ctx), op.slideId)
  const frame = findShape(slideDocFor(ctx, op.slideId), op.shapeId)
  const part = frame.localName === 'graphicFrame' ? chartPartOf(ctx, slide.part, frame) : undefined
  if (!part) throw new PptxEditError('UNSUPPORTED_SHAPE', `Shape ${op.shapeId} is not a chart.`)
  const chart = firstChild(ctx.edit(part).documentElement, CHART_NS, 'chart')
  const plot = chart ? firstChild(chart, CHART_NS, 'plotArea') : undefined
  if (!chart || !plot) throw new PptxEditError('INVALID_PACKAGE', 'Chart part is incomplete.')
  if (op.target === 'title') {
    setRich(ensureTitle(chart, []), op.text)
    for (const flag of children(chart, CHART_NS, 'autoTitleDeleted')) flag.setAttribute('val', '0')
  } else if (op.target === 'categoryAxisTitle' || op.target === 'valueAxisTitle') {
    const axis = axisOf(plot, op.target === 'valueAxisTitle' ? 'value' : 'category')
    if (!axis) throw new PptxEditError('SHAPE_NOT_FOUND', 'Chart has no such axis.')
    setRich(ensureTitle(axis, ['axPos', 'majorGridlines', 'minorGridlines']), op.text)
  } else {
    const index = op.index ?? 0
    if (op.target === 'category') return setCategory(plot, index, op.text)
    const ser = descendants(plot, CHART_NS, 'ser')[index]
    if (!ser) throw new PptxEditError('SHAPE_NOT_FOUND', `Chart series ${index} does not exist.`)
    setSeriesName(ser, op.text)
  }
}
