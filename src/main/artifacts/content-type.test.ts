import { describe, expect, it } from 'vitest'

import { validateArtifactContentType } from './content-type'

const pngSample = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const zipSample = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])

describe('validateArtifactContentType', () => {
  it('accepts a matching declared type, extension, and binary signature', () => {
    expect(() =>
      validateArtifactContentType({
        filename: 'plot.png',
        declaredContentType: 'image/png',
        sample: pngSample
      })
    ).not.toThrow()
  })

  it('rejects a declared type that contradicts the binary signature', () => {
    expect(() =>
      validateArtifactContentType({
        filename: 'plot.png',
        declaredContentType: 'image/jpeg',
        sample: pngSample
      })
    ).toThrow(/declared MIME type.*detected source type/i)
  })

  it('rejects a known filename extension that contradicts the binary signature', () => {
    expect(() =>
      validateArtifactContentType({
        filename: 'plot.jpg',
        declaredContentType: 'application/octet-stream',
        sample: pngSample
      })
    ).toThrow(/source type.*filename/i)
  })

  it('allows an unknown text format without pretending to identify its bytes', () => {
    expect(() =>
      validateArtifactContentType({
        filename: 'analysis.custom',
        declaredContentType: 'text/plain',
        sample: Buffer.from('plain text')
      })
    ).not.toThrow()
  })

  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['document.odt', 'application/vnd.oasis.opendocument.text'],
    ['workbook.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['slides.odp', 'application/vnd.oasis.opendocument.presentation'],
    ['book.epub', 'application/epub+zip'],
    ['library.jar', 'application/java-archive']
  ])('accepts ZIP-container bytes for %s', (filename, declaredContentType) => {
    expect(() =>
      validateArtifactContentType({ filename, declaredContentType, sample: zipSample })
    ).not.toThrow()
  })

  it('still rejects ZIP-container bytes declared as a non-container format', () => {
    expect(() =>
      validateArtifactContentType({
        filename: 'plot.png',
        declaredContentType: 'image/png',
        sample: zipSample
      })
    ).toThrow(/declared MIME type.*detected source type/i)
  })

  it('allows a macro-enabled Office ZIP-container MIME without inventing a final subtype detector', () => {
    expect(() =>
      validateArtifactContentType({
        filename: 'macros.xlsm',
        declaredContentType: 'application/vnd.ms-excel.sheet.macroenabled.12',
        sample: zipSample
      })
    ).not.toThrow()
  })

  it.each(['text/plain', 'text/csv', 'application/json'])(
    'rejects ZIP bytes declared as unrelated %s content',
    (declaredContentType) => {
      expect(() =>
        validateArtifactContentType({
          filename: 'data.custom',
          declaredContentType,
          sample: zipSample
        })
      ).toThrow(/declared MIME type.*detected source type/i)
    }
  )

  it.each([
    ['plot.png', 'image/png'],
    ['report.pdf', 'application/pdf'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['macros.xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12'],
    ['bundle.custom', 'application/x-custom+zip']
  ])('rejects %s when its required binary signature is absent', (filename, declaredContentType) => {
    expect(() =>
      validateArtifactContentType({
        filename,
        declaredContentType,
        sample: Buffer.from('not the declared binary format')
      })
    ).toThrow(/required signature/i)
  })
})
