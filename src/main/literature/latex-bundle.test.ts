import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import type { LiteratureItemView } from '../../shared/literature'
import { LiteratureLatexBundle } from './latex-bundle'

const item = (id: string, citationKey?: string): LiteratureItemView => ({
  id,
  metadataRevision: 2,
  createdAt: 0,
  updatedAt: 0,
  projectIds: ['project-1'],
  collectionIds: [],
  attachments: [],
  item: {
    itemType: 'journalArticle',
    title: 'A useful paper',
    abstract: '',
    issuedText: '2024',
    issuedYear: 2024,
    containerTitle: 'Journal of Tests',
    shortTitle: '',
    language: 'en',
    rights: '',
    url: '',
    extra: '',
    typeFields: {},
    creators: [],
    identifiers: [],
    ...(citationKey ? { citationKey } : {})
  }
})

describe('LiteratureLatexBundle', () => {
  it('packages semantic citations, BibTeX, and revision mapping for Overleaf', async () => {
    const first = item('item-1', 'smith2024')
    const second = item('item-2')
    const exportReferences = vi.fn(async () => '@article{smith2024}\n@article{fallback}')
    const bundle = new LiteratureLatexBundle(
      { getMany: async () => [first, second] },
      { exportReferences }
    )

    const result = await bundle.prepare({
      sourceName: 'review.tex',
      content:
        '\\usepackage[backend=biber]{biblatex}\n\\addbibresource{references.bib}\nFirst {{cite:item-1}}, again {{cite:item-1}}, second {{cite:item-2}}.\n{{bibliography}}'
    })

    const archive = unzipSync(result.content)
    const latex = strFromU8(archive['review.tex']!)
    const manifest = JSON.parse(strFromU8(archive['.open-science-literature.json']!))
    expect(latex).toContain('First \\cite{smith2024}, again \\cite{smith2024}')
    expect(latex).toMatch(/second \\cite\{os[a-f0-9]{12}\}/u)
    expect(latex).toContain('\\printbibliography')
    expect(strFromU8(archive['references.bib']!)).toContain('@article{smith2024}')
    expect(manifest.citations).toEqual([
      { citationKey: 'smith2024', itemId: 'item-1', metadataRevision: 2 },
      {
        citationKey: expect.stringMatching(/^os[a-f0-9]{12}$/u),
        itemId: 'item-2',
        metadataRevision: 2
      }
    ])
    expect(result).toMatchObject({ citationCount: 3, referenceCount: 2 })
    expect(result.sidecar.literature.citations).toHaveLength(3)
    expect(exportReferences).toHaveBeenCalledWith(
      [
        { id: 'smith2024', item: first.item },
        { id: expect.stringMatching(/^os[a-f0-9]{12}$/u), item: second.item }
      ],
      'bibtex'
    )
  })

  it('rejects unavailable items and duplicate imported citation keys', async () => {
    const missing = new LiteratureLatexBundle(
      { getMany: async () => [] },
      { exportReferences: vi.fn() }
    )
    await expect(
      missing.prepare({ sourceName: 'review.tex', content: '{{cite:missing}}' })
    ).rejects.toThrow('Literature Item is unavailable: missing')

    const duplicate = new LiteratureLatexBundle(
      { getMany: async () => [item('item-1', 'same'), item('item-2', 'same')] },
      { exportReferences: vi.fn() }
    )
    await expect(
      duplicate.prepare({
        sourceName: 'review.tex',
        content: '{{cite:item-1}} {{cite:item-2}}'
      })
    ).rejects.toThrow('duplicate citation keys')

    const incomplete = new LiteratureLatexBundle(
      { getMany: async () => [item('item-1')] },
      { exportReferences: vi.fn() }
    )
    await expect(
      incomplete.prepare({ sourceName: 'review.tex', content: '{{cite:item-1}}' })
    ).rejects.toThrow('must load the biblatex package')
  })
})
