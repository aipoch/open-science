import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LITERATURE_CITATION_STYLES, type LiteratureItemInput } from '../../shared/literature'
import { LiteratureCitationFormatter } from './citation-formatter'
import { citationResourceDirectory, LiteratureCitationStyleLibrary } from './citation-style-library'

const reference: LiteratureItemInput = {
  itemType: 'journalArticle',
  title: 'Corrective Retrieval Augmented Generation',
  abstract: '',
  issuedText: '2024',
  issuedYear: 2024,
  containerTitle: 'arXiv',
  shortTitle: '',
  language: 'en',
  rights: '',
  url: '',
  extra: '',
  typeFields: { volume: '2401', pages: '15884' },
  creators: [
    { nameMode: 'person', givenName: 'Shi-Qi', familyName: 'Yan', creatorType: 'author' },
    { nameMode: 'person', givenName: 'Jia-Chen', familyName: 'Gu', creatorType: 'author' },
    { nameMode: 'person', givenName: 'Yun', familyName: 'Zhu', creatorType: 'author' },
    { nameMode: 'person', givenName: 'Zhen-Hua', familyName: 'Ling', creatorType: 'author' }
  ],
  identifiers: [{ scheme: 'doi', value: '10.48550/arXiv.2401.15884', isPrimary: true }]
}

describe('LiteratureCitationFormatter', () => {
  it.each([
    [
      'CN  - Research Consortium',
      [{ nameMode: 'organization', literalName: 'Research Consortium', creatorType: 'author' }]
    ],
    [
      'AU  - Smith JA',
      [{ nameMode: 'person', familyName: 'Smith', givenName: 'JA', creatorType: 'author' }]
    ],
    [
      'FAU - Smith, Jane Ann\nAU  - Smith JA\nCN  - Research Consortium\nFAU - Jones, Mary\nAU  - Jones M',
      [
        { nameMode: 'person', familyName: 'Smith', givenName: 'Jane Ann', creatorType: 'author' },
        { nameMode: 'organization', literalName: 'Research Consortium', creatorType: 'author' },
        { nameMode: 'person', familyName: 'Jones', givenName: 'Mary', creatorType: 'author' }
      ]
    ]
  ])('preserves NBIB author semantics and sequence for %s', async (authors, expected) => {
    const result = await new LiteratureCitationFormatter().parseReferences(
      `PMID- 12345\nTI  - Group authored paper\nDP  - 2024\n${authors}\n`
    )
    expect(result.errors).toEqual([])
    expect(result.items[0].creators).toEqual(expected)
  })

  it('preserves uncertain personal names and warns without dropping the record', async () => {
    const parsed = await new LiteratureCitationFormatter().parseReferences(
      'PMID- 12345\nTI  - Paper\nFAU - Unsplit Name\n'
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([['uncertain-author-name']])
    expect(parsed.items[0]).toMatchObject({
      creators: [{ nameMode: 'person', familyName: 'Unsplit Name', givenName: '' }],
      extra: 'FAU - Unsplit Name'
    })
  })

  it('does not drop unmatched abbreviated authors or collapse repeated people', async () => {
    const parsed = await new LiteratureCitationFormatter().parseReferences(
      'PMID- 12345\nTI  - Paper\nAU  - Smith JA\nFAU - Jones, Mary\nAU  - Jones M\nFAU - Jones, Mary\nAU  - Jones M\n'
    )
    expect(parsed.items[0].creators).toEqual([
      { nameMode: 'person', familyName: 'Smith', givenName: 'JA', creatorType: 'author' },
      { nameMode: 'person', familyName: 'Jones', givenName: 'Mary', creatorType: 'author' },
      { nameMode: 'person', familyName: 'Jones', givenName: 'Mary', creatorType: 'author' }
    ])
  })

  it('keeps adjacent people with the same surname and different initials distinct', async () => {
    const parsed = await new LiteratureCitationFormatter().parseReferences(
      'PMID- 12345\nTI  - Paper\nAU  - Smith JA\nFAU - Smith, Mary\nAU  - Smith M\n'
    )
    expect(parsed.items[0].creators).toHaveLength(2)
    expect(parsed.items[0].creators[0]).toMatchObject({ familyName: 'Smith', givenName: 'JA' })
    expect(parsed.items[0].creators[1]).toMatchObject({ familyName: 'Smith', givenName: 'Mary' })
  })

  it('formats every pinned built-in style without network access', async () => {
    const formatter = new LiteratureCitationFormatter()

    const [apa] = await formatter.formatReferences(
      [{ id: 'crag', item: reference }],
      'apa',
      'zh-CN'
    )
    const [vancouver] = await formatter.formatReferences(
      [{ id: 'crag', item: reference }],
      'vancouver',
      'en-US'
    )
    const [mla] = await formatter.formatReferences(
      [{ id: 'crag', item: reference }],
      'mla',
      'en-US'
    )

    expect(apa).toMatchObject({
      inText: '(Yan 等, 2024)',
      reference: expect.stringContaining('Corrective Retrieval Augmented Generation')
    })
    expect(vancouver).toMatchObject({
      inText: '[1]',
      reference: expect.stringContaining('Yan S-Q')
    })
    expect(mla).toMatchObject({
      inText: expect.stringContaining('Yan'),
      reference: expect.stringContaining('Corrective Retrieval Augmented Generation')
    })

    await expect(formatter.formatStyleExample('apa')).resolves.toMatchObject({
      inText: '(Rivera & Chen, 2024)',
      reference: expect.stringContaining('Genome Editing in Human Cells')
    })

    for (const style of LITERATURE_CITATION_STYLES.filter(
      (candidate) => candidate !== 'apa' && candidate !== 'mla' && candidate !== 'vancouver'
    )) {
      await expect(
        formatter.formatReferences([{ id: 'crag', item: reference }], style, 'en-US')
      ).resolves.toEqual([
        expect.objectContaining({
          itemId: 'crag',
          inText: expect.any(String),
          reference: expect.stringContaining('Corrective Retrieval Augmented Generation')
        })
      ])
    }
  })

  it('formats references with an imported CSL style', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-formatter-csl-'))
    try {
      const styles = new LiteratureCitationStyleLibrary(join(root, 'styles'))
      const styleId = await styles.import(
        await readFile(join(citationResourceDirectory(), 'apa.csl'), 'utf8')
      )
      const formatter = new LiteratureCitationFormatter(styles)

      await expect(
        formatter.formatReferences([{ id: 'crag', item: reference }], styleId, 'en-US')
      ).resolves.toEqual([
        expect.objectContaining({
          itemId: 'crag',
          reference: expect.stringContaining('Corrective Retrieval Augmented Generation')
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exports the same CSL projection as BibTeX and RIS', async () => {
    const formatter = new LiteratureCitationFormatter()
    const references = [{ id: 'crag', item: reference }]

    await expect(formatter.exportReferences(references, 'bibtex')).resolves.toContain(
      '@article{crag'
    )
    await expect(formatter.exportReferences(references, 'ris')).resolves.toContain('TY  - JOUR')
  })

  it('keeps duplicate keys observable to the complete export owner instead of silently renaming them', async () => {
    const formatter = new LiteratureCitationFormatter()
    const content = await formatter.exportReferences(
      [
        { id: 'first', item: { ...reference, citationKey: 'SameKey' } },
        { id: 'second', item: { ...reference, title: 'Another paper', citationKey: 'SameKey' } }
      ],
      'bibtex'
    )
    expect(content.match(/@article\{SameKey,/gu)).toHaveLength(2)
    expect(content).not.toContain('@article{SameKeya,')
    await expect(
      formatter.exportReferences(
        [
          { id: 'first', item: { ...reference, citationKey: 'SameKey' } },
          { id: 'second', item: { ...reference, citationKey: 'SameKey' } }
        ],
        'ris'
      )
    ).resolves.toContain('TY  - JOUR')
  })

  it('isolates an invalid stored custom style from formatting, export, and record import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-invalid-csl-'))
    try {
      const directory = join(root, 'styles')
      await mkdir(directory)
      const digest = 'a'.repeat(64)
      await writeFile(
        join(directory, `${digest}.csl`),
        '<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text"><info><title>Broken style</title><id>https://example.test/styles/broken</id></info></style>'
      )
      const styles = new LiteratureCitationStyleLibrary(directory)
      const formatter = new LiteratureCitationFormatter(styles)
      const references = [{ id: 'crag', item: reference }]

      await expect(formatter.formatStyleExample(`custom:${digest}`)).rejects.toThrow()
      await expect(formatter.formatReferences(references, 'apa', 'en-US')).resolves.toEqual([
        expect.objectContaining({ inText: '(Yan et al., 2024)' })
      ])
      await expect(formatter.exportReferences(references, 'bibtex')).resolves.toContain(
        '@article{crag'
      )
      await expect(formatter.exportReferences(references, 'ris')).resolves.toContain('TY  - JOUR')
      await expect(
        formatter.parseReferences('@article{example, title={A useful paper}, year={2024}}')
      ).resolves.toMatchObject({ items: [expect.objectContaining({ title: 'A useful paper' })] })
      expect((await styles.list()).some(({ id }) => id === `custom:${digest}`)).toBe(true)
      await styles.delete(`custom:${digest}`)
      expect((await styles.list()).some(({ id }) => id === `custom:${digest}`)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('parses BibTeX and RIS into the same Literature model', async () => {
    const formatter = new LiteratureCitationFormatter()

    await expect(
      formatter.parseReferences(`
        @article{yan2024,
          title={Corrective Retrieval Augmented Generation},
          author={Yan, Shi-Qi and Gu, Jia-Chen},
          year={2024},
          journal={arXiv},
          doi={10.48550/arXiv.2401.15884}
        }
      `)
    ).resolves.toMatchObject({
      format: 'bibtex',
      items: [
        {
          title: 'Corrective Retrieval Augmented Generation',
          issuedYear: 2024,
          citationKey: 'yan2024',
          identifiers: [{ scheme: 'doi', value: '10.48550/arXiv.2401.15884' }]
        }
      ],
      errors: [],
      truncated: false,
      scannedEntries: 1
    })

    await expect(
      formatter.parseReferences(
        'TY  - JOUR\nTI  - A useful paper\nAU  - Smith, Jane\nPY  - 2023\nER  -'
      )
    ).resolves.toMatchObject({
      format: 'ris',
      items: [{ title: 'A useful paper', issuedYear: 2023 }],
      errors: []
    })
  })

  it('parses PubMed NBIB downloads into the Literature model', async () => {
    const formatter = new LiteratureCitationFormatter()

    await expect(
      formatter.parseReferences(`PMID- 12345678
OWN - NLM
STAT- MEDLINE
PT  - Review
DP  - 2024 Jan
TI  - A useful PubMed paper
AB  - The first line of the abstract.
      The second line continues it.
FAU - Smith, Jane A
CN  - Research Consortium
JT  - Journal of Useful Results
TA  - J Useful Results
VI  - 12
IP  - 3
PG  - 44-58
LID - 10.1234/example.2024.1 [doi]
IS  - 1234-5678 (Electronic)
LA  - eng
PMC - PMC1234567
`)
    ).resolves.toMatchObject({
      format: 'nbib',
      items: [
        {
          itemType: 'review',
          title: 'A useful PubMed paper',
          abstract: 'The first line of the abstract. The second line continues it.',
          issuedText: '2024 Jan',
          issuedYear: 2024,
          containerTitle: 'Journal of Useful Results',
          shortTitle: 'J Useful Results',
          language: 'eng',
          url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/',
          typeFields: { volume: '12', issue: '3', pages: '44-58' },
          creators: [
            {
              nameMode: 'person',
              familyName: 'Smith',
              givenName: 'Jane A',
              creatorType: 'author'
            },
            {
              nameMode: 'organization',
              literalName: 'Research Consortium',
              creatorType: 'author'
            }
          ],
          identifiers: [
            { scheme: 'pmid', value: '12345678', isPrimary: true },
            { scheme: 'doi', value: '10.1234/example.2024.1', isPrimary: false },
            { scheme: 'pmcid', value: 'PMC1234567', isPrimary: false },
            { scheme: 'issn', value: '1234-5678', isPrimary: false }
          ]
        }
      ],
      errors: [],
      truncated: false,
      scannedEntries: 1
    })
  })

  it('keeps consecutive PubMed NBIB records independent', async () => {
    const formatter = new LiteratureCitationFormatter()

    await expect(
      formatter.parseReferences(`PMID- 11111111
TI  - First PubMed paper
FAU - Example, Alice
DP  - 2023
JT  - First Journal

PMID- 22222222
TI  - Second PubMed paper
FAU - Example, Bob
DP  - 2024
JT  - Second Journal
`)
    ).resolves.toMatchObject({
      format: 'nbib',
      items: [
        {
          title: 'First PubMed paper',
          issuedYear: 2023,
          containerTitle: 'First Journal',
          identifiers: [{ scheme: 'pmid', value: '11111111', isPrimary: true }]
        },
        {
          title: 'Second PubMed paper',
          issuedYear: 2024,
          containerTitle: 'Second Journal',
          identifiers: [{ scheme: 'pmid', value: '22222222', isPrimary: true }]
        }
      ],
      scannedEntries: 2
    })
  })

  it('imports at most one thousand PubMed records and reports the remaining records', async () => {
    const formatter = new LiteratureCitationFormatter()
    const content = Array.from(
      { length: 1_001 },
      (_, index) => `PMID- ${String(index + 1).padStart(8, '0')}\nTI  - Paper ${index + 1}\n`
    ).join('\n')

    const parsed = await formatter.parseReferences(content)

    expect(parsed.items).toHaveLength(1_000)
    expect(parsed.items.at(-1)?.title).toBe('Paper 1000')
    expect(parsed.scannedEntries).toBe(1_001)
    expect(parsed.truncated).toBe(true)
  })
})
