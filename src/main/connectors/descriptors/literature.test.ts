import { describe, it, expect } from 'vitest'
import { LITERATURE_TOOLS } from './literature'

// Integration: the aggregate "Literature Graph" tool set. Per-tool behavior is covered in
// literature-openalex.test.ts and literature-arxiv.test.ts.
const EXPECTED_IDS = [
  'openalex_search_works',
  'openalex_get_work',
  'openalex_citations',
  'openalex_references',
  'openalex_search_authors',
  'openalex_get_author',
  'openalex_venue_info',
  'arxiv_search',
  'arxiv_get_papers'
]

describe('literature / aggregate', () => {
  it('exposes exactly the 9 Literature Graph tools in order', () => {
    expect(LITERATURE_TOOLS.map((t) => t.id)).toEqual(EXPECTED_IDS)
  })

  it('registers every tool under the literature connector with unique ids', () => {
    expect(LITERATURE_TOOLS.every((t) => t.connector === 'literature')).toBe(true)
    expect(new Set(LITERATURE_TOOLS.map((t) => t.id)).size).toBe(LITERATURE_TOOLS.length)
  })

  it('gives every tool an input schema, docs, and a run() implementation', () => {
    for (const t of LITERATURE_TOOLS) {
      expect(typeof t.run).toBe('function')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.returns && t.returns.length).toBeTruthy()
      expect(t.input).toMatchObject({ type: 'object' })
    }
  })
})
