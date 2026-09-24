import { describe, expect, it } from 'vitest'

import { getFileIconKind } from './file-type-icon-kind'

describe('getFileIconKind', () => {
  it.each([
    ['report.pdf', undefined, 'pdf'],
    ['report.docx', undefined, 'document'],
    ['table.xlsx', undefined, 'spreadsheet'],
    ['table.csv', undefined, 'spreadsheet'],
    ['slides.pptx', undefined, 'presentation'],
    ['figure.png', undefined, 'image'],
    ['diagram.svg', undefined, 'vector'],
    ['archive.tar.gz', undefined, 'archive'],
    ['config.json', undefined, 'data'],
    ['analysis.ipynb', undefined, 'notebook'],
    ['sequence.fasta', undefined, 'sequence'],
    ['compound.sdf', undefined, 'molecule'],
    ['settings.yaml', undefined, 'config'],
    ['script.py', undefined, 'python'],
    ['analysis.R', undefined, 'r'],
    ['script.ts', undefined, 'code'],
    ['document.xml', undefined, 'code'],
    ['notes.md', undefined, 'text'],
    ['report.txt', 'application/pdf', 'text'],
    ['table.csv', 'image/png', 'spreadsheet'],
    ['legacy.doc', undefined, 'document'],
    ['legacy.ppt', undefined, 'presentation'],
    ['extensionless', 'application/pdf', 'pdf'],
    ['extensionless', 'image/svg+xml', 'vector'],
    ['extensionless', 'application/x-ipynb+json', 'notebook'],
    ['extensionless', 'text/html', 'code'],
    ['extensionless', 'text/csv', 'spreadsheet'],
    ['extensionless', 'text/tab-separated-values', 'spreadsheet'],
    ['__proto__', 'application/octet-stream', 'unknown'],
    ['extensionless', 'application/octet-stream', 'unknown']
  ])('%s resolves to %s', (name, mimeType, expected) => {
    expect(getFileIconKind(name, mimeType)).toBe(expected)
  })
})
