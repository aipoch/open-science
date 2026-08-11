import { describe, expect, it } from 'vitest'

import {
  MAX_EMBEDDED_TEXT_UPLOAD_BYTES,
  buildDatasetAttachmentNotice,
  buildDeferredMediaNotice,
  buildLocalFileAttachmentNotice,
  buildOversizedAttachmentNotice,
  formatBytes,
  imageAttachmentMimeType,
  isDatasetAttachment,
  isTabularAttachment,
  isTextLikeAttachment
} from './attachment-content'

describe('isTextLikeAttachment', () => {
  it('classifies by MIME type', () => {
    expect(isTextLikeAttachment('x', 'text/plain')).toBe(true)
    expect(isTextLikeAttachment('x', 'text/csv')).toBe(true)
    expect(isTextLikeAttachment('x', 'application/json')).toBe(true)
  })

  it('classifies by extension when the MIME type is missing or generic', () => {
    expect(isTextLikeAttachment('data.csv')).toBe(true)
    expect(isTextLikeAttachment('reads.fastq')).toBe(true)
    expect(isTextLikeAttachment('variants.vcf', 'application/octet-stream')).toBe(true)
    expect(isTextLikeAttachment('tree.nwk')).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(isTextLikeAttachment('DATA.CSV')).toBe(true)
  })

  it('rejects binary files without a text MIME type or extension', () => {
    expect(isTextLikeAttachment('archive.zip')).toBe(false)
    expect(isTextLikeAttachment('reads.bam')).toBe(false)
    expect(isTextLikeAttachment('noext')).toBe(false)
  })

  it('lets a concrete non-text MIME override a text-looking extension', () => {
    // A gzipped FASTQ keeps a .fastq name but is binary — the explicit MIME must win.
    expect(isTextLikeAttachment('reads.fastq', 'application/gzip')).toBe(false)
    expect(isTextLikeAttachment('data.csv', 'application/x-parquet')).toBe(false)
    expect(isTextLikeAttachment('sheet.csv', 'application/vnd.ms-excel')).toBe(false)
  })

  it('falls back to the extension only for a missing or generic MIME', () => {
    expect(isTextLikeAttachment('data.csv', 'application/octet-stream')).toBe(true)
    expect(isTextLikeAttachment('data.csv', 'binary/octet-stream')).toBe(true)
    expect(isTextLikeAttachment('archive.zip', 'application/octet-stream')).toBe(false)
  })

  it('normalizes MIME casing and parameters before classifying', () => {
    expect(isTextLikeAttachment('data.csv', 'Text/CSV')).toBe(true)
    expect(isTextLikeAttachment('data.json', 'application/json; charset=utf-8')).toBe(true)
    expect(isTextLikeAttachment('notes.txt', 'TEXT/PLAIN')).toBe(true)
    // A generic MIME with a parameter still defers to the extension.
    expect(isTextLikeAttachment('data.csv', 'application/octet-stream; charset=binary')).toBe(true)
  })

  it('accepts structured-suffix and chemical text MIME types', () => {
    expect(isTextLikeAttachment('regions.geojson', 'application/geo+json')).toBe(true)
    expect(isTextLikeAttachment('feed.xml', 'application/atom+xml')).toBe(true)
    expect(isTextLikeAttachment('1abc.pdb', 'chemical/x-pdb')).toBe(true)
    expect(isTextLikeAttachment('mol.sdf', 'chemical/x-mdl-sdfile')).toBe(true)
    // A compressed payload stays binary even with a text-looking name.
    expect(isTextLikeAttachment('reads.fastq', 'application/gzip')).toBe(false)
  })
})

describe('imageAttachmentMimeType', () => {
  it('resolves a concrete image MIME type', () => {
    expect(imageAttachmentMimeType('x', 'image/png')).toBe('image/png')
    expect(imageAttachmentMimeType('x', 'image/jpeg')).toBe('image/jpeg')
    expect(imageAttachmentMimeType('x', 'IMAGE/WEBP')).toBe('image/webp')
    expect(imageAttachmentMimeType('x', 'image/gif; foo=bar')).toBe('image/gif')
  })

  it('falls back to the extension when the MIME is missing or generic', () => {
    // The reported bug: a screenshot dropped/pasted with no browser MIME must still be sent as pixels.
    expect(imageAttachmentMimeType('image.png')).toBe('image/png')
    expect(imageAttachmentMimeType('photo.JPG')).toBe('image/jpeg')
    expect(imageAttachmentMimeType('shot.jpeg', 'application/octet-stream')).toBe('image/jpeg')
    expect(imageAttachmentMimeType('anim.gif', 'binary/octet-stream')).toBe('image/gif')
    expect(imageAttachmentMimeType('pic.webp')).toBe('image/webp')
    expect(imageAttachmentMimeType('pic.avif')).toBe('image/avif')
  })

  it('lets a concrete non-image MIME stay authoritative', () => {
    expect(imageAttachmentMimeType('image.png', 'application/pdf')).toBeUndefined()
    expect(imageAttachmentMimeType('sheet.csv', 'text/csv')).toBeUndefined()
  })

  it('excludes SVG and unknown or non-image extensions', () => {
    expect(imageAttachmentMimeType('logo.svg', 'image/svg+xml')).toBeUndefined()
    expect(imageAttachmentMimeType('logo.svg')).toBeUndefined()
    expect(imageAttachmentMimeType('archive.zip')).toBeUndefined()
    expect(imageAttachmentMimeType('noext')).toBeUndefined()
    expect(imageAttachmentMimeType('data.csv', 'application/octet-stream')).toBeUndefined()
  })
})

describe('isTabularAttachment', () => {
  it('detects column-oriented files', () => {
    expect(isTabularAttachment('data.csv')).toBe(true)
    expect(isTabularAttachment('data.tsv')).toBe(true)
    expect(isTabularAttachment('x', 'text/tab-separated-values')).toBe(true)
  })

  it('does not treat plain text or JSON as tabular', () => {
    expect(isTabularAttachment('notes.txt')).toBe(false)
    expect(isTabularAttachment('config.json')).toBe(false)
  })

  it('normalizes MIME casing and parameters', () => {
    expect(isTabularAttachment('x', 'Text/CSV; charset=utf-8')).toBe(true)
  })
})

describe('formatBytes', () => {
  it('renders binary units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(19_112_059)).toBe('18.2 MB')
  })
})

describe('buildOversizedAttachmentNotice', () => {
  it('names the file, size, and preview and steers away from a full read', () => {
    const notice = buildOversizedAttachmentNotice({
      name: 'big.csv',
      size: 19_112_059,
      preview: 'id,name\n1,a\n2,b',
      truncated: true,
      tabular: true
    })

    expect(notice).toContain('"big.csv"')
    expect(notice).toContain('18.2 MB')
    expect(notice).toContain('id,name')
    expect(notice).toContain('rows or columns')
    expect(notice).toContain('Do not load the whole file')
    expect(notice).toContain('… file continues')
  })

  it('uses line-range wording for non-tabular files and omits the continuation trailer when complete', () => {
    const notice = buildOversizedAttachmentNotice({
      name: 'notes.txt',
      size: 700_000,
      preview: 'first line',
      truncated: false,
      tabular: false
    })

    expect(notice).toContain('line ranges or sections')
    expect(notice).not.toContain('file continues')
  })
})

describe('binary dataset attachments', () => {
  it('recognizes spreadsheet and columnar scientific data formats', () => {
    expect(isDatasetAttachment('study.xlsx')).toBe(true)
    expect(isDatasetAttachment('events.parquet', 'application/octet-stream')).toBe(true)
    expect(isDatasetAttachment('matrix.h5')).toBe(true)
    expect(isDatasetAttachment('movie.mp4')).toBe(false)
  })

  it('steers the agent toward schema inspection and notebook computation', () => {
    const notice = buildDatasetAttachmentNotice({ name: 'study.xlsx', size: 3_000_000_000 })

    expect(notice).toContain('study.xlsx')
    expect(notice).toContain('available on disk')
    expect(notice).toContain('schema')
    expect(notice).toContain('sample')
    expect(notice).toContain('notebook')
    expect(notice).toContain('Do not load the whole file')
  })
})

describe('generic binary attachments', () => {
  it('keeps unsupported provider file formats available through local tooling', () => {
    const notice = buildLocalFileAttachmentNotice({ name: 'report.docx', size: 24_576 })

    expect(notice).toContain('report.docx')
    expect(notice).toContain('24.0 KB')
    expect(notice).toContain('available on disk')
    expect(notice).toContain('appropriate local tooling')
    expect(notice).toContain('do not send the binary file directly to the model')
  })
})

describe('buildDeferredMediaNotice', () => {
  it.each([
    ['image', 'microscopy.png'],
    ['PDF', 'paper.pdf']
  ] as const)('describes an oversized %s as an on-disk linked resource', (kind, name) => {
    const notice = buildDeferredMediaNotice({ name, size: 3 * 1024 * 1024 * 1024, kind })

    expect(notice).toContain(name)
    expect(notice).toContain('3.0 GB')
    expect(notice).toContain('too large for automatic in-memory processing')
    expect(notice).toContain('available on disk via the linked resource below')
  })
})

describe('MAX_EMBEDDED_TEXT_UPLOAD_BYTES', () => {
  it('is 512 KB', () => {
    expect(MAX_EMBEDDED_TEXT_UPLOAD_BYTES).toBe(512 * 1024)
  })
})
