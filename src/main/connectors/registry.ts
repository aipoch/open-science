import { BIOMART_TOOLS } from './descriptors/biomart'
import { BIORXIV_TOOLS } from './descriptors/biorxiv'
import { CANCER_MODELS_TOOLS } from './descriptors/cancer-models'
import { CELLGUIDE_TOOLS } from './descriptors/cellguide'
import { CHEMBL_TOOLS } from './descriptors/chembl'
import { CHEMISTRY_TOOLS } from './descriptors/chemistry'
import { CLINICAL_GENOMICS_TOOLS } from './descriptors/clinical-genomics'
import { CLINICAL_TRIALS_TOOLS } from './descriptors/clinical-trials'
import { DRUG_REGULATORY_TOOLS } from './descriptors/drug-regulatory'
import { EXPRESSION_TOOLS } from './descriptors/expression'
import { GENES_TOOLS } from './descriptors/genes'
import { GENOMES_TOOLS } from './descriptors/genomes'
import { HUMAN_GENETICS_TOOLS } from './descriptors/human-genetics'
import { LITERATURE_TOOLS } from './descriptors/literature'
import { OMICS_ARCHIVES_TOOLS } from './descriptors/omics-archives'
import { PROTEIN_ANNOTATION_TOOLS } from './descriptors/protein-annotation'
import { PUBMED_TOOLS } from './descriptors/pubmed'
import { REGULATION_TOOLS } from './descriptors/regulation'
import { RESEARCH_RESOURCES_TOOLS } from './descriptors/research-resources'
import { RNA_TOOLS } from './descriptors/rna'
import { STRUCTURES_TOOLS } from './descriptors/structures'
import { VARIANTS_TOOLS } from './descriptors/variants'
import { ZINC_TOOLS } from './descriptors/zinc'
import type { ToolDescriptor } from './types'

const ALL_TOOLS: ToolDescriptor[] = [
  ...BIOMART_TOOLS,
  ...BIORXIV_TOOLS,
  ...CANCER_MODELS_TOOLS,
  ...CELLGUIDE_TOOLS,
  ...CHEMBL_TOOLS,
  ...CHEMISTRY_TOOLS,
  ...CLINICAL_GENOMICS_TOOLS,
  ...CLINICAL_TRIALS_TOOLS,
  ...DRUG_REGULATORY_TOOLS,
  ...EXPRESSION_TOOLS,
  ...GENES_TOOLS,
  ...GENOMES_TOOLS,
  ...HUMAN_GENETICS_TOOLS,
  ...LITERATURE_TOOLS,
  ...OMICS_ARCHIVES_TOOLS,
  ...PROTEIN_ANNOTATION_TOOLS,
  ...PUBMED_TOOLS,
  ...REGULATION_TOOLS,
  ...RESEARCH_RESOURCES_TOOLS,
  ...RNA_TOOLS,
  ...STRUCTURES_TOOLS,
  ...VARIANTS_TOOLS,
  ...ZINC_TOOLS
]

export const ALL_CONNECTOR_IDS = [...new Set(ALL_TOOLS.map((t) => t.connector))]

export function getConnectorTools(connector: string): ToolDescriptor[] {
  return ALL_TOOLS.filter((t) => t.connector === connector)
}

export function getDescriptor(connector: string, method: string): ToolDescriptor | undefined {
  return ALL_TOOLS.find((t) => t.connector === connector && t.id === method)
}
