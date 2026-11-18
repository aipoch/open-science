import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { OFFICE_PREVIEW_MAX_FILE_BYTES } from '../office-preview'
import { PptxEditError } from './errors'

export const NS = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types'
} as const

export type PptxPackage = {
  files: Map<string, Uint8Array>
  dirty: Set<string>
}

const MAX_ENTRIES = 20_000
const MAX_UNCOMPRESSED_BYTES = 192 * 1024 * 1024

export const loadPackage = (bytes: Uint8Array): PptxPackage => {
  let total = 0
  let count = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        count += 1
        total += file.originalSize
        if (count > MAX_ENTRIES || total > MAX_UNCOMPRESSED_BYTES) {
          throw new PptxEditError('INVALID_PACKAGE', 'Presentation package exceeds size limits.')
        }
        return true
      }
    })
  } catch (error) {
    if (error instanceof PptxEditError) throw error
    throw new PptxEditError('INVALID_PACKAGE', 'Presentation is not a valid zip package.')
  }
  const files = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(entries)) {
    if (!name.endsWith('/')) files.set(name, data)
  }
  if (!files.has('ppt/presentation.xml')) {
    throw new PptxEditError('INVALID_PACKAGE', 'Presentation part is missing.')
  }
  return { files, dirty: new Set() }
}

const STORED_EXTENSIONS = /\.(png|jpe?g|gif|mp4|mov|zip|docx|xlsx|pptx)$/i

export const savePackage = (pkg: PptxPackage): Uint8Array => {
  const zippable: Zippable = {}
  for (const [name, data] of pkg.files) {
    zippable[name] = [data, { level: STORED_EXTENSIONS.test(name) ? 0 : 6 }]
  }
  const bytes = zipSync(zippable)
  if (bytes.byteLength > OFFICE_PREVIEW_MAX_FILE_BYTES) {
    throw new PptxEditError('OUTPUT_TOO_LARGE', 'Edited presentation exceeds the size limit.')
  }
  return bytes
}

export const readPart = (pkg: PptxPackage, name: string): string => {
  const data = pkg.files.get(name)
  if (!data) throw new PptxEditError('INVALID_PACKAGE', `Part ${name} is missing.`)
  return strFromU8(data)
}

export const parseXml = (xml: string, label: string): Document => {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new PptxEditError('INVALID_XML', `${label} contains a forbidden declaration.`)
  }
  const fail = (message: string): never => {
    throw new PptxEditError('INVALID_XML', `${label} is not well-formed XML: ${message}`)
  }
  const parser = new DOMParser({
    errorHandler: { warning: () => {}, error: fail, fatalError: fail }
  })
  return parser.parseFromString(xml, 'text/xml')
}

export const readXml = (pkg: PptxPackage, name: string): Document =>
  parseXml(readPart(pkg, name), name)

export const writeXml = (pkg: PptxPackage, name: string, doc: Document): void => {
  pkg.files.set(name, strToU8(new XMLSerializer().serializeToString(doc)))
  pkg.dirty.add(name)
}

export const writeBytes = (pkg: PptxPackage, name: string, data: Uint8Array): void => {
  pkg.files.set(name, data)
  pkg.dirty.add(name)
}

export const removePart = (pkg: PptxPackage, name: string): void => {
  pkg.files.delete(name)
  pkg.dirty.add(name)
}

export const children = (parent: Element, ns: string, local: string): Element[] => {
  const result: Element[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    const el = node as Element
    if (node.nodeType === 1 && el.localName === local && el.namespaceURI === ns) result.push(el)
  }
  return result
}

export const firstChild = (parent: Element, ns: string, local: string): Element | undefined =>
  children(parent, ns, local)[0]

export const descendants = (root: Element, ns: string, local: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(ns, local)) as Element[]

export const dirname = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)

export const resolveTarget = (basePart: string, target: string): string => {
  if (target.startsWith('/')) return target.slice(1)
  const segments = dirname(basePart).split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '.' && segment !== '') segments.push(segment)
  }
  return segments.join('/')
}

export const relsPathFor = (part: string): string =>
  `${dirname(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`
