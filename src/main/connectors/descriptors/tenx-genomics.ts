import type { ToolDescriptor } from '../types'

const SEARCH = 'https://www.10xgenomics.com/api/search'
type JsonObject = Record<string, unknown>

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid 10x Genomics response: expected ${label} to be an object`)
  }
  return value as JsonObject
}

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid 10x Genomics response: missing ${name}`)
  }
  return value
}

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const searchUrl = (document: 'dataset' | 'pipeline', search: string, offset: number): string => {
  const params = new URLSearchParams({
    document,
    search,
    sort: 'publishedAt DESC',
    offset: String(offset)
  })
  return `${SEARCH}?${params}`
}

const searchResults = (raw: unknown): { hits: JsonObject[]; total: number | null } => {
  const body = object(raw, 'search response')
  const candidate = body.hits ?? body.results ?? body.items
  if (!Array.isArray(candidate)) {
    throw new Error('Invalid 10x Genomics response: missing hits, results, or items')
  }
  return {
    hits: candidate.map((value) => object(value, 'search hit')),
    total:
      typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : candidate.length
  }
}

const summary = (raw: JsonObject, kind: 'datasets' | 'pipelines'): JsonObject => {
  const slug = requiredString(raw.slug ?? raw.path, 'slug')
  return {
    slug,
    title: requiredString(raw.title, 'title'),
    description: optionalString(raw.description),
    platform: optionalString(raw.platformNameStr),
    product: optionalString(raw.productName),
    species: stringArray(raw.species),
    published_at: optionalString(raw.publishedAt),
    updated_at: optionalString(raw.updatedAt),
    landing_url: `https://www.10xgenomics.com/${kind === 'datasets' ? 'datasets' : 'pipelines'}/${slug}`
  }
}

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {})
})

const offset = { type: 'integer', minimum: 0, maximum: 100000, default: 0 }
const query = { type: 'string', maxLength: 500 }

export const TENX_GENOMICS_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_datasets',
    connector: 'tenx-genomics',
    description:
      'Search the public 10x Genomics dataset catalog. The endpoint is public and read-only; results expose stable catalog metadata and landing-page URLs rather than inferred download links.',
    input: objectSchema({ query, offset }),
    returns:
      '{ datasets: [{ slug, title, description, platform, product, species, published_at, updated_at, landing_url }], total }',
    example: 'await host.mcp("tenx-genomics", "search_datasets", { query: "pbmc", offset: 0 })',
    run: async (ctx, args) => {
      const result = searchResults(
        await ctx.fetchJson(
          searchUrl('dataset', String(args.query ?? ''), Number(args.offset ?? 0))
        )
      )
      return { datasets: result.hits.map((hit) => summary(hit, 'datasets')), total: result.total }
    }
  },
  {
    id: 'get_dataset',
    connector: 'tenx-genomics',
    description:
      'Resolve one public 10x Genomics dataset by exact slug and return its catalog metadata and landing-page URL.',
    input: objectSchema(
      { slug: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' } },
      ['slug']
    ),
    returns:
      '{ slug, title, description, platform, product, species, published_at, updated_at, landing_url }',
    example: 'await host.mcp("tenx-genomics", "get_dataset", { slug: "pbmc-1k-v3" })',
    run: async (ctx, args) => {
      const slug = String(args.slug)
      const result = searchResults(await ctx.fetchJson(searchUrl('dataset', slug, 0)))
      const match = result.hits.find((hit) => hit.slug === slug || hit.path === slug)
      if (!match) throw new Error(`10x Genomics dataset not found: ${slug}`)
      return summary(match, 'datasets')
    }
  },
  {
    id: 'list_pipelines',
    connector: 'tenx-genomics',
    description:
      'List public 10x Genomics pipeline metadata from the catalog search API. This is read-only and does not start or alter a pipeline run.',
    input: objectSchema({ query, offset }),
    returns:
      '{ pipelines: [{ slug, title, description, platform, product, species, published_at, updated_at, landing_url }], total }',
    example: 'await host.mcp("tenx-genomics", "list_pipelines", { query: "cell ranger" })',
    run: async (ctx, args) => {
      const result = searchResults(
        await ctx.fetchJson(
          searchUrl('pipeline', String(args.query ?? ''), Number(args.offset ?? 0))
        )
      )
      return { pipelines: result.hits.map((hit) => summary(hit, 'pipelines')), total: result.total }
    }
  }
]
