import {
  createLiteratureIdentifierUrl,
  LITERATURE_IDENTITY_SCHEMES,
  normalizeLiteratureIdentifierKey,
  normalizeLiteratureIdentifierValue,
  type BibliographicRecord
} from '@aipoch/literature-citations/contracts'
import {
  literatureRelatedPaperIdSchema,
  type LiteratureRelatedProvider,
  type LiteratureRelatedRecord
} from '@aipoch/literature-discovery/contracts'

export type CitationDirection = 'references' | 'citations'
export type CitationGraphFilter = 'all' | CitationDirection
export type CitationGraphRelation = CitationDirection | 'both' | 'center'
// Each direction loads at most five pages of twenty records, plus the center.
export const CITATION_GRAPH_NODE_LIMIT = 201
export type CitationGraphEntry = { direction: CitationDirection; record: LiteratureRelatedRecord }
export type CitationGraphNode = {
  id: string
  record: LiteratureRelatedRecord
  center: boolean
  relation: CitationGraphRelation
  conflicting?: boolean
  paperIds: string[]
}
export type CitationGraph = {
  nodes: CitationGraphNode[]
  edges: { source: string; target: string }[]
  limited: boolean
}

export function normalizeCitationPaperId(paperId: string): string {
  return literatureRelatedPaperIdSchema.parse(paperId)
}

export function citationRecordProvider(paperId: string): LiteratureRelatedProvider {
  if (paperId.startsWith('europe-pmc:')) return 'europe-pmc'
  if (paperId.startsWith('opencitations:')) return 'opencitations'
  throw new Error('Unsupported citation source identity.')
}

type Identifier = BibliographicRecord['identifiers'][number]
const identifierKey = ({ scheme, value }: Identifier): string =>
  scheme + ':' + normalizeLiteratureIdentifierKey(scheme, value)

function identities(item: BibliographicRecord, paperId: string): string[] {
  return [
    normalizeCitationPaperId(paperId),
    ...item.identifiers
      .filter(({ scheme }) => LITERATURE_IDENTITY_SCHEMES.some((strong) => strong === scheme))
      .map(identifierKey)
  ]
}

// Each observed set of aliases for a scheme must overlap the other observations.
function conflictingClaims(items: BibliographicRecord[]): boolean {
  return LITERATURE_IDENTITY_SCHEMES.some((scheme) => {
    const claims: Set<string>[] = []
    for (const item of items) {
      const values = item.identifiers.filter((id) => id.scheme === scheme).map(identifierKey)
      if (!values.length) continue
      if (claims.some((previous) => !values.some((value) => previous.has(value)))) return true
      claims.push(new Set(values))
    }
    return false
  })
}

function lookupReference(id: Identifier): string {
  return id.scheme === 'doi'
    ? normalizeLiteratureIdentifierKey(id.scheme, id.value)
    : id.scheme + ':' + normalizeLiteratureIdentifierValue(id.scheme, id.value)
}

export function citationMetadataReference(item: BibliographicRecord): string | undefined {
  for (const scheme of ['pmid', 'pmcid', 'doi', 'arxiv'] as const) {
    const values = item.identifiers.filter((id) => id.scheme === scheme)
    if (values.length !== 1 || !createLiteratureIdentifierUrl(scheme, values[0].value)) continue
    return lookupReference(values[0])
  }
  return undefined
}

function mergeIdentifiers(left: Identifier[], right: Identifier[]): Identifier[] {
  const known = new Map(left.map((id) => [identifierKey(id), id]))
  for (const id of right) {
    const key = identifierKey(id)
    if (!known.has(key)) known.set(key, id)
  }
  return [...known.values()]
}

// Keep only supplements the user viewed in this discovery session.
export type CitationMetadata = Map<string, BibliographicRecord>

export function verifiedCitationMetadata(
  item: BibliographicRecord,
  candidate: BibliographicRecord,
  reference: string
): boolean {
  return (
    candidate.identifiers.some((id) => lookupReference(id) === reference) &&
    !conflictingClaims([item, candidate])
  )
}

export function supplementedCitation(
  item: BibliographicRecord,
  metadata?: CitationMetadata
): { item: BibliographicRecord; reference?: string } {
  const reference = citationMetadataReference(item)
  const candidate = reference && metadata?.get(reference)
  if (!candidate || !verifiedCitationMetadata(item, candidate, reference)) return { item }
  return {
    reference,
    item: {
      ...item,
      creators: item.creators.some((c) => c.creatorType === 'author')
        ? item.creators
        : [...item.creators, ...candidate.creators.filter((c) => c.creatorType === 'author')],
      abstract: item.abstract || candidate.abstract,
      containerTitle: item.containerTitle || candidate.containerTitle,
      issuedYear: item.issuedYear ?? candidate.issuedYear,
      issuedText:
        item.issuedText ||
        (!item.issuedYear || item.issuedYear === candidate.issuedYear ? candidate.issuedText : ''),
      typeFields: { ...candidate.typeFields, ...item.typeFields },
      identifiers: mergeIdentifiers(item.identifiers, candidate.identifiers)
    }
  }
}

// Provider IDs and exact scholarly identifiers establish identity; titles never establish an edge.
// Union all aliases before applying the display limit so bridge records preserve both directions.
export function buildCitationGraph(
  center: LiteratureRelatedRecord,
  entries: CitationGraphEntry[],
  limit = CITATION_GRAPH_NODE_LIMIT
): CitationGraph {
  const records = [center, ...entries.map(({ record }) => record)]
  const parent = records.map((_, index) => index)
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]
      index = parent[index]
    }
    return index
  }
  const aliases = new Map<string, number>()
  records.forEach((record, index) => {
    for (const identity of identities(record.item, record.paperId)) {
      const old = aliases.get(identity)
      if (old !== undefined) {
        const left = root(index)
        const right = root(old)
        parent[Math.max(left, right)] = Math.min(left, right)
      }
      aliases.set(identity, index)
    }
  })
  const groups = new Map<number, BibliographicRecord[]>()
  records.forEach((record, index) => {
    const key = root(index)
    const items = groups.get(key)
    if (items) items.push(record.item)
    else groups.set(key, [record.item])
  })
  // A bridge can connect two contradictory records indirectly. Fall back to native
  // identities for the entire ambiguous group, independent of arrival order.
  const conflicts = new Set(
    [...groups]
      .filter(([, items]) => items.length > 1 && conflictingClaims(items))
      .map(([key]) => key)
  )
  const native = new Map<string, number>()
  const keys = records.map((record, index) => {
    if (!conflicts.has(root(index))) return root(index)
    const first = native.get(record.paperId) ?? index
    native.set(record.paperId, first)
    return first
  })
  const nodes = new Map<number, CitationGraphNode>()
  records.forEach((record, index) => {
    const key = keys[index]
    const existing = nodes.get(key)
    if (existing && !existing.conflicting) {
      const identifiers = mergeIdentifiers(
        existing.record.item.identifiers,
        record.item.identifiers
      )
      nodes.set(key, {
        ...existing,
        paperIds: [...new Set([...existing.paperIds, normalizeCitationPaperId(record.paperId)])],
        record: { ...existing.record, item: { ...existing.record.item, identifiers } }
      })
    } else if (!existing && nodes.size < limit)
      nodes.set(key, {
        id: records[key].paperId,
        record,
        ...(conflicts.has(root(index)) ? { conflicting: true } : {}),
        center: key === keys[0],
        relation: key === keys[0] ? 'center' : 'references',
        paperIds: [normalizeCitationPaperId(record.paperId)]
      })
  })
  const centerId = nodes.get(keys[0])!.id
  const edges = new Map<string, { source: string; target: string }>()
  entries.forEach(({ direction }, index) => {
    const node = nodes.get(keys[index + 1])
    if (!node || node.id === centerId) return
    const edge =
      direction === 'references'
        ? { source: centerId, target: node.id }
        : { source: node.id, target: centerId }
    edges.set(`${edge.source}:${edge.target}`, edge)
  })
  return {
    nodes: [...nodes.values()].map((node) => ({
      ...node,
      relation: node.center
        ? 'center'
        : edges.has(`${centerId}:${node.id}`) && edges.has(`${node.id}:${centerId}`)
          ? 'both'
          : edges.has(`${centerId}:${node.id}`)
            ? 'references'
            : 'citations'
    })),
    edges: [...edges.values()],
    limited: new Set(keys).size > nodes.size
  }
}

/** Filter merged identities so a mutual paper keeps its canonical id and metadata in every view. */
export function filterCitationGraph(
  graph: CitationGraph,
  filter: CitationGraphFilter
): CitationGraph {
  if (filter === 'all') return graph
  const centerId = graph.nodes.find((node) => node.center)?.id
  const edges = graph.edges.filter((edge) =>
    filter === 'references' ? edge.source === centerId : edge.target === centerId
  )
  const visible = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  return {
    nodes: graph.nodes.filter((node) => node.center || visible.has(node.id)),
    edges,
    limited: graph.limited
  }
}

// Assign against the full graph, before filtering. Surviving papers keep their positions even
// when a new page discovers the opposite relation or merges another provider alias into them.
export function assignCitationGraphSlots(
  nodes: CitationGraphNode[],
  previous: ReadonlyMap<string, number>
): Map<string, number> {
  const slots = new Map<string, number>()
  const occupied = new Set<number>()
  for (const node of nodes) {
    if (node.center) {
      slots.set(node.id, -1)
      continue
    }
    const slot = [previous.get(node.id), ...node.paperIds.map((id) => previous.get(id))].find(
      (slot) => slot !== undefined && slot >= 0 && !occupied.has(slot)
    )
    if (slot !== undefined) {
      slots.set(node.id, slot)
      occupied.add(slot)
    }
  }
  let next = 0
  for (const node of nodes) {
    if (slots.has(node.id)) continue
    while (occupied.has(next)) next++
    slots.set(node.id, next)
    occupied.add(next)
  }
  return slots
}

export function citationGraphPosition(slot: number): { x: number; y: number } {
  if (slot < 0) return { x: 800, y: 500 }
  const ring = Math.floor(slot / 12)
  const position = slot % 12
  // Golden-angle prefixes distribute sparse results without moving older nodes on pagination.
  const angle = position * Math.PI * (3 - Math.sqrt(5)) + (ring % 2 ? Math.PI / 12 : 0)
  const radius = 280 + ring * 155
  return {
    x: 800 + Math.cos(angle) * radius,
    y: 500 + Math.sin(angle) * radius
  }
}

function citationGraphAuthor(item: BibliographicRecord): string {
  const author = item.creators.find((creator) => creator.creatorType === 'author')
  return author
    ? author.nameMode === 'person'
      ? author.familyName || author.givenName
      : author.literalName
    : item.shortTitle || item.title
}

export function citationGraphRecordsMatch(
  left: LiteratureRelatedRecord,
  right: LiteratureRelatedRecord
): boolean {
  const leftIds = new Set(identities(left.item, left.paperId))
  return (
    !conflictingClaims([left.item, right.item]) &&
    identities(right.item, right.paperId).some((identity) => leftIds.has(identity))
  )
}

export type CitationGraphCamera = { x: number; y: number; width: number; height: number }
export function fitCitationGraph(
  positions: Iterable<{ x: number; y: number }>,
  anchor?: { x: number; y: number },
  margin = 120
): CitationGraphCamera {
  const points = [...positions]
  if (!points.length) return { x: 620, y: 320, width: 360, height: 360 }
  if (anchor) {
    const radiusX = Math.max(...points.map((point) => Math.abs(point.x - anchor.x)), 0)
    const radiusY = Math.max(...points.map((point) => Math.abs(point.y - anchor.y)), 0)
    return {
      x: anchor.x - radiusX - margin,
      y: anchor.y - radiusY - margin,
      width: radiusX * 2 + margin * 2,
      height: radiusY * 2 + margin * 2
    }
  }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const x = Math.min(...xs) - 180
  const y = Math.min(...ys) - 180
  return { x, y, width: Math.max(...xs) + 180 - x, height: Math.max(...ys) + 180 - y }
}

export type CitationGraphPoint = { x: number; y: number }
export function citationGraphNodeRadius(center: boolean): number {
  return center ? 22 : 14
}

/**
 * Keep edge separation deterministic while retaining the opposing bends for mutual edges.
 * References and citations use opposite signs so the two directions remain readable when
 * they share a pair of nodes; mutual edges use the larger bend used by the canvas today.
 */
export function citationGraphEdgeBend(
  direction: CitationDirection,
  relation: CitationGraphRelation
): number {
  if (relation === 'both') return 28
  return direction === 'references' ? 14 : -14
}

export function citationGraphEdgeGeometry(
  from: CitationGraphPoint,
  to: CitationGraphPoint,
  fromRadius: number,
  toRadius: number,
  scale: number,
  bend = 0
): { start: CitationGraphPoint; control: CitationGraphPoint; end: CitationGraphPoint } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const control = {
    x: (from.x + to.x) / 2 - (dy * bend) / distance,
    y: (from.y + to.y) / 2 + (dx * bend) / distance
  }
  const boundary = (point: CitationGraphPoint, radius: number, gap: number): CitationGraphPoint => {
    const x = control.x - point.x
    const y = control.y - point.y
    const ratio = (radius + gap / scale) / Math.hypot(x, y)
    return { x: point.x + x * ratio, y: point.y + y * ratio }
  }
  // End the arrowhead at the node boundary so the relationship reads as continuous.
  const start = boundary(from, fromRadius, 1)
  const end = boundary(to, toRadius, 0)
  return {
    start,
    control: bend ? control : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    end
  }
}

export function citationGraphTextWidth(text: string): number {
  return Array.from(text).reduce((width, character) => {
    if (/\s/u.test(character)) return width + 3.5
    if ((character.codePointAt(0) ?? 0) > 255) return width + 11
    if (/[MW@%#&]/u.test(character)) return width + 11
    if (/[mw]/u.test(character)) return width + 9
    if (/[ilI.,:;'!|]/u.test(character)) return width + 4
    if (/[0-9]/u.test(character)) return width + 6.5
    if (/[A-Z]/u.test(character)) return width + 9
    return width + 7
  }, 0)
}

export function citationGraphShortTitle(title: string, maxWidth = 108): string {
  if (citationGraphTextWidth(title) <= maxWidth) return title
  let result = ''
  for (const character of Array.from(title)) {
    if (citationGraphTextWidth(`${result}${character}…`) > maxWidth) break
    result += character
  }
  return `${result}…`
}

export function citationGraphCompactLabel(item: BibliographicRecord, maxWidth: number): string {
  const year = item.issuedYear?.toString() ?? '—'
  const suffix = ` ${year}`
  const author = citationGraphShortTitle(
    citationGraphAuthor(item),
    maxWidth - citationGraphTextWidth(suffix)
  )
  return `${author}${suffix}`
}

export function nearestCitationGraphNode(
  points: Iterable<{ id: string; x: number; y: number }>,
  x: number,
  y: number
): string | undefined {
  let nearest: string | undefined
  let distance = Infinity
  for (const point of points) {
    const next = (point.x - x) ** 2 + (point.y - y) ** 2
    if (next < distance) {
      nearest = point.id
      distance = next
    }
  }
  return nearest
}

export type CitationGraphLabelCandidate = {
  id: string
  x: number
  y: number
  radius: number
  label: string
  priority: number
  relation?: CitationGraphRelation
}

/** Place a small reading set in screen pixels, keeping text clear of marks and other labels. */
export function placeCitationGraphLabels(
  candidates: CitationGraphLabelCandidate[],
  viewport: { width: number; height: number },
  limit = 16
): Map<string, CitationGraphPoint> {
  const placed = new Map<string, CitationGraphPoint>()
  const boxes: { left: number; right: number; top: number; bottom: number }[] = []
  const visible = candidates.filter(
    ({ x, y, radius }) =>
      x + radius > 0 &&
      x - radius < viewport.width &&
      y + radius > 0 &&
      y - radius < viewport.height
  )
  const ordered = visible
    .filter(({ priority }) => priority >= 2)
    .sort((left, right) => right.priority - left.priority)
  const regions: CitationGraphLabelCandidate[][] = [[], [], []]
  for (const candidate of visible.filter(({ priority }) => priority < 2)) {
    const region =
      candidate.relation === 'both'
        ? 2
        : candidate.relation === 'references'
          ? 0
          : candidate.relation === 'citations'
            ? 1
            : candidate.x < viewport.width / 2
              ? 0
              : 1
    regions[region].push(candidate)
  }
  // Provider pages arrive one direction at a time. Sample each region in turn so that the
  // reading budget cannot be exhausted by the first direction, even after panning the camera.
  for (let index = 0; regions.some((region) => index < region.length); index++) {
    for (const region of regions) {
      if (region[index]) ordered.push(region[index])
    }
  }
  for (const candidate of ordered) {
    if (placed.size >= limit && candidate.priority < 2) continue
    const width = (citationGraphTextWidth(candidate.label) * 12) / 11
    const offsets = [candidate.radius + 18, -candidate.radius - 8]
    let selected: CitationGraphPoint | undefined
    for (const offset of offsets) {
      const point = {
        x: Math.max(width / 2 + 6, Math.min(viewport.width - width / 2 - 6, candidate.x)),
        y: candidate.y + offset
      }
      const box = {
        left: point.x - width / 2 - 4,
        right: point.x + width / 2 + 4,
        top: point.y - 13,
        bottom: point.y + 4
      }
      if (box.top < 8 || box.bottom > viewport.height - 8) continue
      if (
        boxes.some(
          (other) =>
            box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top
        )
      )
        continue
      if (
        visible.some(
          (node) =>
            box.left < node.x + node.radius + 3 &&
            box.right > node.x - node.radius - 3 &&
            box.top < node.y + node.radius + 3 &&
            box.bottom > node.y - node.radius - 3
        )
      )
        continue
      selected = point
      boxes.push(box)
      break
    }
    // Selected/inspected labels may cross dense marks, but never another priority label.
    // The unselected center can yield its label; its full title remains in the context header.
    if (!selected && candidate.priority >= 3) {
      const fallback = {
        x: Math.max(width / 2 + 6, Math.min(viewport.width - width / 2 - 6, candidate.x)),
        y: Math.max(20, Math.min(viewport.height - 8, candidate.y + candidate.radius + 18))
      }
      const box = {
        left: fallback.x - width / 2 - 4,
        right: fallback.x + width / 2 + 4,
        top: fallback.y - 13,
        bottom: fallback.y + 4
      }
      if (
        !boxes.some(
          (other) =>
            box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top
        )
      ) {
        selected = fallback
        boxes.push(box)
      }
    }
    if (selected) placed.set(candidate.id, selected)
  }
  return placed
}
