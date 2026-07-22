import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { OFFICE_PREVIEW_MAX_COMPRESSED_BYTES, validateOfficePackage } from './office-package'

type ZipEntry = {
  name: string
  localName?: string
  extra?: Uint8Array
  compressedSize?: number
  uncompressedSize?: number
  flags?: number
  compressionMethod?: 0 | 8
  data?: Uint8Array
}

const encoder = new TextEncoder()

const getEntryData = (entry: ZipEntry): Uint8Array =>
  entry.data ?? (entry.name.endsWith('.xml') ? encoder.encode('<root/>') : new Uint8Array([0]))

const relationshipsXml = (relationship: string): Uint8Array =>
  encoder.encode(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship}</Relationships>`
  )

const createZip = (
  entries: ZipEntry[],
  options: { reportedEntryCount?: number; trailingData?: Uint8Array; zip64?: boolean } = {}
): Uint8Array => {
  const localRecords: Array<{ bytes: Uint8Array; offset: number }> = []
  let localOffset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.localName ?? entry.name)
    const data = getEntryData(entry)
    const extra = entry.extra ?? new Uint8Array()
    const record = new Uint8Array(30 + name.length + extra.length + data.length)
    const view = new DataView(record.buffer)
    const compressedSize = entry.compressedSize ?? data.length
    const uncompressedSize = entry.uncompressedSize ?? data.length

    view.setUint32(0, 0x04034b50, true)
    view.setUint16(6, entry.flags ?? 0, true)
    view.setUint16(8, entry.compressionMethod ?? 0, true)
    view.setUint32(18, compressedSize, true)
    view.setUint32(22, uncompressedSize, true)
    view.setUint16(26, name.length, true)
    view.setUint16(28, extra.length, true)
    record.set(name, 30)
    record.set(extra, 30 + name.length)
    record.set(data, 30 + name.length + extra.length)
    localRecords.push({ bytes: record, offset: localOffset })
    localOffset += record.length
  }

  const centralSize = entries.reduce(
    (size, entry) => size + 46 + encoder.encode(entry.name).length + (entry.extra?.length ?? 0),
    0
  )
  const trailingData = options.trailingData ?? new Uint8Array()
  const result = new Uint8Array(localOffset + centralSize + 22 + trailingData.length)
  let offset = 0

  for (const record of localRecords) {
    result.set(record.bytes, offset)
    offset += record.bytes.length
  }

  entries.forEach((entry, index) => {
    const name = encoder.encode(entry.name)
    const extra = entry.extra ?? new Uint8Array()
    const view = new DataView(result.buffer, offset)

    view.setUint32(0, 0x02014b50, true)
    view.setUint16(8, entry.flags ?? 0, true)
    view.setUint16(10, entry.compressionMethod ?? 0, true)
    view.setUint32(20, entry.compressedSize ?? getEntryData(entry).length, true)
    view.setUint32(24, entry.uncompressedSize ?? getEntryData(entry).length, true)
    view.setUint16(28, name.length, true)
    view.setUint16(30, extra.length, true)
    view.setUint32(42, localRecords[index].offset, true)
    result.set(name, offset + 46)
    result.set(extra, offset + 46 + name.length)
    offset += 46 + name.length + extra.length
  })

  const eocd = new DataView(result.buffer, offset)
  const reportedEntryCount = options.zip64 ? 0xffff : (options.reportedEntryCount ?? entries.length)
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, reportedEntryCount, true)
  eocd.setUint16(10, reportedEntryCount, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, localOffset, true)
  result.set(trailingData, offset + 22)

  return result
}

const validEntries = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml']
} as const

describe('validateOfficePackage', () => {
  it('uses one 40 MiB compressed-file admission limit for every Office format', () => {
    expect(OFFICE_PREVIEW_MAX_COMPRESSED_BYTES).toBe(40 * 1024 * 1024)
  })

  it.each(Object.entries(validEntries))(
    'accepts a valid %s package index',
    async (extension, names) => {
      await expect(
        validateOfficePackage(
          createZip(
            names.map((name) => ({
              name,
              data:
                name === 'word/document.xml'
                  ? encoder.encode('<document><body/></document>')
                  : undefined
            }))
          ),
          extension as keyof typeof validEntries
        )
      ).resolves.toBeUndefined()
    }
  )

  it('accepts an OOXML package with trailing line whitespace', async () => {
    const docx = createZip(
      validEntries.docx.map((name) => ({
        name,
        data:
          name === 'word/document.xml' ? encoder.encode('<document><body/></document>') : undefined
      })),
      { trailingData: new Uint8Array([0x0d, 0x0a]) }
    )

    await expect(validateOfficePackage(docx, 'docx')).resolves.toBeUndefined()
  })

  it('rejects an OOXML package with arbitrary trailing data', async () => {
    const docx = createZip(
      validEntries.docx.map((name) => ({
        name,
        data:
          name === 'word/document.xml' ? encoder.encode('<document><body/></document>') : undefined
      })),
      { trailingData: new Uint8Array([0xde, 0xad]) }
    )

    await expect(validateOfficePackage(docx, 'docx')).rejects.toThrow(/damaged or unsupported/i)
  })

  it('accepts a legacy XLS compound file', async () => {
    const bytes = new Uint8Array(512)
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

    await expect(validateOfficePackage(bytes, 'xls')).resolves.toBeUndefined()
  })

  it('rejects a legacy XLS file with the wrong signature', async () => {
    await expect(validateOfficePackage(new Uint8Array(512), 'xls')).rejects.toThrow(/legacy Excel/i)
  })

  it('rejects an OOXML file whose package markers do not match its extension', async () => {
    await expect(
      validateOfficePackage(createZip(validEntries.xlsx.map((name) => ({ name }))), 'docx')
    ).rejects.toThrow(/valid DOCX/i)
  })

  it('rejects encrypted ZIP entries', async () => {
    await expect(
      validateOfficePackage(
        createZip(validEntries.docx.map((name) => ({ name, flags: 0x0001 }))),
        'docx'
      )
    ).rejects.toThrow(/encrypted/i)
  })

  it('rejects ZIP64 packages', async () => {
    await expect(
      validateOfficePackage(
        createZip(
          validEntries.pptx.map((name) => ({ name })),
          { zip64: true }
        ),
        'pptx'
      )
    ).rejects.toThrow(/ZIP64/i)
  })

  it('rejects packages with more than 4000 entries', async () => {
    const validation = validateOfficePackage(
      createZip(
        validEntries.xlsx.map((name) => ({ name })),
        { reportedEntryCount: 4001 }
      ),
      'xlsx'
    )
    await expect(validation).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })
    await expect(validation).rejects.toThrow(/too many/i)
  })

  it('rejects a single entry larger than 32 MiB', async () => {
    const entries: ZipEntry[] = [
      ...validEntries.docx.map((name) => ({ name })),
      { name: 'word/media/large.bin', uncompressedSize: 32 * 1024 * 1024 + 1 }
    ]

    await expect(validateOfficePackage(createZip(entries), 'docx')).rejects.toThrow(
      /entry is too large/i
    )
  })

  it('rejects PPTX media whose declared total exceeds the renderer budget', async () => {
    const entries: ZipEntry[] = [
      ...validEntries.pptx.map((name) => ({ name })),
      ...Array.from({ length: 7 }, (_, index) => ({
        name: `ppt/media/video-${index}.bin`,
        uncompressedSize: 32 * 1024 * 1024
      }))
    ]

    const validation = validateOfficePackage(createZip(entries), 'pptx')
    await expect(validation).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })
    await expect(validation).rejects.toThrow(/too much media/i)
  })

  it('allows a large XLSX worksheet entry within the package expansion limit', async () => {
    const worksheet = new Uint8Array(32 * 1024 * 1024 + 1)
    const compressedWorksheet = deflateRawSync(worksheet)
    const xlsx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'xl/workbook.xml' },
      {
        name: 'xl/worksheets/sheet1.xml',
        compressionMethod: 8,
        data: compressedWorksheet,
        uncompressedSize: worksheet.byteLength
      }
    ])

    await expect(validateOfficePackage(xlsx, 'xlsx')).resolves.toBeUndefined()
  })

  it('rejects an XLSX package whose declared total expansion exceeds 128 MiB', async () => {
    const worksheetBytes = 8 * 1024 * 1024
    const compressedWorksheet = deflateRawSync(new Uint8Array(worksheetBytes))
    const xlsx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'xl/workbook.xml' },
      ...Array.from({ length: 17 }, (_, index) => ({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        compressionMethod: 8 as const,
        data: compressedWorksheet,
        uncompressedSize: worksheetBytes
      }))
    ])

    await expect(validateOfficePackage(xlsx, 'xlsx')).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED'
    })
  })

  it('allows an XLSX package whose actual total expansion is exactly 128 MiB', async () => {
    const worksheetBytes = 8 * 1024 * 1024
    const markerBytes = validEntries.xlsx.reduce(
      (total, name) => total + getEntryData({ name }).byteLength,
      0
    )
    const compressedWorksheet = deflateRawSync(new Uint8Array(worksheetBytes))
    const finalWorksheetBytes = worksheetBytes - markerBytes
    const compressedFinalWorksheet = deflateRawSync(new Uint8Array(finalWorksheetBytes))
    const xlsx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'xl/workbook.xml' },
      ...Array.from({ length: 15 }, (_, index) => ({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        compressionMethod: 8 as const,
        data: compressedWorksheet,
        uncompressedSize: worksheetBytes
      })),
      {
        name: 'xl/worksheets/sheet16.xml',
        compressionMethod: 8,
        data: compressedFinalWorksheet,
        uncompressedSize: finalWorksheetBytes
      }
    ])

    await expect(validateOfficePackage(xlsx, 'xlsx')).resolves.toBeUndefined()
  })

  it('keeps the 256 MiB total expansion budget for PPTX packages', async () => {
    const embeddedBytes = 8 * 1024 * 1024
    const compressedEmbedding = deflateRawSync(new Uint8Array(embeddedBytes))
    const pptx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'ppt/presentation.xml' },
      ...Array.from({ length: 17 }, (_, index) => ({
        name: `ppt/embeddings/object${index + 1}.bin`,
        compressionMethod: 8 as const,
        data: compressedEmbedding,
        uncompressedSize: embeddedBytes
      }))
    ])

    await expect(validateOfficePackage(pptx, 'pptx')).resolves.toBeUndefined()
  })

  it('rejects a non-worksheet XLSX entry larger than 32 MiB', async () => {
    const xlsx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'xl/workbook.xml' },
      { name: 'xl/sharedStrings.xml', uncompressedSize: 32 * 1024 * 1024 + 1 }
    ])

    await expect(validateOfficePackage(xlsx, 'xlsx')).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED'
    })
  })

  it('allows a DOCX package to expand beyond the former 32 MiB total limit', async () => {
    const media = deflateRawSync(new Uint8Array(10 * 1024 * 1024))
    const docx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'word/document.xml', data: encoder.encode('<document><body/></document>') },
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `word/media/image-${index}.bin`,
        compressionMethod: 8 as const,
        data: media,
        uncompressedSize: 10 * 1024 * 1024
      }))
    ])

    await expect(validateOfficePackage(docx, 'docx')).resolves.toBeUndefined()
  })

  it('rejects a package expanding beyond 256 MiB in total', async () => {
    const entries: ZipEntry[] = [
      ...validEntries.pptx.map((name) => ({ name })),
      ...Array.from({ length: 9 }, (_, index) => ({
        name: `ppt/embeddings/${index}.bin`,
        uncompressedSize: 32 * 1024 * 1024
      }))
    ]

    await expect(validateOfficePackage(createZip(entries), 'pptx')).rejects.toThrow(
      /expands too large/i
    )
  })

  it('rejects actual inflated output when ZIP metadata understates its size', async () => {
    const compressed = deflateRawSync(new Uint8Array(32 * 1024 * 1024 + 1))
    const entries: ZipEntry[] = [
      { name: '[Content_Types].xml' },
      { name: 'word/document.xml', data: encoder.encode('<document><body/></document>') },
      {
        name: 'word/media/hidden-bomb.bin',
        compressionMethod: 8,
        data: compressed,
        uncompressedSize: 1
      }
    ]

    await expect(validateOfficePackage(createZip(entries), 'docx')).rejects.toThrow(
      /entry is too large|expands too large/i
    )
  })

  it('rejects external OOXML media relationships before rendering', async () => {
    const pptx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'ppt/presentation.xml' },
      {
        name: 'ppt/slides/_rels/slide1.xml.rels',
        data: relationshipsXml(
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://tracker.example/image.png" TargetMode="External"/>'
        )
      }
    ])

    await expect(validateOfficePackage(pptx, 'pptx')).rejects.toThrow(/external resources/i)
  })

  it('rejects ZIP entries whose local and central names differ', async () => {
    const pptx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'ppt/presentation.xml' },
      {
        name: 'ppt/slides/safe-package-entry.bin',
        localName: 'ppt/slides/_rels/slide1.xml.rels',
        data: relationshipsXml(
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://tracker.example/image.png" TargetMode="External"/>'
        )
      }
    ])

    await expect(validateOfficePackage(pptx, 'pptx')).rejects.toThrow(/damaged or unsupported/i)
  })

  it('rejects Unicode Path extra fields that can override the validated entry name', async () => {
    const unicodePathExtraField = new Uint8Array([0x75, 0x70, 0x01, 0x00, 0x00])
    const docx = createZip([
      { name: '[Content_Types].xml' },
      {
        name: 'word/document.xml',
        extra: unicodePathExtraField,
        data: encoder.encode('<document><body/></document>')
      }
    ])

    await expect(validateOfficePackage(docx, 'docx')).rejects.toThrow(/damaged or unsupported/i)
  })

  it('allows external hyperlinks in DOCX packages', async () => {
    const docx = createZip([
      { name: '[Content_Types].xml' },
      {
        name: 'word/document.xml',
        data: encoder.encode('<document><body/></document>')
      },
      {
        name: 'word/_rels/document.xml.rels',
        data: relationshipsXml(
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/reference" TargetMode="External"/>'
        )
      }
    ])

    await expect(validateOfficePackage(docx, 'docx')).resolves.toBeUndefined()
  })

  it('continues to reject external media relationships in DOCX packages', async () => {
    const docx = createZip([
      { name: '[Content_Types].xml' },
      {
        name: 'word/document.xml',
        data: encoder.encode('<document><body/></document>')
      },
      {
        name: 'word/_rels/document.xml.rels',
        data: relationshipsXml(
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://tracker.example/image.png" TargetMode="External"/>'
        )
      }
    ])

    await expect(validateOfficePackage(docx, 'docx')).rejects.toThrow(/external resources/i)
  })

  it.each([
    [
      'Type',
      '<Relationship xmlns:x="urn:shadow" Id="rId1" x:Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://tracker.example/image.png" TargetMode="External"/>'
    ],
    [
      'TargetMode',
      '<Relationship xmlns:x="urn:shadow" Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://tracker.example/image.png" x:TargetMode="Internal" TargetMode="External"/>'
    ]
  ])('rejects namespace-shadowed %s attributes in external relationships', async (_name, xml) => {
    const docx = createZip([
      { name: '[Content_Types].xml' },
      {
        name: 'word/document.xml',
        data: encoder.encode('<document><body/></document>')
      },
      {
        name: 'word/_rels/document.xml.rels',
        data: relationshipsXml(xml)
      }
    ])

    await expect(validateOfficePackage(docx, 'docx')).rejects.toThrow(/external resources/i)
  })

  it('allows external hyperlinks in PPTX packages', async () => {
    const pptx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'ppt/presentation.xml' },
      {
        name: 'ppt/slides/_rels/slide1.xml.rels',
        data: relationshipsXml(
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://tracker.example/disguised-image.png" TargetMode="External"/>'
        )
      }
    ])

    await expect(validateOfficePackage(pptx, 'pptx')).resolves.toBeUndefined()
  })

  it('rejects relationship XML larger than 4 MiB', async () => {
    const pptx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'ppt/presentation.xml' },
      {
        name: 'ppt/slides/_rels/slide1.xml.rels',
        data: new Uint8Array(4 * 1024 * 1024 + 1)
      }
    ])

    await expect(validateOfficePackage(pptx, 'pptx')).rejects.toThrow(
      /relationship file is too large/i
    )
  })

  it('rejects a DOCX document tree that is too deeply nested', async () => {
    const depth = 130
    const documentXml = encoder.encode(
      `<document>${'<node>'.repeat(depth)}text${'</node>'.repeat(depth)}</document>`
    )
    const docx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'word/document.xml', data: documentXml }
    ])

    await expect(validateOfficePackage(docx, 'docx')).rejects.toThrow(/too complex/i)
  })

  it('rejects a DOCX document with more than 100000 elements', async () => {
    const documentXml = encoder.encode(`<document>${'<node/>'.repeat(100_000)}</document>`)
    const docx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'word/document.xml', data: documentXml }
    ])

    await expect(validateOfficePackage(docx, 'docx')).rejects.toThrow(/too complex/i)
  })

  it('rejects excessive XML complexity in DOCX parts with uppercase extensions', async () => {
    const stylesXml = encoder.encode(`<styles>${'<style/>'.repeat(100_000)}</styles>`)
    const docx = createZip([
      { name: '[Content_Types].xml' },
      { name: 'word/document.xml', data: encoder.encode('<document><body/></document>') },
      { name: 'word/styles.XML', data: stylesXml }
    ])

    await expect(validateOfficePackage(docx, 'docx')).rejects.toThrow(/too complex/i)
  })

  it('rejects an Office file larger than the compressed-size limit', async () => {
    const validation = validateOfficePackage(
      new Uint8Array(OFFICE_PREVIEW_MAX_COMPRESSED_BYTES + 1),
      'xlsx'
    )
    await expect(validation).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' })
    await expect(validation).rejects.toThrow(/too large to preview/i)
  })
})
