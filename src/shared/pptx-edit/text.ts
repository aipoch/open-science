import { relationshipsOf, type DocSource, type EditContext } from './context'
import { addRelationship, relType } from './parts'
import { NS, children, firstChild } from './package'
import type { PptxParagraph } from './operations'

type RunSpec = PptxParagraph['runs'][number]

export const paragraphText = (paragraph: Element): string => {
  let text = ''
  for (let node = paragraph.firstChild; node; node = node.nextSibling) {
    const el = node as Element
    if (node.nodeType !== 1 || el.namespaceURI !== NS.a) continue
    if (el.localName === 'br') text += '\n'
    else if (el.localName === 'r' || el.localName === 'fld') {
      text += firstChild(el, NS.a, 't')?.textContent ?? ''
    }
  }
  return text
}

export const readTextBody = (txBody: Element): string =>
  children(txBody, NS.a, 'p').map(paragraphText).join('\n')

const FILL_NAMES = ['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']

const applyRunFormat = (rPr: Element, run: RunSpec): void => {
  const doc = rPr.ownerDocument
  if (run.fontFamily !== undefined) {
    let latin = firstChild(rPr, NS.a, 'latin')
    if (!latin) {
      latin = doc.createElementNS(NS.a, 'a:latin')
      const anchor = Array.from(rPr.childNodes).find(
        (node) =>
          node.nodeType === 1 &&
          ['ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst'].includes(
            (node as Element).localName
          )
      )
      rPr.insertBefore(latin, anchor ?? null)
    }
    latin.setAttribute('typeface', run.fontFamily)
  }
  if (run.bold !== undefined) rPr.setAttribute('b', run.bold ? '1' : '0')
  if (run.italic !== undefined) rPr.setAttribute('i', run.italic ? '1' : '0')
  if (run.underline !== undefined) rPr.setAttribute('u', run.underline ? 'sng' : 'none')
  if (run.sizePt !== undefined) rPr.setAttribute('sz', String(Math.round(run.sizePt * 100)))
  if (run.color === undefined) return
  for (const name of FILL_NAMES) {
    for (const old of children(rPr, NS.a, name)) rPr.removeChild(old)
  }
  const fill = doc.createElementNS(NS.a, 'a:solidFill')
  const rgb = doc.createElementNS(NS.a, 'a:srgbClr')
  rgb.setAttribute('val', run.color.toUpperCase())
  fill.appendChild(rgb)
  const line = firstChild(rPr, NS.a, 'ln')
  rPr.insertBefore(fill, line ? line.nextSibling : rPr.firstChild)
}

const buildRun = (
  doc: Document,
  run: RunSpec,
  template: Element | undefined,
  linkId?: string
): Element => {
  const r = doc.createElementNS(NS.a, 'a:r')
  const rPr = template ? (template.cloneNode(true) as Element) : doc.createElementNS(NS.a, 'a:rPr')
  applyRunFormat(rPr, run)
  if (run.hyperlink !== undefined) {
    for (const old of children(rPr, NS.a, 'hlinkClick')) rPr.removeChild(old)
    if (linkId) {
      const link = doc.createElementNS(NS.a, 'a:hlinkClick')
      link.setAttributeNS(NS.r, 'r:id', linkId)
      rPr.insertBefore(link, firstChild(rPr, NS.a, 'extLst') ?? null)
    }
  }
  r.appendChild(rPr)
  const t = doc.createElementNS(NS.a, 'a:t')
  t.appendChild(doc.createTextNode(run.text))
  r.appendChild(t)
  return r
}

const runProps = (paragraph: Element | undefined, index: number): Element | undefined => {
  if (!paragraph) return undefined
  const runs = children(paragraph, NS.a, 'r')
  const run = runs[index] ?? runs[0]
  return run ? firstChild(run, NS.a, 'rPr') : undefined
}

export const writeTextBody = (
  txBody: Element,
  paragraphs: PptxParagraph[],
  links?: { ctx: EditContext; part: string }
): void => {
  const doc = txBody.ownerDocument
  const existing = children(txBody, NS.a, 'p')
  const fallback = existing[existing.length - 1]
  for (const old of existing) txBody.removeChild(old)
  const specs = paragraphs.length > 0 ? paragraphs : [{ runs: [] }]
  specs.forEach((spec, index) => {
    const source = existing[index] ?? fallback
    const p = doc.createElementNS(NS.a, 'a:p')
    const pPr = source ? firstChild(source, NS.a, 'pPr') : undefined
    if (pPr) p.appendChild(pPr.cloneNode(true))
    spec.runs.forEach((run, runIndex) => {
      const linkId =
        run.hyperlink && links
          ? addRelationship(links.ctx, links.part, relType('hyperlink'), run.hyperlink, true)
          : undefined
      p.appendChild(buildRun(doc, run, runProps(source, run.sourceRun ?? runIndex), linkId))
    })
    const endProps = source ? firstChild(source, NS.a, 'endParaRPr') : undefined
    if (endProps) p.appendChild(endProps.cloneNode(true))
    txBody.appendChild(p)
  })
}

export const createTextBody = (
  doc: Document,
  ns: string,
  prefix: string,
  paragraphs: PptxParagraph[],
  links?: { ctx: EditContext; part: string }
): Element => {
  const txBody = doc.createElementNS(ns, `${prefix}:txBody`)
  txBody.appendChild(doc.createElementNS(NS.a, 'a:bodyPr'))
  txBody.appendChild(doc.createElementNS(NS.a, 'a:lstStyle'))
  writeTextBody(txBody, paragraphs, links)
  return txBody
}

export const readTextParagraphs = (
  body: Element,
  source: DocSource,
  part: string
): PptxParagraph[] =>
  children(body, NS.a, 'p').map((paragraph) => ({
    runs: Array.from(paragraph.childNodes)
      .filter(
        (node): node is Element =>
          node.nodeType === 1 &&
          (node as Element).namespaceURI === NS.a &&
          ['r', 'fld', 'br'].includes((node as Element).localName)
      )
      .map((node, index) => {
        const props = firstChild(node, NS.a, 'rPr')
        const defaults = firstChild(paragraph, NS.a, 'pPr')
        const inherited = defaults ? firstChild(defaults, NS.a, 'defRPr') : undefined
        const attr = (name: string): string | null =>
          props?.getAttribute(name) || inherited?.getAttribute(name) || null
        const fill = props ? firstChild(props, NS.a, 'solidFill') : undefined
        const color = fill ? firstChild(fill, NS.a, 'srgbClr')?.getAttribute('val') : undefined
        const link = props ? firstChild(props, NS.a, 'hlinkClick') : undefined
        const rel = link
          ? relationshipsOf(source, part).find((r) => r.id === link.getAttributeNS(NS.r, 'id'))
          : undefined
        return {
          text: node.localName === 'br' ? '\n' : (firstChild(node, NS.a, 't')?.textContent ?? ''),
          sourceRun: index,
          ...(props && firstChild(props, NS.a, 'latin')?.getAttribute('typeface')
            ? { fontFamily: firstChild(props, NS.a, 'latin')!.getAttribute('typeface')! }
            : {}),
          ...(attr('b') !== null ? { bold: ['1', 'true'].includes(attr('b')!) } : {}),
          ...(attr('i') !== null ? { italic: ['1', 'true'].includes(attr('i')!) } : {}),
          ...(attr('u') !== null ? { underline: attr('u') !== 'none' } : {}),
          ...(attr('sz') ? { sizePt: Number(attr('sz')) / 100 } : {}),
          ...(color ? { color } : {}),
          ...(rel?.mode === 'External' && /^(https?:\/\/|mailto:)/i.test(rel.target)
            ? { hyperlink: rel.target }
            : {})
        }
      })
  }))
