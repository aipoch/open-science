// @vitest-environment jsdom
// Covers what a plain string swap gets wrong in this form: the command dropdown labels are catalog
// keys resolved at render (a stale `.label` would silently ship English), the credential actions and
// hints are composed from independently-translated strings whose order the catalog must not assume,
// and Cancel comes from the shared `common` namespace.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CustomServerView } from '../../../../shared/settings'
import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { ConnectorAddForm } from './ConnectorAddForm'
import { connectorDescription, connectorToolDescription } from './connector-copy'

let container: HTMLDivElement
let root: Root
let renderKey = 0

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const setup = (): void => {
  useSettingsStore.setState({
    addCustomServer: vi.fn().mockResolvedValue(undefined),
    updateCustomServer: vi.fn().mockResolvedValue(undefined)
  } as never)
}

const render = (props: Partial<Parameters<typeof ConnectorAddForm>[0]> = {}): void => {
  act(() => {
    root.render(
      <ConnectorAddForm key={renderKey++} onDone={vi.fn()} onCancel={vi.fn()} {...props} />
    )
  })
}

const openAdvancedSettings = (): void => {
  const trigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.includes('Advanced settings')
  )
  act(() => trigger?.click())
}

const editServer: CustomServerView = {
  id: 'srv-1',
  name: 'memory-server',
  displayName: 'Memory server',
  transport: 'stdio',
  enabled: true,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory']
}

const envEditServer: CustomServerView = {
  ...editServer,
  hasEnv: true,
  environmentNames: ['API_TOKEN']
}

const remoteEditServer: CustomServerView = {
  id: 'srv-2',
  name: 'remote-server',
  displayName: 'Remote server',
  transport: 'streamable_http',
  enabled: true,
  url: 'https://example.com/mcp'
}

// hasHeaders puts the form into the Static-headers auth mode and defaults editing to preserving the
// existing bindings.
const headersEditServer: CustomServerView = {
  ...remoteEditServer,
  id: 'srv-3',
  name: 'headers-server',
  hasHeaders: true
}

beforeEach(() => {
  setup()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  switchTo('en')
})

describe('ConnectorAddForm copy', () => {
  it('translates the mode switch and the trust confirmation', () => {
    render()
    expect(container.textContent).toContain('Local command')
    expect(container.textContent).toContain('Remote server')
    expect(container.textContent).toContain(
      'I trust this connector. Only add connectors from developers you trust.'
    )

    switchTo('zh-Hans')
    expect(container.textContent).toContain('本地命令')
    expect(container.textContent).toContain('远程服务器')
    expect(container.textContent).toContain('我信任这个连接器。只添加来自你信任的开发者的连接器。')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('本機指令')
    expect(container.textContent).toContain('遠端伺服器')
    expect(container.textContent).toContain('我信任這個連接器。只加入來自你信任的開發者的連接器。')
  })

  it('resolves the selected command label from the catalog, keeping the runtime name verbatim', () => {
    render()
    const trigger = container.querySelector('[aria-label="Command"]') as HTMLElement
    expect(trigger.textContent).toBe('npx — Node package')

    switchTo('zh-Hans')
    expect((container.querySelector('[aria-label="命令"]') as HTMLElement).textContent).toBe(
      'npx — Node 包'
    )

    switchTo('zh-Hant')
    expect((container.querySelector('[aria-label="指令"]') as HTMLElement).textContent).toBe(
      'npx — Node 套件'
    )
  })

  it('takes Cancel from the shared common namespace', () => {
    render()
    expect(container.textContent).toContain('Cancel')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('取消')
  })

  it('labels the submit button for add versus edit', () => {
    render()
    expect(container.textContent).toContain('Add connector')
    expect(container.textContent).not.toContain('Save changes')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('添加连接器')

    render({ editServer })
    expect(container.textContent).toContain('保存更改')
    expect(container.textContent).not.toContain('添加连接器')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('儲存變更')
  })

  // Add mode binds names to device credentials. Edit mode defaults to the explicit keep action and
  // exposes saved names without rendering their values, so translations must cover both states.
  it('translates the environment add hint and explicit edit action', () => {
    render()
    openAdvancedSettings()
    expect(container.textContent).toContain('One variable name per line as KEY=.')
    expect(container.textContent).not.toContain('Keep saved variables')

    render({ editServer: envEditServer })
    expect(container.textContent).toContain('Keep saved variables')
    expect(container.textContent).toContain('Saved names: API_TOKEN.')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('每行一个变量名，格式为 KEY=。')
    expect(container.textContent).toContain('保留已保存的变量')
    expect(container.textContent).toContain('已保存的名称：API_TOKEN。')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('每行一個變數名稱，格式為 KEY=。')
    expect(container.textContent).toContain('保留已儲存的變數')
    expect(container.textContent).toContain('已儲存的名稱：API_TOKEN。')
  })

  it('translates the explicit header credential action', () => {
    render({ editServer: headersEditServer })
    expect(container.textContent).toContain('Keep saved headers')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('保留已儲存的標頭')
  })

  // The invocation name is immutable after creation, so editing disables the field. The hint explaining
  // what the name is used for is catalog copy, while `host.mcp(…)` is API surface and stays verbatim.
  it('translates the connector-ID hint and keeps the host.mcp call untranslated', () => {
    render({ editServer })
    const idField = container.querySelector('#connector-name-id') as HTMLInputElement
    expect(idField.disabled).toBe(true)
    expect(idField.value).toBe('memory-server')
    expect(container.textContent).toContain(
      'Used by host.mcp("memory-server", …), Specialists, and the generated MCP skill.'
    )

    switchTo('zh-Hans')
    expect(container.textContent).toContain(
      '供 host.mcp("memory-server", …)、专家和生成的 MCP 技能使用。'
    )

    switchTo('zh-Hant')
    expect(container.textContent).toContain(
      '供 host.mcp("memory-server", …)、專家和產生的 MCP 技能使用。'
    )
  })

  it('keeps protocol values untranslated in the remote fields', () => {
    render({ editServer: remoteEditServer })
    openAdvancedSettings()
    const transport = container.querySelector('[aria-label="Transport"]') as HTMLElement
    expect(transport.textContent).toBe('Streamable HTTP')
    expect((container.querySelector('#connector-url') as HTMLInputElement).value).toBe(
      'https://example.com/mcp'
    )

    switchTo('zh-Hans')
    expect((container.querySelector('[aria-label="传输方式"]') as HTMLElement).textContent).toBe(
      'Streamable HTTP'
    )
  })

  it('covers every localized featured connector and tool description branch', () => {
    const t = i18next.getFixedT('en')
    const fallback = 'runtime fallback'
    const connectorCases = [
      ['interproscan', 'InterProScan job status and TSV result retrieval via EMBL-EBI.'],
      ['zenodo', 'Public research records, versions and file metadata from Zenodo.'],
      [
        'genes',
        'Gene/protein identity, ontology terms and gene-set enrichment — mygene.info, UniProt, OLS4 ontologies, GO annotations, Reactome pathways and g:Profiler.'
      ],
      [
        'genomes',
        'Genome annotation, sequence similarity search, multiple sequence alignment and browser tracks via NCBI, EMBL-EBI, Ensembl and UCSC.'
      ],
      [
        'variants',
        'Human genetic variants — gnomAD population frequencies/constraint, ClinVar records/search (direct NCBI), dbSNP, structural and mitochondrial variants.'
      ],
      [
        'omics-archives',
        'Omics data archives — expression (ArrayExpress, GEO), sequencing reads (ENA), metabolomics (MetaboLights), metagenomics (MGnify) and proteomics (PRIDE).'
      ],
      ['literature', 'Literature and research data via OpenAlex, arXiv, Crossref and DataCite.']
    ] as const

    for (const [id, expected] of connectorCases) {
      expect(connectorDescription({ id, description: fallback }, t)).toBe(expected)
    }
    expect(connectorDescription({ id: 'custom', description: fallback }, t)).toBe(fallback)

    const toolCases = [
      [
        'interproscan/status',
        'Check an InterProScan job once. Wait at least 10 seconds between checks.'
      ],
      [
        'interproscan/results',
        'Retrieve the complete TSV report for a finished InterProScan job. Results expire at the service.'
      ],
      ['zenodo/search_records', 'Search public Zenodo records, one page at a time.'],
      [
        'zenodo/get_record',
        'Retrieve Zenodo record metadata and file links. Files are not downloaded.'
      ],
      [
        'genomes/clustalo_submit',
        'Submit three or more protein, DNA or RNA sequences to Clustal Omega for asynchronous multiple sequence alignment.'
      ],
      [
        'genomes/clustalo_status',
        'Check a Clustal Omega job once. Wait at least 10 seconds between checks.'
      ],
      [
        'genomes/clustalo_results',
        'Retrieve the alignment file for a finished Clustal Omega job. Results expire at the service.'
      ],
      [
        'rna/search_sequence',
        'Search RNA/DNA against Rfam models. Cancelling stops polling; the service retains results for one week.'
      ],
      [
        'literature/crossref_get_work',
        'Retrieve publisher-deposited bibliographic metadata by DOI.'
      ],
      [
        'literature/crossref_get_updates',
        'Find deposited corrections and retractions. Missing updates do not establish reliability.'
      ],
      ['literature/datacite_search_records', 'Find datasets and software by topic or related DOI.'],
      [
        'literature/datacite_get_record',
        'Retrieve dataset metadata, rights and publication relationships by DOI.'
      ],
      ['genes/search_uniprot_entries', 'Discover UniProt proteins with cursor pagination.'],
      ['genes/submit_uniprot_id_mapping', 'Submit an asynchronous UniProt identifier mapping job.'],
      [
        'genes/get_uniprot_id_mapping_status',
        'Check the status of a UniProt identifier mapping job.'
      ],
      [
        'genes/get_uniprot_id_mapping_results',
        'Retrieve a page of UniProt identifier mapping results.'
      ],
      [
        'genes/list_enrichment_sources',
        'List available g:Profiler enrichment sources for an organism.'
      ],
      [
        'genes/enrich_gene_set',
        'Run g:Profiler gene-set enrichment with multiple-testing correction.'
      ],
      ['omics-archives/ena_query_runs', 'Discover ENA sequencing runs with metadata filters.'],
      [
        'omics-archives/ena_get_submitted_files',
        'List submitted files for an ENA run without downloading them.'
      ],
      ['omics-archives/ena_search_runs', 'Find ENA runs by accession or study.'],
      [
        'omics-archives/ena_get_run_files',
        'List FASTQ files for an ENA run without downloading them.'
      ],
      [
        'omics-archives/pride_get_project_files',
        'List one page of public PRIDE project files without downloading them.'
      ],
      ['genomes/blast_submit', 'Submit an asynchronous NCBI BLAST sequence search.'],
      ['genomes/blast_status', 'Check the status of an NCBI BLAST search.'],
      ['genomes/blast_results', 'Retrieve results for a finished NCBI BLAST search.'],
      [
        'genomes/ncbi_resolve_taxon',
        'Resolve a species or taxon name to NCBI Taxonomy identifiers.'
      ],
      [
        'genomes/ncbi_get_assembly_info',
        'Retrieve exact identity and paired accessions for an NCBI genome assembly.'
      ],
      [
        'genomes/ncbi_get_sequence_aliases',
        'List sequence names and UCSC, RefSeq and GenBank aliases for an NCBI assembly.'
      ],
      ['genomes/ucsc_conservation', 'Summarize UCSC conservation scores for a genomic region.'],
      ['variants/get_variant', 'Retrieve a gnomAD variant with optional population frequencies.']
    ] as const

    for (const [id, expected] of toolCases) {
      expect(connectorToolDescription(id, fallback, t)).toBe(expected)
    }
    expect(connectorToolDescription('custom/tool', fallback, t)).toBe(fallback)
  })
})
