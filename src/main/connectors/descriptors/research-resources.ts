import type { ToolDescriptor } from '../types'

const BASE = 'https://www.antibodyregistry.org/api'

type AntibodyRecord = {
  abId?: number
  abName?: string
  abTarget?: string
  vendorName?: string
  clonality?: string
}

type FtsAntibodiesResponse = { totalElements?: number; items?: AntibodyRecord[] }

const toRrid = (abId: number | undefined): string | undefined =>
  abId === undefined ? undefined : `AB_${abId}`

const compactAntibody = (r: AntibodyRecord): Record<string, unknown> => ({
  ab_id: toRrid(r.abId),
  name: r.abName,
  vendor: r.vendorName,
  target: r.abTarget,
  clonality: r.clonality
})

// Accepts a plain integer, "AB_<id>" or "RRID:AB_<id>" and returns the bare numeric id
// (mirrors the upstream Python client's parse_ab_id).
const parseAbId = (value: unknown): string => {
  const s = String(value).trim()
  const m = /^(?:RRID:)?AB_(\d+)$/i.exec(s)
  if (m) return m[1]
  if (/^\d+$/.test(s)) return s
  throw new Error(`not a valid antibody id / RRID: ${s}`)
}

// Antibody Registry (antibodyregistry.org) REST API: read-only antibody catalog lookups.
// Anonymous depth cap upstream: fts-antibodies returns HTTP 401 once page*size > 500.
export const RESEARCH_RESOURCES_TOOLS: ToolDescriptor[] = [
  {
    id: 'antibody_search',
    connector: 'research_resources',
    description:
      'Full-text search the Antibody Registry by target/name/catalog text; returns RRID, name, vendor, target, and clonality per hit.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        page: { type: 'integer', default: 1 },
        size: { type: 'integer', default: 10 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ "total_elements": int, "items": [ { "ab_id": str, "name": str, "vendor": str, "target": str, "clonality": str } ] }` — `ab_id` is an `AB_<id>` RRID. `total_elements` is the full match count; `items` holds one page (default 10) and is `[]` when nothing matches. Anonymous paging past page*size > 500 fails upstream (HTTP 401).',
    url: (a) => {
      const page = Number.isFinite(Number(a.page)) ? Math.max(1, Number(a.page)) : 1
      const size = Number.isFinite(Number(a.size)) ? Math.max(1, Number(a.size)) : 10
      return `${BASE}/fts-antibodies?q=${encodeURIComponent(String(a.query))}&page=${page}&size=${size}`
    },
    parse: (raw) => {
      const r = raw as FtsAntibodiesResponse
      return {
        total_elements: r.totalElements,
        items: (r.items ?? []).map(compactAntibody)
      }
    }
  },
  {
    id: 'antibody_get',
    connector: 'research_resources',
    description:
      'Get Antibody Registry record(s) for an accession/RRID (plain id, "AB_<id>", or "RRID:AB_<id>"); an accession can map to several curated records.',
    input: {
      type: 'object',
      properties: { ab_id: { type: 'string' } },
      required: ['ab_id']
    },
    required: ['ab_id'],
    returns:
      '`[ { "ab_id": str, "name": str, "vendor": str, "target": str, "clonality": str } ]` — an array because one accession can map to several curated records; `ab_id` is an `AB_<id>` RRID. Empty array when the id has no records.',
    url: (a) => `${BASE}/antibodies/${parseAbId(a.ab_id)}`,
    parse: (raw) => (raw as AntibodyRecord[]).map(compactAntibody)
  }
]
