import {
  NS,
  descendants,
  parseXml,
  readPart,
  relsPathFor,
  writeXml,
  type PptxPackage
} from './package'

export type Relationship = { id: string; type: string; target: string; mode: string | null }

export type DocSource = {
  has(part: string): boolean
  doc(part: string): Document
}

export const relationshipsOf = (source: DocSource, part: string): Relationship[] => {
  const path = relsPathFor(part)
  if (!source.has(path)) return []
  return descendants(source.doc(path).documentElement, NS.rel, 'Relationship').map((el) => ({
    id: el.getAttribute('Id') ?? '',
    type: el.getAttribute('Type') ?? '',
    target: el.getAttribute('Target') ?? '',
    mode: el.getAttribute('TargetMode')
  }))
}

export class EditContext implements DocSource {
  readonly pkg: PptxPackage
  private readonly docs = new Map<string, Document>()
  private readonly touched = new Set<string>()

  constructor(pkg: PptxPackage) {
    this.pkg = pkg
  }

  has(part: string): boolean {
    return this.docs.has(part) || this.pkg.files.has(part)
  }

  doc(part: string): Document {
    let doc = this.docs.get(part)
    if (!doc) {
      doc = parseXml(readPart(this.pkg, part), part)
      this.docs.set(part, doc)
    }
    return doc
  }

  edit(part: string): Document {
    this.touched.add(part)
    return this.doc(part)
  }

  create(part: string, xml: string): Document {
    const doc = parseXml(xml, part)
    this.docs.set(part, doc)
    this.touched.add(part)
    return doc
  }

  remove(part: string): void {
    this.docs.delete(part)
    this.touched.delete(part)
    this.pkg.files.delete(part)
    this.pkg.dirty.add(part)
  }

  putBytes(part: string, data: Uint8Array): void {
    this.pkg.files.set(part, data)
    this.pkg.dirty.add(part)
  }

  flush(): void {
    for (const part of this.touched) {
      const doc = this.docs.get(part)
      if (doc) writeXml(this.pkg, part, doc)
    }
    this.touched.clear()
  }
}

export const packageSource = (pkg: PptxPackage): DocSource => new EditContext(pkg)
