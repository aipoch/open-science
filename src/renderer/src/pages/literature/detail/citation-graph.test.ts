import { expect, it } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureRelatedRecord } from '@aipoch/literature-discovery/contracts'
import {
  buildCitationGraph,
  citationGraphRecordsMatch,
  citationMetadataReference,
  supplementedCitation,
  filterCitationGraph,
  citationRecordProvider,
  normalizeCitationPaperId,
  assignCitationGraphSlots,
  citationGraphPosition,
  citationGraphNodeRadius,
  citationGraphEdgeBend,
  nearestCitationGraphNode,
  citationGraphEdgeGeometry,
  citationGraphShortTitle,
  citationGraphCompactLabel,
  citationGraphTextWidth,
  placeCitationGraphLabels,
  fitCitationGraph,
  type CitationGraphEntry
} from './citation-graph'

const paperId = (letter: string): string => `europe-pmc:MED:${letter.charCodeAt(0)}`
const record = (
  letter: string,
  identifiers: { scheme: 'doi' | 'pmid'; value: string }[] = []
): LiteratureRelatedRecord => ({
  paperId: paperId(letter),
  item: literatureItemInputSchema.parse({
    itemType: 'document',
    title: `Paper ${letter}`,
    identifiers
  })
})

it('fits the graph symmetrically around the original paper', () => {
  const camera = fitCitationGraph(
    [
      { x: 400, y: 500 },
      { x: 800, y: 500 },
      { x: 1200, y: 500 }
    ],
    { x: 800, y: 500 }
  )
  expect(camera.x + camera.width / 2).toBe(800)
  expect(camera.y + camera.height / 2).toBe(500)
})
it('draws references out of the center and citations into the center without inventing neighbor edges', () => {
  const graph = buildCitationGraph(record('a'), [
    { direction: 'references', record: record('b') },
    { direction: 'citations', record: record('c') }
  ])
  expect(graph.edges).toEqual([
    { source: paperId('a'), target: paperId('b') },
    { source: paperId('c'), target: paperId('a') }
  ])
})
it('merges provider IDs bridged by normalized scholarly identifiers while retaining both directions', () => {
  const graph = buildCitationGraph(record('a'), [
    {
      direction: 'references',
      record: record('b', [{ scheme: 'doi', value: 'https://doi.org/10.1234/TEST' }])
    },
    { direction: 'citations', record: record('c', [{ scheme: 'pmid', value: '123' }]) },
    {
      direction: 'references',
      record: record('d', [
        { scheme: 'doi', value: '10.1234/test' },
        { scheme: 'pmid', value: 'PMID:123' }
      ])
    }
  ])
  expect(graph.nodes).toHaveLength(2)
  expect(graph.nodes[1].record.item.identifiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scheme: 'doi' }),
      expect.objectContaining({ scheme: 'pmid', value: '123' })
    ])
  )
  expect(graph.edges).toEqual([
    { source: paperId('a'), target: paperId('b') },
    { source: paperId('b'), target: paperId('a') }
  ])
})
it('deduplicates center aliases, suppresses self edges and leaves equal titles separate', () => {
  const center = record('a', [{ scheme: 'doi', value: '10.1234/same' }])
  const same = record('b', [{ scheme: 'doi', value: '10.1234/same' }])
  const other = record('c')
  other.item.title = center.item.title
  const graph = buildCitationGraph(center, [
    { direction: 'references', record: same },
    { direction: 'references', record: other }
  ])
  expect(graph.nodes).toHaveLength(2)
  expect(graph.edges).toEqual([{ source: center.paperId, target: other.paperId }])
})
it('applies the limit after identity resolution and never leaves dangling edges', () => {
  const entries: CitationGraphEntry[] = ['b', 'c', 'd', 'e'].map((letter) => ({
    direction: 'references',
    record: record(letter)
  }))
  const graph = buildCitationGraph(record('a'), entries, 3)
  expect(graph.nodes).toHaveLength(3)
  expect(graph.limited).toBe(true)
  expect(graph.edges).toHaveLength(2)
  expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.target))).toBe(
    true
  )
})

it('keeps slots and coordinates fixed when paging crosses the old dense threshold', () => {
  const center = record('a')
  const entries: CitationGraphEntry[] = Array.from({ length: 35 }, (_, index) => ({
    direction: 'references',
    record: { ...record('b'), paperId: `europe-pmc:MED:${index + 1000}` }
  }))
  const first = buildCitationGraph(center, entries)
  const before = assignCitationGraphSlots(first.nodes, new Map())
  const afterGraph = buildCitationGraph(center, [
    ...entries,
    { direction: 'citations', record: record('f') }
  ])
  const after = assignCitationGraphSlots(afterGraph.nodes, before)
  for (const node of first.nodes) {
    expect(after.get(node.id)).toBe(before.get(node.id))
    expect(citationGraphPosition(after.get(node.id)!)).toEqual(
      citationGraphPosition(before.get(node.id)!)
    )
  }
  expect(new Set([...after.values()]).size).toBe(37)
})

it('gives references, citing papers and a merged mutual paper unique radial positions', () => {
  const graph = buildCitationGraph(record('a'), [
    { direction: 'references', record: record('b') },
    { direction: 'citations', record: record('c') },
    { direction: 'references', record: record('d') },
    { direction: 'citations', record: record('d') }
  ])
  const slots = assignCitationGraphSlots(graph.nodes, new Map())
  const center = citationGraphPosition(-1)
  const node = (letter: string): (typeof graph.nodes)[number] =>
    graph.nodes.find((node) => node.id === paperId(letter))!
  expect(node('b').relation).toBe('references')
  expect(node('c').relation).toBe('citations')
  expect(node('d').relation).toBe('both')
  const points = graph.nodes.map((node) => citationGraphPosition(slots.get(node.id)!))
  expect(new Set(points.map(({ x, y }) => `${x}:${y}`)).size).toBe(4)
  for (const node of graph.nodes.filter((node) => !node.center)) {
    const point = citationGraphPosition(slots.get(node.id)!)
    expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeCloseTo(280)
  }
  expect(graph.nodes).toHaveLength(4)
  expect(
    graph.edges.filter((edge) => edge.source === node('d').id || edge.target === node('d').id)
  ).toHaveLength(2)
})
it('spreads a sparse prefix around the center regardless of citation direction', () => {
  const center = citationGraphPosition(-1)
  const points = [0, 1, 2, 3, 4].map(citationGraphPosition)
  expect(points.slice(0, 2).some((point) => point.x < center.x)).toBe(true)
  expect(points.slice(0, 2).some((point) => point.x > center.x)).toBe(true)
  expect(points.some((point) => point.y < center.y)).toBe(true)
  expect(points.some((point) => point.y > center.y)).toBe(true)
})
it('preserves all slots when a newly discovered relation makes a paper mutual', () => {
  const original: CitationGraphEntry[] = [
    { direction: 'references', record: record('b', [{ scheme: 'doi', value: '10.1234/mutual' }]) },
    { direction: 'references', record: record('c') },
    { direction: 'citations', record: record('d') }
  ]
  const beforeGraph = buildCitationGraph(record('a'), original)
  const before = assignCitationGraphSlots(beforeGraph.nodes, new Map())
  const afterGraph = buildCitationGraph(record('a'), [
    ...original,
    { direction: 'citations', record: record('e', [{ scheme: 'doi', value: '10.1234/mutual' }]) },
    { direction: 'references', record: record('f') }
  ])
  const after = assignCitationGraphSlots(afterGraph.nodes, before)
  expect(after.get(paperId('c'))).toBe(before.get(paperId('c')))
  expect(after.get(paperId('d'))).toBe(before.get(paperId('d')))
  const mutual = afterGraph.nodes.find((node) => node.id === paperId('b'))!
  expect(mutual.paperIds).toContain(paperId('e'))
  expect(mutual.relation).toBe('both')
  expect(after.get(mutual.id)).toBe(before.get(mutual.id))
  expect(afterGraph.nodes.filter((node) => node.paperIds.includes(paperId('e')))).toHaveLength(1)
  expect(assignCitationGraphSlots(afterGraph.nodes, after).get(mutual.id)).toBe(
    after.get(mutual.id)
  )
})
it.each(['references', 'citations'] as const)(
  'distributes one hundred %s around the center without overlapping node positions',
  (direction) => {
    const entries: CitationGraphEntry[] = Array.from({ length: 100 }, (_, index) => ({
      direction,
      record: { ...record('b'), paperId: `europe-pmc:MED:${index + 1000}` }
    }))
    const graph = buildCitationGraph(record('a'), entries)
    const slots = assignCitationGraphSlots(graph.nodes, new Map())
    const positions = graph.nodes
      .filter((node) => !node.center)
      .map((node) => citationGraphPosition(slots.get(node.id)!))
    expect(positions).toHaveLength(100)
    expect(new Set(positions.map(({ x, y }) => `${x}:${y}`)).size).toBe(100)
    expect(positions.some(({ x }) => x < 800)).toBe(true)
    expect(positions.some(({ x }) => x > 800)).toBe(true)
    expect(positions.some(({ y }) => y < 500)).toBe(true)
    expect(positions.some(({ y }) => y > 500)).toBe(true)
    expect(assignCitationGraphSlots(graph.nodes, slots)).toEqual(slots)
  }
)

it('shortens long paper titles for the compact graph label without changing their source', () => {
  const title = 'A sufficiently long paper title with details'
  expect(citationGraphShortTitle(title).endsWith('…')).toBe(true)
  expect(citationGraphShortTitle('短标题')).toBe('短标题')
  expect(citationGraphShortTitle('这是一个需要截断的很长的中文论文标题').endsWith('…')).toBe(true)
  expect(title).toBe('A sufficiently long paper title with details')
})

it('budgets graph authors before rendering while keeping every known year intact', () => {
  const paper = record('b').item
  paper.issuedYear = 2002
  paper.creators = [{ nameMode: 'organization', creatorType: 'author', literalName: '张三丰' }]
  expect(citationGraphCompactLabel(paper, 63)).toBe('张三丰 2002')
  expect(citationGraphTextWidth(citationGraphCompactLabel(paper, 63))).toBeLessThanOrEqual(63)
  for (const name of [
    '张三丰李研究团队',
    'Researcher with a very long name',
    'Wissenschaftlicher Forschungsverbund'
  ]) {
    paper.creators = [{ nameMode: 'organization', creatorType: 'author', literalName: name }]
    const label = citationGraphCompactLabel(paper, 63)
    expect(label.endsWith(' 2002')).toBe(true)
    expect(label).toContain('…')
    expect(citationGraphTextWidth(label)).toBeLessThanOrEqual(63)
    expect(paper.creators[0]).toEqual(expect.objectContaining({ literalName: name }))
  }
})
it('uses the compact missing-year mark and actual center title widths without hard clipping', () => {
  const paper = record('b').item
  paper.creators = [
    {
      nameMode: 'organization',
      creatorType: 'author',
      literalName: 'Wissenschaftlicher Forschungsverbund'
    }
  ]
  expect(citationGraphCompactLabel(paper, 63).endsWith(' —')).toBe(true)
  expect(citationGraphTextWidth(citationGraphCompactLabel(paper, 63))).toBeLessThanOrEqual(63)
  for (const width of [98, 108]) {
    const title = citationGraphShortTitle('WWWWW宽字符和一个很长的论文标题WWW', width)
    expect(title.endsWith('…')).toBe(true)
    expect(citationGraphTextWidth(title)).toBeLessThanOrEqual(width)
  }
})

it('uses stable real circle radii and cuts straight and mutual edges outside their boundaries', () => {
  expect(citationGraphNodeRadius(true)).toBe(22)
  expect(citationGraphNodeRadius(false)).toBe(14)
  const from = { x: 800, y: 500 }
  const to = { x: 800, y: 900 }
  for (const bend of [0, 28, -28]) {
    const edge = citationGraphEdgeGeometry(from, to, 22, 14, 0.5, bend)
    expect(Math.hypot(edge.start.x - from.x, edge.start.y - from.y)).toBeCloseTo(24)
    expect(Math.hypot(edge.end.x - to.x, edge.end.y - to.y)).toBeCloseTo(20)
    expect(edge.end.y).toBeGreaterThan(edge.start.y)
  }
})

it('keeps ordinary edges mildly curved and mutual edges on opposing sides', () => {
  expect(citationGraphEdgeBend('references', 'references')).toBe(14)
  expect(citationGraphEdgeBend('citations', 'citations')).toBe(-14)
  expect(citationGraphEdgeBend('references', 'both')).toBe(28)
  expect(citationGraphEdgeBend('citations', 'both')).toBe(28)

  const from = { x: 800, y: 500 }
  const to = { x: 400, y: 500 }
  const references = citationGraphEdgeGeometry(from, to, 22, 14, 1, 14)
  const citations = citationGraphEdgeGeometry(to, from, 14, 22, 1, 28)
  expect(references.control.y).not.toBe(500)
  expect(citations.control.y).not.toBe(500)
  expect(references.control.y).toBeLessThan(500)
  expect(citations.control.y).toBeGreaterThan(500)
})

it('chooses the closest actual screen-space node when accessible hit areas overlap', () => {
  const points = [
    { id: 'root', x: 80, y: 50 },
    { id: 'b', x: 40, y: 50 },
    { id: 'c', x: 40, y: 59 }
  ]
  expect(nearestCitationGraphNode(points, 40, 50)).toBe('b')
  expect(nearestCitationGraphNode(points, 40, 58)).toBe('c')
  expect(nearestCitationGraphNode([], 40, 50)).toBeUndefined()
})

it('preserves native Europe PMC identity case and keeps its MED and PMC namespaces separate', () => {
  const root = { ...record('a'), paperId: 'europe-pmc:MED:123' }
  const neighbor = { ...record('b'), paperId: 'europe-pmc:PMC:PMC123' }
  const graph = buildCitationGraph(root, [
    { direction: 'references', record: neighbor },
    { direction: 'citations', record: neighbor }
  ])
  expect(graph.nodes.map((node) => ({ id: node.id, aliases: node.paperIds }))).toEqual([
    { id: 'europe-pmc:MED:123', aliases: ['europe-pmc:MED:123'] },
    { id: 'europe-pmc:PMC:PMC123', aliases: ['europe-pmc:PMC:PMC123'] }
  ])
  expect(graph.nodes[1].relation).toBe('both')
  expect(graph.edges).toEqual([
    { source: root.paperId, target: neighbor.paperId },
    { source: neighbor.paperId, target: root.paperId }
  ])
})

it('keeps OpenCitations provider identities and merges exact DOI aliases without losing exploration IDs', () => {
  const center = { ...record('a'), paperId: 'opencitations:br/1' }
  const first = {
    ...record('b', [{ scheme: 'doi', value: '10.1000/oc' }]),
    paperId: 'opencitations:br/2'
  }
  const alias = {
    ...record('c', [{ scheme: 'doi', value: '10.1000/OC' }]),
    paperId: 'opencitations:br/3'
  }
  expect(citationRecordProvider(center.paperId)).toBe('opencitations')
  expect(normalizeCitationPaperId('opencitations:br/001')).toBe('opencitations:br/001')
  const graph = buildCitationGraph(center, [
    { direction: 'references', record: first },
    { direction: 'citations', record: alias }
  ])
  expect(graph.nodes).toHaveLength(2)
  expect(graph.nodes[1]).toMatchObject({
    relation: 'both',
    paperIds: ['opencitations:br/2', 'opencitations:br/3']
  })
  expect(graph.edges).toEqual([
    { source: center.paperId, target: first.paperId },
    { source: first.paperId, target: center.paperId }
  ])
})

it.each([0, 20, 100])(
  'retains five full pages per direction with %i mutual aliases and no slot collisions or dangling edges',
  (overlap) => {
    const entries: CitationGraphEntry[] = ['references', 'citations'].flatMap((direction) =>
      Array.from({ length: 100 }, (_, index) => ({
        direction: direction as CitationGraphEntry['direction'],
        record: {
          ...record('b', [
            {
              scheme: 'doi',
              value: `10.1234/${direction === 'citations' && index >= overlap ? index + 100 : index}`
            }
          ]),
          paperId: `${direction === 'references' ? 'europe-pmc:MED:' : 'opencitations:br/'}${index + 1000}`
        }
      }))
    )
    const graph = buildCitationGraph(record('a'), entries)
    expect(graph.nodes).toHaveLength(201 - overlap)
    expect(graph.edges).toHaveLength(200)
    expect(graph.limited).toBe(false)
    expect(graph.nodes.filter((node) => node.relation === 'both')).toHaveLength(overlap)
    const slots = assignCitationGraphSlots(graph.nodes, new Map())
    const positions = [...slots.values()].map((slot) => citationGraphPosition(slot))
    expect(new Set(slots.values()).size).toBe(graph.nodes.length)
    expect(new Set(positions.map(({ x, y }) => `${x}:${y}`)).size).toBe(graph.nodes.length)
    const ids = new Set(graph.nodes.map((node) => node.id))
    expect(graph.edges.every(({ source, target }) => ids.has(source) && ids.has(target))).toBe(true)
    expect(assignCitationGraphSlots(graph.nodes, slots)).toEqual(slots)
  }
)

it('rejects historical and unknown provider identities instead of treating them as a source', () => {
  for (const invalidId of ['a'.repeat(40), 'unknown:123']) {
    expect(() => normalizeCitationPaperId(invalidId)).toThrow()
    expect(() => citationRecordProvider(invalidId)).toThrow()
    expect(() => buildCitationGraph({ ...record('a'), paperId: invalidId }, [])).toThrow()
  }
})

it('keeps selected and center labels readable while bounding the optional reading set', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    id: `paper-${index}`,
    x: 70 + (index % 5) * 140,
    y: 130 + Math.floor(index / 5) * 55,
    radius: 7,
    label: `Author ${2000 + index}`,
    priority: index === 29 ? 4 : index === 28 ? 2 : 0
  }))
  const labels = placeCitationGraphLabels(candidates, { width: 760, height: 500 }, 8)
  expect(labels.has('paper-29')).toBe(true)
  expect(labels.has('paper-28')).toBe(true)
  expect(labels.size).toBeLessThanOrEqual(8)
  const entries = [...labels]
  for (const [index, [id, point]] of entries.entries()) {
    const width =
      (citationGraphTextWidth(candidates.find((candidate) => candidate.id === id)!.label) * 12) / 11
    expect(point.x - width / 2).toBeGreaterThanOrEqual(0)
    expect(point.x + width / 2).toBeLessThanOrEqual(760)
    expect(point.y).toBeGreaterThanOrEqual(21)
    for (const [otherId, other] of entries.slice(index + 1)) {
      const otherWidth =
        (citationGraphTextWidth(candidates.find((candidate) => candidate.id === otherId)!.label) *
          12) /
        11
      expect(
        Math.abs(point.y - other.y) >= 17 ||
          Math.abs(point.x - other.x) >= (width + otherWidth) / 2 + 8
      ).toBe(true)
    }
  }
})

it('retains the selected label when dense marks suppress optional labels and excludes offscreen papers', () => {
  const labels = placeCitationGraphLabels(
    [
      { id: 'other', x: 150, y: 200, radius: 20, label: 'Other 2024', priority: 0 },
      { id: 'selected', x: 150, y: 210, radius: 20, label: 'Selected 2025', priority: 4 },
      { id: 'outside', x: -200, y: 200, radius: 20, label: 'Outside 2023', priority: 0 }
    ],
    { width: 320, height: 300 }
  )
  expect(labels.has('selected')).toBe(true)
  expect(labels.has('outside')).toBe(false)
})

it.each([false, true])(
  'balances the readable label budget across directions regardless of provider page order (reversed: %s)',
  (reverse) => {
    const regions = ['references', 'citations'] as const
    const groups = regions.map((relation) =>
      Array.from({ length: 20 }, (_, index) => ({
        id: `${relation}-${index}`,
        relation,
        x: relation === 'references' ? 100 : 800,
        y: 130 + index * 40,
        radius: 5,
        label: `Author ${2000 + index}`,
        priority: index === 19 ? (relation === 'citations' ? 4 : 3) : 0
      }))
    )
    const candidates = [
      ...(reverse ? groups.toReversed() : groups).flat(),
      {
        id: 'center',
        relation: 'center' as const,
        x: 450,
        y: 500,
        radius: 10,
        label: 'Center 2025',
        priority: 2
      }
    ]
    const labels = placeCitationGraphLabels(candidates, { width: 900, height: 1100 }, 16)
    const references = [...labels.keys()].filter((id) => id.startsWith('references-'))
    const citations = [...labels.keys()].filter((id) => id.startsWith('citations-'))
    expect(labels.size).toBe(16)
    expect([...labels.keys()].slice(0, 3)).toEqual(['citations-19', 'references-19', 'center'])
    expect(Math.abs(references.length - citations.length)).toBeLessThanOrEqual(1)
    expect(references.length).toBeGreaterThanOrEqual(7)
    expect(citations.length).toBeGreaterThanOrEqual(7)
  }
)

it('lets a crowded center yield its label instead of overlapping the selected paper', () => {
  const labels = placeCitationGraphLabels(
    [
      { id: 'selected', x: 150, y: 200, radius: 20, label: 'Selected author 2025', priority: 4 },
      { id: 'center', x: 150, y: 202, radius: 20, label: 'Center author 2024', priority: 2 }
    ],
    { width: 320, height: 280 }
  )
  expect(labels.has('selected')).toBe(true)
  expect(labels.has('center')).toBe(false)
})

it('does not let an inspected fallback overlap the higher-priority selected fallback in a short plot', () => {
  const labels = placeCitationGraphLabels(
    [
      { id: 'selected', x: 150, y: 22, radius: 20, label: 'Selected author 2025', priority: 4 },
      { id: 'inspected', x: 150, y: 24, radius: 20, label: 'Inspected author 2024', priority: 3 }
    ],
    { width: 320, height: 58 }
  )
  expect(labels.has('selected')).toBe(true)
  expect(labels.has('inspected')).toBe(false)
})

it('filters canonical nodes and real directional edges without duplicating mutual papers', () => {
  const graph = buildCitationGraph(record('a'), [
    { direction: 'references', record: record('b') },
    { direction: 'citations', record: record('c') },
    { direction: 'references', record: record('d', [{ scheme: 'doi', value: '10.1234/shared' }]) },
    { direction: 'citations', record: record('e', [{ scheme: 'doi', value: '10.1234/shared' }]) }
  ])
  const mutual = graph.nodes.find((node) => node.relation === 'both')!
  const slots = assignCitationGraphSlots(graph.nodes, new Map())
  expect(graph.nodes).toHaveLength(4)
  expect(graph.edges).toHaveLength(4)
  expect(filterCitationGraph(graph, 'all')).toBe(graph)
  for (const filter of ['references', 'citations'] as const) {
    const filtered = filterCitationGraph(graph, filter)
    expect(filtered.nodes).toHaveLength(3)
    expect(filtered.edges).toHaveLength(2)
    expect(filtered.nodes.find((node) => node.id === mutual.id)).toBe(mutual)
    expect(
      filtered.edges.every((edge) =>
        filter === 'references' ? edge.source === paperId('a') : edge.target === paperId('a')
      )
    ).toBe(true)
    for (const node of filtered.nodes) expect(slots.has(node.id)).toBe(true)
  }
  expect(mutual.paperIds).toContain(paperId('e'))
})

it('keeps the center when a direction has no results', () => {
  const graph = buildCitationGraph(record('a'), [{ direction: 'citations', record: record('b') }])
  const references = filterCitationGraph(graph, 'references')
  expect(references.nodes).toEqual([graph.nodes[0]])
  expect(references.edges).toEqual([])
})

it('keeps disjoint claims separate even when an intermediate native ID bridges both', () => {
  const pmid = { scheme: 'pmid', value: '12' } as const
  const first = record('b', [pmid, { scheme: 'doi', value: '10.1234/first' }])
  const bridge = record('c', [pmid])
  const last = record('d', [pmid, { scheme: 'doi', value: '10.1234/last' }])
  for (const rows of [
    [first, bridge, last],
    [last, first, bridge]
  ]) {
    const graph = buildCitationGraph(
      record('a'),
      rows.map((record) => ({ direction: 'references', record }))
    )
    expect(graph.nodes.slice(1).map((node) => [node.id, node.conflicting])).toEqual(
      rows.map((r) => [r.paperId, true])
    )
    expect(graph.edges).toHaveLength(3)
  }
  expect(citationGraphRecordsMatch(first, last)).toBe(false)
})

it('uses transport-compatible DOI and PMCID values and fills only verified fields', () => {
  const item = record('b', [{ scheme: 'doi', value: 'https://doi.org/10.1234/Title' }]).item
  const pmcid = { scheme: 'pmcid', value: 'pmc123', isPrimary: false } as const
  const incoming = {
    ...item,
    title: 'Alternate title',
    abstract: 'Verified',
    identifiers: [...item.identifiers, pmcid]
  }
  expect(citationMetadataReference(item)).toBe('10.1234/title')
  expect(citationMetadataReference({ ...item, identifiers: [pmcid] })).toBe('pmcid:PMC123')
  const metadata = new Map([['10.1234/title', incoming]])
  expect(supplementedCitation(item, metadata).item).toMatchObject({
    title: item.title,
    abstract: 'Verified',
    identifiers: incoming.identifiers
  })
  const conflicting = { ...item, identifiers: [...item.identifiers, { ...pmcid, value: 'PMC999' }] }
  expect(supplementedCitation(conflicting, new Map([['pmcid:PMC999', incoming]]))).toEqual({
    item: conflicting
  })
})
