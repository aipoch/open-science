import type { TFunction } from 'i18next'

// Generated Skill documents retain the full API contract. Settings uses concise localized copy.
export function connectorDescription(
  connector: { id: string; description: string },
  t: TFunction
): string {
  if (connector.id === 'interproscan') {
    return t('InterProScan job status and TSV result retrieval via EMBL-EBI.')
  }
  if (connector.id === 'zenodo') {
    return t('Public research records, versions and file metadata from Zenodo.')
  }
  if (connector.id === 'genes') {
    return t(
      'Gene/protein identity, ontology terms and gene-set enrichment — mygene.info, UniProt, OLS4 ontologies, GO annotations, Reactome pathways and g:Profiler.'
    )
  }
  if (connector.id === 'genomes') {
    return t(
      'Genome annotation, sequence similarity search, multiple sequence alignment and browser tracks via NCBI, EMBL-EBI, Ensembl and UCSC.'
    )
  }
  if (connector.id === 'variants') {
    return t(
      'Human genetic variants — gnomAD population frequencies/constraint, ClinVar records/search (direct NCBI), dbSNP, structural and mitochondrial variants.'
    )
  }
  if (connector.id === 'omics-archives') {
    return t(
      'Omics data archives — expression (ArrayExpress, GEO), sequencing reads (ENA), metabolomics (MetaboLights), metagenomics (MGnify) and proteomics (PRIDE).'
    )
  }
  if (connector.id === 'hmmer') {
    return t('HMMER protein-family scans and remote-homology searches via EMBL-EBI.')
  }
  if (connector.id === 'clinical-genomics') {
    return t(
      'Clinical genomics knowledge bases: ClinGen curations, CIViC clinical evidence, the Open Targets Platform, and ClinPGx pharmacogenomics.'
    )
  }
  return connector.id === 'literature'
    ? t('Literature and research data via OpenAlex, arXiv, Crossref and DataCite.')
    : connector.description
}

export function connectorToolDescription(id: string, fallback: string, t: TFunction): string {
  switch (id) {
    case 'interproscan/status':
      return t('Check an InterProScan job once. Wait at least 10 seconds between checks.')
    case 'interproscan/results':
      return t(
        'Retrieve the complete TSV report for a finished InterProScan job. Results expire at the service.'
      )
    case 'hmmer/search':
      return t('Submit an asynchronous HMMER3 search and retain the returned job ID.')
    case 'hmmer/status':
      return t('Check one HMMER job without polling or resubmitting.')
    case 'hmmer/results':
      return t(
        'Retrieve HMMER results after the job succeeds; results may be paginated or contain jackhmmer iterations.'
      )

    case 'zenodo/search_records':
      return t('Search public Zenodo records, one page at a time.')
    case 'zenodo/get_record':
      return t('Retrieve Zenodo record metadata and file links. Files are not downloaded.')
    case 'genomes/clustalo_submit':
      return t(
        'Submit three or more protein, DNA or RNA sequences to Clustal Omega for asynchronous multiple sequence alignment.'
      )
    case 'genomes/clustalo_status':
      return t('Check a Clustal Omega job once. Wait at least 10 seconds between checks.')
    case 'genomes/clustalo_results':
      return t(
        'Retrieve the alignment file for a finished Clustal Omega job. Results expire at the service.'
      )
    case 'rna/search_sequence':
      return t(
        'Search RNA/DNA against Rfam models. Cancelling stops polling; the service retains results for one week.'
      )
    case 'literature/crossref_get_work':
      return t('Retrieve publisher-deposited bibliographic metadata by DOI.')
    case 'literature/crossref_get_updates':
      return t(
        'Find deposited corrections and retractions. Missing updates do not establish reliability.'
      )
    case 'literature/datacite_search_records':
      return t('Find datasets and software by topic or related DOI.')
    case 'literature/datacite_get_record':
      return t('Retrieve dataset metadata, rights and publication relationships by DOI.')
    case 'genes/search_uniprot_entries':
      return t('Discover UniProt proteins with cursor pagination.')
    case 'genes/submit_uniprot_id_mapping':
      return t('Submit an asynchronous UniProt identifier mapping job.')
    case 'genes/get_uniprot_id_mapping_status':
      return t('Check the status of a UniProt identifier mapping job.')
    case 'genes/get_uniprot_id_mapping_results':
      return t('Retrieve a page of UniProt identifier mapping results.')
    case 'genes/list_enrichment_sources':
      return t('List available g:Profiler enrichment sources for an organism.')
    case 'genes/enrich_gene_set':
      return t('Run g:Profiler gene-set enrichment with multiple-testing correction.')
    case 'omics-archives/ena_query_runs':
      return t('Discover ENA sequencing runs with metadata filters.')
    case 'omics-archives/ena_get_submitted_files':
      return t('List submitted files for an ENA run without downloading them.')
    case 'omics-archives/ena_search_runs':
      return t('Find ENA runs by accession or study.')
    case 'omics-archives/ena_get_run_files':
      return t('List FASTQ files for an ENA run without downloading them.')
    case 'omics-archives/pride_get_project_files':
      return t('List one page of public PRIDE project files without downloading them.')
    case 'genomes/blast_submit':
      return t('Submit an asynchronous NCBI BLAST sequence search.')
    case 'genomes/blast_status':
      return t('Check the status of an NCBI BLAST search.')
    case 'genomes/blast_results':
      return t('Retrieve results for a finished NCBI BLAST search.')
    case 'genomes/ncbi_resolve_taxon':
      return t('Resolve a species or taxon name to NCBI Taxonomy identifiers.')
    case 'genomes/ncbi_get_assembly_info':
      return t('Retrieve exact identity and paired accessions for an NCBI genome assembly.')
    case 'genomes/ncbi_get_sequence_aliases':
      return t('List sequence names and UCSC, RefSeq and GenBank aliases for an NCBI assembly.')
    case 'genomes/ucsc_conservation':
      return t('Summarize UCSC conservation scores for a genomic region.')
    case 'protein-annotation/get_string_ppi_enrichment':
      return t(
        'Test whether a protein set has more interactions than expected in STRING, with an optional background set.'
      )
    case 'variants/get_variant':
      return t('Retrieve a gnomAD variant with optional population frequencies.')
    case 'clinical-genomics/clinpgx_search_chemicals':
      return t(
        'Resolve ClinPGx drug/chemical records by ClinPGx accession id or name before querying pharmacogenomic annotations.'
      )
    case 'clinical-genomics/clinpgx_search_genes':
      return t(
        'Resolve ClinPGx gene records by ClinPGx accession id or HGNC symbol before querying pharmacogenomic annotations.'
      )
    case 'clinical-genomics/clinpgx_search_summary_annotations':
      return t(
        'Search ClinPGx clinical annotations linking a drug, gene, and variant. Supports CPIC-style evidence levels 1A, 1B, 2A, 2B, 3, and 4.'
      )
    case 'clinical-genomics/clinpgx_get_summary_annotation':
      return t(
        'Retrieve one ClinPGx clinical annotation by its numeric ClinPGx record id, including linked drug, gene, variant, phenotype, and evidence level.'
      )
    case 'clinical-genomics/clinpgx_search_variant_annotations':
      return t(
        'Search ClinPGx variant annotations by gene symbol or variant fingerprint (commonly an rsID).'
      )
    case 'clinical-genomics/clinpgx_search_guideline_annotations':
      return t(
        'Search ClinPGx pharmacogenomic dosing guideline annotations from CPIC, DPWG, or PharmGKB/PRO.'
      )
    case 'clinical-genomics/clinpgx_search_drug_labels':
      return t(
        'Search ClinPGx regulatory pharmacogenomic drug labels from FDA, EMA, PMDA, or Health Canada.'
      )
    case 'clinical-genomics/clinpgx_search_variants':
      return t('Resolve ClinPGx pharmacogenomic variants by dbSNP rsID or another variant symbol.')
    case 'clinical-genomics/clinpgx_get_variant_frequency':
      return t(
        'Retrieve population variant frequencies reported by ClinPGx for a variant fingerprint such as an rsID.'
      )
    case 'clinical-genomics/clinpgx_get_drug_gene_variant':
      return t(
        'Query a pairwise ClinPGx connection between two objects (for example, a drug and a gene) using the shared connection report; provide one identifier for each object. Use summary annotations for a drug-gene-variant clinical annotation.'
      )
    default:
      return fallback
  }
}
