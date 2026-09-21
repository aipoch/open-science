import { expect, it } from 'vitest'
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFArray,
  PDFHexString,
  PDFRawStream,
  degrees
} from 'pdf-lib'
import { exportAnnotatedPdf } from './pdf-export'
import type { PdfExportMark } from './pdf-export-contract'

const checksum = async (data: ArrayBuffer): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
const mark = (kind: PdfExportMark['kind'], id = kind): PdfExportMark => ({
  id,
  kind,
  color: 'yellow',
  note: '中文批注\n' + 'Long comment\n'.repeat(500),
  createdAt: '2026-09-20T00:00:00Z',
  updatedAt: '2026-09-20T01:00:00Z',
  pageNumber: 1,
  quads: [[20, 80, 140, 80, 20, 60, 140, 60]]
})
const input = async (): Promise<ArrayBuffer> => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 400])
  page.drawText('Original content')
  page.setCropBox(10, 15, 250, 320)
  page.setRotation(degrees(90))
  page.node.set(PDFName.of('UserUnit'), doc.context.obj(2))
  page.node.set(
    PDFName.of('Annots'),
    doc.context.obj([
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 20, 20],
          A: { S: 'URI', URI: PDFHexString.fromText('https://example.org') }
        })
      )
    ])
  )
  return (await doc.save()).buffer as ArrayBuffer
}
it('writes every native type and exact Unicode comments while preserving source contents, page attributes and links', async () => {
  const data = await input()
  const marks = [
    'highlight',
    'underline',
    'squiggly',
    'strikethrough',
    'area',
    'page-note',
    'document-note'
  ].map((kind) => mark(kind as PdfExportMark['kind']))
  const result = await exportAnnotatedPdf({ data, checksum: await checksum(data), marks })
  const original = await PDFDocument.load(data),
    exported = await PDFDocument.load(result)
  const page = exported.getPage(0),
    before = original.getPage(0)
  expect(page.getCropBox()).toEqual(before.getCropBox())
  expect(page.getRotation()).toEqual(before.getRotation())
  expect(page.node.get(PDFName.of('UserUnit'))?.toString()).toBe('2')
  const streams = (doc: typeof original): number[][] => {
    const content = doc.getPage(0).node.Contents() as PDFArray
    return content
      .asArray()
      .map((ref) => [...(doc.context.lookup(ref) as PDFRawStream).getContents()])
  }
  expect(streams(exported)).toEqual(streams(original))
  const annots = page.node.Annots()!
  expect(annots.size()).toBe(8)
  expect(
    exported.context.lookup(annots.get(0), PDFDict).get(PDFName.of('Subtype'))?.toString()
  ).toBe('/Link')
  const types = ['Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Square', 'Text', 'Text']
  marks.forEach((entry, i) => {
    const dict = exported.context.lookup(annots.get(i + 1), PDFDict)
    expect(dict.get(PDFName.of('Subtype'))?.toString()).toBe('/' + types[i])
    expect(dict.lookup(PDFName.of('T'), PDFHexString).decodeText()).toBe('Open-Science')
    expect(dict.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe(entry.note)
    expect(dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))).toBeDefined()
    expect(dict.get(PDFName.of('F'))?.toString()).toBe('4')
  })
})
it('rejects mismatched sources, invalid page geometry and digitally signed inputs', async () => {
  const data = await input(),
    hash = await checksum(data)
  await expect(
    exportAnnotatedPdf({ data, checksum: '0'.repeat(64), marks: [mark('highlight')] })
  ).rejects.toThrow('source-changed')
  await expect(
    exportAnnotatedPdf({ data, checksum: hash, marks: [{ ...mark('area'), pageNumber: 99 }] })
  ).rejects.toThrow('invalid-annotations')
  await expect(
    exportAnnotatedPdf({ data, checksum: hash, marks: [{ ...mark('area'), quads: [[NaN]] }] })
  ).rejects.toThrow('invalid-annotations')
  const signed = await PDFDocument.load(data)
  signed.catalog.set(
    PDFName.of('Perms'),
    signed.context.obj({
      DocMDP: signed.context.register(
        signed.context.obj({
          Type: 'Sig',
          ByteRange: [0, 1, 2, 3],
          Contents: PDFHexString.of('00')
        })
      )
    })
  )
  const signedData = (await signed.save()).buffer as ArrayBuffer
  await expect(
    exportAnnotatedPdf({
      data: signedData,
      checksum: await checksum(signedData),
      marks: [mark('highlight')]
    })
  ).rejects.toThrow('signed')
})

it('refuses encrypted inputs without bypassing encryption', async () => {
  const document = await PDFDocument.create()
  document.addPage()
  document.context.trailerInfo.Encrypt = document.context.register(
    document.context.obj({ Filter: 'Standard' })
  )
  const data = (await document.save()).buffer as ArrayBuffer
  await expect(
    exportAnnotatedPdf({ data, checksum: await checksum(data), marks: [mark('highlight')] })
  ).rejects.toThrow('encrypted')
})

it('replaces committed native originals, preserves unimported marks, and exports deletion of every imported mark', async () => {
  const doc = await PDFDocument.load(await input())
  const annots = doc.getPage(0).node.Annots()!
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [20, 60, 140, 80],
      Contents: PDFHexString.fromText('Original')
    })
  )
  const popup = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Popup', Parent: ref, Rect: [0, 0, 10, 10] })
  )
  const unsupported = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Sound', Rect: [0, 0, 10, 10] })
  )
  annots.push(ref)
  annots.push(popup)
  annots.push(unsupported)
  const data = (await doc.save()).buffer as ArrayBuffer
  const nativeRefs = [{ pageNumber: 1, id: `${ref.objectNumber}R` }]
  const result = await exportAnnotatedPdf({
    data,
    checksum: await checksum(data),
    nativeRefs,
    marks: [mark('highlight')]
  })
  const edited = await PDFDocument.load(result)
  expect(edited.getPage(0).node.Annots()!.size()).toBe(3)
  const repeated = await exportAnnotatedPdf({
    data: result,
    checksum: await checksum(result),
    marks: [mark('highlight')]
  })
  expect((await PDFDocument.load(repeated)).getPage(0).node.Annots()!.size()).toBe(3)
  const deleted = await exportAnnotatedPdf({
    data,
    checksum: await checksum(data),
    nativeRefs,
    marks: []
  })
  const output = await PDFDocument.load(deleted)
  const types = output
    .getPage(0)
    .node.Annots()!
    .asArray()
    .map((ref) => output.context.lookup(ref, PDFDict).get(PDFName.of('Subtype'))?.toString())
  expect(types).toEqual(['/Link', '/Sound'])
})
