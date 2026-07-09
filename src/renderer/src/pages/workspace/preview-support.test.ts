import { describe, expect, it } from 'vitest'

import { getPreviewFormat } from './preview-support'

describe('preview support format detection', () => {
  it.each([
    ['png', undefined, 'image'],
    ['jpg', undefined, 'image'],
    ['jpeg', undefined, 'image'],
    ['gif', undefined, 'image'],
    ['webp', undefined, 'image'],
    ['svg', undefined, 'image'],
    ['txt', undefined, 'text'],
    ['log', undefined, 'text'],
    ['md', undefined, 'markdown'],
    ['markdown', undefined, 'markdown'],
    ['csv', undefined, 'csv'],
    ['tsv', undefined, 'csv'],
    ['fasta', undefined, 'fasta'],
    ['fa', undefined, 'fasta'],
    ['fna', undefined, 'fasta'],
    ['faa', undefined, 'fasta'],
    ['json', undefined, 'json'],
    ['pdb', undefined, 'pdb'],
    ['html', undefined, 'html'],
    ['htm', undefined, 'html']
  ])('maps .%s files to %s previews', (extension, mimeType, expectedFormat) => {
    expect(getPreviewFormat(extension, mimeType)).toBe(expectedFormat)
  })

  it.each([
    ['application/json', 'json'],
    ['text/html', 'html'],
    ['text/csv', 'csv'],
    ['image/png', 'image'],
    ['text/markdown', 'markdown'],
    ['chemical/x-pdb', 'pdb'],
    ['text/plain', 'text']
  ])('uses mime type %s when the extension is not enough', (mimeType, expectedFormat) => {
    expect(getPreviewFormat('', mimeType)).toBe(expectedFormat)
  })

  it('falls back to unknown for unsupported extensions and mime types', () => {
    expect(getPreviewFormat('zip', 'application/zip')).toBe('unknown')
  })
})
