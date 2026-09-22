import type { ToolDescriptor } from '../types'

const CENSUS_VERSION = 'stable'

const VERSION = {
  type: 'string',
  description:
    'Census release name, for example "stable" or "2025-11-08". The response reports the resolved build date. Aliases such as "stable" can change; use the returned build date for reproducible subsequent queries.',
  default: CENSUS_VERSION
}

const ORGANISM = {
  type: 'string',
  description:
    'Census organism key. Defaults to "homo_sapiens"; examples include "homo_sapiens" and "mus_musculus".',
  default: 'homo_sapiens'
}

// The Python bridge builds exact SOMA value filters and rejects these characters rather than
// treating user input as filter syntax. Keep the public schema aligned with that boundary.
const EXACT_FILTER_PATTERN = String.raw`^(?!.*['\\\r\n])(?=.*\S).+$`

const FILTERS = {
  organism: ORGANISM,
  tissue: {
    type: 'string',
    pattern: EXACT_FILTER_PATTERN,
    description: 'Nonblank exact tissue_general value, for example "liver".'
  },
  cell_type: {
    type: 'string',
    pattern: EXACT_FILTER_PATTERN,
    description: 'Nonblank exact cell_type value, for example "hepatocyte".'
  },
  disease: {
    type: 'string',
    pattern: EXACT_FILTER_PATTERN,
    description:
      'Nonblank exact disease field value, for example "normal". Composite disease fields are not expanded.'
  }
}

const COHORT_FILTER_REQUIREMENT = [
  { required: ['tissue'], properties: { tissue: {} } },
  { required: ['cell_type'], properties: { cell_type: {} } },
  { required: ['disease'], properties: { disease: {} } }
]

const boundedLimit = (description: string, defaultValue: number): Record<string, unknown> => ({
  type: 'integer',
  minimum: 1,
  maximum: 100,
  description,
  default: defaultValue
})

const appOnly = (name: string): Pick<ToolDescriptor, 'run'> => ({
  run: async (): Promise<unknown> => {
    throw new Error(`${name} is handled by the app Python runtime and cannot run in this context.`)
  }
})

export const CENSUS_TOOLS: ToolDescriptor[] = [
  {
    id: 'census_list_datasets',
    connector: 'census',
    description:
      'List datasets in the selected CELLxGENE Census release. Optionally search dataset id, title, collection name, or citation. Results are bounded to 100 rows.',
    input: {
      type: 'object',
      properties: {
        census_version: VERSION,
        query: {
          type: 'string',
          description: 'Case-insensitive text search over dataset metadata.'
        },
        limit: boundedLimit('Maximum datasets to return.', 25)
      },
      additionalProperties: false
    },
    returns:
      '`{ census_version, total (matching datasets), datasets: [{ dataset_id, dataset_version_id, dataset_title, collection_id, collection_name, collection_doi, dataset_total_cell_count }] }`. Dataset fields absent from the selected release are omitted.',
    example:
      'const result = await host.mcp("census", "census_list_datasets", {"query": "liver", "limit": 10})',
    ...appOnly('census_list_datasets')
  },
  {
    id: 'census_query_cells',
    connector: 'census',
    description:
      'Query bounded single-cell observation metadata from CELLxGENE Census by organism plus exact tissue, cell type, and/or disease filters. At least one nonblank metadata filter is required. Cells are not deduplicated across datasets. A combination of valid filter values that matches no cells may still require a scan and reach the query timeout.',
    input: {
      type: 'object',
      properties: {
        census_version: VERSION,
        ...FILTERS,
        limit: boundedLimit('Maximum cells to return; the first row-major cells are used.', 25)
      },
      anyOf: COHORT_FILTER_REQUIREMENT,
      additionalProperties: false
    },
    returns:
      '`{ census_version, organism, total_returned, cells: [{ soma_joinid, dataset_id, assay, cell_type, tissue_general, disease, sex, development_stage }] }`. Fields absent from the selected Census release are omitted from each cell.',
    example:
      'const result = await host.mcp("census", "census_query_cells", {"organism": "homo_sapiens", "tissue": "liver", "cell_type": "hepatocyte", "limit": 10})',
    ...appOnly('census_query_cells')
  }
]
