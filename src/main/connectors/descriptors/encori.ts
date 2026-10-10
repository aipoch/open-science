import type { ToolDescriptor } from '../types'
import { encoriCall } from '../encori/runtime'
import { query, references, type Args } from '../encori/client'
import { BULK_TYPES, DATASETS, download, listDatasets } from '../encori/download'

const text = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\r\\n\\u0000]*[^\\s\\u0000][^\\r\\n\\u0000]*$'
}
const directory = { type: ['string', 'null'], minLength: 1, maxLength: 4096 }
const choice = (...values: string[]): Args => ({ type: 'string', enum: values })
const integer = (minimum: number, maximum = 999): Args => ({ type: 'integer', minimum, maximum })
const humanMouse = choice('hg38', 'mm10')
const assemblies = choice('hg38', 'mm10', 'dm6', 'ce10', 'sacCer3')
const geneTypes = choice('mRNA', 'lncRNA', 'pseudogene', 'circRNA', 'sncRNA')
const common = { max_records: { ...integer(1, 200), default: 20 }, output_dir: directory }
const evidence = { clip_exp_num: integer(1), pancancer_num: integer(0, 32) }
const returns =
  '{ ok, database, source_url, queried_at, query, columns, citation_lines, total_records, returned_records, is_complete, result_scope, completeness_note, records, raw_response_path, warnings }. On failure: { ok: false, database, source_url, queried_at, error: { code, message, retryable, status_code } }. Caller cancellation and service permission/schema errors propagate. Queries and reference calls have a 120-second total deadline including retries and waits, with a 45-second network idle timeout. The total deadline propagates as an error; increasing an outer execution timeout does not extend it. Counts describe this official response; records may be a preview. Raw response bytes are saved even when all rows are displayed. Never relax filters after zero results or infer full-result distributions from a preview.'
function table(
  id: string,
  endpoint: string,
  description: string,
  properties: Args,
  mapping: Record<string, string>,
  exampleArgs: Args
): ToolDescriptor {
  return {
    connector: 'encori',
    id,
    description,
    input: {
      type: 'object',
      properties: { ...properties, ...common },
      required: Object.keys(properties),
      additionalProperties: false
    },
    returns,
    totalTimeoutMs: 120000,
    example: `await host.mcp("encori", "${id}", ${JSON.stringify({ ...exampleArgs, max_records: 2 })})`,
    run: (ctx, args) => encoriCall(ctx, () => query(ctx, args, endpoint, mapping))
  }
}
const targetMapping = {
  assembly: 'assembly',
  gene_type: 'geneType',
  target: 'target',
  cell_type: 'cellType'
}
export const ENCORI_TOOLS: ToolDescriptor[] = [
  table(
    'query_mirna_targets',
    'miRNATarget',
    'Query official miRNA target evidence. Use mirna=all for unrestricted miRNA; preserve cell_type exactly. program is a comma-separated list of PITA, RNA22, miRmap, DIANA-microT, miRanda, PicTar or TargetScan, never all.',
    {
      assembly: humanMouse,
      gene_type: geneTypes,
      mirna: text,
      clip_exp_num: integer(0),
      degra_exp_num: integer(0),
      pancancer_num: integer(0, 32),
      program_num: integer(1, 7),
      program: text,
      target: text,
      cell_type: text
    },
    {
      ...targetMapping,
      mirna: 'miRNA',
      clip_exp_num: 'clipExpNum',
      degra_exp_num: 'degraExpNum',
      pancancer_num: 'pancancerNum',
      program_num: 'programNum',
      program: 'program'
    },
    {
      assembly: 'hg38',
      gene_type: 'mRNA',
      mirna: 'all',
      clip_exp_num: 1,
      degra_exp_num: 0,
      pancancer_num: 0,
      program_num: 1,
      program: 'TargetScan',
      target: 'PDCD4',
      cell_type: 'HeLa'
    }
  ),
  table(
    'query_rna_rna_interactions',
    'RNARNA',
    'Query official RNA–RNA interactions. Use cell_type=all only when unrestricted; do not substitute another database.',
    {
      assembly: humanMouse,
      gene_type: choice('mRNA', 'lncRNA', 'pseudogene', 'sncRNA', 'miRNA'),
      rna: text,
      inter_num: integer(1),
      exp_num: integer(1),
      cell_type: text
    },
    {
      assembly: 'assembly',
      gene_type: 'geneType',
      rna: 'RNA',
      inter_num: 'interNum',
      exp_num: 'expNum',
      cell_type: 'cellType'
    },
    { assembly: 'hg38', gene_type: 'mRNA', rna: 'TP53', inter_num: 1, exp_num: 1, cell_type: 'all' }
  ),
  table(
    'query_rbp_targets',
    'RBPTarget',
    'Query official RBP target evidence. Use rbp=all for all RBPs; preserve cell_type and distinguish zero rows from request failure.',
    {
      assembly: assemblies,
      gene_type: geneTypes,
      rbp: text,
      ...evidence,
      target: text,
      cell_type: text
    },
    { ...targetMapping, rbp: 'RBP', clip_exp_num: 'clipExpNum', pancancer_num: 'pancancerNum' },
    {
      assembly: 'hg38',
      gene_type: 'mRNA',
      rbp: 'all',
      clip_exp_num: 1,
      pancancer_num: 0,
      target: 'TP53',
      cell_type: 'HeLa'
    }
  ),
  table(
    'query_cerna_network',
    'ceRNA',
    'Query official ceRNA networks. Use family=all when unrestricted. Preserve official P values and FDR; never infer missing family names from counts.',
    {
      assembly: humanMouse,
      gene_type: choice('mRNA', 'lncRNA', 'pseudogene'),
      cerna: text,
      mirna_num: integer(1),
      family: text,
      pval: { type: 'number', minimum: 0, maximum: 0.01 },
      fdr: { type: 'number', minimum: 0, maximum: 0.01 },
      pancancer_num: integer(0, 32)
    },
    {
      assembly: 'assembly',
      gene_type: 'geneType',
      cerna: 'ceRNA',
      mirna_num: 'miRNAnum',
      family: 'family',
      pval: 'pval',
      fdr: 'fdr',
      pancancer_num: 'pancancerNum'
    },
    {
      assembly: 'hg38',
      gene_type: 'mRNA',
      cerna: 'MYC',
      mirna_num: 1,
      family: 'all',
      pval: 0.01,
      fdr: 0.01,
      pancancer_num: 0
    }
  ),
  table(
    'query_rbp_disease',
    'RBPDisease',
    'Query official RBP disease evidence. Preserve tissue, disease and target filters without widening zero-result queries.',
    { assembly: choice('hg38'), rbp: text, tissue: text, disease: text, target: text },
    { assembly: 'assembly', rbp: 'RBP', tissue: 'tissue', disease: 'disease', target: 'target' },
    { assembly: 'hg38', rbp: 'all', tissue: 'breast', disease: 'carcinoma', target: 'MYC' }
  ),
  table(
    'scan_rbp_motifs',
    'RBPMotifScan',
    'Search official RBP motif rankings. Preserve order and scores. QueryMotif and IdentifiedMotif are independent fields; no reverse complement is performed or inferred.',
    {
      assembly: assemblies,
      length: choice('short', 'long'),
      motif: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: '^[ACGTUNRYKMSWBDHVacgtunrykmswbdhv]+$'
      },
      rank_limit: integer(1, 100)
    },
    { assembly: 'assembly', length: 'length', motif: 'motif', rank_limit: 'rankLimit' },
    { assembly: 'hg38', length: 'short', motif: 'UGCAUG', rank_limit: 10 }
  ),
  {
    ...table(
      'get_binding_sites',
      'bindingSite',
      'Retrieve official BED binding sites by dataset_id. Remove only known SQL prefixes from parsed records; retain exact raw bytes.',
      { assembly: assemblies, dataset_id: { ...text, maxLength: 64 } },
      { assembly: 'assembly', dataset_id: 'datasetID' },
      { assembly: 'hg38', dataset_id: 'SBDH2131' }
    ),
    input: {
      type: 'object',
      properties: {
        assembly: assemblies,
        dataset_id: { ...text, maxLength: 64 },
        max_records: { ...integer(1, 1000), default: 100 },
        output_dir: directory
      },
      required: ['assembly', 'dataset_id'],
      additionalProperties: false
    }
  },
  {
    connector: 'encori',
    id: 'get_reference_tables',
    description:
      'List exact table names from the online official reference ZIP, or read one exact table_name such as reference_data/degradome_ref.txt. Fetches the ZIP anew on each call.',
    input: {
      type: 'object',
      properties: {
        table_name: { ...text, type: ['string', 'null'], maxLength: 512 },
        max_records: { ...integer(1, 500), default: 50 },
        output_dir: directory
      },
      additionalProperties: false
    },
    returns:
      '{ ok, database, source_url, queried_at, files, table_names, returned_files, selected_table, records, total_records, returned_records, is_complete, result_scope, raw_response_path, warnings, error }. Selected tables also include columns, citation_lines, completeness_note and saved_path. Listing reads metadata only and does not save or return table contents; raw_response_path is null. Complete selected tables return all rows without writing a file; raw_response_path and saved_path are null. Only a truncated table saves the full original bytes locally and returns both paths. Counts describe the selected official table; never infer full-result distributions from a preview. On failure: { ok: false, database, source_url, queried_at, error: { code, message, retryable, status_code } }. Caller cancellation and service permission/schema errors propagate. This call has a 120-second total deadline including retries and waits, with a 45-second network idle timeout. The total deadline propagates as an error; increasing an outer execution timeout does not extend it.',
    example:
      'await host.mcp("encori", "get_reference_tables", {"table_name":"reference_data/degradome_ref.txt","max_records":2})',
    totalTimeoutMs: 120000,
    run: (ctx, args) => encoriCall(ctx, () => references(ctx, args))
  },
  {
    connector: 'encori',
    id: 'list_bulk_datasets',
    description:
      'List the 24 documented official bulk dataset filenames. By default HEAD probes availability and byte sizes, without downloading data. Unchecked availability and size are null.',
    input: {
      type: 'object',
      properties: {
        assembly: { type: ['string', 'null'], enum: ['hg38', 'mm10', null] },
        data_type: { type: ['string', 'null'], enum: [...BULK_TYPES, null] },
        check_availability: { type: 'boolean', default: true }
      },
      additionalProperties: false
    },
    returns:
      '{ ok, files: [{ filename, assembly, data_type, download_url, available, size_bytes, size_mib, etag, last_modified, accept_ranges, error? }], returned_files, warnings, error }. Per-file failures are preserved. size_mib uses 1024² bytes. This call has a 300-second total deadline including all HEAD probes, retries and waits, with a 45-second network idle timeout. The total deadline propagates as an error; increasing an outer execution timeout does not extend it.',
    example:
      'await host.mcp("encori", "list_bulk_datasets", {"assembly":"hg38","data_type":"miRNA_mRNA"})',
    totalTimeoutMs: 300000,
    run: (ctx, args) => encoriCall(ctx, () => listDatasets(ctx, args))
  },
  {
    connector: 'encori',
    id: 'download_bulk_dataset',
    description:
      'Only when the user requests a download, stream one official bulk file to destination_dir on the computer running Open Science. Never overwrite an existing file. Interrupted .part files resume on the same filename/directory only after identity and HTTP range validation. Validate size and gzip integrity before publication.',
    input: {
      type: 'object',
      properties: {
        filename: choice(...DATASETS.map((item) => item.filename)),
        destination_dir: directory
      },
      required: ['filename'],
      additionalProperties: false
    },
    returns:
      '{ ok, source_url, saved_path, filename, size_bytes, size_mib, resumed, resumed_from_bytes, verified_gzip, warnings }. Success requires verified_gzip=true and an actual published file. This call has a 3600-second total deadline including metadata requests, transfer, retries, verification and publication, with a 45-second network idle timeout. The total deadline propagates as an error; increasing an outer execution timeout does not extend it. Interrupted transfers retain .part and .meta.json; call the same filename and destination_dir to resume after identity and range checks. A timeout before file publication is not success. Downloads follow the existing Connector permission settings; explicit user policies, Skip approvals and remembered grants retain their existing precedence. Specialist capability scopes follow their existing independent policy. Concurrent transfers of the same file in this app process are rejected; process exit releases that guard.',
    example:
      'await host.mcp("encori", "download_bulk_dataset", {"filename":"hg38.miRNA_sncRNA.tar.gz","destination_dir":"/absolute/path/to/output"})',
    totalTimeoutMs: 3600000,
    run: (ctx, args) => encoriCall(ctx, () => download(ctx, args))
  }
]
