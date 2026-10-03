// @vitest-environment jsdom
// Covers what a plain string swap gets wrong in this form: the command dropdown labels are catalog
// keys resolved at render (a stale `.label` would silently ship English), the credential actions and
// hints are composed from independently-translated strings whose order the catalog must not assume,
// and Cancel comes from the shared `common` namespace.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CustomServerView } from '../../../../shared/settings'
import { i18next, initI18n, prepareI18nLocale } from '@/i18n'
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
  it.each(['de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru'] as const)(
    'localizes IEDB discovery and evidence tools in %s',
    async (locale) => {
      await prepareI18nLocale(locale)
      const t = i18next.getFixedT(locale, 'renderer')
      const description =
        'Immune epitopes, T/B cell and MHC assays, antigens and literature evidence from IEDB.'
      const translated = connectorDescription({ id: 'iedb', description }, t)
      expect(translated).toBe(i18next.getResource(locale, 'renderer', description))
      expect(translated).not.toBe(description)
      for (const [method, english] of [
        ['search_epitopes', 'Search immune epitopes by sequence, host, antigen and MHC.'],
        ['search_antigens', 'Search epitope source antigens and UniProt references.'],
        [
          'search_tcell_assays',
          'Retrieve T cell experiments, measurements and literature evidence.'
        ],
        [
          'search_bcell_assays',
          'Retrieve B cell experiments, measurements and literature evidence.'
        ],
        [
          'search_mhc_assays',
          'Retrieve MHC binding and ligand elution experiments with methods and units.'
        ],
        [
          'search_references',
          'Find IEDB references and PubMed identifiers for experimental evidence.'
        ]
      ]) {
        const copy = connectorToolDescription(`iedb/${method}`, english, t)
        expect(copy).toBe(i18next.getResource(locale, 'renderer', english))
        expect(copy).not.toBe(english)
      }
    }
  )

  it.each(['de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru'] as const)(
    'renders the PDB sequence search description from the %s catalog',
    async (locale) => {
      await prepareI18nLocale(locale)
      const english =
        'Search experimental PDB structures by protein sequence, sequence identity and query coverage; return entities, chains and alignment details.'
      const fallback = 'Full API contract for the agent'
      const id = 'structures/pdb_search_sequence'
      const t = i18next.getFixedT(locale, 'renderer')
      const translated = i18next.getResource(locale, 'renderer', english)
      expect(typeof translated).toBe('string')
      expect(translated).not.toBe('')
      expect(translated).not.toBe(english)
      act(() => {
        root.render(<p>{connectorToolDescription(id, fallback, t)}</p>)
      })
      expect(container.querySelector('p')?.textContent).toBe(translated)
      expect(container.textContent).not.toContain(fallback)
      expect(connectorToolDescription(id, fallback, i18next.getFixedT('en', 'renderer'))).toBe(
        english
      )
    }
  )

  it.each(['de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru'] as const)(
    'renders GEO tool descriptions from the %s catalog without API-contract fallback',
    async (locale) => {
      await prepareI18nLocale(locale)
      const descriptions = [
        ['geo_get_series', 'Retrieve GEO series metadata, samples and supplementary-file links.'],
        [
          'geo_get_matrix_files',
          'Find GEO Series Matrix and NCBI RNA-seq count file links for manual download.'
        ],
        [
          'geo_preflight_matrix',
          'Check decompressed GEO matrix structure, dimensions and sample alignment before analysis.'
        ]
      ] as const
      const fallback = 'Full English API contract'
      const t = i18next.getFixedT(locale, 'renderer')
      act(() => {
        root.render(
          <div>
            {descriptions.map(([method]) => (
              <p key={method}>
                {connectorToolDescription(`omics-archives/${method}`, fallback, t)}
              </p>
            ))}
          </div>
        )
      })
      const paragraphs = container.querySelectorAll('p')
      expect(paragraphs).toHaveLength(descriptions.length)
      descriptions.forEach(([method, english], index) => {
        const translated = i18next.getResource(locale, 'renderer', english)
        expect(typeof translated).toBe('string')
        expect(translated).not.toBe('')
        expect(translated).not.toBe(english)
        expect(paragraphs[index].textContent).toBe(translated)
        expect(
          connectorToolDescription(`omics-archives/${method}`, fallback, i18next.getFixedT('en'))
        ).toBe(english)
      })
      expect(container.textContent).not.toContain(fallback)
    }
  )

  it.each(['de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru'] as const)(
    'localizes Monarch evidence descriptions in %s',
    async (locale) => {
      await prepareI18nLocale(locale)
      const t = i18next.getFixedT(locale, 'renderer')
      const copy =
        'Disease and gene phenotype associations with evidence sources via Monarch Initiative.'
      expect(connectorDescription({ id: 'monarch', description: copy }, t)).toBe(
        i18next.getResource(locale, 'renderer', copy)
      )
      for (const [method, english] of [
        [
          'monarch_get_disease_phenotypes',
          'Retrieve disease–phenotype associations with evidence sources and relation types.'
        ],
        [
          'monarch_get_gene_phenotypes',
          'Retrieve gene–phenotype associations with evidence sources and relation types.'
        ]
      ]) {
        const translated = connectorToolDescription(`monarch/${method}`, english, t)
        expect(translated).toBe(i18next.getResource(locale, 'renderer', english))
        expect(translated).not.toBe(english)
      }
    }
  )

  it.each(['de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru'] as const)(
    'renders all Alliance tool descriptions from the %s catalog without English fallback',
    async (locale) => {
      await prepareI18nLocale(locale)
      act(() => {
        initI18n(locale)
      })
      const descriptions = [
        ['alliance_get_gene', 'Retrieve an Alliance gene summary and genomic location.'],
        ['alliance_search_genes', 'Search Alliance genes by symbol, name or identifier.'],
        ['alliance_get_gene_orthologs', 'Retrieve cross-species orthologs and prediction methods.'],
        [
          'alliance_get_gene_disease_models',
          'Retrieve disease models associated with an Alliance gene.'
        ],
        ['alliance_get_gene_phenotypes', 'Retrieve phenotype annotations for an Alliance gene.'],
        [
          'alliance_get_gene_alleles',
          'Retrieve alleles and variants associated with an Alliance gene.'
        ],
        [
          'alliance_get_gene_expression',
          'Retrieve anatomical and developmental expression annotations.'
        ],
        ['alliance_get_disease_genes', 'Retrieve genes associated with a Disease Ontology term.']
      ] as const
      const t = i18next.getFixedT(locale, 'renderer')
      act(() => {
        root.render(
          <div>
            {descriptions.map(([method, english]) => (
              <p key={method}>{connectorToolDescription(`alliance/${method}`, english, t)}</p>
            ))}
          </div>
        )
      })
      const paragraphs = container.querySelectorAll('p')
      expect(paragraphs).toHaveLength(descriptions.length)
      descriptions.forEach(([method, english], index) => {
        const translated = i18next.getResource(locale, 'renderer', english)
        expect(typeof translated).toBe('string')
        expect(translated).not.toBe('')
        expect(translated).not.toBe(english)
        expect(paragraphs[index].textContent).toBe(translated)
        expect(connectorToolDescription(`alliance/${method}`, '', i18next.getFixedT('en'))).toBe(
          english
        )
      })
    }
  )

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
      [
        'cellosaurus',
        'Cell line identity, origin, diseases, quality records and database mappings from Cellosaurus.'
      ],
      [
        'cellxgene-discover',
        'Public collections, datasets, versions and file download links from CELLxGENE Discover.'
      ],
      ['interproscan', 'InterProScan job status and TSV result retrieval via EMBL-EBI.'],
      ['zenodo', 'Public research records, versions and file metadata from Zenodo.'],
      [
        'genes',
        'Gene/protein identity, ontology terms and gene-set enrichment — mygene.info, UniProt, OLS4 ontologies, GO annotations, Reactome pathways, g:Profiler and Enrichr.'
      ],
      [
        'genomes',
        'Genome annotation, sequence similarity search, multiple sequence alignment and browser tracks via NCBI, EMBL-EBI, Ensembl and UCSC.'
      ],
      [
        'variants',
        'Genetic variants — gnomAD frequencies and constraint, ClinVar, dbSNP, and MaveDB functional scores, mappings and experiments.'
      ],
      [
        'omics-archives',
        'Omics data archives — expression (ArrayExpress, GEO), sequencing reads (ENA), metabolomics (MetaboLights, Metabolomics Workbench), metagenomics (MGnify) and proteomics (PRIDE).'
      ],
      ['literature', 'Literature and research data via OpenAlex, arXiv, Crossref and DataCite.']
    ] as const

    for (const [id, expected] of connectorCases) {
      expect(connectorDescription({ id, description: fallback }, t)).toBe(expected)
    }
    expect(connectorDescription({ id: 'custom', description: fallback }, t)).toBe(fallback)

    const toolCases = [
      ['cellosaurus/search_cell_lines', 'Search cell lines by name or synonym.'],
      [
        'cellosaurus/get_cell_line',
        'Retrieve cell line identity, origin, quality records and database mappings by CVCL or RRID.'
      ],
      ['cellxgene-discover/list_collections', 'Search public CELLxGENE Discover collections.'],
      ['cellxgene-discover/get_collection', 'Retrieve collection metadata and a page of datasets.'],
      ['cellxgene-discover/list_datasets', 'Search public single-cell datasets by metadata.'],
      ['cellxgene-discover/get_dataset', 'Retrieve dataset metadata and file links.'],
      ['cellxgene-discover/list_collection_versions', 'List published collection versions.'],
      ['cellxgene-discover/get_collection_version', 'Retrieve a specific collection version.'],
      ['cellxgene-discover/list_dataset_versions', 'List published dataset versions.'],
      ['cellxgene-discover/get_dataset_version', 'Retrieve a specific dataset version.'],
      [
        'cellxgene-discover/list_dataset_files',
        'List dataset file formats, sizes and download URLs without downloading files.'
      ],
      [
        'omics-archives/workbench_search_compounds',
        'Look up Metabolomics Workbench compound structures and cross-references.'
      ],
      ['omics-archives/workbench_search_studies', 'Search Metabolomics Workbench study records.'],
      [
        'omics-archives/workbench_get_study',
        'Retrieve Metabolomics Workbench study, sample and experimental metadata.'
      ],
      ['variants/mavedb_search_score_sets', 'Search public MaveDB functional score sets.'],
      ['variants/mavedb_get_score_set', 'Retrieve MaveDB score set metadata and download links.'],
      ['variants/mavedb_download_scores', 'Download a CSV page of MaveDB variant scores.'],
      [
        'variants/mavedb_get_mapped_variants',
        'Retrieve existing MaveDB variant mappings in VRS format.'
      ],
      ['variants/mavedb_get_experiment', 'Retrieve MaveDB experiment methods and metadata.'],
      ['variants/mavedb_get_experiment_score_sets', 'List score sets in a MaveDB experiment.'],

      ['expression/bgee_species', 'List or retrieve species in the Bgee expression atlas.'],
      [
        'expression/bgee_expression_calls',
        'Retrieve Bgee expression calls for one gene and species.'
      ],
      ['expression/bgee_sparql_expression', 'Run a bounded Bgee SPARQL expression query.'],
      ['expression/bgee_download_links', 'Build official Bgee expression download links.'],
      ['cancer-models/cbioportal_get_samples', 'List cBioPortal samples in a study.'],
      ['cancer-models/cbioportal_get_patients', 'List cBioPortal patients in a study.'],
      [
        'cancer-models/cbioportal_get_clinical_data',
        'Fetch cBioPortal clinical data for selected patients or samples.'
      ],
      [
        'cancer-models/cbioportal_get_molecular_data',
        'Fetch cBioPortal molecular expression data for selected samples.'
      ],
      [
        'drug-regulatory/search_drug_adverse_events',
        'Search FAERS adverse-event reports with bounded filters.'
      ],
      [
        'drug-regulatory/count_drug_adverse_events',
        'Count matching FAERS adverse-event reports by selected buckets.'
      ],
      ['drug-regulatory/search_drug_recalls', 'Search FDA drug enforcement and recall reports.'],
      [
        'omics-archives/mgnify_get_analysis_files',
        'List result-file metadata and download URLs for an MGnify analysis.'
      ],
      [
        'pathway-commons/pathway_commons_search',
        'Search Pathway Commons pathways, genes, and proteins.'
      ],
      [
        'pathway-commons/pathway_commons_top_pathways',
        'Find top-level Pathway Commons pathways with optional filters.'
      ],
      [
        'pathway-commons/pathway_commons_graph',
        'Query Pathway Commons gene neighborhoods and network paths.'
      ],
      [
        'pathway-commons/pathway_commons_export',
        'Export Pathway Commons entities in BioPAX, GSEA, SIF, TXT, SBGN, or JSON-LD.'
      ],
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
      [
        'genes/list_enrichr_libraries',
        'List Enrichr gene-set libraries and their coverage statistics for an organism.'
      ],
      ['genes/enrich_gene_set_enrichr', 'Run Enrichr enrichment for gene symbols or identifiers.'],
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
      [
        'protein-annotation/get_string_ppi_enrichment',
        'Test whether a protein set has more interactions than expected in STRING, with an optional background set.'
      ],
      ['variants/get_variant', 'Retrieve a gnomAD variant with optional population frequencies.'],
      [
        'clinical-genomics/clinpgx_search_chemicals',
        'Resolve ClinPGx drug/chemical records by ClinPGx accession id or name before querying pharmacogenomic annotations.'
      ],
      [
        'clinical-genomics/clinpgx_search_genes',
        'Resolve ClinPGx gene records by ClinPGx accession id or HGNC symbol before querying pharmacogenomic annotations.'
      ],
      [
        'clinical-genomics/clinpgx_search_summary_annotations',
        'Search ClinPGx clinical annotations linking a drug, gene, and variant. Supports CPIC-style evidence levels 1A, 1B, 2A, 2B, 3, and 4.'
      ],
      [
        'clinical-genomics/clinpgx_get_summary_annotation',
        'Retrieve one ClinPGx clinical annotation by its numeric ClinPGx record id, including linked drug, gene, variant, phenotype, and evidence level.'
      ],
      [
        'clinical-genomics/clinpgx_search_variant_annotations',
        'Search ClinPGx variant annotations by gene symbol or variant fingerprint (commonly an rsID).'
      ],
      [
        'clinical-genomics/clinpgx_search_guideline_annotations',
        'Search ClinPGx pharmacogenomic dosing guideline annotations from CPIC, DPWG, or PharmGKB/PRO.'
      ],
      [
        'clinical-genomics/clinpgx_search_drug_labels',
        'Search ClinPGx regulatory pharmacogenomic drug labels from FDA, EMA, PMDA, or Health Canada.'
      ],
      [
        'clinical-genomics/clinpgx_search_variants',
        'Resolve ClinPGx pharmacogenomic variants by dbSNP rsID or another variant symbol.'
      ],
      [
        'clinical-genomics/clinpgx_get_variant_frequency',
        'Retrieve population variant frequencies reported by ClinPGx for a variant fingerprint such as an rsID.'
      ],
      [
        'clinical-genomics/clinpgx_get_drug_gene_variant',
        'Query a pairwise ClinPGx connection between two objects (for example, a drug and a gene) using the shared connection report; provide one identifier for each object. Use summary annotations for a drug-gene-variant clinical annotation.'
      ]
    ] as const

    for (const [id, expected] of toolCases) {
      expect(connectorToolDescription(id, fallback, t)).toBe(expected)
    }
    expect(connectorToolDescription('custom/tool', fallback, t)).toBe(fallback)
  })
})
