import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { ARXIV_LITERATURE_TOOLS } from './literature-arxiv'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => ARXIV_LITERATURE_TOOLS.find((t) => t.id === id)!

// Response stub matching the engine's fetchImpl contract.
const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

// Runs a tool through the engine with a mocked fetch, returning [result, capturedUrl].
async function run(
  id: string,
  args: Record<string, unknown>,
  body: string
): Promise<{ out: unknown; url: string; mock: ReturnType<typeof vi.fn> }> {
  const mock = vi.fn().mockResolvedValue(textRes(body))
  const out = await new ParserEngine({ fetchImpl: mock as unknown as typeof fetch }).call(
    tool(id),
    args,
    {}
  )
  return { out, url: mock.mock.calls[0]?.[0] as string, mock }
}

// A realistic two-entry Atom feed with namespaced arXiv/opensearch elements and a pdf link.
const SEARCH_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>142</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>2</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2103.14030v2</id>
    <updated>2021-08-17T18:00:00Z</updated>
    <published>2021-03-25T17:59:59Z</published>
    <title>Swin Transformer:
      Hierarchical Vision Transformer</title>
    <summary>  We present a new vision Transformer.
    It builds hierarchical feature maps.  </summary>
    <author><name>Ze Liu</name></author>
    <author><name>Yutong Lin</name></author>
    <arxiv:doi>10.1109/ICCV48922.2021.00986</arxiv:doi>
    <link href="http://arxiv.org/abs/2103.14030v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2103.14030v2" rel="related" type="application/pdf"/>
    <arxiv:comment>ICCV 2021 camera-ready</arxiv:comment>
    <arxiv:journal_ref>ICCV 2021, pp. 10012-10022</arxiv:journal_ref>
    <arxiv:primary_category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1706.03762</id>
    <published>2017-06-12T00:00:00Z</published>
    <updated>2017-06-12T00:00:00Z</updated>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence models use recurrence.</summary>
    <author><name>Ashish Vaswani</name></author>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`

// arXiv's HTTP-200 error feed: a single entry whose id points at /api/errors.
const ERROR_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_bad</id>
    <title>Error</title>
    <summary>incorrect id format for bad</summary>
  </entry>
</feed>`

describe('arxiv_search', () => {
  it('assembles search_query (query AND cat AND date range), encodes it, and sets sort params', async () => {
    const { out, url } = await run(
      'arxiv_search',
      {
        query: 'ti:transformer AND au:vaswani',
        category: 'cs.LG',
        date_from: '2021-01-01',
        date_to: '2021-12-31',
        sort_by: 'submittedDate',
        sort_order: 'ascending'
      },
      SEARCH_FEED
    )
    const search = decodeURIComponent(url.split('search_query=')[1].split('&')[0])
    expect(search).toBe(
      'ti:transformer AND au:vaswani AND cat:cs.LG AND submittedDate:[202101010000 TO 202112312359]'
    )
    expect((out as { search_query: string }).search_query).toBe(search)
    expect(url).toContain('sortBy=submittedDate')
    expect(url).toContain('sortOrder=ascending')
    // The raw query keeps its spaces percent-encoded, not dropped.
    expect(url).toContain('search_query=ti%3Atransformer')
  })

  it('fills open-ended date ranges with sentinel bounds', async () => {
    const from = await run('arxiv_search', { date_from: '2020-06-01' }, SEARCH_FEED)
    expect((from.out as { search_query: string }).search_query).toBe(
      'submittedDate:[202006010000 TO 300001012359]'
    )
    const to = await run('arxiv_search', { date_to: '2020-06-01' }, SEARCH_FEED)
    expect((to.out as { search_query: string }).search_query).toBe(
      'submittedDate:[199101010000 TO 202006012359]'
    )
  })

  it('clamps max_results to 100 and passes start through', async () => {
    const { url } = await run(
      'arxiv_search',
      { query: 'x', max_results: 500, start: 25 },
      SEARCH_FEED
    )
    expect(url).toContain('max_results=100')
    expect(url).toContain('start=25')
  })

  it('extracts full record fields including version, categories, and namespaced metadata', async () => {
    const { out } = await run('arxiv_search', { query: 'transformer' }, SEARCH_FEED)
    const res = out as {
      api_total: number
      start_index: number
      n_records_returned: number
      records_truncated: boolean
      records: Array<Record<string, unknown>>
    }
    expect(res.api_total).toBe(142)
    expect(res.start_index).toBe(0)
    expect(res.n_records_returned).toBe(2)
    expect(res.records_truncated).toBe(true)
    const first = res.records[0]
    expect(first).toMatchObject({
      arxiv_id: '2103.14030',
      version: 2,
      id_versioned: '2103.14030v2',
      title: 'Swin Transformer: Hierarchical Vision Transformer',
      abstract: 'We present a new vision Transformer. It builds hierarchical feature maps.',
      authors: ['Ze Liu', 'Yutong Lin'],
      published: '2021-03-25T17:59:59Z',
      updated: '2021-08-17T18:00:00Z',
      primary_category: 'cs.CV',
      categories: ['cs.CV', 'cs.LG'],
      doi: '10.1109/ICCV48922.2021.00986',
      journal_ref: 'ICCV 2021, pp. 10012-10022',
      comment: 'ICCV 2021 camera-ready',
      abs_url: 'http://arxiv.org/abs/2103.14030v2',
      pdf_url: 'http://arxiv.org/pdf/2103.14030v2'
    })
    // Unversioned entry with no arXiv namespaced metadata yields nulls, not throws.
    expect(res.records[1]).toMatchObject({
      arxiv_id: '1706.03762',
      version: null,
      id_versioned: '1706.03762',
      doi: null,
      journal_ref: null,
      comment: null,
      pdf_url: null
    })
  })

  it('throws when no search dimension is provided', async () => {
    await expect(run('arxiv_search', {}, SEARCH_FEED)).rejects.toThrow(/at least one of/)
  })

  it('throws on the arXiv HTTP-200 error feed, carrying its summary', async () => {
    await expect(run('arxiv_search', { query: 'bad' }, ERROR_FEED)).rejects.toThrow(
      /incorrect id format for bad/
    )
  })
})

describe('arxiv_get_papers', () => {
  // A batch feed covering a versioned new-style id and an old-style (slash) id.
  const BATCH_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2103.14030v2</id>
    <title>Swin Transformer</title>
    <summary>abstract one</summary>
    <author><name>Ze Liu</name></author>
    <arxiv:primary_category term="cs.CV"/>
    <category term="cs.CV"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/q-bio/0601001v1</id>
    <title>An old-style paper</title>
    <summary>abstract two</summary>
    <author><name>Jane Doe</name></author>
    <arxiv:primary_category term="q-bio.GN"/>
    <category term="q-bio.GN"/>
  </entry>
</feed>`

  it('normalizes prefixes/URLs and percent-encodes old-style slashes in id_list', async () => {
    const { url, out } = await run(
      'arxiv_get_papers',
      {
        arxiv_ids: ['arXiv:2103.14030v2', 'https://arxiv.org/pdf/q-bio/0601001v1.pdf']
      },
      BATCH_FEED
    )
    const idList = decodeURIComponent(url.split('id_list=')[1].split('&')[0])
    // Encoded form keeps the slash percent-encoded (%2F) so arXiv doesn't 503.
    expect(url).toContain('id_list=2103.14030v2,q-bio%2F0601001v1')
    expect(idList).toBe('2103.14030v2,q-bio/0601001v1')
    expect(url).toContain('max_results=2')
    const res = out as {
      n_requested: number
      n_found: number
      records: Array<{ arxiv_id: string }>
    }
    expect(res.n_requested).toBe(2)
    expect(res.n_found).toBe(2)
    expect(res.records.map((r) => r.arxiv_id)).toEqual(['2103.14030', 'q-bio/0601001'])
  })

  it('dedupes inputs resolving to the same paper into duplicates and preserves requested order', async () => {
    const { out } = await run(
      'arxiv_get_papers',
      { arxiv_ids: ['q-bio/0601001', '2103.14030', '2103.14030v2'] },
      BATCH_FEED
    )
    const res = out as {
      n_requested: number
      duplicates: string[]
      records: Array<{ arxiv_id: string }>
    }
    expect(res.n_requested).toBe(3)
    expect(res.duplicates).toEqual(['2103.14030v2'])
    // Records follow the deduped requested order, not the feed order.
    expect(res.records.map((r) => r.arxiv_id)).toEqual(['q-bio/0601001', '2103.14030'])
  })

  it('reports unmatched ids in not_found', async () => {
    const { out } = await run(
      'arxiv_get_papers',
      { arxiv_ids: ['2103.14030', '9999.99999'] },
      BATCH_FEED
    )
    const res = out as {
      n_found: number
      not_found: string[]
      records: Array<{ arxiv_id: string }>
    }
    expect(res.n_found).toBe(1)
    expect(res.not_found).toEqual(['9999.99999'])
    expect(res.records.map((r) => r.arxiv_id)).toEqual(['2103.14030'])
  })

  it('throws on an empty id list', async () => {
    await expect(run('arxiv_get_papers', { arxiv_ids: [] }, BATCH_FEED)).rejects.toThrow(
      /non-empty/
    )
  })

  it('throws on more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `2101.${String(i).padStart(5, '0')}`)
    await expect(run('arxiv_get_papers', { arxiv_ids: ids }, BATCH_FEED)).rejects.toThrow(
      /at most 100/
    )
  })

  it('routes malformed ids to not_found without issuing a request', async () => {
    const { out, mock } = await run(
      'arxiv_get_papers',
      { arxiv_ids: ['not-an-id', '!!!'] },
      ERROR_FEED
    )
    const res = out as { records: unknown[]; not_found: string[] }
    expect(res.records).toEqual([])
    expect(res.not_found).toEqual(['not-an-id', '!!!'])
    expect(mock).not.toHaveBeenCalled()
  })

  it('keeps valid ids when the batch also contains a malformed id', async () => {
    const { out, url } = await run(
      'arxiv_get_papers',
      { arxiv_ids: ['2103.14030', 'garbage!!'] },
      BATCH_FEED
    )
    const res = out as { not_found: string[]; records: Array<{ arxiv_id: string }> }
    expect(url).toContain('id_list=2103.14030')
    expect(url).not.toContain('garbage')
    expect(res.records.map((r) => r.arxiv_id)).toEqual(['2103.14030'])
    expect(res.not_found).toEqual(['garbage!!'])
  })
})
