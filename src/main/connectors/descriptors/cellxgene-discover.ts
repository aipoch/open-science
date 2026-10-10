import type { ToolDescriptor } from '../../connector-core/types'

// Public read-only API: https://api.cellxgene.cziscience.com/curation/ui/
// Canonical IDs follow the latest publication; version IDs identify a published snapshot.
// The API returns whole catalogs (no server-side text search or pagination).
const API = 'https://api.cellxgene.cziscience.com/curation/v1'
const CONNECTOR = 'cellxgene-discover'
const COLLECTION = '9a71db9e-687f-41f0-b88e-544eb1314ef6'
const DATASET = '0bbf93aa-2d3a-420f-95a1-26fe384024cb'
const COLLECTION_VERSION = '46ac9732-ff1c-4f87-86d7-0488d15aecd3'
const DATASET_VERSION = '8e0fcb64-735c-4fcb-a74b-12a3518683d1'
const PAGE_NOTE =
  ' Filtering and pagination are client-side over the complete API response, fetched on each call; results may change between calls. Save version IDs for reproducibility.'
const PAGE_RETURNS =
  'page, page_size, count, total (after filtering), next_page (null at the end), pagination: "client"'

type Row = Record<string, unknown>
const uuid = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}
const textFilter = { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' }
const pages = {
  page: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
  page_size: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
}
const schema = (properties: Row, required: string[] = []): Row => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
function object(raw: unknown): Row {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid CELLxGENE Discover response: expected an object')
  }
  return raw as Row
}
function rows(raw: unknown): Row[] {
  if (!Array.isArray(raw)) {
    throw new Error('Invalid CELLxGENE Discover response: expected an array')
  }
  return raw.map(object)
}
function record(raw: unknown, kind: 'collection' | 'dataset'): Row {
  const value = object(raw)
  for (const key of [`${kind}_id`, `${kind}_version_id`]) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`Invalid CELLxGENE Discover response: missing ${key}`)
    }
  }
  return value
}
function pick(row: Row, fields: string[]): Row {
  return Object.fromEntries(fields.filter((key) => key in row).map((key) => [key, row[key]]))
}
const datasetSummary = (row: Row): Row =>
  pick(row, [
    'dataset_id',
    'dataset_version_id',
    'collection_id',
    'collection_version_id',
    'collection_name',
    'collection_doi',
    'title',
    'cell_count',
    'primary_cell_count',
    'organism',
    'tissue',
    'disease',
    'assay',
    'schema_version',
    'published_at',
    'revised_at',
    'is_primary_data',
    'is_pre_analysis',
    'visibility',
    'tombstone',
    'explorer_url'
  ])
const collectionSummary = (row: Row): Row => ({
  ...pick(row, [
    'collection_id',
    'collection_version_id',
    'collection_url',
    'name',
    'doi',
    'published_at',
    'revised_at',
    'visibility',
    'tombstone',
    'is_pre_analysis'
  ]),
  dataset_count: rows(row.dataset_versions ?? row.datasets).length
})
function paginate(items: Row[], args: Row): Row {
  const page = Number(args.page ?? 1)
  const pageSize = Number(args.page_size ?? 25)
  const start = (page - 1) * pageSize
  const result = items.slice(start, start + pageSize)
  return {
    page,
    page_size: pageSize,
    count: result.length,
    total: items.length,
    next_page: start + result.length < items.length ? page + 1 : null,
    pagination: 'client',
    results: result
  }
}
function includes(value: unknown, query: unknown): boolean {
  return (
    typeof value === 'string' && value.toLowerCase().includes(String(query).trim().toLowerCase())
  )
}
function matchesOntology(value: unknown, query: unknown): boolean {
  if (value == null) return false
  const refs = rows(value).map((ref) => {
    for (const key of ['label', 'ontology_term_id']) {
      if (ref[key] !== undefined && typeof ref[key] !== 'string') {
        throw new Error(`Invalid CELLxGENE Discover response: malformed ontology ${key}`)
      }
    }
    return ref
  })
  const term = String(query).trim().toLowerCase()
  return refs.some((ref) => {
    return [ref.label, ref.ontology_term_id].some(
      (v) => typeof v === 'string' && v.toLowerCase() === term
    )
  })
}
function collectionDetail(raw: unknown, args: Row, version: boolean): Row {
  const row = record(raw, 'collection')
  const field = version ? 'dataset_versions' : 'datasets'
  const { [field]: datasets, ...metadata } = row
  return {
    ...metadata,
    [field]: paginate(
      rows(datasets).map((dataset) => datasetSummary(record(dataset, 'dataset'))),
      args
    )
  }
}
const currentDatasetPath = (a: Row): string =>
  `/collections/${encodeURIComponent(String(a.collection_id))}/datasets/${encodeURIComponent(String(a.dataset_id))}`
const example = (method: string, args: Row): string =>
  `const result = await host.mcp("${CONNECTOR}", "${method}", ${JSON.stringify(args)})`

export const CELLXGENE_DISCOVER_TOOLS: ToolDescriptor[] = [
  {
    id: 'list_collections',
    connector: CONNECTOR,
    description:
      'List public CELLxGENE Discover collections; optional case-insensitive substring query over name, description and DOI.' +
      PAGE_NOTE,
    input: schema({ query: textFilter, ...pages }),
    returns: `{ ${PAGE_RETURNS}, results: [collection summaries with canonical/version IDs, name, DOI, dates, URL and dataset_count] }`,
    example: example('list_collections', { query: 'liver', page_size: 10 }),
    url: () => `${API}/collections?visibility=PUBLIC`,
    parse: (raw, a) =>
      paginate(
        rows(raw)
          .map((r) => record(r, 'collection'))
          .filter(
            (r) =>
              a.query == null || [r.name, r.description, r.doi].some((v) => includes(v, a.query))
          )
          .map(collectionSummary),
        a
      )
  },
  {
    id: 'get_collection',
    connector: CONNECTOR,
    description:
      'Retrieve the latest public collection metadata by canonical collection_id, with a page of dataset summaries.' +
      PAGE_NOTE,
    input: schema({ collection_id: uuid, ...pages }, ['collection_id']),
    required: ['collection_id'],
    returns: `{ collection_id, collection_version_id, name, description, DOI/links and other API metadata, datasets: { ${PAGE_RETURNS}, results: [dataset summaries] } }`,
    example: example('get_collection', { collection_id: COLLECTION }),
    url: (a) => `${API}/collections/${encodeURIComponent(String(a.collection_id))}`,
    parse: (raw, a) => collectionDetail(raw, a, false)
  },
  {
    id: 'list_datasets',
    connector: CONNECTOR,
    description:
      "List public datasets. query matches title, collection name or DOI by case-insensitive substring. organism, tissue, disease, assay and cell_type match an exact ontology ID or label (case-insensitive); filters are ANDed. schema_version selects the latest published collection versions matching a major/minor/patch schema and can return historical datasets. Use each result's dataset_version_id with get_dataset_version or list_dataset_files to retain that publication; canonical IDs resolve to the current version." +
      PAGE_NOTE,
    input: schema({
      query: textFilter,
      collection_id: uuid,
      organism: textFilter,
      tissue: textFilter,
      disease: textFilter,
      assay: textFilter,
      cell_type: textFilter,
      schema_version: {
        type: 'string',
        pattern: '^\\d+(\\.\\d+){0,2}$',
        description:
          'Upstream schema filter; may return historical versions. Continue with the returned dataset_version_id.'
      },
      ...pages
    }),
    returns: `{ ${PAGE_RETURNS}, results: [dataset summaries with canonical/version IDs, collection identity, title, cell counts, organism/tissue/disease/assay, schema version and dates] }`,
    example: example('list_datasets', {
      organism: 'NCBITaxon:9606',
      tissue: 'liver',
      page_size: 10
    }),
    url: (a) => {
      const query = new URLSearchParams({ visibility: 'PUBLIC' })
      if (a.schema_version != null) query.set('schema_version', String(a.schema_version))
      return `${API}/datasets?${query}`
    },
    parse: (raw, a) =>
      paginate(
        rows(raw)
          .map((r) => record(r, 'dataset'))
          .filter(
            (r) =>
              (a.collection_id == null ||
                String(r.collection_id).toLowerCase() === String(a.collection_id).toLowerCase()) &&
              (a.query == null ||
                [r.title, r.collection_name, r.collection_doi].some((v) => includes(v, a.query))) &&
              ['organism', 'tissue', 'disease', 'assay', 'cell_type'].every(
                (key) => a[key] == null || matchesOntology(r[key], a[key])
              )
          )
          .map(datasetSummary),
        a
      )
  },
  {
    id: 'get_dataset',
    connector: CONNECTOR,
    description:
      'Retrieve full current public dataset metadata, ontology annotations, citation, assets and version ID using canonical collection_id and dataset_id.',
    input: schema({ collection_id: uuid, dataset_id: uuid }, ['collection_id', 'dataset_id']),
    required: ['collection_id', 'dataset_id'],
    returns:
      'The API dataset object, including dataset_id, dataset_version_id, title, cell_count, ontology annotations, schema_version, citation and assets [{filetype, filesize (bytes, or -1 when unknown), url}]. Nullable metadata is preserved. No files are downloaded.',
    example: example('get_dataset', { collection_id: COLLECTION, dataset_id: DATASET }),
    url: (a) => `${API}${currentDatasetPath(a)}`,
    parse: (raw) => record(raw, 'dataset')
  },
  {
    id: 'list_collection_versions',
    connector: CONNECTOR,
    description:
      'List published versions of a canonical collection, newest first, retaining version IDs and dataset counts.' +
      PAGE_NOTE,
    input: schema({ collection_id: uuid, ...pages }, ['collection_id']),
    required: ['collection_id'],
    returns: `{ ${PAGE_RETURNS}, results: [collection version summaries] }`,
    example: example('list_collection_versions', { collection_id: COLLECTION }),
    url: (a) => `${API}/collections/${encodeURIComponent(String(a.collection_id))}/versions`,
    parse: (raw, a) =>
      paginate(
        rows(raw).map((r) => collectionSummary(record(r, 'collection'))),
        a
      )
  },
  {
    id: 'get_collection_version',
    connector: CONNECTOR,
    description:
      'Retrieve a specific published collection_version_id and a page of its dataset versions; does not resolve to the latest collection.' +
      PAGE_NOTE,
    input: schema({ collection_version_id: uuid, ...pages }, ['collection_version_id']),
    required: ['collection_version_id'],
    returns: `{ collection_id, collection_version_id, name, description and other API metadata, dataset_versions: { ${PAGE_RETURNS}, results: [dataset version summaries] } }`,
    example: example('get_collection_version', { collection_version_id: COLLECTION_VERSION }),
    url: (a) => `${API}/collection_versions/${encodeURIComponent(String(a.collection_version_id))}`,
    parse: (raw, a) => collectionDetail(raw, a, true)
  },
  {
    id: 'list_dataset_versions',
    connector: CONNECTOR,
    description:
      'List published versions of a canonical dataset_id, newest first, with schema version and publication dates.' +
      PAGE_NOTE,
    input: schema({ dataset_id: uuid, ...pages }, ['dataset_id']),
    required: ['dataset_id'],
    returns: `{ ${PAGE_RETURNS}, results: [dataset version summaries] }`,
    example: example('list_dataset_versions', { dataset_id: DATASET }),
    url: (a) => `${API}/datasets/${encodeURIComponent(String(a.dataset_id))}/versions`,
    parse: (raw, a) =>
      paginate(
        rows(raw).map((r) => datasetSummary(record(r, 'dataset'))),
        a
      )
  },
  {
    id: 'get_dataset_version',
    connector: CONNECTOR,
    description:
      'Retrieve full metadata and file assets for a specific published dataset_version_id. This ID is distinct from the canonical dataset_id.',
    input: schema({ dataset_version_id: uuid }, ['dataset_version_id']),
    required: ['dataset_version_id'],
    returns:
      'The API dataset version object, including dataset_id, dataset_version_id, collection_id, collection_version_id (first publication), schema_version, citation, ontology metadata and assets [{filetype, filesize (bytes, or -1 when unknown), url}].',
    example: example('get_dataset_version', { dataset_version_id: DATASET_VERSION }),
    url: (a) => `${API}/dataset_versions/${encodeURIComponent(String(a.dataset_version_id))}`,
    parse: (raw) => record(raw, 'dataset')
  },
  {
    id: 'list_dataset_files',
    connector: CONNECTOR,
    description:
      'Return a download inventory from public dataset assets. Provide either dataset_version_id for a fixed publication, or both collection_id and dataset_id for the current version. After list_datasets with a schema_version filter, pass the returned dataset_version_id to preserve the selected publication. Returns API-provided H5AD/RDS/ATAC assets when available; no binary download, upload manifest or Census expression query.',
    input: {
      ...schema({ collection_id: uuid, dataset_id: uuid, dataset_version_id: uuid }),
      oneOf: [
        schema({ dataset_version_id: uuid }, ['dataset_version_id']),
        schema({ collection_id: uuid, dataset_id: uuid }, ['collection_id', 'dataset_id'])
      ]
    },
    returns:
      '{ collection_id, dataset_id, dataset_version_id, collection_version_id (when supplied), schema_version, citation, count, files: [{filetype, filesize (bytes, or -1 when unknown), url}] }. URL and format come directly from the API; no checksum is invented. Empty assets return count: 0; malformed responses and HTTP errors propagate.',
    example: example('list_dataset_files', { dataset_version_id: DATASET_VERSION }),
    url: (a) =>
      a.dataset_version_id != null
        ? `${API}/dataset_versions/${encodeURIComponent(String(a.dataset_version_id))}`
        : `${API}${currentDatasetPath(a)}`,
    parse: (raw, a) => {
      const row = record(raw, 'dataset')
      const files = rows(row.assets).map((asset) => {
        if (
          typeof asset.filetype !== 'string' ||
          !asset.filetype ||
          typeof asset.url !== 'string' ||
          !asset.url ||
          typeof asset.filesize !== 'number' ||
          !Number.isFinite(asset.filesize) ||
          (asset.filesize < 0 && asset.filesize !== -1)
        ) {
          throw new Error('Invalid CELLxGENE Discover response: malformed file asset')
        }
        return pick(asset, ['filetype', 'filesize', 'url'])
      })
      return {
        collection_id: row.collection_id ?? a.collection_id,
        ...pick(row, [
          'dataset_id',
          'dataset_version_id',
          'collection_version_id',
          'schema_version',
          'citation'
        ]),
        count: files.length,
        files
      }
    }
  }
]
