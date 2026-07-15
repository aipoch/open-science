import type { ConnectorGroup } from '../../shared/settings'

export type ConnectorMeta = {
  id: string
  displayName: string
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
    description:
      'Scholarly literature graph — OpenAlex works/authors/venues/citations, arXiv metadata.',
    useWhen:
      'Use when exploring the scholarly literature graph — searching works/papers by topic with citation counts and authors, following a work’s citations or references, looking up authors (ORCID, h-index, institution) or a venue/journal, or searching arXiv preprints. Sourced from OpenAlex and arXiv.',
    sources: ['OpenAlex', 'arXiv'],
    termsUrl: 'https://docs.openalex.org/additional-help/terms',
    requiresNcbi: false
  },
  {
    id: 'pubmed',
    displayName: 'PubMed',
    description: 'Biomedical literature via NCBI E-utilities.',
    useWhen:
      'Use when searching the biomedical literature for articles, publication counts, or titles about a disease, gene, drug, or clinical topic. Sourced from PubMed (NCBI).',
    sources: ['PubMed'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
    requiresNcbi: true,
    group: 'directory'
  },
  {
    id: 'genes',
    displayName: 'Genes & Proteins',
    description: 'Protein and gene annotation via UniProt and MyGene.',
    useWhen:
      'Use when you need protein or gene annotation — a UniProt entry (protein name, gene, function) for an accession, or resolving a gene symbol to identifiers (Entrez/Ensembl).',
    sources: ['UniProt', 'MyGene'],
    termsUrl: 'https://www.uniprot.org/help/license',
    requiresNcbi: false
  },
  {
    id: 'genomes',
    displayName: 'Genomes',
    description: 'Gene genomic location and identifiers via Ensembl.',
    useWhen:
      "Use when you need a gene's Ensembl ID, genomic location (chromosome/coordinates), or biotype — from a species + gene symbol, or an Ensembl ID.",
    sources: ['Ensembl'],
    termsUrl: 'https://www.ensembl.org/info/about/legal/disclaimer.html',
    requiresNcbi: false
  },
  {
    id: 'variants',
    displayName: 'Variants',
    description: 'Genetic variant clinical significance via ClinVar.',
    useWhen:
      'Use when you need ClinVar records for a gene or genetic variant — clinical significance and summaries.',
    sources: ['ClinVar'],
    termsUrl: 'https://www.ncbi.nlm.nih.gov/clinvar/docs/maintenance_use/',
    requiresNcbi: true
  },
  {
    id: 'clinical_trials',
    displayName: 'Clinical Trials',
    description: 'Clinical trial records via ClinicalTrials.gov.',
    useWhen:
      'Use when searching or fetching clinical trials from ClinicalTrials.gov — by NCT id, or by a condition, intervention, or free-text query.',
    sources: ['ClinicalTrials.gov'],
    termsUrl: 'https://clinicaltrials.gov/about-site/terms-conditions',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'clinical_genomics',
    displayName: 'Clinical Genomics',
    description:
      'Clinical genomics knowledge bases: ClinGen curations, CIViC clinical evidence, and the Open Targets Platform.',
    useWhen:
      "Use when you need clinical interpretation of genes and variants — ClinGen gene-disease validity, dosage sensitivity, clinical actionability, and expert-panel (VCEP) variant pathogenicity classifications; CIViC clinical evidence, assertions, molecular profiles, diseases, and therapies for a gene or variant in cancer; or Open Targets target-disease association scores, a disease's known drugs/associated targets, a drug's mechanism of action, and arbitrary Open Targets GraphQL. Sourced from ClinGen, CIViC, and the Open Targets Platform.",
    sources: ['ClinGen', 'CIViC', 'Open Targets'],
    termsUrl: 'https://platform-docs.opentargets.org/licence',
    requiresNcbi: false
  },
  {
    id: 'structures',
    displayName: 'Structures',
    description: 'Protein 3D structures via PDB and AlphaFold.',
    useWhen:
      'Use when you need a protein 3D structure — an experimental PDB entry by PDB id, or an AlphaFold predicted model by UniProt accession.',
    sources: ['PDB', 'AlphaFold'],
    termsUrl: 'https://www.rcsb.org/pages/usage-policy',
    requiresNcbi: false
  },
  {
    id: 'gnomad',
    displayName: 'gnomAD',
    description: 'Population variant frequencies via the gnomAD GraphQL API.',
    useWhen:
      'Use when you need population allele frequencies or variant data for a gene or genetic variant from gnomAD.',
    sources: ['gnomAD'],
    termsUrl: 'https://gnomad.broadinstitute.org/policies',
    requiresNcbi: false
  },
  {
    id: 'chembl',
    displayName: 'ChEMBL',
    description: 'Bioactive drug-like small molecules via the ChEMBL REST API.',
    useWhen:
      'Use when searching for a bioactive small molecule or drug by name, or looking up a known ChEMBL compound record (preferred name, clinical phase, molecule type) by ChEMBL ID.',
    sources: ['ChEMBL'],
    termsUrl: 'https://chembl.gitbook.io/chembl-interface-documentation/about',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'biorxiv',
    displayName: 'bioRxiv',
    description: 'Preprint metadata via the bioRxiv/medRxiv REST API.',
    useWhen:
      'Use when looking up a bioRxiv or medRxiv preprint by DOI, or listing preprints posted in a date range (optionally filtered by category) — title, authors, date, category, and journal-publication link.',
    sources: ['bioRxiv'],
    termsUrl: 'https://www.biorxiv.org/about/FAQ',
    requiresNcbi: false,
    group: 'directory'
  },
  {
    id: 'drug_regulatory',
    displayName: 'Drug Regulatory',
    description: 'Drugs@FDA applications, labels, and corpus statistics via openFDA.',
    useWhen:
      'Use when you need FDA drug regulatory data — searching or fetching Drugs@FDA applications (NDA/ANDA/BLA) by brand, generic, ingredient, sponsor, marketing status, or pharmacologic class; aggregate/corpus statistics; generic equivalents of a brand; or product label (SPL) sections such as indications and boxed warnings. Sourced from openFDA (Drugs@FDA + drug labels).',
    sources: ['openFDA'],
    termsUrl: 'https://open.fda.gov/terms/',
    requiresNcbi: false
  },
  {
    id: 'human_genetics',
    displayName: 'Human Genetics',
    description: 'Genome-wide association study results via the GWAS Catalog.',
    useWhen:
      'Use when you need genome-wide association study (GWAS) evidence — variant-trait associations mapped to a gene symbol, or associations reported for a specific dbSNP variant (rsID), including p-value, risk allele, and mapped trait.',
    sources: ['GWAS Catalog'],
    termsUrl: 'https://www.ebi.ac.uk/gwas/docs/about',
    requiresNcbi: false
  },
  {
    id: 'expression',
    displayName: 'Expression',
    description: 'Human tissue expression and eQTLs via the GTEx Portal.',
    useWhen:
      'Use for GTEx tissue expression and eQTL evidence — listing tissue sites or dataset releases, resolving gene symbols to versioned GENCODE ids, median or per-sample expression (TPM) by tissue, top-expressed genes per tissue, sample/donor metadata, and cis-eQTLs (eGenes, single-tissue, multi-tissue METASOFT, or on-the-fly calculation) for a gene or variant. Sourced from GTEx.',
    sources: ['GTEx'],
    termsUrl: 'https://gtexportal.org/home/license',
    requiresNcbi: false
  },
  {
    id: 'protein_annotation',
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
    id: 'cancer_models',
    displayName: 'Cancer Models',
    description: 'Cancer genomics study records via the cBioPortal REST API.',
    useWhen:
      "Use when you need cancer genomics data from cBioPortal — listing or looking up cancer studies (cancer type, sample counts, citation), the mutations of a gene in a study (recurrent protein changes, mutation types), a gene's mutation frequency across several studies, discrete copy-number alterations (deletions/amplifications) of a gene, or a study's clinical attributes and survival endpoints.",
    sources: ['cBioPortal'],
    termsUrl: 'https://www.cbioportal.org/faq',
    requiresNcbi: false
  },
  {
    id: 'rna',
    displayName: 'RNA',
    description: 'Non-coding RNA family metadata via Rfam.',
    useWhen:
      'Use when you need RNA family metadata — Rfam accession, family id, description, or RNA type (e.g. tRNA, rRNA, riboswitch) for an Rfam accession or family id.',
    sources: ['Rfam'],
    termsUrl: 'https://docs.rfam.org/en/latest/',
    requiresNcbi: false
  },
  {
    id: 'omics_archives',
    displayName: 'Omics Archives',
    description:
      'Omics data archives — expression (ArrayExpress, GEO), metabolomics (MetaboLights), metagenomics (MGnify) and proteomics (PRIDE).',
    useWhen:
      'Use when finding or looking up omics datasets across the major archives — functional-genomics / expression experiments in ArrayExpress (BioStudies) or NCBI GEO series (by keyword, organism, assay, or accession, with per-sample metadata); metabolomics studies and data files in MetaboLights (MTBLS); metagenomics studies and analyses in MGnify (MGYS, by free text or biome lineage); or proteomics projects and proteins in PRIDE Archive (PXD, by keyword/organism/instrument/disease, or protein↔project). Sourced from ArrayExpress, GEO, MetaboLights, MGnify and PRIDE.',
    sources: ['ArrayExpress', 'GEO', 'MetaboLights', 'MGnify', 'PRIDE'],
    termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use',
    requiresNcbi: true
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
    description: 'Gene-regulation functional-genomics experiments via the ENCODE portal.',
    useWhen:
      'Use when you need gene-regulation / functional-genomics experiment data — searching ENCODE experiments (ChIP-seq, ATAC-seq, ...) by free text, or looking up a known ENCODE experiment by accession (assay, target, biosample, status).',
    sources: ['ENCODE'],
    termsUrl: 'https://www.encodeproject.org/about/data-use-policy/',
    requiresNcbi: false
  },
  {
    id: 'research_resources',
    displayName: 'Research Resources',
    description: 'Antibody catalog lookups via the Antibody Registry.',
    useWhen:
      'Use when you need a research antibody by target, name, or catalog text — RRID, vendor, target, and clonality. Sourced from the Antibody Registry.',
    sources: ['Antibody Registry'],
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
    description: 'Purchasable compound lookups via ZINC22.',
    useWhen:
      'Use when you need to look up a purchasable compound by ZINC identifier — structure (SMILES), tranche properties, and which suppliers sell it. Sourced from ZINC22.',
    sources: ['ZINC'],
    termsUrl: 'https://zinc.docking.org/',
    requiresNcbi: false
  }
]
