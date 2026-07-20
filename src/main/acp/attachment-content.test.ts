import { describe, expect, it } from 'vitest'

import {
  MAX_EMBEDDED_TEXT_UPLOAD_BYTES,
  buildOversizedAttachmentNotice,
  formatBytes,
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

describe('MAX_EMBEDDED_TEXT_UPLOAD_BYTES', () => {
  it('is 512 KB', () => {
    expect(MAX_EMBEDDED_TEXT_UPLOAD_BYTES).toBe(512 * 1024)
  })
})
