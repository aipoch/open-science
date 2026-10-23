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
  defaultEnabled?: boolean
  requiresNcbi: boolean
}

// Scientific provider metadata, independent of application navigation and presentation.
export const CONNECTOR_CATALOG: ConnectorMeta[] = [
  {
    id: 'tcia',
    displayName: 'TCIA',
    aliases: ['TCIA', 'Cancer Imaging Archive', 'NBIA'],
    description: 'Public cancer imaging collections and series metadata from TCIA.',
    useWhen:
      'Use to discover public TCIA imaging collections by keyword, retrieve collection download requirements and licenses by exact short title, or inspect an existing DICOM SeriesInstanceUID. Returns metadata and download entrypoints, not images or restricted data.',
    sources: ['TCIA', 'NBIA'],
    termsUrl: 'https://www.cancerimagingarchive.net/data-usage-policies-and-restrictions/',
    defaultEnabled: false,
    requiresNcbi: false
  },
  {
    id: 'kegg',
    displayName: 'KEGG',
    aliases: ['KEGG'],
    description:
      'KEGG pathways, entries and gene mappings. Academic-use and licensing restrictions apply.',
    useWhen:
      'Use for KEGG pathway, KO, compound and reaction summaries or gene-to-pathway/UniProt mappings. Public API is for eligible academic use only; non-academic use and service provision require appropriate licensing. Enabling this connector does not grant a license. For enrichment use the Genes connector.',
    sources: ['KEGG'],
    termsUrl: 'https://www.kegg.jp/kegg/legal.html',
    defaultEnabled: false,
    requiresNcbi: false
  },
  {
    id: 'rxnorm',
    displayName: 'RxNorm / RxNav',
    aliases: ['RxNorm', 'RxNav', 'RxCUI'],
    description: 'Drug name resolution and concept properties from RxNorm.',
    useWhen:
      'Use to resolve drug names to RxCUIs and retrieve active RxNorm concept names and term types.',
    sources: ['RxNorm', 'RxNav'],
    termsUrl: 'https://lhncbc.nlm.nih.gov/RxNav/TermsofService.html',
    defaultEnabled: false,
    requiresNcbi: false
  },
  {
    id: 'dailymed',
    displayName: 'DailyMed',
    aliases: ['DailyMed', 'SPL history'],
    description: 'Drug label identities and version history from DailyMed.',
    useWhen:
      'Use to discover DailyMed Structured Product Labels by drug name and retrieve publication and version history by SPL SET ID.',
    sources: ['DailyMed'],
    termsUrl: 'https://dailymed.nlm.nih.gov/dailymed/about-dailymed.cfm',
    defaultEnabled: false,
    requiresNcbi: false
  },
  {
    id: 'biosamples',
    displayName: 'BioSamples',
    aliases: ['BioSamples', 'EBI BioSamples'],
    description: 'Public sample metadata and cross-references from BioSamples.',
    useWhen:
      'Use to search public EMBL-EBI BioSamples records or retrieve sample characteristics, ontology terms, external references and provenance dates by accession.',
    sources: ['EMBL-EBI BioSamples'],
    termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
    defaultEnabled: false,
    requiresNcbi: false
  },
  {
    id: 'wikipathways',
    displayName: 'WikiPathways',
    aliases: ['WikiPathways', 'WP pathways'],
    description: 'Pathway discovery, metadata and revisions from WikiPathways.',
    useWhen:
      'Use to find WikiPathways by name and species or retrieve metadata, authors and revision dates by WP identifier.',
    sources: ['WikiPathways'],
    termsUrl: 'https://www.wikipathways.org/json/',
    defaultEnabled: false,
    requiresNcbi: false
  },
  {
    id: 'orphadata',
    displayName: 'Orphadata',
    aliases: ['Orphanet', 'ORPHAcode'],
    description: 'Rare-disease genes, phenotypes and frequency evidence from Orphadata.',
    useWhen:
      'Use for Orphanet rare-disease gene associations and HPO phenotype frequencies by ORPHAcode.',
    sources: ['Orphadata', 'Orphanet'],
    termsUrl: 'https://www.orphadata.com/orphanet-scientific-knowledge/',
    defaultEnabled: false,
    requiresNcbi: false
  },
  {
    id: 'encori',
    displayName: 'ENCORI',
    aliases: ['starBase', 'RNA interactome'],
    description: 'RNA interactions, regulatory evidence and bulk datasets from ENCORI.',
    useWhen:
      'Use for ENCORI (starBase) miRNA targets, RNA–RNA interactions, RBP targets and disease associations, ceRNA networks, RBP motif rankings, dataset binding sites, online reference tables, and bulk dataset discovery and downloads.',
    sources: ['ENCORI'],
    termsUrl: 'https://rnasysu.com/encori/',
    requiresNcbi: false
  },
  {
    id: 'pdc',
    displayName: 'PDC',
    aliases: ['Proteomic Data Commons', 'CPTAC proteomics'],
    description:
      'Cancer proteomics studies, sample and aliquot mappings, and file discovery from PDC.',
    useWhen:
      'Use for NCI Proteomic Data Commons (PDC) cancer proteomics and CPTAC study discovery: search study names and versions, inspect assay metadata, map aliquots to samples and cases, retrieve public case demographics and diagnosis metadata, and discover quantitative reports and supplementary files.',
    sources: ['PDC'],
    termsUrl: 'https://pdc.cancer.gov/pdc/data-use-guidelines',
    requiresNcbi: false
  },
  {
    id: 'iedb',
    displayName: 'IEDB',
    aliases: ['Immune Epitope Database', 'immune epitopes', 'immunology assays', 'TCR', 'BCR'],
    description:
      'Immune epitopes, T/B cell and MHC assays, TCR/BCR receptors, antigens and literature evidence from IEDB.',
    useWhen:
      'Use for experimental immunology evidence in the Immune Epitope Database (IEDB): search epitopes, T cell responses, B cell antibody assays, MHC binding and ligand elution experiments, TCR/BCR receptor groups and CDR3 sequences, host species, antigen sources and references.',
    sources: ['IEDB'],
    termsUrl: 'https://www.iedb.org/',
    requiresNcbi: false
  },
  {
    id: 'monarch',
    displayName: 'Monarch Initiative',
    aliases: ['Monarch', 'phenotype evidence', 'disease phenotype associations'],
    description:
      'Disease and gene phenotype associations with evidence sources via Monarch Initiative.',
    useWhen:
      'Use to query disease–phenotype or gene–phenotype associations for Monarch canonical CURIEs and inspect relation types, evidence codes, publications, provenance, negation and qualifiers.',
    sources: ['Monarch Initiative'],
    termsUrl: 'https://monarch-app.monarchinitiative.org/Licensing/',
    requiresNcbi: false
  },
  {
    id: 'alliance',
    displayName: 'Alliance Genome Resources',
    aliases: ['Alliance', 'AGR', 'model organism genes', 'model organism genomics'],
    description:
      'Model-organism and human gene knowledge via the Alliance of Genome Resources — gene summaries, orthology, disease models, phenotypes, alleles and expression.',
    useWhen:
      'Use when you need cross-species model-organism gene knowledge from the Alliance of Genome Resources — search or summarize genes from human, mouse, rat, fly, worm, zebrafish, yeast and frog; retrieve orthologs, disease models, phenotype annotations, alleles/variants, or developmental and anatomical expression; or find genes associated with a Disease Ontology term.',
    sources: ['Alliance of Genome Resources'],
    termsUrl: 'https://www.alliancegenome.org/terms-of-use',
    requiresNcbi: false
  },
  {
    id: 'chemistry',
    displayName: 'Chemistry',
    description:
      'Small-molecule chemistry via PubChem, ChEBI, Rhea, BindingDB, LIPID MAPS and UniChem.',
    useWhen:
      'Use when a question needs authoritative small-molecule chemistry data — PubChem compound properties (formula, weight, SMILES/InChI, IUPAC name), CID resolution and 2D similarity search, bioassay and GHS safety summaries; ChEBI ontology entities, roles and relations; Rhea enzyme reactions (by ChEBI participant, EC number, or equation text); BindingDB binding affinities (Ki/Kd/IC50/EC50) by protein target or compound; LIPID MAPS lipid classification and compound details by exact LMID or PubChem CID; or exact InChIKey/ChEMBL ID mapping to PubChem, ChEMBL and ChEBI through UniChem.',
    sources: ['PubChem', 'ChEBI', 'Rhea', 'BindingDB', 'LIPID MAPS', 'UniChem'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
    requiresNcbi: false
  },
  {
    id: 'literature',
    displayName: 'Literature Graph',
    description: 'Literature and research data via OpenAlex, arXiv, Crossref and DataCite.',
    useWhen:
      'Use when exploring the scholarly literature graph — searching OpenAlex works/papers by topic with citation counts and authors, following a work’s citations or references, looking up authors (ORCID, h-index, institution) or a venue/journal, searching arXiv preprints, checking Crossref bibliographic metadata and deposited corrections/retractions, or discovering DataCite datasets/software and their publication relationships.',
    sources: ['OpenAlex', 'arXiv', 'Crossref', 'DataCite'],
    termsUrl: 'https://docs.openalex.org/additional-help/terms',
    requiresNcbi: false
  },
  {
    id: 'molecule',
    displayName: 'Molecule Viewer',
    description: 'Validate and normalize molecular structures with OpenChemLib.',
    useWhen:
      'Use to validate or normalize SMILES and MDL molfiles and compute molecular formula, weight and heavy-atom count with OpenChemLib.',
    sources: ['OpenChemLib'],
    requiresNcbi: false
  },
  {
    id: 'pubmed',
    displayName: 'PubMed',
    aliases: ['NCBI literature', 'PMC', 'Europe PMC', 'PubTator 3'],
    description:
      'Biomedical literature via NCBI E-utilities, PMC, Europe PMC and PubTator 3 — search, metadata, citation lookup, full text and entity annotations.',
    useWhen:
      'Use for PubTator 3 published-article entity annotations and entity/relation search, or to search the biomedical literature and retrieve article metadata (authors, abstract, DOIs, MeSH), find related/similar articles, resolve citations to PMIDs, convert between PMID/PMCID/DOI, fetch open-access full text from PubMed Central, or check copyright/license status.',
    sources: ['PubMed', 'PMC', 'Europe PMC', 'PubTator 3'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
    requiresNcbi: true
  },
  {
    id: 'genes',
    displayName: 'Genes & Ontologies',
    aliases: ['HGNC', 'MyGene', 'mygene.info', 'UniProt', 'gene information', 'gene annotation'],
    description:
      'Gene/protein identity, ontology terms and gene-set enrichment — HGNC, mygene.info, UniProt, OLS4 ontologies, GO annotations, Reactome pathways, g:Profiler and Enrichr.',
    useWhen:
      'Use for exact HGNC human gene names and alias resolution, or to resolve gene symbols/identifiers (mygene.info), discover UniProt proteins by gene name, protein name, organism or reviewed status, fetch UniProt records or sequences by accession, map batches of UniProt identifiers, look up or search ontology terms (EFO, GO, CL, ChEBI, MONDO via OLS4), retrieve GO annotations for a protein (QuickGO), map genes to Reactome pathways, run cross-database GO/pathway enrichment with an explicit organism, background gene set and multiple-testing correction, or query Enrichr libraries for transcription-factor, perturbation, drug, disease, tissue and cell-type enrichment.',
    sources: ['HGNC', 'MyGene', 'UniProt', 'OLS', 'QuickGO', 'Reactome', 'g:Profiler', 'Enrichr'],
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
      'Use when you need genetic-variant data — gnomAD population allele frequencies, gene constraint (pLI/LOEUF), structural or mitochondrial variants, and build liftover; ClinVar clinical significance (gnomAD mirror or direct NCBI search/records by accession or rsID); dbSNP RefSNP records and region lookups; or MaveDB multiplexed assays of variant effect (MAVE), score set search and metadata, CSV functional scores, existing GA4GH VRS variant mappings, and experiments.',
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
      'Use for ClinicalTrials.gov: search trials by condition/intervention/sponsor/location/status/phase, fetch full details by NCT id, find trials by sponsor, discover investigators and sites, analyze trial endpoints, or find candidate trials by eligibility criteria.',
    sources: ['ClinicalTrials.gov'],
    termsUrl: 'https://clinicaltrials.gov/about-site/terms-conditions',
    requiresNcbi: false
  },
  {
    id: 'clinical-genomics',
    displayName: 'Clinical Genomics',
    aliases: ['DGIdb', 'ClinGen', 'CIViC', 'Open Targets', 'ClinPGx', 'pharmacogenomics'],
    description:
      'Clinical genomics knowledge bases: DGIdb gene–drug interactions, ClinGen curations, CIViC clinical evidence, the Open Targets Platform, and ClinPGx pharmacogenomics.',
    useWhen:
      "Use for DGIdb gene–drug interactions with source evidence, or clinical interpretation of genes, variants, or pharmacogenomics — ClinGen gene-disease validity, dosage sensitivity, clinical actionability, and expert-panel (VCEP) variant pathogenicity classifications; CIViC clinical evidence, assertions, molecular profiles, diseases, and therapies for a gene or variant in cancer; Open Targets target-disease association scores, a disease's known drugs/associated targets, a drug's mechanism of action, and arbitrary Open Targets GraphQL; or ClinPGx drug-gene-variant clinical annotations, dosing guidelines, regulatory labels, variant frequencies, and evidence levels.",
    sources: ['ClinGen', 'CIViC', 'Open Targets', 'ClinPGx', 'DGIdb'],
    termsUrl: 'https://platform-docs.opentargets.org/licence',
    requiresNcbi: false
  },
  {
    id: 'structures',
    displayName: 'Structures & Interactions',
    description:
      'Structures and molecular interactions — PDB structures and PDBe validation, AlphaFold predictions, EMDB cryo-EM entries, Complex Portal complexes, IntAct interaction networks, and OmniPath directed regulation.',
    useWhen:
      'Use when you need a macromolecular 3D structure or a molecular interaction — experimental PDB entries (search, summaries, polymer entities, ligands), PDBe quality summaries and validation statistics with experimental-method context, AlphaFold predicted models, EMDB cryo-EM metadata/validation, curated Complex Portal complexes, IntAct binary interactions and networks, or bounded upstream/downstream signed human protein regulation with OmniPath (query by UniProt accession; mixed-context evidence, not tissue-specific causal proof).',
    sources: ['PDB', 'PDBe', 'AlphaFold', 'EMDB', 'Complex Portal', 'IntAct', 'OmniPath'],
    termsUrl: 'https://www.rcsb.org/pages/usage-policy',
    requiresNcbi: false
  },
  {
    id: 'chembl',
    displayName: 'ChEMBL',
    description:
      'Bioactive compounds, drugs, targets, bioactivity, and mechanisms via the ChEMBL REST API.',
    useWhen:
      'Use for ChEMBL medicinal-chemistry data — search compounds by name, ChEMBL id, or molecular structure (similarity/substructure); find drugs by therapeutic indication with approval and withdrawal flags; get calculated molecular properties for drug-likeness assessment; retrieve bioactivity measurements (IC50, Ki, EC50, pChEMBL) for compound-target pairs; look up mechanism of action; or search biological targets by gene symbol, name, organism, or type.',
    sources: ['ChEMBL'],
    termsUrl: 'https://chembl.gitbook.io/chembl-interface-documentation/about',
    requiresNcbi: false
  },
  {
    id: 'biorxiv',
    displayName: 'bioRxiv',
    description:
      'bioRxiv/medRxiv preprints — search by date/category, metadata by DOI, journal-publication links, funder listings, and platform statistics.',
    useWhen:
      'Use when working with bioRxiv or medRxiv preprints — searching by date range and category (no keyword search), fetching full metadata for a DOI, finding which preprints were published in journals (optionally by publisher DOI prefix), listing preprints by funder (ROR id), or reporting submission/usage statistics over time.',
    sources: ['bioRxiv', 'medRxiv', 'ROR'],
    termsUrl: 'https://www.biorxiv.org/about/FAQ',
    requiresNcbi: false
  },
  {
    id: 'drug-regulatory',
    displayName: 'Drug Regulatory',
    description:
      'FDA drug applications, labels, adverse-event reports, recalls and corpus statistics via openFDA.',
    useWhen:
      'Use when you need FDA drug regulatory and safety data — searching or fetching Drugs@FDA applications (NDA/ANDA/BLA) by brand, generic, ingredient, sponsor, marketing status, or pharmacologic class; aggregate/corpus statistics; generic equivalents of a brand; product label (SPL) sections such as indications and boxed warnings; FAERS adverse-event reports and reaction/drug aggregations; or drug product enforcement and recall reports.',
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
      'Use for tissue expression and eQTL evidence — GTEx tissue sites, dataset releases, versioned GENCODE resolution, median or per-sample TPM, top-expressed genes, donor metadata, and cis-eQTLs; or Bgee healthy wild-type expression across animal species, present/absent calls and scores for a gene, bounded SPARQL lookup constrained by gene/species/tissue, and official expression-call or processed-value download links.',
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
      'Use when you need profile-HMM protein-family scans, sequence-versus-sequence homology searches, or iterative remote-homolog discovery through phmmer, hmmscan, hmmsearch, or jackhmmer. It complements BLAST for protein-family and distant-homology analysis and overlaps with InterProScan for domain-family discovery.',
    sources: ['HMMER3', 'EMBL-EBI'],
    termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
    requiresNcbi: false
  },
  {
    id: 'interproscan',
    displayName: 'InterProScan',
    aliases: ['InterProScan 5', 'iprscan5'],
    description:
      'InterProScan protein sequence submission, job status and TSV result retrieval via EMBL-EBI.',
    useWhen:
      'Use to identify protein domains, families and functional sites in submitted protein sequences with EMBL-EBI InterProScan. For precomputed annotations of known UniProt accessions, use Protein Annotation instead.',
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
      "Use when you need protein annotation — a protein's complete InterPro/Pfam domain architecture, entry/family/clan search and detail, member proteins or proteomes of a Pfam family, Human Protein Atlas per-gene expression (tissue/subcellular/pathology/blood/brain) and bulk search, or STRING id mapping, interaction networks and homology similarity.",
    sources: ['InterPro', 'Pfam', 'Human Protein Atlas', 'STRING'],
    termsUrl: 'https://string-db.org/cgi/access?footer_active_subpage=licensing',
    requiresNcbi: false
  },
  {
    id: 'cancer-models',
    displayName: 'Cancer Models',
    description:
      'Cancer genomics studies, cell models, gene dependencies and drug responses via cBioPortal and DepMap.',
    useWhen:
      "Use when you need cancer genomics data from cBioPortal — listing or looking up cancer studies, samples and patients; retrieving patient/sample clinical values; fetching mRNA expression values for genes; the mutations of a gene in a study (recurrent protein changes, mutation types), a gene's mutation frequency across several studies, discrete copy-number alterations (deletions/amplifications) of a gene, or a study's clinical attributes and survival endpoints. Also use for DepMap/CCLE model identity, exact-gene Chronos gene effects and exact-compound PRISM secondary AUC profiles; preserve dataset releases, units and missing values.",
    sources: ['cBioPortal', 'DepMap / CCLE'],
    termsUrl: 'https://www.cbioportal.org/faq',
    requiresNcbi: false
  },
  {
    id: 'gdc',
    displayName: 'GDC',
    description: 'Cancer project, case and file inventories via the Genomic Data Commons API.',
    useWhen:
      'Use when you need GDC project, case or file metadata and data inventories — including project summaries, case identifiers, file formats, checksums, access classification and Data Transfer Tool manifests.',
    sources: ['Genomic Data Commons (GDC)'],
    termsUrl: 'https://docs.gdc.cancer.gov/API/Users_Guide/Getting_Started/',
    requiresNcbi: false
  },
  {
    id: 'rna',
    displayName: 'RNA',
    description:
      'Non-coding RNA sequences and identifier mappings via RNAcentral, and family metadata, alignments, models and structures via Rfam.',
    useWhen:
      'Use for RNAcentral sequence records and cross-database identifier mappings, or non-coding RNA families from Rfam (accession or family id, e.g. RF00005 / tRNA): family metadata (RNA type, seed/full counts, gathering/trusted/noise cutoffs, clan); the seed alignment (Stockholm or FASTA); the Infernal covariance model; the seed phylogenetic tree; full-region hits across sequence databases; PDB structure mappings; accession<->id conversion; and single-sequence cmscan search against all Rfam models.',
    sources: ['Rfam', 'RNAcentral'],
    termsUrl: 'https://docs.rfam.org/en/latest/',
    requiresNcbi: false
  },
  {
    id: 'omics-archives',
    displayName: 'Omics Archives',
    description:
      'Omics data archives — expression (ArrayExpress, GEO), sequencing reads (ENA), metabolomics (MetaboLights, Metabolomics Workbench), metagenomics (MGnify) and proteomics (PRIDE).',
    useWhen:
      'Use when finding or looking up omics datasets across the major archives — functional-genomics / expression experiments in ArrayExpress (BioStudies) or NCBI GEO series (by keyword, organism, assay, or accession, with per-sample metadata); metabolomics studies and data files in MetaboLights (MTBLS), or Metabolomics Workbench (ST) study records, samples, experimental factors, analysis metadata and compound structures/cross-references; metagenomics studies, analyses and downloadable result files in MGnify (MGYS, by free text or biome lineage); or proteomics projects, proteins and paged project file inventories with download locations in PRIDE Archive (PXD/PRD, by keyword/organism/instrument/disease, or protein↔project). Discover GEO Series Matrix and NCBI-generated RNA-seq count files, or inspect matrix format, dimensions and sample correspondence. Discover ENA sequencing runs by taxonomy, library strategy and title/description keywords, or resolve ENA/INSDC study, experiment or sample accessions to runs. List archive-generated FASTQ URLs or original submitted file locations (including BAM/CRAM), sizes and MD5 checksums for a run.',
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
      'Use to discover public single-cell datasets and collections in CELLxGENE Discover, filter dataset metadata by organism, tissue, disease, assay or cell type, inspect published collection/dataset versions, and obtain file formats, sizes and download URLs. Use CellGuide for cell-type descriptions and marker genes.',
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
      'Use for laboratory cell line identity and curated quality information: search names and aliases, resolve CVCL or RRID:CVCL identifiers, inspect species/tissue origin and donor disease, known contamination or misidentification, ICLAC registrations, and external database mappings.',
    sources: ['Cellosaurus'],
    termsUrl: 'https://www.cellosaurus.org/description.html',
    requiresNcbi: false
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
      'Use when you need gene-regulation / functional-genomics data — ENCODE experiments (ChIP-seq, ATAC-seq, ...), biosamples and data files (searches by assay/target/organism/format, or a record by accession); JASPAR transcription-factor binding profiles (PFM by versioned matrix id, version history, filtered profile catalog by species/collection, and the species/taxa/collections/releases listings); or UniBind high-confidence TF binding sites (search ChIP-seq datasets, per-model TFBS detail with BED/FASTA URLs, and TFBS overlapping a genomic region).',
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
      'Use when you need U.S. federal funding opportunities from Grants.gov (search by keyword, opportunity number, CFDA/ALN, agency such as NIH/NSF/FDA, status, eligibility, or funding category, with facet breakdowns) or research antibodies from the Antibody Registry (full-text search by target/name/catalog, lookup by RRID/accession, exact catalog-number matching, and registry statistics — with RRID, vendor, target, clone, and species).',
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
      'Use when you need purchasable small molecules from ZINC22 — look up compounds by ZINC id, search by SMILES (exact or analog/similarity), resolve vendor catalog codes, draw a random compound sample, or locate docking-ready 3D structures.',
    sources: ['ZINC'],
    termsUrl: 'https://zinc.docking.org/',
    requiresNcbi: false
  },
  {
    id: 'zenodo',
    displayName: 'Zenodo',
    description: 'Public research records, versions and file metadata from Zenodo.',
    useWhen:
      'Use when discovering datasets, software or publications deposited in Zenodo, inspecting record and concept DOIs, or listing file names, sizes, checksums and download links for a record.',
    sources: ['Zenodo'],
    termsUrl: 'https://about.zenodo.org/terms/',
    requiresNcbi: false
  }
]
