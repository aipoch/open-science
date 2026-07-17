import { describe, expect, it } from 'vitest'

import {
  getPreviewFormat,
  getPreviewFormatForFile,
  getPreviewThumbnailReadEncoding
} from './preview-support'

describe('preview support format detection', () => {
  it.each([
    ['png', undefined, 'image'],
    ['jpg', undefined, 'image'],
    ['jpeg', undefined, 'image'],
    ['gif', undefined, 'image'],
    ['webp', undefined, 'image'],
    ['svg', undefined, 'image'],
    ['iqtree', undefined, 'text'],
    ['nwk', undefined, 'text'],
    ['state', undefined, 'text'],
    ['tree', undefined, 'text'],
    ['treefile', undefined, 'text'],
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
    ['mol', undefined, 'molecule'],
    ['sdf', undefined, 'molecule'],
    ['smi', undefined, 'molecule'],
    ['smiles', undefined, 'molecule'],
    ['rxn', undefined, 'molecule'],
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
    ['chemical/x-mdl-rxnfile', 'molecule'],
    ['application/xml', 'text'],
    ['application/atom+xml', 'text'],
    ['text/plain', 'text']
  ])('uses mime type %s when the extension is not enough', (mimeType, expectedFormat) => {
    expect(getPreviewFormat('', mimeType)).toBe(expectedFormat)
  })

  it('falls back to unknown for unsupported extensions and mime types', () => {
    expect(getPreviewFormat('zip', 'application/zip')).toBe('unknown')
  })

  it('derives the preview format from source-neutral file metadata', () => {
    expect(getPreviewFormatForFile({ name: 'results.csv', mimeType: 'text/plain' })).toBe('csv')
    expect(getPreviewFormatForFile({ name: 'analysis.treefile' })).toBe('text')
  })

  it.each([
    ['image', undefined],
    ['csv', 'utf8'],
    ['fasta', 'utf8'],
    ['text', 'utf8'],
    ['pdf', undefined],
    ['unknown', undefined]
  ] as const)('uses %s preview encoding %s', (format, expectedEncoding) => {
    expect(getPreviewThumbnailReadEncoding(format)).toBe(expectedEncoding)
  })
})
