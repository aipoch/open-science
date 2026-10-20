import { createConnectorRegistry } from '@aipoch/connector-core'
import { ALLIANCE_TOOLS } from './alliance'
import { BIOMART_TOOLS } from './biomart'
import { BIORXIV_TOOLS } from './biorxiv'
import { CANCER_MODELS_TOOLS } from './cancer-models'
import { CELLOSAURUS_TOOLS } from './cellosaurus'
import { CELLGUIDE_TOOLS } from './cellguide'
import { CELLXGENE_DISCOVER_TOOLS } from './cellxgene-discover'
import { CHEMBL_TOOLS } from './chembl'
import { CHEMISTRY_TOOLS } from './chemistry'
import { CLINICAL_GENOMICS_TOOLS } from './clinical-genomics'
import { CLINPGX_TOOLS } from './clinpgx'
import { CLINICAL_TRIALS_TOOLS } from './clinical-trials'
import { DRUG_REGULATORY_TOOLS } from './drug-regulatory'
import { createEncoriTools } from './encori'
import { publishTestFile } from './encori/publication.test-helper'
import { EXPRESSION_TOOLS } from './expression'
import { GENES_TOOLS } from './genes'
import { GENOMES_TOOLS } from './genomes'
import { GDC_TOOLS } from './gdc'
import { PDC_TOOLS } from './pdc'
import { HUMAN_GENETICS_TOOLS } from './human-genetics'
import { HMMER_TOOLS } from './hmmer'
import { IEDB_TOOLS } from './iedb'
import { INTERPROSCAN_TOOLS } from './interproscan'
import { LITERATURE_TOOLS } from './literature'
import { MONARCH_TOOLS } from './monarch'
import { MOLECULE_TOOLS } from './molecule'
import { OMICS_ARCHIVES_TOOLS } from './omics-archives'
import { PATHWAY_COMMONS_TOOLS } from './pathway-commons'
import { PROTEIN_ANNOTATION_TOOLS } from './protein-annotation'
import { PUBMED_TOOLS } from './pubmed'
import { REGULATION_TOOLS } from './regulation'
import { RESEARCH_RESOURCES_TOOLS } from './research-resources'
import { RNA_TOOLS } from './rna'
import { STRUCTURES_TOOLS } from './structures'
import { VARIANTS_TOOLS } from './variants'
import { ZENODO_TOOLS } from './zenodo'
import { ZINC_TOOLS } from './zinc'
import type { ToolDescriptor } from '@aipoch/connector-core'

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
  ...createEncoriTools(publishTestFile),
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

export const {
  connectorIds: ALL_CONNECTOR_IDS,
  getConnectorTools,
  getDescriptor,
  validateToolArguments
} = createConnectorRegistry(ALL_TOOLS)
