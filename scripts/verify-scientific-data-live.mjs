// Opt-in public-service smoke checks. Run after the normal package build; no Python,
// credentials, file writes, imports, workers, jobs or research databases are created.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { RESEARCH_DATASET_TOOLS } from '@aipoch/connector-builtins/research-datasets'
import { MOLECULAR_DATA_TOOLS } from '@aipoch/connector-builtins/molecular-data'
import { EUROPEPMC_TOOLS } from '@aipoch/connector-builtins/literature-europepmc'
import { GENES_TOOLS } from '@aipoch/connector-builtins/genes'

const registry = createConnectorRegistry([
  ...RESEARCH_DATASET_TOOLS,
  ...MOLECULAR_DATA_TOOLS,
  ...EUROPEPMC_TOOLS,
  ...GENES_TOOLS.filter((tool) => tool.id.includes('hgnc'))
])
const engine = new ParserEngine({
  retries: 0,
  timeoutMs: 20_000,
  totalTimeoutMs: 30_000,
  maxResponseBytes: 8_000_000
})
const cases = [
  [
    'europepmc',
    'search_europepmc',
    { query: 'TP53 AND liver fibrosis', page_size: 2 },
    (r) => assert.ok(r.records.length > 0)
  ],
  [
    'research-datasets',
    'list_nhanes_files',
    { cycle_begin_year: 2017 },
    (r) => assert.ok(r.files.some((f) => /DEMO_J.XPT/i.test(f.filename)))
  ],
  [
    'research-datasets',
    'list_physionet_demo_files',
    { dataset: 'mimic', directory: 'hosp' },
    (r) => assert.ok(r.files.some((f) => f.filename === 'patients.csv.gz'))
  ],
  [
    'research-datasets',
    'list_physionet_demo_files',
    { dataset: 'eicu' },
    (r) => assert.ok(r.files.some((f) => f.filename === 'patient.csv.gz'))
  ],
  [
    'drug-regulatory',
    'list_faers_bulk_files',
    { limit: 2 },
    (r) => assert.equal(r.files.length, 2)
  ],
  ['genes', 'get_hgnc_service_info', {}, (r) => assert.ok(r.service.searchableFields.length > 0)],
  [
    'genes',
    'query_hgnc_field',
    { field: 'entrez_id', value: '7157' },
    (r) => assert.equal(r.records[0].symbol, 'TP53')
  ],
  ['genes', 'list_hgnc_files', { limit: 2 }, (r) => assert.ok(r.files.length > 0)],
  [
    'chea3',
    'rank_transcription_factors',
    { genes: ['FOXM1', 'SMAD9', 'MYC', 'SMAD3', 'STAT1', 'STAT3'], top_n: 2 },
    (r) => assert.ok(Object.keys(r.libraries).length > 0)
  ],
  ['chea3', 'list_gmt_libraries', {}, (r) => assert.ok(r.files.length > 0)],
  [
    'biodbnet',
    'convert_ids',
    { input_type: 'genesymbol', values: ['TP53'], outputs: ['geneid'] },
    (r) => assert.match(JSON.stringify(r.result), /7157/)
  ],
  [
    'cellosaurus',
    'get_cell_line_rdf',
    { accession: 'CVCL_0030' },
    (r) => assert.match(r.content, /CVCL_0030/i)
  ],
  [
    'cellosaurus',
    'query_knowledge_graph',
    { query: 'SELECT ?s WHERE { ?s a <http://www.w3.org/2002/07/owl#Class> }', max_rows: 2 },
    (r) => assert.ok(r.records.length <= 2)
  ],
  [
    'cellosaurus',
    'search_str_similarity',
    { markers: { D5S818: '12,13' }, min_markers: 1, max_results: 2 },
    (r) => assert.ok(r.result && typeof r.result === 'object')
  ],
  ['cellosaurus', 'list_cellosaurus_files', {}, (r) => assert.ok(r.files.length > 0)]
]

// JavaScript entry point; return type annotations require TypeScript syntax.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function verifyScientificDataLive() {
  const results = []
  let next = 0
  // Keep independent upstream checks bounded; HGNC descriptors share their own admission.
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < cases.length) {
        const [connector, method, args, verify] = cases[next++]
        const tool = registry.getDescriptor(connector, method)
        try {
          registry.validateToolArguments(tool, args)
          const result = await engine.call(tool, args, {})
          verify(result)
          const report = {
            connector,
            method,
            status: 'passed',
            source_url: result.source_url,
            retrieved_at: result.retrieved_at
          }
          results.push(report)
          console.log(JSON.stringify(report))
        } catch (error) {
          const report = {
            connector,
            method,
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unknown failure'
          }
          results.push(report)
          console.log(JSON.stringify(report))
        }
      }
    })
  )
  for (const dataset of ['charls', 'chns', 'seer', 'gbd']) {
    console.log(
      JSON.stringify({
        dataset,
        status: 'not_tested',
        scope: 'Personal access or browser export; no account or approved research file was used.'
      })
    )
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await verifyScientificDataLive()
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1
}
