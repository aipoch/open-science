import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const moduleUrl = pathToFileURL(
  resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')
).href
const { hasTableEvidence } = await import(moduleUrl)

it('rejects incomplete glossary grids, unnumbered references and corresponding-author addresses', () => {
  const glossary = {
    issues: [],
    grid: [
      ['AEC', 'Automatic exposure control'],
      ['AGD', 'Average glandular dose'],
      ['', ''],
      ['DBT', 'Digital breast tomosynthesis'],
      ['MLO', 'Mediolateral oblique']
    ],
    unassigned: ['Abbreviations']
  }
  const contacts = {
    issues: [],
    grid: [
      ['Medical Oncology Unit', 'Radiation Therapy Unit'],
      ['123 Main Street', '456 Other Street']
    ],
    unassigned: ['Corresponding author. E-mail address: author@example.org']
  }
  const references = {
    issues: [],
    grid: [
      ['Author A et al. 2008 Title', '(doi:10.1234/example)'],
      ['Author B et al. 2009 Title', '(doi:10.1234/second)'],
      ['Author C et al. 2010 Title', '(doi:10.1234/third)']
    ]
  }
  for (const table of [glossary, contacts, references]) {
    expect(hasTableEvidence(table)).toBe(false)
    expect(hasTableEvidence(table, { text: 'Table 1. A published dataset' })).toBe(true)
  }
  expect(hasTableEvidence({ ...glossary, unassigned: [] })).toBe(true)
  expect(
    hasTableEvidence({ ...contacts, unassigned: ['E-mail address: author@example.org'] })
  ).toBe(true)
  expect(hasTableEvidence({ ...references, grid: references.grid.slice(0, 2) })).toBe(true)
  const abstract = {
    issues: [],
    grid: [
      ['Abstract', 'Objective: Compare treatment outcomes.'],
      ['Results', 'A treatment effect was observed.']
    ]
  }
  expect(hasTableEvidence(abstract, undefined, [{ text: 'K E Y W O R D S' }])).toBe(false)
})

it('rejects parallel abbreviation lists and fragmented affiliation directories', () => {
  const glossary = {
    issues: [],
    grid: [
      ['Abbreviations', '', 'MS', 'Mass spectrometry'],
      ['CI', '95% confidence intervals', 'PK', 'Pharmacokinetics'],
      ['IV', 'Intravenous', 'ORR', 'Objective response rate'],
      ['EPI', 'Epirubicin', '', '']
    ]
  }
  expect(hasTableEvidence(glossary)).toBe(false)
  expect(hasTableEvidence({ ...glossary, grid: glossary.grid.slice(1) })).toBe(true)
  const contacts = {
    issues: [],
    grid: [
      ['1', 'Division of Community Health, Medical College'],
      ['2', 'Division of Epidemiology, Medical College'],
      ['3', 'Division of Biostatistics, Medical College']
    ],
    unassigned: ['author@example.org']
  }
  expect(hasTableEvidence(contacts)).toBe(false)
  const directory = {
    issues: [],
    grid: [
      ['University Hospital, 123 Main Road', '10', 'Medical University, 456 Other Road'],
      ['University Hospital, 789 Main Road', '11', 'Medical University, 123 Other Road']
    ]
  }
  expect(hasTableEvidence(directory, undefined, [{ text: 'Affiliations' }])).toBe(false)
  expect(hasTableEvidence(directory)).toBe(true)
  for (const table of [glossary, contacts, directory]) {
    expect(hasTableEvidence(table, { text: 'Table 1. Institutional dataset' })).toBe(true)
  }
})

it('rejects parallel author correspondence blocks without excluding captioned contact datasets', () => {
  const table = {
    issues: [],
    grid: [
      ['Department A', 'Department B'],
      ['City 12345', 'City 67890'],
      ['E-mail: a@example.org', 'E-mail: b@example.org'],
      ['Tel.: +1-12345', 'Tel.: +2-67890']
    ]
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Institutional contacts' })).toBe(true)
  expect(hasTableEvidence({ ...table, grid: table.grid.slice(0, 3) })).toBe(true)
})

it('rejects fragmented hanging-indent references even when row numbers are lost in the grid', () => {
  const table = {
    cropRect: [0, 0, 300, 200],
    issues: ['text-crosses-crop-boundary'],
    grid: [
      ['32. Author', 'A, other authors'],
      ['Journal', ''],
      ['33. Another', 'author and title']
    ]
  }
  const items = [32, 33, 34].flatMap((n, i) => [
    { text: `${n}.`, rect: [10, 10 + i * 50, 25, 20 + i * 50], baseline: 20 + i * 50, height: 10 },
    {
      text: 'A study title. Journal 9: 1777, 2018.',
      rect: [30, 25 + i * 50, 280, 35 + i * 50],
      baseline: 35 + i * 50,
      height: 10
    }
  ])
  expect(hasTableEvidence(table, undefined, items)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Literature comparison' }, items)).toBe(true)
  expect(hasTableEvidence(table, undefined, items.slice(0, 4))).toBe(true)
})

it('excludes reporting-summary forms but retains captioned tables and ordinary study-design data', () => {
  const marker = { text: 'nature portfolio | reporting summary' }
  const section = { text: 'Life sciences study design' }
  const forms = [
    [
      ['Sample sizeSample size', 'We analyzed the study population.'],
      ['BlindingBlinding', 'Coded data were used.']
    ],
    [
      ['n/a', 'Involved in the study'],
      ['Antibodies', 'ChIP-seq'],
      ['Clinical data', 'Flow cytometry']
    ]
  ]
  for (const grid of forms) {
    const table = { grid, issues: [] }
    expect(hasTableEvidence(table, undefined, [marker, section])).toBe(false)
    expect(hasTableEvidence(table, undefined, [marker])).toBe(true)
    expect(hasTableEvidence(table, undefined, [section])).toBe(true)
    expect(hasTableEvidence(table, { text: 'Table 1. Study designs' }, [marker, section])).toBe(
      true
    )
    expect(
      hasTableEvidence(table, undefined, [
        { text: 'See nature portfolio | reporting summary for details.' },
        section
      ])
    ).toBe(true)
  }
})

// Elsevier article-info/abstract panels can receive high table confidence: the
// first two text lines become rows and the remaining abstract becomes one cell.
it('rejects a keyword sidebar beside an abstract without rejecting prose tables', () => {
  const table = {
    cropRect: [49, 453, 846, 732],
    grid: [
      ['Keywords:', 'Background: Natural compounds are studied for their potential applications.'],
      ['Model organism', 'This review describes the experimental approaches used in recent work.'],
      ['Drug discovery', 'These studies describe the methods and their limitations. '.repeat(12)]
    ],
    issues: ['unassigned-source-text']
  }
  const heading = { text: 'A B S T R A C T', rect: [303, 434, 390, 443] }
  expect(hasTableEvidence(table, undefined, [heading])).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Review of abstracts' }, [heading])).toBe(true)
  // Neither a keyword column nor long descriptions alone makes a table invalid.
  expect(hasTableEvidence(table)).toBe(true)
  for (const rect of [
    [303, 100, 390, 109],
    [900, 434, 980, 443],
    [303, 460, 390, 469]
  ]) {
    expect(hasTableEvidence(table, undefined, [{ ...heading, rect }])).toBe(true)
  }
  expect(
    hasTableEvidence(
      {
        ...table,
        grid: [
          ['Keywords', 'Count'],
          ['Drug', '20'],
          ['Cell', '10']
        ]
      },
      undefined,
      [heading]
    )
  ).toBe(true)
})

it('rejects two-column prose cut into artificial rows without discarding labelled text tables', () => {
  const paragraphs = [
    [
      'The patients in this study were treated after surgery to evaluate',
      'The results described in the following section indicate that the'
    ],
    [
      'changes in expression at each of the designated intervals.',
      'expression levels were associated with a change in response.'
    ],
    [
      'Further experiments were performed to determine the mechanism.',
      'These findings suggest an effect on the subsequent recovery.'
    ]
  ]
  const issues = ['text-crosses-crop-boundary', 'unassigned-source-text']
  expect(hasTableEvidence({ grid: paragraphs, issues })).toBe(false)
  expect(hasTableEvidence({ grid: paragraphs.map(([text], i) => [String(i), text]), issues })).toBe(
    true
  )
  expect(
    hasTableEvidence({ grid: paragraphs, issues }, { text: 'Table 1. Comparison of descriptions' })
  ).toBe(true)
})

it('rejects an article-info/abstract heading straddling the crop edge', () => {
  const table = {
    cropRect: [40, 441, 850, 734],
    grid: [
      ['Keywords:', 'A study of the experimental methods.'],
      ['Model organism', 'These studies describe the methods and their limitations. '.repeat(12)]
    ],
    issues: ['unassigned-source-text']
  }
  const heading = { text: 'A B S T R A C T', rect: [303, 438, 388, 448] }
  const articleInfo = [
    { text: 'A R T I C L E', rect: [56, 438, 127, 448] },
    { text: 'I N F O', rect: [135, 438, 174, 448] }
  ]
  expect(hasTableEvidence(table, undefined, [heading, ...articleInfo])).toBe(false)
  expect(hasTableEvidence(table, undefined, [heading])).toBe(true)
  expect(hasTableEvidence(table, undefined, articleInfo)).toBe(true)
  expect(
    hasTableEvidence(table, { text: 'Table 1. Abstract comparison' }, [heading, ...articleInfo])
  ).toBe(true)
  expect(
    hasTableEvidence(
      table,
      undefined,
      [heading, ...articleInfo].map((item) => ({
        ...item,
        rect: item.rect.map((value, index) => value + (index % 2 ? 80 : 0))
      }))
    )
  ).toBe(true)
})

// Minimized, anonymized outputs from s11914-026-00956-3: page 1 affiliations
// became a 3x1 grid; page 5 prose became an empty 5x9 grid with overlapping columns.
it.each([
  {
    grid: [['contact@example.org'], ['Department A'], ['Department B']],
    issues: ['unassigned-source-text', 'unresolved-multiline-cell']
  },
  {
    grid: Array.from({ length: 5 }, () => Array<string>(9).fill('')),
    issues: ['overlapping-predicted-columns', 'unassigned-source-text']
  }
])('rejects the text-only paper false positive: $issues', (table) => {
  expect(hasTableEvidence(table, undefined)).toBe(false)
})

it('rejects clipped prose with a short continuation column only when most text is unassigned', () => {
  const table = {
    grid: [
      ['following the procedure as previously described in', 'earlier work'],
      ['the detailed procedure can be found in', 'additional materials']
    ],
    unassigned: ['Unplaced body prose with many words '.repeat(8)],
    issues: ['text-crosses-crop-boundary', 'unassigned-source-text']
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence({ ...table, unassigned: [] })).toBe(true)
  expect(hasTableEvidence(table, { text: 'Table 1. Procedures' })).toBe(true)
  for (const values of [
    ['10 mg', '20 mg'],
    ['−10 mg', '−20 mg'],
    ['.5 mg', ',5 mg']
  ])
    expect(
      hasTableEvidence({
        ...table,
        grid: [
          ['Dose administered daily to the first treatment group', values[0]],
          ['Dose administered daily to the second treatment group', values[1]]
        ]
      })
    ).toBe(true)
})
it('keeps a captionless text table without requiring numeric cells', () => {
  expect(
    hasTableEvidence({
      grid: [
        ['Category', 'Description'],
        ['A', 'First'],
        ['B', 'Second']
      ],
      issues: []
    })
  ).toBe(true)
})

it('rejects clipped bibliography prose when reference markers form an artificial short column', () => {
  const table = {
    grid: [
      ['A. Author and B. Author, A review of retrieval systems,', '[30]'],
      ['C. Author, A study of query rewriting in search,', 'et al., [32]'],
      ['D. Author, A view of reranking from lists to pages,', '[33]']
    ],
    unassigned: ['Unplaced reference authors and publication details '.repeat(20)],
    issues: ['text-crosses-crop-boundary', 'unassigned-source-text']
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table I. Comparison of studies' })).toBe(true)
})

it('keeps supported rows beneath a merged header and allows missing cells', () => {
  expect(
    hasTableEvidence({
      grid: [
        ['Merged heading', '', ''],
        ['A', '10', ''],
        ['B', '', '20']
      ],
      issues: ['unassigned-source-text']
    })
  ).toBe(true)
})

it('requires a reliable caption for a single-column table, and never accepts empty content', () => {
  const caption = { text: 'Table 1. Supported single-column table.' }
  expect(hasTableEvidence({ grid: [['Heading'], ['Value']], issues: [] }, caption)).toBe(true)
  expect(
    hasTableEvidence(
      {
        grid: [
          ['', ''],
          ['', '']
        ],
        issues: []
      },
      caption
    )
  ).toBe(false)
})

it('rejects overlapping or single-row guesses without a caption', () => {
  expect(
    hasTableEvidence({
      grid: [
        ['A', 'B'],
        ['C', 'D']
      ],
      issues: ['overlapping-predicted-columns']
    })
  ).toBe(false)
  expect(hasTableEvidence({ grid: [['A', 'B']], issues: [] })).toBe(false)
})

// SIM: a bibliography heading and one wrapped reference became four artificial rows.
it('rejects a standalone references section split into columns', () => {
  const table = {
    grid: [
      ['first author upon request.', '', ''],
      ['References', '', ''],
      ['1. Centers for Disease Control', 'and Prevention,', '“Cost-Effectiveness'],
      ['Analysis,” published September', '2024, accessed', 'November 1, 2025,']
    ],
    unassigned: ['https://www.cdc.gov/example.html'],
    issues: ['text-crosses-crop-boundary', 'unassigned-source-text']
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Reference comparison' })).toBe(true)
  expect(
    hasTableEvidence({ ...table, grid: table.grid.filter((row) => row[0] !== 'References') })
  ).toBe(true)
  expect(
    hasTableEvidence({
      ...table,
      grid: [
        ['Study', 'Year', 'References'],
        ['First', '2024', '1. Author'],
        ['Second', '2025', '2. Author']
      ]
    })
  ).toBe(true)
})

it('rejects bibliography continuations with missing numbered entries, but preserves numbered data tables', () => {
  const grid = [
    [
      '10.',
      'Smith, A. et al. A detailed study of plant growth in changing environments. Journal of Plants 13 (2023).'
    ],
    [
      '11.',
      'Brown, B. An investigation of nutrient delivery and its effects on roots and leaves. Plant Research (2022).'
    ],
    [
      '12.',
      'Chen, C. et al. Effects of bacteria on plant health and resistance to disease in field trials. (2021).'
    ],
    ['', 'A continuation of the citation text.'],
    [
      '14.',
      'Singh, D. et al. A comparison of plant growth patterns under different treatment conditions in the greenhouse. (2024).'
    ],
    [
      '15.',
      'Khan, E. et al. A systematic review of bacterial influences on plant growth and development in field studies. (2025).'
    ],
    ['', 'Acknowledgements'],
    ['', 'The authors thank the participants.']
  ]
  const table = { grid, issues: [], unassigned: [] }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Included studies' })).toBe(true)
  expect(hasTableEvidence({ ...table, grid: [['No.', 'Study'], ...grid] })).toBe(true)
  expect(
    hasTableEvidence({
      ...table,
      grid: [
        ['1.', '20'],
        ['2.', '30'],
        ['3.', '40']
      ]
    })
  ).toBe(true)
})

it('rejects received/accepted publication metadata beside an abstract', () => {
  const table = {
    grid: [
      ['Received: 17 September 2024', 'A. Author, B. Author'],
      ['Accepted: 8 October 2025', ''],
      [
        'Published online: 20 November 2025',
        'Meta-analysis enhances the power of association tests.'
      ],
      ['Check for updates', 'The study describes methods and results for the analysis. '.repeat(10)]
    ],
    issues: []
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Publication history' })).toBe(true)
  expect(
    hasTableEvidence({
      ...table,
      grid: table.grid.map((row) => [row[0].replace('Accepted:', 'Status:'), row[1]])
    })
  ).toBe(true)
})

it('rejects bibliographies whose publication years fell into unassigned text', () => {
  const table = {
    grid: [
      [
        '34.',
        'Jiang, L., Zheng, Z., Fang, H. & Yang, J. A generalized linear mixed model association tool for biobank-scale data.'
      ],
      [
        '35.',
        'Dey, R., Schmidt, E., Abecasis, G. & Lee, S. A fast and accurate algorithm to test binary phenotypes.'
      ],
      [
        '36.',
        'Bulik-Sullivan, B. et al. LD score regression distinguishes confounding from polygenicity in genome-wide association studies.'
      ],
      [
        '37.',
        'Denny, J. et al. PheWAS: demonstrating the feasibility of a phenome-wide scan to discover gene–disease associations.'
      ]
    ],
    issues: ['unassigned-source-text'],
    unassigned: ['1616–1621 (2021).', '37–49 (2017).']
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Publications' })).toBe(true)
})

it('rejects a paragraph split through ordinary word spaces but retains real prose columns', () => {
  const grid = Array.from({ length: 4 }, () => [
    'treatment assigned to participants',
    'received combination treatment before surgery'
  ])
  const cells = grid.flatMap((_, row) =>
    [0, 1].map((column) => ({
      column,
      colSpan: 1,
      rect: [column * 100, row * 20, (column + 1) * 100, row * 20 + 15]
    }))
  )
  const items = grid.flatMap((_, row) => [
    {
      text: 'participants',
      rect: [80, row * 20, 99, row * 20 + 10],
      height: 10,
      baseline: row * 20 + 10
    },
    {
      text: 'received',
      rect: [103, row * 20, 140, row * 20 + 10],
      height: 10,
      baseline: row * 20 + 10
    }
  ])
  const table = { grid, cells, issues: ['text-crosses-crop-boundary'] }
  expect(hasTableEvidence(table, undefined, items)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Treatments' }, items)).toBe(true)
  expect(
    hasTableEvidence(
      table,
      undefined,
      items.map((item, i) =>
        i % 2 ? { ...item, rect: item.rect.map((v, j) => (j % 2 ? v : v + 25)) } : item
      )
    )
  ).toBe(true)
})

it('rejects clipped bibliography numbers with journal-style years', () => {
  const table = {
    issues: ['text-crosses-crop-boundary'],
    grid: [
      [
        '- 39',
        'Zheng Y, Yang X, Yan C, et al. Effect of treatment on patients followed by resection. Eur J Cancer. 2020;130:12–19.'
      ],
      [
        '40 cancer',
        'Tang Z, Wang Y, Yu Y, et al. Neoadjuvant treatment in patients with locally advanced disease. BMC Med. 2022;20:107.'
      ],
      [
        '41',
        'Jardim D, Rodrigues C, Novis Y, Rocha V, Hoff P. Treatment related thrombocytopenia. Ann Oncol. 2012;23:1937–1942.'
      ]
    ]
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Included publications' })).toBe(true)
})

it('excludes article email-alert panels while preserving captioned service comparisons', () => {
  const table = {
    grid: [
      ['References', 'This article cites 12 articles: https://journal.example/article#BIBL'],
      ['Email alerting service', 'Receive free email alerts when new articles cite this article.']
    ]
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Publication services' })).toBe(true)
})

it('rejects paragraph tails from the adjacent page column as table stubs', () => {
  const table = {
    cropRect: [100, 0, 400, 80],
    issues: ['text-crosses-crop-boundary'],
    grid: [
      ['found', 'The participants described how they felt after treatment.'],
      ['for', 'Another participant described a change in their mood.']
    ],
    cells: [0, 40].map((y, row) => ({ row, column: 0, colSpan: 1, rect: [100, y, 140, y + 20] }))
  }
  const items = [0, 40].flatMap((y, r) => [
    {
      text: 'There were no significant differences',
      rect: [0, y + 5, 103, y + 15],
      baseline: y + 15,
      height: 10
    },
    { text: table.grid[r][0], rect: [108, y + 5, 130, y + 15], baseline: y + 15, height: 10 }
  ])
  expect(hasTableEvidence(table, undefined, items)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 2. Interview responses' }, items)).toBe(true)
  expect(
    hasTableEvidence(
      table,
      undefined,
      items.filter((_, i) => i % 2)
    )
  ).toBe(true)
})

it('rejects publisher contact blocks while retaining explicitly captioned comparisons', () => {
  const table = {
    grid: [
      ['Corresponding Author: Jane Smith. E-mail: jane@example.org', 'Body prose'],
      ['doi: 10.1234/example', 'More body prose'],
      ['Published by Example under Creative Commons', 'Article text']
    ]
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { lines: ['Table 1. Publisher comparison'] })).toBe(true)
})

it('rejects small bibliography fragments only with repeated source citation evidence', () => {
  const table = {
    grid: [
      ['Smith et al. Journal 2015;153:173–81', 'Citation continuation'],
      ['More reference text', 'J Sex Med']
    ]
  }
  const source = [{ text: 'Journal 2015;153:173 Journal 2013;31:2942 Journal 2014;12:345' }]
  expect(hasTableEvidence(table, undefined, source)).toBe(false)
  expect(hasTableEvidence(table, { lines: ['Table 2. Studies'] }, source)).toBe(true)
  expect(
    hasTableEvidence(
      {
        grid: [
          ['Treatment', '12'],
          ['Control', '14']
        ],
        issues: []
      },
      undefined,
      source
    )
  ).toBe(true)
})

it('rejects reprint metadata while retaining an explicitly captioned comparison table', () => {
  const table = {
    grid: [
      ['Reprints and permission', 'https://publisher.example/permissions'],
      ['DOI: 10.1000/example', 'Research journal']
    ],
    unassigned: []
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { lines: ['Table 1. Publication metadata comparison'] })).toBe(
    true
  )
})
it('rejects numbered bibliography fragments using parenthesized publication years', () => {
  const table = {
    grid: [
      ['1.', 'Author A et al. Study title. Journal 12, 14–19 (2020).'],
      ['2.', 'Author B et al. Another study. Journal 13, 20–25 (2021).']
    ],
    unassigned: []
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { lines: ['Table 1. Included study references'] })).toBe(true)
})

it('rejects unlinked author-year citations with repeated journal volume and page ranges', () => {
  const table = {
    issues: [],
    grid: [
      [
        'Smith AB 2011 Effects of treatment on the long term outcome',
        'Journal of Research 12 123–130',
        ''
      ],
      [
        'Jones CD 2012 Changes in body weight after the original intervention',
        'Clinical Research 18 222–230',
        ''
      ],
      [
        'Brown EF 2013 Comparison of results from two independent study populations',
        'Other Journal 19 301–310',
        ''
      ]
    ]
  }
  expect(hasTableEvidence(table)).toBe(false)
  expect(hasTableEvidence(table, { text: 'Table 1. Included studies' })).toBe(true)
  expect(hasTableEvidence({ ...table, grid: table.grid.slice(0, 2) })).toBe(true)
})

it('rejects a contents list even when its first entry is associated as a caption', () => {
  const table = {
    grid: [['TABLE 2 Example outcome 34'], ['TABLE 3 Other outcome 35'], ['TABLE 4 Follow-up 39']]
  }
  expect(hasTableEvidence(table, { lines: ['TABLE 1 Schedule 16'] })).toBe(false)
  expect(
    hasTableEvidence(
      {
        grid: [
          ['Department of Surgery', '34', '35'],
          ['Department of Medicine', '20', '25']
        ]
      },
      { text: 'Table 1. Participating sites' }
    )
  ).toBe(true)
})

it('rejects multi-column affiliations but retains measured institutional comparisons', () => {
  const grid = [
    ['1 Department of Surgery, Hospital A', '9', 'Department of Oncology, Hospital B'],
    ['2 Department of Medicine, Hospital C', '10', 'Department of Surgery, Hospital D']
  ]
  expect(hasTableEvidence({ grid })).toBe(false)
  expect(hasTableEvidence({ grid }, { text: 'Table 1. Participating institutions' })).toBe(true)
})

it('excludes uncaptioned author contribution forms and nomenclature lists with source headings', () => {
  const authors = {
    issues: [],
    grid: [
      ['Criteria', 'Author Initials'],
      ['Conception and design', 'A. B.; C. D.'],
      ['Final approval of the version', 'A. B.; C. D.']
    ]
  }
  const glossary = {
    issues: [],
    grid: [
      ['amu', 'atom mass units'],
      ['CID', 'collision-induced dissociation'],
      ['ECD', 'electrochemical detection'],
      ['ESI', 'electrospray ionization'],
      ['LC', 'liquid chromatography'],
      ['M', 'mass of molecular ion']
    ]
  }
  for (const [table, heading] of [
    [authors, 'Author contributions'],
    [glossary, '5. Nomenclature']
  ] as const) {
    expect(hasTableEvidence(table, undefined, [{ text: heading }])).toBe(false)
    expect(hasTableEvidence(table)).toBe(true)
    expect(hasTableEvidence(table, { lines: ['Table 1. Comparison'] }, [{ text: heading }])).toBe(
      true
    )
  }
})
