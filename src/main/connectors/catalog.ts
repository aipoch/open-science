import type { ConnectorGroup } from '../../shared/settings'

export type ConnectorMeta = {
  id: string
  displayName: string
  // User-facing/source aliases used by the bridge's deterministic per-turn router.
  aliases?: string[]
  description: string
  // Trigger-style summary ("Use when …") that drives automatic skill discovery — the agent matches a
  // plain user question against this without the user naming the connector. Keep it query-oriented.
  useWhen: string
  sources: string[]
  termsUrl?: string
  requiresNcbi: boolean
  // Settings-list section. Absent = "featured" (Anthropic research connectors); "directory" connectors
  // mirror entries in the Claude Connectors Directory.
  group?: ConnectorGroup
}

// Static connector metadata for the settings UI (tool lists come from the registry).
export const CONNECTOR_CATALOG: ConnectorMeta[] = [
  {
    id: 'iedb',
    displayName: 'IEDB',
    aliases: ['Immune Epitope Database', 'immune epitopes', 'immunology assays'],
    description:
      'Immune epitopes, T/B cell and MHC assays, antigens and literature evidence from IEDB.',
    useWhen:
      'Use for experimental immunology evidence in the Immune Epitope Database (IEDB): search epitopes, T cell responses, B cell antibody assays, MHC binding and ligand elution experiments, host species, antigen sources and references. Preserve methods, quantitative measurements, units, inequalities and negative results. These are database observations, not predictions. Parent UniProt antigens can differ from the curated antigen sequence. Follow explicit UniProt accessions through Genes & Ontologies and PDB identifiers through Structures & Interactions; follow PMIDs through PubMed. Public read-only IQ-API; no credentials required.',
    sources: ['IEDB'],
    termsUrl: 'https://www.iedb.org/',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'monarch',
    displayName: 'Monarch Initiative',
    aliases: ['Monarch', 'phenotype evidence', 'disease phenotype associations'],
    description:
      'Disease and gene phenotype associations with evidence sources via Monarch Initiative.',
    useWhen:
      'Use to query disease–phenotype or gene–phenotype associations for Monarch canonical CURIEs and inspect relation types, evidence codes, publications, provenance, negation and qualifiers. Source database IDs and aliases are not automatically converted; a zero total means no match for the supplied identifier and filters, not absence of phenotype evidence. Direct identifier matching is the default, not a claim of experimental evidence; inspect knowledge_level and agent_type. Resolve ontology terms with OLS in Genes & Ontologies and use Alliance for model-organism gene summaries, orthology and annotations. This read-only public API requires no authentication.',
    sources: ['Monarch Initiative'],
    termsUrl: 'https://monarch-app.monarchinitiative.org/Licensing/',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'alliance',
    displayName: 'Alliance Genome Resources',
    aliases: ['Alliance', 'AGR', 'model organism genes', 'model organism genomics'],
    description:
      'Model-organism and human gene knowledge via the Alliance of Genome Resources — gene summaries, orthology, disease models, phenotypes, alleles and expression.',
    useWhen:
      'Use when you need cross-species model-organism gene knowledge from the Alliance of Genome Resources — search or summarize genes from human, mouse, rat, fly, worm, zebrafish, yeast and frog; retrieve orthologs, disease models, phenotype annotations, alleles/variants, or developmental and anatomical expression; or find genes associated with a Disease Ontology term. The public API is read-only and does not require authentication.',
    sources: ['Alliance of Genome Resources'],
    termsUrl: 'https://www.alliancegenome.org/terms-of-use',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'chemistry',
    displayName: 'Chemistry',
    description: 'Small-molecule chemistry via PubChem, ChEBI, Rhea and BindingDB.',
    useWhen:
      'Use when a question needs authoritative small-molecule chemistry data — PubChem compound properties (formula, weight, SMILES/InChI, IUPAC name), CID resolution and 2D similarity search, bioassay and GHS safety summaries; ChEBI ontology entities, roles and relations; Rhea enzyme reactions (by ChEBI participant, EC number, or equation text); or BindingDB binding affinities (Ki/Kd/IC50/EC50) by protein target or compound. Sourced from PubChem, ChEBI, Rhea and BindingDB.',
    sources: ['PubChem', 'ChEBI', 'Rhea', 'BindingDB'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
    requiresNcbi: false
  },
  {
    id: 'literature',
    displayName: 'Literature Graph',
    description: 'Literature and research data via OpenAlex, arXiv, Crossref and DataCite.',
    useWhen:
      'Use when exploring the scholarly literature graph — searching works/papers by topic with citation counts and authors, following a work’s citations or references, looking up authors (ORCID, h-index, institution) or a venue/journal, searching arXiv preprints, checking Crossref bibliographic metadata and deposited corrections/retractions, or discovering DataCite datasets/software and their publication relationships. Sourced from OpenAlex, arXiv, Crossref and DataCite.',
    sources: ['OpenAlex', 'arXiv', 'Crossref', 'DataCite'],
    termsUrl: 'https://docs.openalex.org/additional-help/terms',
    requiresNcbi: false
  },
  {
    id: 'molecule',
    displayName: 'Molecule Viewer',
    description:
      'Validate and preview 2D molecular structures and reactions (OpenChemLib). Backs the .mol/.sdf/.smi/.smiles/.rxn artifact viewer.',
    useWhen:
      'Use when the user provides or wants to inspect a chemical structure — validating or normalizing a SMILES or MDL molfile, computing a molecular formula / weight / heavy-atom count, or turning a structure into a previewable 2D depiction. The paired viewer also renders MDL reaction (.rxn) files. Self-contained: pass a SMILES or molfile directly, no other connector required. Sourced from OpenChemLib (offline, in-app).',
    sources: ['OpenChemLib'],
    requiresNcbi: false
  },
  {
    id: 'pubmed',
    displayName: 'PubMed',
    aliases: ['NCBI literature', 'PMC', 'Europe PMC'],
    description:
      'Biomedical literature via NCBI E-utilities, the PMC ID Converter and Europe PMC — search, metadata, related articles, citation lookup, ID conversion, full text and copyright.',
    useWhen:
      'Use to search the biomedical literature and retrieve article metadata (authors, abstract, DOIs, MeSH), find related/similar articles, resolve citations to PMIDs, convert between PMID/PMCID/DOI, fetch open-access full text from PubMed Central, or check copyright/license status. Sourced from PubMed (NCBI), PMC and Europe PMC.',
    sources: ['PubMed', 'PMC', 'Europe PMC'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
    requiresNcbi: true,
    group: 'directory'
  },
  {
    id: 'genes',
    displayName: 'Genes & Ontologies',
    aliases: ['MyGene', 'mygene.info', 'UniProt', 'gene information', 'gene annotation'],
    description:
      'Gene/protein identity, ontology terms and gene-set enrichment — mygene.info, UniProt, OLS4 ontologies, GO annotations, Reactome pathways, g:Profiler and Enrichr.',
    useWhen:
      'Use when you need to resolve gene symbols/identifiers (mygene.info), discover UniProt proteins by gene name, protein name or organism with optional reviewed status and cursor pagination, fetch UniProt records or sequences by accession, submit batch UniProt ID mapping jobs and check status or page through mapping pairs and unmatched IDs, look up or search ontology terms (EFO, GO, CL, ChEBI, MONDO via OLS4), retrieve GO annotations for a protein (QuickGO), map genes to Reactome pathways, run cross-database GO/pathway enrichment with an explicit organism, background gene set and multiple-testing correction, or query Enrichr libraries for transcription-factor, perturbation, drug, disease, tissue and cell-type enrichment.',
    sources: ['MyGene', 'UniProt', 'OLS', 'QuickGO', 'Reactome', 'g:Profiler', 'Enrichr'],
    termsUrl: 'https://www.uniprot.org/help/license',
    requiresNcbi: false
  },
  {
    id: 'pathway-commons',
    displayName: 'Pathway Commons',
    aliases: ['Pathway Commons', 'PC2', 'BioPAX pathways', 'pathway network'],
    description:
      'Integrated pathway and molecular interaction network queries via the Pathway Commons PC2 v14 REST API, including Reactome-filtered pathways, gene neighborhoods, paths between gene sets, and BioPAX/GSEA/SIF exports.',
    useWhen:
      'Use for Pathway Commons BioPAX discovery and network analysis — search pathways, genes, proteins, and interactions; find top-level pathways; query a gene neighborhood, paths between source genes, directed paths from source to target genes, or common streams; and export pathway subsets as BioPAX, JSON-LD, GSEA GMT, SIF, TXT, or SBGN. Use datasource filters such as Reactome when a cross-source pathway view is needed; use the Protein Annotation connector for STRING-specific networks.',
    sources: ['Pathway Commons', 'Reactome'],
    termsUrl: 'https://www.pathwaycommons.org/pc2/',
    requiresNcbi: false
  },
  {
    id: 'genomes',
    displayName: 'Genomes',
    description:
      'Genome annotation, taxon and assembly identity, sequence aliases, variants, homology, sequence, similarity search, multiple sequence alignment and browser tracks — NCBI Datasets/BLAST, EMBL-EBI Clustal Omega, Ensembl REST and the UCSC Genome Browser.',
    useWhen:
      'Use when you need to resolve species or taxon names, validate a versioned NCBI genome assembly and sequence aliases, identify an unknown nucleotide or protein sequence with an asynchronous NCBI BLAST search, align three or more uniquely named FASTA protein/DNA/RNA records with EMBL-EBI Clustal Omega and retrieve a downloadable alignment file, retrieve Ensembl gene/transcript annotation, cross-references, VEP variant consequences, orthologues/paralogues, sequence, or region overlaps — or UCSC Genome Browser tracks, track data, conservation scores, TFBS clusters and chromosome sizes.',
    sources: ['NCBI Datasets', 'NCBI BLAST', 'EMBL-EBI Job Dispatcher', 'Ensembl', 'UCSC'],
    termsUrl: 'https://www.ensembl.org/info/about/legal/disclaimer.html',
    requiresNcbi: false
  },
  {
    id: 'variants',
    displayName: 'Variants',
    aliases: ['gnomAD', 'ClinVar', 'dbSNP', 'MaveDB', 'MAVE', 'genetic variant'],
    description:
      'Genetic variants — gnomAD frequencies and constraint, ClinVar, dbSNP, and MaveDB functional scores, mappings and experiments.',
    useWhen:
      'Use when you need genetic-variant data — gnomAD population allele frequencies, gene constraint (pLI/LOEUF), structural or mitochondrial variants, and build liftover; ClinVar clinical significance (gnomAD mirror or direct NCBI search/records by accession or rsID); dbSNP RefSNP records and region lookups; or MaveDB multiplexed assays of variant effect (MAVE), score set search and metadata, CSV functional scores, existing GA4GH VRS variant mappings, and experiments. MaveDB public data needs no API key or contact email; functional scores are assay-specific, not clinical classifications.',
    sources: ['gnomAD', 'ClinVar', 'dbSNP', 'MaveDB'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/clinvar/docs/maintenance_use/',
    requiresNcbi: true
  },
  {
    id: 'clinical-trials',
    displayName: 'Clinical Trials',
    description:
      'Clinical trials from ClinicalTrials.gov — search, details, sponsors, investigators, endpoints, and eligibility.',
    useWhen:
      'Use for ClinicalTrials.gov: search trials by condition/intervention/sponsor/location/status/phase, fetch full details by NCT id, find trials by sponsor, discover investigators and sites, analyze trial endpoints, or match patients by eligibility.',
    sources: ['ClinicalTrials.gov'],
    termsUrl: 'https://clinicaltrials.gov/about-site/terms-conditions',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'clinical-genomics',
    displayName: 'Clinical Genomics',
    aliases: ['ClinGen', 'CIViC', 'Open Targets', 'ClinPGx', 'pharmacogenomics'],
    description:
      'Clinical genomics knowledge bases: ClinGen curations, CIViC clinical evidence, the Open Targets Platform, and ClinPGx pharmacogenomics.',
    useWhen:
      "Use when you need clinical interpretation of genes, variants, or pharmacogenomics — ClinGen gene-disease validity, dosage sensitivity, clinical actionability, and expert-panel (VCEP) variant pathogenicity classifications; CIViC clinical evidence, assertions, molecular profiles, diseases, and therapies for a gene or variant in cancer; Open Targets target-disease association scores, a disease's known drugs/associated targets, a drug's mechanism of action, and arbitrary Open Targets GraphQL; or ClinPGx drug-gene-variant clinical annotations, dosing guidelines, regulatory labels, variant frequencies, and evidence levels. Sourced from ClinGen, CIViC, the Open Targets Platform, and ClinPGx.",
    sources: ['ClinGen', 'CIViC', 'Open Targets', 'ClinPGx'],
    termsUrl: 'https://platform-docs.opentargets.org/licence',
    requiresNcbi: false
  },
  {
    id: 'structures',
    displayName: 'Structures & Interactions',
    description:
      'Structures and molecular interactions — PDB structures, AlphaFold predictions, EMDB cryo-EM entries, Complex Portal complexes, IntAct interaction networks.',
    useWhen:
      'Use when you need a macromolecular 3D structure or a molecular interaction — experimental PDB entries (search, summaries, polymer entities, ligands), AlphaFold predicted models, EMDB cryo-EM metadata/validation, curated Complex Portal complexes, or IntAct binary interactions and networks.',
    sources: ['PDB', 'AlphaFold', 'EMDB', 'Complex Portal', 'IntAct'],
    termsUrl: 'https://www.rcsb.org/pages/usage-policy',
    requiresNcbi: false
  },
  {
    id: 'chembl',
    displayName: 'ChEMBL',
    description:
      'Bioactive compounds, drugs, targets, bioactivity, and mechanisms via the ChEMBL REST API.',
    useWhen:
      'Use for ChEMBL medicinal-chemistry data — search compounds by name, ChEMBL id, or molecular structure (similarity/substructure); find drugs by therapeutic indication with approval and withdrawal flags; get calculated ADMET / drug-likeness properties for a molecule; retrieve bioactivity measurements (IC50, Ki, EC50, pChEMBL) for compound-target pairs; look up mechanism of action; or search biological targets by gene symbol, name, organism, or type. Sourced from ChEMBL (EBI).',
    sources: ['ChEMBL'],
    termsUrl: 'https://chembl.gitbook.io/chembl-interface-documentation/about',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'biorxiv',
    displayName: 'bioRxiv',
    description:
      'bioRxiv/medRxiv preprints — search by date/category, metadata by DOI, journal-publication links, funder listings, and platform statistics.',
    useWhen:
      'Use when working with bioRxiv or medRxiv preprints — searching by date range and category (no keyword search), fetching full metadata for a DOI, finding which preprints were published in journals (optionally by publisher DOI prefix), listing preprints by funder (ROR id), or reporting submission/usage statistics over time. Sourced from bioRxiv and medRxiv (funder ids via ROR).',
    sources: ['bioRxiv', 'medRxiv', 'ROR'],
    termsUrl: 'https://www.biorxiv.org/about/FAQ',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'drug-regulatory',
    displayName: 'Drug Regulatory',
    description: 'Drugs@FDA applications, labels, and corpus statistics via openFDA.',
    useWhen:
      'Use when you need FDA drug regulatory and safety data — searching or fetching Drugs@FDA applications (NDA/ANDA/BLA) by brand, generic, ingredient, sponsor, marketing status, or pharmacologic class; aggregate/corpus statistics; generic equivalents of a brand; product label (SPL) sections such as indications and boxed warnings; FAERS adverse-event reports and reaction/drug aggregations; or drug product enforcement and recall reports. Sourced from openFDA (Drugs@FDA, drug labels, drug events and drug enforcement).',
    sources: ['openFDA'],
    termsUrl: 'https://open.fda.gov/terms/',
    requiresNcbi: false
  },
  {
    id: 'human-genetics',
    displayName: 'Human Genetics',
    description:
      'Human genetic association evidence — GWAS Catalog, eQTL Catalogue, and PheWeb PheWAS portals (FinnGen, BioBank Japan).',
    useWhen:
      'Use when you need human genetic-association evidence — GWAS Catalog associations/studies/traits for a variant, gene or trait; eQTL Catalogue molecular-QTL datasets and associations; or PheWAS scans (variant- or gene-level) from FinnGen and BioBank Japan PheWeb portals.',
    sources: ['GWAS Catalog', 'eQTL Catalogue', 'PheWeb'],
    termsUrl: 'https://www.ebi.ac.uk/gwas/docs/about',
    requiresNcbi: false
  },
  {
    id: 'expression',
    displayName: 'Expression',
    aliases: ['Bgee', 'Bgee expression', 'cross-species expression', 'normal tissue expression'],
    description: 'Human and cross-species normal tissue expression via GTEx and Bgee.',
    useWhen:
      'Use for tissue expression and eQTL evidence — GTEx tissue sites, dataset releases, versioned GENCODE resolution, median or per-sample TPM, top-expressed genes, donor metadata, and cis-eQTLs; or Bgee healthy wild-type expression across animal species, present/absent calls and scores for a gene, bounded SPARQL lookup constrained by gene/species/tissue, and official expression-call or processed-value download links. Sourced from GTEx and Bgee.',
    sources: ['GTEx', 'Bgee'],
    termsUrl: 'https://www.bgee.org/about/terms-and-conditions',
    requiresNcbi: false
  },
  {
    id: 'hmmer',
    displayName: 'HMMER',
    aliases: ['HMMER3', 'phmmer', 'hmmscan', 'hmmsearch', 'jackhmmer', 'profile HMM'],
    description: 'Protein family and remote-homology searches via the EMBL-EBI HMMER3 service.',
    useWhen:
      'Use when you need profile-HMM protein-family scans, sequence-versus-sequence homology searches, or iterative remote-homolog discovery through phmmer, hmmscan, hmmsearch, or jackhmmer. It complements BLAST for protein-family and distant-homology analysis and overlaps with InterProScan for domain-family discovery. Jobs run asynchronously on EMBL-EBI: submit a search, retain its job_id, then check status and retrieve results.',
    sources: ['HMMER3', 'EMBL-EBI'],
    termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
    requiresNcbi: false
  },
  {
    id: 'interproscan',
    displayName: 'InterProScan',
    aliases: ['InterProScan 5', 'iprscan5'],
    description: 'InterProScan job status and TSV result retrieval via EMBL-EBI.',
    useWhen:
      'Use when you already have an EMBL-EBI InterProScan job_id and need to check its status or retrieve its finished TSV matches. This connector does not create or cancel jobs. For precomputed annotations of known UniProt accessions, use Protein Annotation instead.',
    sources: ['InterProScan', 'EMBL-EBI'],
    termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
    requiresNcbi: false
  },
  {
    id: 'protein-annotation',
    displayName: 'Protein Annotation',
    description:
      'Protein domain architecture, family/clan membership, expression atlas and interaction networks via InterPro/Pfam, the Human Protein Atlas and STRING.',
    useWhen:
      "Use when you need protein annotation — a protein's complete InterPro/Pfam domain architecture, entry/family/clan search and detail, member proteins or proteomes of a Pfam family, Human Protein Atlas per-gene expression (tissue/subcellular/pathology/blood/brain) and bulk search, or STRING id mapping, interaction networks and homology similarity. Sourced from InterPro, Pfam, the Human Protein Atlas and STRING.",
    sources: ['InterPro', 'Pfam', 'Human Protein Atlas', 'STRING'],
    termsUrl: 'https://string-db.org/cgi/access?footer_active_subpage=licensing',
    requiresNcbi: false
  },
  {
    id: 'cancer-models',
    displayName: 'Cancer Models',
    description: 'Cancer genomics study records via the cBioPortal REST API.',
    useWhen:
      "Use when you need cancer genomics data from cBioPortal — listing or looking up cancer studies, samples and patients; retrieving patient/sample clinical values; fetching mRNA expression values for genes; the mutations of a gene in a study (recurrent protein changes, mutation types), a gene's mutation frequency across several studies, discrete copy-number alterations (deletions/amplifications) of a gene, or a study's clinical attributes and survival endpoints.",
    sources: ['cBioPortal'],
    termsUrl: 'https://www.cbioportal.org/faq',
    requiresNcbi: false
  },
  {
    id: 'gdc',
    displayName: 'GDC',
    description: 'Cancer project, case and file inventories via the Genomic Data Commons API.',
    useWhen:
      'Use when you need GDC project, case or file metadata and data inventories — including project summaries, case identifiers, file formats, checksums, access classification and Data Transfer Tool manifests. GDC file discovery distinguishes open-access files from controlled-access files; controlled data requires the user’s GDC authorization, so finding a file or creating a manifest does not guarantee that it can be downloaded. No file bytes are downloaded by this connector.',
    sources: ['Genomic Data Commons (GDC)'],
    termsUrl: 'https://docs.gdc.cancer.gov/API/Users_Guide/Getting_Started/',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'rna',
    displayName: 'RNA',
    description: 'Non-coding RNA family data (metadata, alignments, models, structures) via Rfam.',
    useWhen:
      'Use for non-coding RNA families from Rfam (accession or family id, e.g. RF00005 / tRNA): family metadata (RNA type, seed/full counts, gathering/trusted/noise cutoffs, clan); the seed alignment (Stockholm or FASTA); the Infernal covariance model; the seed phylogenetic tree; full-region hits across sequence databases; PDB structure mappings; accession<->id conversion; and single-sequence cmscan search against all Rfam models.',
    sources: ['Rfam'],
    termsUrl: 'https://docs.rfam.org/en/latest/',
    requiresNcbi: false
  },
  {
    id: 'omics-archives',
    displayName: 'Omics Archives',
    description:
      'Omics data archives — expression (ArrayExpress, GEO), sequencing reads (ENA), metabolomics (MetaboLights, Metabolomics Workbench), metagenomics (MGnify) and proteomics (PRIDE).',
    useWhen:
      'Use when finding or looking up omics datasets across the major archives — functional-genomics / expression experiments in ArrayExpress (BioStudies) or NCBI GEO series (by keyword, organism, assay, or accession, with per-sample metadata); metabolomics studies and data files in MetaboLights (MTBLS), or Metabolomics Workbench (ST) study records, samples, experimental factors, analysis metadata and compound structures/cross-references; metagenomics studies, analyses and downloadable result files in MGnify (MGYS, by free text or biome lineage); or proteomics projects, proteins and paged project file inventories with download locations in PRIDE Archive (PXD/PRD, by keyword/organism/instrument/disease, or protein↔project). Discover GEO Series Matrix and NCBI-generated RNA-seq count files, then preflight decompressed matrix format, dimensions and sample correspondence with geo_preflight_matrix. Discover ENA sequencing runs by taxonomy, library strategy and title/description keywords, or resolve ENA/INSDC study, experiment or sample accessions to runs. List archive-generated FASTQ URLs or original submitted file locations (including BAM/CRAM), sizes and MD5 checksums for a run; resolve GEO/ArrayExpress/MGnify IDs to linked INSDC accessions first. Sourced from ArrayExpress, GEO, ENA, MetaboLights, Metabolomics Workbench, MGnify and PRIDE.',
    sources: [
      'ArrayExpress',
      'GEO',
      'ENA',
      'MetaboLights',
      'Metabolomics Workbench',
      'MGnify',
      'PRIDE'
    ],
    termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
    requiresNcbi: true
  },
  {
    id: 'cellxgene-discover',
    displayName: 'CELLxGENE Discover',
    aliases: ['CELLxGENE Discover', 'CELLxGENE datasets'],
    description:
      'Public collections, datasets, versions and file download links from CELLxGENE Discover.',
    useWhen:
      'Use to discover public single-cell datasets and collections in CELLxGENE Discover, filter dataset metadata by organism, tissue, disease, assay or cell type, inspect published collection/dataset versions, and obtain file formats, sizes and download URLs. Canonical IDs follow the current publication; version IDs pin a published snapshot. Lists are filtered and paginated client-side. Use CellGuide for cell-type descriptions and marker genes. Census expression-matrix queries and binary downloads are not provided.',
    sources: ['CELLxGENE Discover'],
    termsUrl: 'https://cellxgene.cziscience.com/',
    requiresNcbi: false
  },
  {
    id: 'cellosaurus',
    displayName: 'Cellosaurus',
    aliases: ['Cellosaurus', 'cell line identity', 'CVCL'],
    description:
      'Cell line identity, origin, diseases, quality records and database mappings from Cellosaurus.',
    useWhen:
      'Use for laboratory cell line identity and curated quality information: search names and aliases, resolve CVCL or RRID:CVCL identifiers, inspect species/tissue origin and donor disease, known contamination or misidentification, ICLAC registrations, and external database mappings. Search returns candidates; select an accession before requesting details. No recorded problem does not certify a sample. This read-only API requires no authentication.',
    sources: ['Cellosaurus'],
    termsUrl: 'https://www.cellosaurus.org/description.html',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'cellguide',
    displayName: 'CellGuide',
    description:
      'Cell-type identity, marker genes, source datasets, and tissues via CELLxGENE CellGuide.',
    useWhen:
      'Use for cell-type biology from CELLxGENE CellGuide — searching cell types by name/synonym, or (by Cell Ontology id or name) getting identity/description, computational or canonical marker genes, contributing source datasets/publications, and the anatomical tissues a cell type is found in.',
    sources: ['CELLxGENE'],
    termsUrl: 'https://cellxgene.cziscience.com/',
    requiresNcbi: false
  },
  {
    id: 'regulation',
    displayName: 'Regulation',
    description:
      'Gene-regulation functional genomics — ENCODE experiments/biosamples/files, JASPAR TF binding profiles, and UniBind ChIP-seq TFBS.',
    useWhen:
      'Use when you need gene-regulation / functional-genomics data — ENCODE experiments (ChIP-seq, ATAC-seq, ...), biosamples and data files (complete, count-verified searches by assay/target/organism/format, or a record by accession); JASPAR transcription-factor binding profiles (PFM by versioned matrix id, version history, filtered profile catalog by species/collection, and the species/taxa/collections/releases listings); or UniBind high-confidence TF binding sites (search ChIP-seq datasets, per-model TFBS detail with BED/FASTA URLs, and TFBS overlapping a genomic region). Sourced from ENCODE, JASPAR and UniBind.',
    sources: ['ENCODE', 'JASPAR', 'UniBind'],
    termsUrl: 'https://www.encodeproject.org/about/data-use-policy/',
    requiresNcbi: false
  },
  {
    id: 'research-resources',
    displayName: 'Research Resources',
    description:
      'Funding-opportunity search (Grants.gov) and antibody catalog lookups (Antibody Registry).',
    useWhen:
      'Use when you need U.S. federal funding opportunities from Grants.gov (search by keyword, opportunity number, CFDA/ALN, agency such as NIH/NSF/FDA, status, eligibility, or funding category — complete, count-verified, with facet breakdowns) or research antibodies from the Antibody Registry (full-text search by target/name/catalog, lookup by RRID/accession, exact catalog-number matching, and registry statistics — with RRID, vendor, target, clone, and species). Sourced from Grants.gov and the Antibody Registry.',
    sources: ['Grants.gov', 'Antibody Registry'],
    termsUrl: 'https://www.antibodyregistry.org/',
    requiresNcbi: false
  },
  {
    id: 'biomart',
    displayName: 'BioMart',
    description: 'Ensembl BioMart attribute queries and identifier translation.',
    useWhen:
      'Use when you need Ensembl BioMart data — browsing the marts → datasets → attributes/filters hierarchy, running attribute queries (get_data) for a dataset with filters, or translating gene/transcript identifiers between attribute types (e.g. HGNC symbol → Ensembl gene ID).',
    sources: ['Ensembl BioMart'],
    termsUrl: 'https://www.ensembl.org/info/about/legal/disclaimer.html',
    requiresNcbi: false
  },
  {
    id: 'zinc',
    displayName: 'ZINC',
    description:
      'ZINC22 purchasable chemical space (CartBlanche22) — compound lookup by ZINC id, SMILES exact/similarity search, supplier-code resolution, random sampling, 3D structure locations for docking.',
    useWhen:
      'Use when you need purchasable small molecules from ZINC22 — look up compounds by ZINC id, search by SMILES (exact or analog/similarity), resolve vendor catalog codes, draw a random compound sample, or locate docking-ready 3D structures. Sourced from ZINC22 / CartBlanche22.',
    sources: ['ZINC'],
    termsUrl: 'https://zinc.docking.org/',
    requiresNcbi: false
  },
  {
    id: 'zenodo',
    displayName: 'Zenodo',
    description: 'Public research records, versions and file metadata from Zenodo.',
    useWhen:
      'Use when discovering datasets, software or publications deposited in Zenodo, inspecting record and concept DOIs, or listing file names, sizes, checksums and download links for a record. Searches fetch one page of public metadata; file access may be restricted. No uploads or file downloads.',
    sources: ['Zenodo'],
    termsUrl: 'https://about.zenodo.org/terms/',
    requiresNcbi: false
  }
]
