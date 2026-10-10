import { createConnectorRegistry } from '../connector-core/registry'
import { ALLIANCE_TOOLS } from './descriptors/alliance'
import { BIOMART_TOOLS } from './descriptors/biomart'
import { BIORXIV_TOOLS } from './descriptors/biorxiv'
import { CANCER_MODELS_TOOLS } from './descriptors/cancer-models'
import { CELLOSAURUS_TOOLS } from './descriptors/cellosaurus'
import { CELLGUIDE_TOOLS } from './descriptors/cellguide'
import { CELLXGENE_DISCOVER_TOOLS } from './descriptors/cellxgene-discover'
import { CHEMBL_TOOLS } from './descriptors/chembl'
import { CHEMISTRY_TOOLS } from './descriptors/chemistry'
import { CLINICAL_GENOMICS_TOOLS } from './descriptors/clinical-genomics'
import { CLINPGX_TOOLS } from './descriptors/clinpgx'
import { CLINICAL_TRIALS_TOOLS } from './descriptors/clinical-trials'
import { DRUG_REGULATORY_TOOLS } from './descriptors/drug-regulatory'
import { ENCORI_TOOLS } from './descriptors/encori'
import { EXPRESSION_TOOLS } from './descriptors/expression'
import { GENES_TOOLS } from './descriptors/genes'
import { GENOMES_TOOLS } from './descriptors/genomes'
import { GDC_TOOLS } from './descriptors/gdc'
import { PDC_TOOLS } from './descriptors/pdc'
import { HUMAN_GENETICS_TOOLS } from './descriptors/human-genetics'
import { HMMER_TOOLS } from './descriptors/hmmer'
import { IEDB_TOOLS } from './descriptors/iedb'
import { INTERPROSCAN_TOOLS } from './descriptors/interproscan'
import { LITERATURE_TOOLS } from './descriptors/literature'
import { MONARCH_TOOLS } from './descriptors/monarch'
import { MOLECULE_TOOLS } from './descriptors/molecule'
import { OMICS_ARCHIVES_TOOLS } from './descriptors/omics-archives'
import { PATHWAY_COMMONS_TOOLS } from './descriptors/pathway-commons'
import { PROTEIN_ANNOTATION_TOOLS } from './descriptors/protein-annotation'
import { PUBMED_TOOLS } from './descriptors/pubmed'
import { REGULATION_TOOLS } from './descriptors/regulation'
import { RESEARCH_RESOURCES_TOOLS } from './descriptors/research-resources'
import { RNA_TOOLS } from './descriptors/rna'
import { STRUCTURES_TOOLS } from './descriptors/structures'
import { VARIANTS_TOOLS } from './descriptors/variants'
import { ZENODO_TOOLS } from './descriptors/zenodo'
import { ZINC_TOOLS } from './descriptors/zinc'
import type { ToolDescriptor } from './types'

const ALL_TOOLS: ToolDescriptor[] = [
  ...ALLIANCE_TOOLS,
  ...BIOMART_TOOLS,
  ...BIORXIV_TOOLS,
  ...CANCER_MODELS_TOOLS,
  ...CELLOSAURUS_TOOLS,
  ...CELLGUIDE_TOOLS,
  ...CELLXGENE_DISCOVER_TOOLS,
  ...CHEMBL_TOOLS,
  ...CHEMISTRY_TOOLS,
  ...CLINICAL_GENOMICS_TOOLS,
  ...CLINPGX_TOOLS,
  ...CLINICAL_TRIALS_TOOLS,
  ...DRUG_REGULATORY_TOOLS,
  ...ENCORI_TOOLS,
  ...EXPRESSION_TOOLS,
  ...GENES_TOOLS,
  ...GENOMES_TOOLS,
  ...GDC_TOOLS,
  ...PDC_TOOLS,
  ...HUMAN_GENETICS_TOOLS,
  ...HMMER_TOOLS,
  ...IEDB_TOOLS,
  ...INTERPROSCAN_TOOLS,
  ...LITERATURE_TOOLS,
  ...MONARCH_TOOLS,
  ...MOLECULE_TOOLS,
  ...OMICS_ARCHIVES_TOOLS,
  ...PATHWAY_COMMONS_TOOLS,
  ...PROTEIN_ANNOTATION_TOOLS,
  ...PUBMED_TOOLS,
  ...REGULATION_TOOLS,
  ...RESEARCH_RESOURCES_TOOLS,
  ...RNA_TOOLS,
  ...STRUCTURES_TOOLS,
  ...VARIANTS_TOOLS,
  ...ZENODO_TOOLS,
  ...ZINC_TOOLS
]

// The host chooses the bundled implementations. The registry itself knows none of them.
export const builtinConnectorRegistry = createConnectorRegistry(ALL_TOOLS)
export const {
  connectorIds: ALL_CONNECTOR_IDS,
  getConnectorTools,
  getDescriptor,
  validateToolArguments
} = builtinConnectorRegistry
