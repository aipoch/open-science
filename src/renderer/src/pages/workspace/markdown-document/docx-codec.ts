import React from 'react'
import JSZip from 'jszip'
import {
  createSlateEditor,
  createSlatePlugin,
  ElementApi,
  TextApi,
  type Descendant,
  type SlateEditor,
  type TElement,
  type TText,
  type Value
} from 'platejs'
import type { PlateStaticProps } from 'platejs/static'
import { exportToDocx, importDocx } from '@platejs/docx-io'

import {
  DROPDOWN_LANGUAGE,
  decodeDropdownDefinition,
  isSafeRemoteImageUrl
} from './markdown-blocks'
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-codec'

const DOCX_COMMENT_TOKEN_PATTERN = /\[\[DOCX_COMMENT_REF:[^\]]*\]\]/gu
const SUPPORTED_DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/iu
const DOCX_NATIVE_DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|gif);base64,/iu
const DISALLOWED_CODE_LANGUAGES = /^(?:mermaid|flowchart|sequenceDiagram)$/iu
const MONOSPACE_FONT_PATTERN = /^(?:courier(?:\s+new)?|consolas|menlo|monaco|monospace)$/iu

const EMBEDDED_MAMMOTH_STYLE_MAP = [
  'p.Title => h1:fresh',
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='title'] => h1:fresh",
  'p.Subtitle => h2:fresh',
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='subtitle'] => h2:fresh",
  'p.Quote => blockquote > p:fresh',
  "p[style-name='Quote'] => blockquote > p:fresh",
  'p.IntenseQuote => blockquote > p:fresh',
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Block Text'] => blockquote > p:fresh",
  "p.Code => pre:separator('\\n')",
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='Source Code'] => pre:separator('\\n')",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  'p.OpenScienceHr => p.openscienceHr:fresh',
  'r.OpenScienceInlineCode => code',
  "r[style-name='Verbatim Char'] => code",
  "r[style-name='HTML Code'] => code",
  "r[style-name='Code Char'] => code",
  "highlight[color='lightGray'] => code"
].join('\n')

type FormattedText = TText & {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  code?: boolean
}

const stripDocxCommentTokens = (value: string): string =>
  value.replace(DOCX_COMMENT_TOKEN_PATTERN, '')

const normalizeDocxImageSrc = (src: string): string => {
  const trimmed = src.trim()
  if (/^data:image\/jpg;base64,/iu.test(trimmed)) {
    return `data:image/jpeg;base64,${trimmed.slice('data:image/jpg;base64,'.length)}`
  }
  return trimmed
}

const isSupportedDocxImportImageSrc = (src: string | null): src is string => {
  if (!src) return false
  const normalized = normalizeDocxImageSrc(src)
  return SUPPORTED_DATA_IMAGE_PATTERN.test(normalized) || isSafeRemoteImageUrl(normalized)
}

const isSafeLinkHref = (href: string): boolean => {
  const trimmed = href.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('#')) return trimmed.length > 1
  try {
    const parsed = new URL(trimmed)
    return (
      (parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        parsed.protocol === 'mailto:') &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

const toExactArrayBuffer = (bytes: Uint8Array | ArrayBuffer): ArrayBuffer => {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const getWordAttr = (element: Element, localName: string): string | null =>
  element.getAttribute(`w:${localName}`) ?? element.getAttribute(localName)

const findFirstChildByLocalName = (parent: Element, localName: string): Element | undefined => {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index]
    if (child && (child.localName === localName || child.tagName === `w:${localName}`)) {
      return child
    }
  }
  return undefined
}

const findDirectChildrenByLocalName = (parent: Element, localName: string): Element[] => {
  const matches: Element[] = []
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index]
    if (child && (child.localName === localName || child.tagName === `w:${localName}`)) {
      matches.push(child)
    }
  }
  return matches
}

const annotateDocumentXmlForMammoth = (documentXml: string): string => {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return documentXml
  const parsed = new DOMParser().parseFromString(documentXml, 'application/xml')
  if (parsed.getElementsByTagName('parsererror').length > 0) return documentXml
  const root = parsed.documentElement
  if (!root) return documentXml
  const wordNs =
    root.lookupNamespaceURI('w') ?? 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

  const ensureParagraphStyle = (p: Element, styleVal: string): Element => {
    let pPr = findFirstChildByLocalName(p, 'pPr')
    if (!pPr) {
      pPr = parsed.createElementNS(wordNs, 'w:pPr')
      p.insertBefore(pPr, p.firstChild)
    }
    let pStyle = findFirstChildByLocalName(pPr, 'pStyle')
    if (!pStyle) {
      pStyle = parsed.createElementNS(wordNs, 'w:pStyle')
      pPr.insertBefore(pStyle, pPr.firstChild)
    }
    pStyle.setAttributeNS(wordNs, 'w:val', styleVal)
    return pPr
  }

  const paragraphs = Array.from(root.getElementsByTagName('*')).filter(
    (el) => el.localName === 'p' || el.tagName === 'w:p'
  )

  let mutated = false
  const drawings = Array.from(root.getElementsByTagName('*')).filter(
    (el) => el.localName === 'drawing' || el.tagName === 'w:drawing'
  )
  for (const drawing of drawings) {
    const descendants = Array.from(drawing.getElementsByTagName('*'))
    const docPr = descendants.find((el) => el.localName === 'docPr')
    const cNvPr = descendants.find((el) => el.localName === 'cNvPr')
    const picDescr = cNvPr?.getAttribute('descr')
    if (docPr && !docPr.getAttribute('descr') && picDescr) {
      docPr.setAttribute('descr', picDescr)
      mutated = true
    }
  }

  for (const p of paragraphs) {
    // Skip paragraphs inside tables so table cells stay normal paragraphs.
    let insideTable = false
    for (let ancestor = p.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.localName === 'tc' || ancestor.tagName === 'w:tc') {
        insideTable = true
        break
      }
    }
    if (insideTable) continue

    const pPr = findFirstChildByLocalName(p, 'pPr')
    const existingStyle = pPr ? findFirstChildByLocalName(pPr, 'pStyle') : undefined
    const existingStyleVal = existingStyle ? getWordAttr(existingStyle, 'val') : null
    const pBdr = pPr ? findFirstChildByLocalName(pPr, 'pBdr') : undefined
    const runs = findDirectChildrenByLocalName(p, 'r')
    const hasHyperlinks = findDirectChildrenByLocalName(p, 'hyperlink').length > 0
    const hasDrawings = Array.from(p.getElementsByTagName('*')).some(
      (el) => el.localName === 'drawing' || el.tagName === 'w:drawing'
    )

    if (!existingStyleVal && pBdr) {
      const hasLeftBorder = Boolean(findFirstChildByLocalName(pBdr, 'left'))
      const hasBottomBorder = Boolean(findFirstChildByLocalName(pBdr, 'bottom'))
      const textContent = (p.textContent ?? '').trim()

      if (hasBottomBorder && !hasLeftBorder && !textContent && !hasDrawings && !hasHyperlinks) {
        ensureParagraphStyle(p, 'OpenScienceHr')
        const markerRun = parsed.createElementNS(wordNs, 'w:r')
        const markerText = parsed.createElementNS(wordNs, 'w:t')
        markerText.textContent = '---'
        markerRun.appendChild(markerText)
        p.appendChild(markerRun)
        mutated = true
        continue
      }

      if (hasLeftBorder) {
        ensureParagraphStyle(p, 'Quote')
        mutated = true
        continue
      }
    }

    const textRuns = runs.filter(
      (run) => (run.textContent ?? '').length > 0 || Boolean(findFirstChildByLocalName(run, 'br'))
    )
    const nonEmptyTextRuns = runs.filter((run) => (run.textContent ?? '').length > 0)
    const allRunsMonospace =
      nonEmptyTextRuns.length > 0 &&
      !hasHyperlinks &&
      !hasDrawings &&
      nonEmptyTextRuns.every((run) => {
        const rPr = findFirstChildByLocalName(run, 'rPr')
        if (!rPr || findFirstChildByLocalName(rPr, 'highlight')) return false
        const rFonts = findFirstChildByLocalName(rPr, 'rFonts')
        const fontName = rFonts
          ? (getWordAttr(rFonts, 'ascii') ?? getWordAttr(rFonts, 'hAnsi'))
          : null
        return Boolean(fontName && MONOSPACE_FONT_PATTERN.test(fontName.trim()))
      })

    if (!existingStyleVal && allRunsMonospace) {
      ensureParagraphStyle(p, 'Code')
      mutated = true
      continue
    }

    for (const run of textRuns) {
      const rPr = findFirstChildByLocalName(run, 'rPr')
      if (!rPr || findFirstChildByLocalName(rPr, 'rStyle')) continue
      const rFonts = findFirstChildByLocalName(rPr, 'rFonts')
      const fontName = rFonts
        ? (getWordAttr(rFonts, 'ascii') ?? getWordAttr(rFonts, 'hAnsi'))
        : null
      if (fontName && MONOSPACE_FONT_PATTERN.test(fontName.trim())) {
        const rStyle = parsed.createElementNS(wordNs, 'w:rStyle')
        rStyle.setAttributeNS(wordNs, 'w:val', 'OpenScienceInlineCode')
        rPr.insertBefore(rStyle, rPr.firstChild)
        mutated = true
      }
    }
  }

  return mutated ? new XMLSerializer().serializeToString(parsed) : documentXml
}

const prepareDocxArrayBufferForImport = async (arrayBuffer: ArrayBuffer): Promise<ArrayBuffer> => {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const mainDocEntry = zip.file('word/document.xml')
  if (!mainDocEntry) {
    throw new Error('Invalid DOCX archive: missing word/document.xml.')
  }

  const existingStyleMap = await zip.file('mammoth/style-map')?.async('string')
  zip.file(
    'mammoth/style-map',
    existingStyleMap
      ? `${existingStyleMap}\n${EMBEDDED_MAMMOTH_STYLE_MAP}`
      : EMBEDDED_MAMMOTH_STYLE_MAP
  )

  const documentXml = await mainDocEntry.async('string')
  const annotatedXml = annotateDocumentXmlForMammoth(documentXml)
  if (annotatedXml !== documentXml) {
    zip.file('word/document.xml', annotatedXml)
  }

  return await zip.generateAsync({ type: 'arraybuffer' })
}

const createDocxImportEditor = (): SlateEditor =>
  createSlateEditor({
    plugins: [
      createSlatePlugin({
        key: 'p',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['P'] }],
              parse: ({ element }) =>
                element.classList.contains('openscienceHr')
                  ? { type: 'hr', children: [{ text: '' }] }
                  : { type: 'p' }
            }
          }
        }
      }),
      ...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).map((heading) =>
        createSlatePlugin({
          key: heading,
          node: { isElement: true },
          parsers: {
            html: {
              deserializer: {
                rules: [{ validNodeName: [heading.toUpperCase()] }],
                parse: () => ({ type: heading })
              }
            }
          }
        })
      ),
      createSlatePlugin({
        key: 'blockquote',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['BLOCKQUOTE'] }],
              parse: () => ({ type: 'blockquote' })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'ul',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['UL'] }],
              parse: () => ({ type: 'ul' })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'ol',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['OL'] }],
              parse: ({ element }) => {
                const startAttr = element.getAttribute('start')
                const start = startAttr ? Number.parseInt(startAttr, 10) : Number.NaN
                return Number.isInteger(start) && start > 1 ? { type: 'ol', start } : { type: 'ol' }
              }
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'li',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['LI'] }],
              parse: () => ({ type: 'li' })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'code_block',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['PRE'] }],
              parse: ({ element }) => {
                const extractPreText = (domNode: Node): string => {
                  if (domNode.nodeType === 3) return domNode.nodeValue ?? ''
                  if (domNode.nodeName === 'BR') return '\n'
                  let out = ''
                  domNode.childNodes.forEach((child) => {
                    out += extractPreText(child)
                  })
                  return out
                }
                const raw = stripDocxCommentTokens(extractPreText(element))
                  .replace(/\r\n|\r/g, '\n')
                  .replace(/\n$/u, '')
                return {
                  type: 'code_block',
                  children: raw.split('\n').map((line) => ({
                    type: 'code_line',
                    children: [{ text: line }]
                  }))
                }
              }
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'table',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['TABLE'] }],
              parse: () => ({ type: 'table' })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'tr',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['TR'] }],
              parse: () => ({ type: 'tr' })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'th',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['TH'] }],
              parse: () => ({ type: 'th' })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'td',
        node: { isElement: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['TD'] }],
              parse: () => ({ type: 'td' })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'a',
        node: { isElement: true, isInline: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['A'] }],
              query: ({ element }) => isSafeLinkHref(element.getAttribute('href') ?? ''),
              parse: ({ element }) => ({
                type: 'a',
                url: (element.getAttribute('href') ?? '').trim()
              })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'img',
        node: { isElement: true, isVoid: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['IMG'] }],
              query: ({ element }) => isSupportedDocxImportImageSrc(element.getAttribute('src')),
              parse: ({ element }) => ({
                type: 'img',
                url: normalizeDocxImageSrc(element.getAttribute('src')!),
                caption: [
                  {
                    text: stripDocxCommentTokens(element.getAttribute('alt') ?? '').replace(
                      /\r\n|\r|\n/g,
                      ' '
                    )
                  }
                ],
                children: [{ text: '' }]
              })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'hr',
        node: { isElement: true, isVoid: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['HR'] }],
              parse: () => ({ type: 'hr', children: [{ text: '' }] })
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'bold',
        node: { isLeaf: true },
        parsers: {
          html: {
            deserializer: {
              rules: [
                { validNodeName: ['STRONG', 'B'] },
                { validStyle: { fontWeight: ['600', '700', 'bold', 'bolder'] } }
              ]
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'italic',
        node: { isLeaf: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['EM', 'I'] }, { validStyle: { fontStyle: 'italic' } }]
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'strikethrough',
        node: { isLeaf: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['DEL', 'S', 'STRIKE'] }]
            }
          }
        }
      }),
      createSlatePlugin({
        key: 'code',
        node: { isLeaf: true },
        parsers: {
          html: {
            deserializer: {
              rules: [{ validNodeName: ['CODE', 'KBD'] }],
              query: ({ element }) => element.parentElement?.nodeName !== 'PRE'
            }
          }
        }
      })
    ]
  })

const sameMarks = (left: FormattedText, right: FormattedText): boolean =>
  Boolean(left.bold) === Boolean(right.bold) &&
  Boolean(left.italic) === Boolean(right.italic) &&
  Boolean(left.strikethrough) === Boolean(right.strikethrough) &&
  Boolean(left.code) === Boolean(right.code)

const cleanTextLeaf = (leaf: TText, singleLine: boolean): FormattedText => {
  const raw = stripDocxCommentTokens(leaf.text ?? '').replace(/\r\n|\r/g, '\n')
  const text = singleLine ? raw.replace(/\n+/g, ' ') : raw
  const record = leaf as FormattedText
  return {
    text,
    ...(record.bold ? { bold: true } : {}),
    ...(record.italic ? { italic: true } : {}),
    ...(record.strikethrough ? { strikethrough: true } : {}),
    ...(record.code ? { code: true } : {})
  }
}

const mergeAdjacentInlineNodes = (nodes: Descendant[]): Descendant[] => {
  const merged: Descendant[] = []
  for (const node of nodes) {
    if (TextApi.isText(node)) {
      const current = node as FormattedText
      const prev = merged.at(-1)
      if (prev && TextApi.isText(prev) && sameMarks(prev as FormattedText, current)) {
        merged[merged.length - 1] = {
          ...(prev as FormattedText),
          text: `${prev.text}${current.text}`
        }
      } else if (current.text.length > 0) {
        merged.push(current)
      }
      continue
    }
    merged.push(node)
  }
  return merged.length > 0 ? merged : [{ text: '' }]
}

const collectInlineAndImages = (
  nodes: readonly Descendant[],
  singleLine: boolean,
  insideLink = false
): Descendant[] => {
  const result: Descendant[] = []
  for (const node of nodes) {
    if (TextApi.isText(node)) {
      result.push(cleanTextLeaf(node, singleLine))
      continue
    }
    if (!ElementApi.isElement(node)) continue
    if (
      node.type === 'img' &&
      typeof node.url === 'string' &&
      isSupportedDocxImportImageSrc(node.url)
    ) {
      if (!insideLink) {
        result.push({
          type: 'img',
          url: normalizeDocxImageSrc(node.url),
          caption: Array.isArray(node.caption) ? node.caption : [{ text: '' }],
          children: [{ text: '' }]
        })
      }
      continue
    }
    if (
      node.type === 'a' &&
      !insideLink &&
      typeof node.url === 'string' &&
      isSafeLinkHref(node.url)
    ) {
      const linkChildren = mergeAdjacentInlineNodes(
        collectInlineAndImages(node.children, singleLine, true)
      )
      const linkText = linkChildren
        .map((child) => (TextApi.isText(child) ? child.text : ''))
        .join('')
      if (linkText.trim().length > 0) {
        result.push({
          type: 'a',
          url: node.url.trim(),
          children: linkChildren
        })
      }
      continue
    }
    const inner = collectInlineAndImages(node.children, singleLine, insideLink)
    if (
      result.length > 0 &&
      inner.length > 0 &&
      (node.type === 'p' ||
        node.type === 'li' ||
        node.type === 'lic' ||
        /^h[1-6]$/u.test(node.type))
    ) {
      result.push({ text: singleLine ? ' ' : '\n' })
    }
    result.push(...inner)
  }
  return result
}

const collectNonEmptyTextLeaves = (nodes: readonly Descendant[]): FormattedText[] => {
  const leaves: FormattedText[] = []
  for (const node of nodes) {
    if (TextApi.isText(node)) {
      if (node.text.trim().length > 0) leaves.push(node as FormattedText)
    } else if (ElementApi.isElement(node)) {
      leaves.push(...collectNonEmptyTextLeaves(node.children))
    }
  }
  return leaves
}

const removeBoldFromInlineTree = (nodes: readonly Descendant[]): Descendant[] =>
  nodes.map((node) => {
    if (TextApi.isText(node)) {
      const { bold: _bold, ...rest } = node as FormattedText
      void _bold
      return rest
    }
    if (ElementApi.isElement(node)) {
      return {
        ...node,
        children: removeBoldFromInlineTree(node.children)
      }
    }
    return node
  })

const stripUniformBold = (nodes: Descendant[]): Descendant[] => {
  const nonEmptyLeaves = collectNonEmptyTextLeaves(nodes)
  if (nonEmptyLeaves.length === 0 || !nonEmptyLeaves.every((leaf) => Boolean(leaf.bold))) {
    return nodes
  }
  return mergeAdjacentInlineNodes(removeBoldFromInlineTree(nodes))
}

const hasNonEmptyInlineContent = (nodes: readonly Descendant[]): boolean =>
  nodes.some((node) => (TextApi.isText(node) ? node.text.length > 0 : ElementApi.isElement(node)))

const splitBlockAroundImages = (
  blockType: string,
  children: readonly Descendant[],
  singleLine: boolean
): TElement[] => {
  const flat = collectInlineAndImages(children, singleLine)
  const blocks: TElement[] = []
  let inlineBuffer: Descendant[] = []
  const isHeading = /^h[1-6]$/u.test(blockType)

  const flushInlineBuffer = (): void => {
    if (!hasNonEmptyInlineContent(inlineBuffer)) {
      inlineBuffer = []
      return
    }
    const merged = mergeAdjacentInlineNodes(inlineBuffer)
    blocks.push({
      type: blockType,
      children: isHeading ? stripUniformBold(merged) : merged
    })
    inlineBuffer = []
  }

  for (const item of flat) {
    if (ElementApi.isElement(item) && item.type === 'img') {
      flushInlineBuffer()
      blocks.push(item)
    } else {
      inlineBuffer.push(item)
    }
  }
  flushInlineBuffer()

  if (blocks.length === 0 && blockType !== 'p') {
    return [{ type: blockType, children: [{ text: '' }] }]
  }
  return blocks
}

const extractTaskCheckboxPrefix = (
  inlineChildren: Descendant[]
): { checked?: boolean; children: Descendant[] } => {
  const first = inlineChildren[0]
  if (!first || !TextApi.isText(first)) return { children: inlineChildren }

  const ballotMatch = /^([☐☑☒])(?:\s+|$)/u.exec(first.text)
  if (ballotMatch) {
    const checked = ballotMatch[1] !== '☐'
    const remainingText = first.text.slice(ballotMatch[0].length)
    const rest = [
      ...(remainingText ? [{ ...first, text: remainingText }] : []),
      ...inlineChildren.slice(1)
    ]
    return { checked, children: rest.length > 0 ? rest : [{ text: '' }] }
  }

  const bracketMatch = /^\[([ xX])\](?:\s+|$)/u.exec(first.text)
  if (bracketMatch) {
    const checked = bracketMatch[1].toLowerCase() === 'x'
    const remainingText = first.text.slice(bracketMatch[0].length)
    const rest = [
      ...(remainingText ? [{ ...first, text: remainingText }] : []),
      ...inlineChildren.slice(1)
    ]
    return { checked, children: rest.length > 0 ? rest : [{ text: '' }] }
  }

  return { children: inlineChildren }
}

const normalizeList = (listNode: TElement): TElement | undefined => {
  const listType = listNode.type === 'ol' ? 'ol' : 'ul'
  const items: TElement[] = []

  for (const rawItem of listNode.children) {
    if (!ElementApi.isElement(rawItem)) continue
    if (rawItem.type === 'ul' || rawItem.type === 'ol') {
      const nested = normalizeList(rawItem)
      if (!nested) continue
      const prevItem = items.at(-1)
      if (prevItem) {
        prevItem.children.push(nested)
      } else {
        items.push({
          type: 'li',
          children: [{ type: 'lic', children: [{ text: '' }] }, nested]
        })
      }
      continue
    }

    const nestedLists: TElement[] = []
    const inlineParts: Descendant[] = []
    for (const child of rawItem.children) {
      if (ElementApi.isElement(child) && (child.type === 'ul' || child.type === 'ol')) {
        const normalizedNested = normalizeList(child)
        if (normalizedNested) nestedLists.push(normalizedNested)
      } else {
        if (
          inlineParts.length > 0 &&
          ElementApi.isElement(child) &&
          (child.type === 'p' || child.type === 'lic')
        ) {
          inlineParts.push({ text: ' ' })
        }
        inlineParts.push(
          ...collectInlineAndImages([child], true).filter(
            (item) => !(ElementApi.isElement(item) && item.type === 'img')
          )
        )
      }
    }

    const mergedInline = mergeAdjacentInlineNodes(inlineParts)
    const explicitChecked = typeof rawItem.checked === 'boolean' ? rawItem.checked : undefined
    const taskParsed =
      explicitChecked === undefined
        ? extractTaskCheckboxPrefix(mergedInline)
        : { checked: explicitChecked, children: mergedInline }

    items.push({
      type: 'li',
      ...(typeof taskParsed.checked === 'boolean' ? { checked: taskParsed.checked } : {}),
      children: [{ type: 'lic', children: taskParsed.children }, ...nestedLists]
    })
  }

  if (items.length === 0) return undefined
  const start =
    listType === 'ol' && typeof listNode.start === 'number' && listNode.start > 1
      ? listNode.start
      : undefined
  return {
    type: listType,
    ...(start !== undefined ? { start } : {}),
    children: items
  }
}

const normalizeTableCell = (cellNode: TElement, cellType: 'th' | 'td'): TElement => {
  const inlineParts = collectInlineAndImages(cellNode.children, true).filter(
    (item) => !(ElementApi.isElement(item) && item.type === 'img')
  )
  const merged = mergeAdjacentInlineNodes(inlineParts)
  return {
    type: cellType,
    children: [
      {
        type: 'p',
        children: cellType === 'th' ? stripUniformBold(merged) : merged
      }
    ]
  }
}

const collectTableRows = (nodes: readonly Descendant[]): TElement[] => {
  const rows: TElement[] = []
  for (const node of nodes) {
    if (!ElementApi.isElement(node)) continue
    if (node.type === 'tr') {
      rows.push(node)
    } else {
      rows.push(...collectTableRows(node.children))
    }
  }
  return rows
}

const normalizeTable = (tableNode: TElement): TElement | undefined => {
  const rawRows = collectTableRows(tableNode.children)
  const rowCells = rawRows
    .map((row) =>
      row.children.filter(
        (cell): cell is TElement =>
          ElementApi.isElement(cell) && (cell.type === 'th' || cell.type === 'td')
      )
    )
    .filter((cells) => cells.length > 0)

  if (rowCells.length === 0) return undefined
  const columnCount = Math.max(...rowCells.map((cells) => cells.length))
  if (columnCount === 0) return undefined

  const normalizedRows: TElement[] = rowCells.map((cells, rowIndex) => {
    const cellType: 'th' | 'td' = rowIndex === 0 ? 'th' : 'td'
    const normalizedCells = Array.from({ length: columnCount }, (_, colIndex) => {
      const cell = cells[colIndex]
      return cell
        ? normalizeTableCell(cell, cellType)
        : { type: cellType, children: [{ type: 'p', children: [{ text: '' }] }] }
    })
    return {
      type: 'tr',
      children: normalizedCells
    }
  })

  // GFM tables require at least one header row; if only one row exists, it still serializes
  // with a delimiter row and empty body, which round-trips cleanly.
  return {
    type: 'table',
    children: normalizedRows
  }
}

const normalizeCodeBlock = (node: TElement): TElement => {
  const rawLang = typeof node.lang === 'string' ? node.lang.trim() : ''
  const lang =
    rawLang && /^[A-Za-z0-9_+-]+$/u.test(rawLang) && !DISALLOWED_CODE_LANGUAGES.test(rawLang)
      ? rawLang
      : undefined

  const rawLines = node.children.flatMap((child) => {
    const text = stripDocxCommentTokens(
      TextApi.isText(child)
        ? child.text
        : ElementApi.isElement(child)
          ? child.children.map((leaf) => (TextApi.isText(leaf) ? leaf.text : '')).join('')
          : ''
    ).replace(/\r\n|\r/g, '\n')
    return text.split('\n')
  })

  const lines = rawLines.length > 0 ? rawLines : ['']
  return {
    type: 'code_block',
    ...(lang ? { lang } : {}),
    children: lines.map((line) => ({
      type: 'code_line',
      children: [{ text: line }]
    }))
  }
}

const normalizeBlockquote = (node: TElement): TElement[] => {
  const paragraphs: TElement[] = []
  let inlineBuffer: Descendant[] = []

  const flushInline = (): void => {
    if (!hasNonEmptyInlineContent(inlineBuffer)) {
      inlineBuffer = []
      return
    }
    paragraphs.push({
      type: 'p',
      children: mergeAdjacentInlineNodes(inlineBuffer)
    })
    inlineBuffer = []
  }

  for (const child of node.children) {
    if (ElementApi.isElement(child) && (child.type === 'p' || /^h[1-6]$/u.test(child.type))) {
      flushInline()
      const split = splitBlockAroundImages('p', child.children, false)
      for (const block of split) {
        if (block.type === 'p') paragraphs.push(block)
      }
    } else {
      inlineBuffer.push(
        ...collectInlineAndImages([child], false).filter(
          (item) => !(ElementApi.isElement(item) && item.type === 'img')
        )
      )
    }
  }
  flushInline()

  if (paragraphs.length === 0) return []
  return [{ type: 'blockquote', children: paragraphs }]
}

export const normalizeImportedDocxNodes = (nodes: readonly Descendant[]): Value => {
  const blocks: TElement[] = []

  for (const node of nodes) {
    if (TextApi.isText(node)) {
      const cleaned = cleanTextLeaf(node, false)
      if (cleaned.text.trim().length > 0) {
        blocks.push({ type: 'p', children: [cleaned] })
      }
      continue
    }
    if (!ElementApi.isElement(node)) continue

    if (node.type === 'p') {
      blocks.push(...splitBlockAroundImages('p', node.children, false))
      continue
    }
    if (/^h[1-6]$/u.test(node.type)) {
      blocks.push(...splitBlockAroundImages(node.type, node.children, true))
      continue
    }
    if (node.type === 'blockquote') {
      blocks.push(...normalizeBlockquote(node))
      continue
    }
    if (node.type === 'ul' || node.type === 'ol') {
      const normalized = normalizeList(node)
      if (normalized) blocks.push(normalized)
      continue
    }
    if (node.type === 'code_block') {
      blocks.push(normalizeCodeBlock(node))
      continue
    }
    if (node.type === 'table') {
      const normalized = normalizeTable(node)
      if (normalized) blocks.push(normalized)
      continue
    }
    if (node.type === 'hr') {
      blocks.push({ type: 'hr', children: [{ text: '' }] })
      continue
    }
    if (
      node.type === 'img' &&
      typeof node.url === 'string' &&
      isSupportedDocxImportImageSrc(node.url)
    ) {
      blocks.push({
        type: 'img',
        url: normalizeDocxImageSrc(node.url),
        caption: Array.isArray(node.caption) ? node.caption : [{ text: '' }],
        children: [{ text: '' }]
      })
      continue
    }

    // Unknown container element: recursively normalize its children.
    blocks.push(...normalizeImportedDocxNodes(node.children))
  }

  return blocks
}

export const convertDocxBytesToMarkdown = async (
  bytes: Uint8Array | ArrayBuffer
): Promise<string> => {
  const rawBuffer = toExactArrayBuffer(bytes)
  if (rawBuffer.byteLength === 0) {
    throw new Error('Cannot open an empty Word document.')
  }

  const preparedBuffer = await prepareDocxArrayBufferForImport(rawBuffer)
  const importEditor = createDocxImportEditor()
  const imported = await importDocx(importEditor, preparedBuffer)
  const normalized = normalizeImportedDocxNodes(imported.nodes)
  if (normalized.length === 0) return ''

  const markdown = serializeMarkdownDocument(normalized)
  const verification = parseMarkdownDocument(markdown)
  if (verification.mode !== 'rich') {
    throw new Error('Converted Word document contains unsupported Markdown constructs.')
  }
  return markdown
}

const renderTextWithSoftBreaks = (text: string): React.ReactNode => {
  if (!text.includes('\n')) return text
  const parts = text.split('\n')
  const children: React.ReactNode[] = []
  parts.forEach((part, index) => {
    if (part.length > 0) children.push(part)
    if (index < parts.length - 1) {
      children.push(React.createElement('br', { key: `br-${index}` }))
    }
  })
  return React.createElement('span', null, ...children)
}

const renderLeafNode = (leaf: FormattedText, key: React.Key): React.ReactNode => {
  if (!leaf.text) return null
  let content: React.ReactNode = renderTextWithSoftBreaks(leaf.text)
  if (leaf.code) content = React.createElement('code', null, content)
  if (leaf.strikethrough) content = React.createElement('del', null, content)
  if (leaf.italic) content = React.createElement('em', null, content)
  if (leaf.bold) content = React.createElement('strong', null, content)
  return React.createElement(React.Fragment, { key }, content)
}

const renderInlineChildren = (children: readonly Descendant[]): React.ReactNode[] =>
  children.map((child, index) => {
    if (TextApi.isText(child)) {
      return renderLeafNode(child as FormattedText, index)
    }
    if (!ElementApi.isElement(child)) return null
    if (child.type === 'a' && typeof child.url === 'string' && child.url.trim()) {
      return React.createElement(
        'a',
        { key: index, href: child.url.trim() },
        React.createElement('span', null, ...renderInlineChildren(child.children))
      )
    }
    return React.createElement(
      React.Fragment,
      { key: index },
      ...renderInlineChildren(child.children)
    )
  })

const captionToAlt = (element: TElement): string =>
  Array.isArray(element.caption)
    ? element.caption
        .map((leaf) =>
          leaf && typeof leaf === 'object' && 'text' in leaf && typeof leaf.text === 'string'
            ? leaf.text
            : ''
        )
        .join('')
    : ''

const renderBlockNode = (node: TElement, key: React.Key): React.ReactNode => {
  switch (node.type) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return React.createElement(node.type, { key }, ...renderInlineChildren(node.children))

    case 'p':
      return React.createElement('p', { key }, ...renderInlineChildren(node.children))

    case 'blockquote': {
      const quoteParagraphs = node.children.filter(ElementApi.isElement)
      if (quoteParagraphs.length === 0) {
        return React.createElement('blockquote', { key }, ...renderInlineChildren(node.children))
      }
      return React.createElement(
        React.Fragment,
        { key },
        ...quoteParagraphs.map((paragraph, pIndex) =>
          React.createElement(
            'blockquote',
            { key: `${String(key)}-q-${pIndex}` },
            React.createElement('span', null, ...renderInlineChildren(paragraph.children))
          )
        )
      )
    }

    case 'ul':
    case 'ol': {
      const listProps: Record<string, unknown> = { key }
      if (node.type === 'ol' && typeof node.start === 'number' && node.start > 1) {
        listProps.start = node.start
      }
      const listItems = node.children
        .filter((child): child is TElement => ElementApi.isElement(child) && child.type === 'li')
        .map((li, liIndex) => {
          const checkedPrefix =
            typeof li.checked === 'boolean' ? (li.checked ? '☑ ' : '☐ ') : undefined
          const renderedChildren: React.ReactNode[] = []
          let prefixInjected = false

          li.children.forEach((liChild, childIndex) => {
            if (!ElementApi.isElement(liChild)) return
            if (liChild.type === 'ul' || liChild.type === 'ol') {
              renderedChildren.push(renderBlockNode(liChild, `${liIndex}-sub-${childIndex}`))
              return
            }
            const prefix = !prefixInjected && checkedPrefix ? checkedPrefix : null
            prefixInjected = true
            renderedChildren.push(
              React.createElement(
                'p',
                { key: `${liIndex}-p-${childIndex}` },
                prefix,
                ...renderInlineChildren(liChild.children)
              )
            )
          })

          if (!prefixInjected && checkedPrefix) {
            renderedChildren.unshift(
              React.createElement('p', { key: `${liIndex}-p-empty` }, checkedPrefix)
            )
          }

          return React.createElement('li', { key: liIndex }, ...renderedChildren)
        })
      return React.createElement(node.type, listProps, ...listItems)
    }

    case 'code_block': {
      const lines = node.children.map((child) =>
        ElementApi.isElement(child)
          ? child.children.map((leaf) => (TextApi.isText(leaf) ? leaf.text : '')).join('')
          : TextApi.isText(child)
            ? child.text
            : ''
      )
      const joined = lines.join('\n')
      if (node.lang === DROPDOWN_LANGUAGE) {
        const dropdown = decodeDropdownDefinition(joined)
        if (dropdown) {
          return React.createElement('p', { key }, dropdown.selected)
        }
      }
      const lineNodes: React.ReactNode[] = []
      lines.forEach((line, index) => {
        if (line.length > 0) lineNodes.push(line)
        if (index < lines.length - 1) {
          lineNodes.push(React.createElement('br', { key: `code-br-${index}` }))
        }
      })
      return React.createElement('pre', { key }, React.createElement('span', null, ...lineNodes))
    }

    case 'table': {
      const rows = node.children.filter(
        (child): child is TElement => ElementApi.isElement(child) && child.type === 'tr'
      )
      if (rows.length === 0) return null
      const renderRow = (
        row: TElement,
        rowIndex: number,
        forceCellTag?: 'th' | 'td'
      ): React.ReactNode => {
        const cells = row.children.filter(
          (cell): cell is TElement =>
            ElementApi.isElement(cell) && (cell.type === 'th' || cell.type === 'td')
        )
        return React.createElement(
          'tr',
          { key: rowIndex },
          ...cells.map((cell, cellIndex) => {
            const tag = forceCellTag ?? (cell.type === 'th' ? 'th' : 'td')
            const paragraphs = cell.children.filter(ElementApi.isElement)
            const cellBody =
              paragraphs.length > 0
                ? paragraphs.map((p, pIndex) =>
                    React.createElement('p', { key: pIndex }, ...renderInlineChildren(p.children))
                  )
                : [React.createElement('p', { key: 0 }, ...renderInlineChildren(cell.children))]
            return React.createElement(tag, { key: cellIndex }, ...cellBody)
          })
        )
      }
      const [headRow, ...bodyRows] = rows
      return React.createElement(
        'table',
        { key },
        React.createElement('thead', null, renderRow(headRow, 0, 'th')),
        bodyRows.length > 0
          ? React.createElement(
              'tbody',
              null,
              ...bodyRows.map((row, index) => renderRow(row, index + 1, 'td'))
            )
          : null
      )
    }

    case 'hr':
      return React.createElement('hr', { key })

    case 'img': {
      const url = typeof node.url === 'string' ? normalizeDocxImageSrc(node.url) : ''
      const alt = captionToAlt(node)
      if (DOCX_NATIVE_DATA_IMAGE_PATTERN.test(url)) {
        return React.createElement('p', { key }, React.createElement('img', { src: url, alt }))
      }
      if (isSafeRemoteImageUrl(url)) {
        return React.createElement(
          'p',
          { key },
          React.createElement('a', { href: url }, React.createElement('span', null, alt || url))
        )
      }
      return alt ? React.createElement('p', { key }, alt) : null
    }

    default:
      return React.createElement('p', { key }, ...renderInlineChildren(node.children))
  }
}

const transcodeWebpDataUrlToPng = async (dataUrl: string): Promise<string> => {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return dataUrl
  return await new Promise<string>((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || img.width || 1
        canvas.height = img.naturalHeight || img.height || 1
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(dataUrl)
          return
        }
        ctx.drawImage(img, 0, 0)
        const pngUrl = canvas.toDataURL('image/png')
        resolve(pngUrl.startsWith('data:image/png;base64,') ? pngUrl : dataUrl)
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

const prepareNodesForDocxExport = async (nodes: Value): Promise<Value> => {
  const prepared: TElement[] = []
  for (const node of nodes) {
    if (
      ElementApi.isElement(node) &&
      node.type === 'img' &&
      typeof node.url === 'string' &&
      /^data:image\/webp;base64,/iu.test(node.url.trim())
    ) {
      prepared.push({
        ...node,
        url: await transcodeWebpDataUrlToPng(node.url.trim())
      })
    } else {
      prepared.push(node)
    }
  }
  return prepared
}

function DocxStaticRenderer(props: PlateStaticProps): React.ReactElement {
  const children = (props.value ?? props.editor.children) as Value
  return React.createElement(
    React.Fragment,
    null,
    ...children.map((node, index) => renderBlockNode(node, index))
  )
}

export const convertMarkdownToDocxBytes = async (markdown: string): Promise<Uint8Array> => {
  const parsed = parseMarkdownDocument(markdown.replace(/^\uFEFF/u, ''))
  if (parsed.mode !== 'rich') {
    throw new Error('Markdown draft cannot be exported safely to DOCX.')
  }
  const baseValue: Value =
    parsed.value.length > 0 ? parsed.value : [{ type: 'p', children: [{ text: '' }] }]
  const exportValue = await prepareNodesForDocxExport(baseValue)
  const blob = await exportToDocx(exportValue, {
    editorStaticComponent: DocxStaticRenderer,
    fontFamily: 'Calibri'
  })
  return new Uint8Array(await blob.arrayBuffer())
}
