import type { TFunction } from 'i18next'

// Generated Skill documents retain the full API contract. Settings uses concise localized copy.
export function connectorDescription(
  connector: { id: string; description: string; sources?: string[] },
  t: TFunction
): string {
  if (connector.id === 'iedb') {
    return t(
      'Immune epitopes, T/B cell and MHC assays, antigens and literature evidence from IEDB.'
    )
  }
  if (connector.id === 'cellosaurus') {
    return t(
      'Cell line identity, origin, diseases, quality records and database mappings from Cellosaurus.'
    )
  }
  if (connector.id === 'monarch') {
    return t(
      'Disease and gene phenotype associations with evidence sources via Monarch Initiative.'
    )
  }
  if (connector.id === 'cellxgene-discover') {
    return t(
      'Public collections, datasets, versions and file download links from CELLxGENE Discover.'
    )
  }
  if (connector.id === 'interproscan') {
    return t(
      'InterProScan protein sequence submission, job status and TSV result retrieval via EMBL-EBI.'
    )
  }
  if (connector.id === 'zenodo') {
    return t('Public research records, versions and file metadata from Zenodo.')
  }
  if (connector.id === 'genes') {
    return t(
      'Gene/protein identity, ontology terms and gene-set enrichment — mygene.info, UniProt, OLS4 ontologies, GO annotations, Reactome pathways, g:Profiler and Enrichr.'
    )
  }
  if (connector.id === 'genomes') {
    return t(
      'Genome annotation, sequence similarity search, multiple sequence alignment and browser tracks via NCBI, EMBL-EBI, Ensembl and UCSC.'
    )
  }
  if (connector.id === 'variants') {
    return t(
      'Genetic variants — gnomAD frequencies and constraint, ClinVar, dbSNP, and MaveDB functional scores, mappings and experiments.'
    )
  }
  if (connector.id === 'omics-archives') {
    return t(
      'Omics data archives — expression (ArrayExpress, GEO), sequencing reads (ENA), metabolomics (MetaboLights, Metabolomics Workbench), metagenomics (MGnify) and proteomics (PRIDE).'
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
    : connector.sources?.length
      ? t('Research data from {{sources}}.', { sources: connector.sources.join(', ') })
      : connector.description
}

export function connectorToolDescription(id: string, fallback: string, t: TFunction): string {
  switch (id) {
    case 'human-genetics/gwas_get_summary_statistics':
      return t(
        'List GWAS summary statistics files, YAML metadata, reference genomes and standard column definitions by GCST accession.'
      )
    case 'iedb/search_epitopes':
      return t('Search immune epitopes by sequence, host, antigen and MHC.')
    case 'iedb/search_antigens':
      return t('Search epitope source antigens and UniProt references.')
    case 'iedb/search_tcell_assays':
      return t('Retrieve T cell experiments, measurements and literature evidence.')
    case 'iedb/search_bcell_assays':
      return t('Retrieve B cell experiments, measurements and literature evidence.')
    case 'iedb/search_mhc_assays':
      return t('Retrieve MHC binding and ligand elution experiments with methods and units.')
    case 'iedb/search_references':
      return t('Find IEDB references and PubMed identifiers for experimental evidence.')
    case 'cellosaurus/search_cell_lines':
      return t('Search cell lines by name or synonym.')
    case 'cellosaurus/get_cell_line':
      return t(
        'Retrieve cell line identity, origin, quality records and database mappings by CVCL or RRID.'
      )

    case 'structures/pdb_search_sequence':
      return t(
        'Search experimental PDB structures by protein sequence, sequence identity and query coverage; return entities, chains and alignment details.'
      )
    case 'monarch/monarch_get_disease_phenotypes':
      return t('Retrieve disease–phenotype associations with evidence sources and relation types.')
    case 'monarch/monarch_get_gene_phenotypes':
      return t('Retrieve gene–phenotype associations with evidence sources and relation types.')
    case 'cellxgene-discover/list_collections':
      return t('Search public CELLxGENE Discover collections.')
    case 'cellxgene-discover/get_collection':
      return t('Retrieve collection metadata and a page of datasets.')
    case 'cellxgene-discover/list_datasets':
      return t('Search public single-cell datasets by metadata.')
    case 'cellxgene-discover/get_dataset':
      return t('Retrieve dataset metadata and file links.')
    case 'cellxgene-discover/list_collection_versions':
      return t('List published collection versions.')
    case 'cellxgene-discover/get_collection_version':
      return t('Retrieve a specific collection version.')
    case 'cellxgene-discover/list_dataset_versions':
      return t('List published dataset versions.')
    case 'cellxgene-discover/get_dataset_version':
      return t('Retrieve a specific dataset version.')
    case 'cellxgene-discover/list_dataset_files':
      return t('List dataset file formats, sizes and download URLs without downloading files.')
    case 'variants/mavedb_search_score_sets':
      return t('Search public MaveDB functional score sets.')
    case 'variants/mavedb_get_score_set':
      return t('Retrieve MaveDB score set metadata and download links.')
    case 'variants/mavedb_download_scores':
      return t('Download a CSV page of MaveDB variant scores.')
    case 'variants/mavedb_get_mapped_variants':
      return t('Retrieve existing MaveDB variant mappings in VRS format.')
    case 'variants/mavedb_get_experiment':
      return t('Retrieve MaveDB experiment methods and metadata.')
    case 'variants/mavedb_get_experiment_score_sets':
      return t('List score sets in a MaveDB experiment.')

    case 'expression/bgee_species':
      return t('List or retrieve species in the Bgee expression atlas.')
    case 'expression/bgee_expression_calls':
      return t('Retrieve Bgee expression calls for one gene and species.')
    case 'expression/bgee_sparql_expression':
      return t('Run a bounded Bgee SPARQL expression query.')
    case 'expression/bgee_download_links':
      return t('Build official Bgee expression download links.')
    case 'cancer-models/cbioportal_get_samples':
      return t('List cBioPortal samples in a study.')
    case 'cancer-models/cbioportal_get_patients':
      return t('List cBioPortal patients in a study.')
    case 'cancer-models/cbioportal_get_clinical_data':
      return t('Fetch cBioPortal clinical data for selected patients or samples.')
    case 'cancer-models/cbioportal_get_molecular_data':
      return t('Fetch cBioPortal molecular expression data for selected samples.')
    case 'drug-regulatory/search_drug_adverse_events':
      return t('Search FAERS adverse-event reports with bounded filters.')
    case 'drug-regulatory/count_drug_adverse_events':
      return t('Count matching FAERS adverse-event reports by selected buckets.')
    case 'drug-regulatory/search_drug_recalls':
      return t('Search FDA drug enforcement and recall reports.')
    case 'omics-archives/mgnify_get_analysis_files':
      return t('List result-file metadata and download URLs for an MGnify analysis.')
    case 'pathway-commons/pathway_commons_search':
      return t('Search Pathway Commons pathways, genes, and proteins.')
    case 'pathway-commons/pathway_commons_top_pathways':
      return t('Find top-level Pathway Commons pathways with optional filters.')
    case 'pathway-commons/pathway_commons_graph':
      return t('Query Pathway Commons gene neighborhoods and network paths.')
    case 'pathway-commons/pathway_commons_export':
      return t('Export Pathway Commons entities in BioPAX, GSEA, SIF, TXT, SBGN, or JSON-LD.')
    case 'interproscan/submit':
      return t('Submit protein sequences to InterProScan and retain the returned job ID.')
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

    case 'alliance/alliance_get_gene':
      return t('Retrieve an Alliance gene summary and genomic location.')
    case 'alliance/alliance_search_genes':
      return t('Search Alliance genes by symbol, name or identifier.')
    case 'alliance/alliance_get_gene_orthologs':
      return t('Retrieve cross-species orthologs and prediction methods.')
    case 'alliance/alliance_get_gene_disease_models':
      return t('Retrieve disease models associated with an Alliance gene.')
    case 'alliance/alliance_get_gene_phenotypes':
      return t('Retrieve phenotype annotations for an Alliance gene.')
    case 'alliance/alliance_get_gene_alleles':
      return t('Retrieve alleles and variants associated with an Alliance gene.')
    case 'alliance/alliance_get_gene_expression':
      return t('Retrieve anatomical and developmental expression annotations.')
    case 'alliance/alliance_get_disease_genes':
      return t('Retrieve genes associated with a Disease Ontology term.')

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
    case 'genes/list_enrichr_libraries':
      return t('List Enrichr gene-set libraries and their coverage statistics for an organism.')
    case 'genes/enrich_gene_set_enrichr':
      return t('Run Enrichr enrichment for gene symbols or identifiers.')
    case 'omics-archives/geo_get_series':
      return t('Retrieve GEO series metadata, samples and supplementary-file links.')
    case 'omics-archives/geo_get_matrix_files':
      return t('Find GEO Series Matrix and NCBI RNA-seq count file links for manual download.')
    case 'omics-archives/geo_preflight_matrix':
      return t(
        'Check decompressed GEO matrix structure, dimensions and sample alignment before analysis.'
      )
    case 'omics-archives/workbench_search_compounds':
      return t('Look up Metabolomics Workbench compound structures and cross-references.')
    case 'omics-archives/workbench_search_studies':
      return t('Search Metabolomics Workbench study records.')
    case 'omics-archives/workbench_get_study':
      return t('Retrieve Metabolomics Workbench study, sample and experimental metadata.')
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
