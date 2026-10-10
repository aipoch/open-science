import { ConnectorArgumentsError, createConnectorRegistry } from '@aipoch/connector-core'
import { ALLIANCE_TOOLS } from '@aipoch/connector-builtins/alliance'
import { BIOMART_TOOLS } from '@aipoch/connector-builtins/biomart'
import { BIORXIV_TOOLS } from '@aipoch/connector-builtins/biorxiv'
import { CANCER_MODELS_TOOLS } from '@aipoch/connector-builtins/cancer-models'
import { CELLOSAURUS_TOOLS } from '@aipoch/connector-builtins/cellosaurus'
import { CELLGUIDE_TOOLS } from '@aipoch/connector-builtins/cellguide'
import { CELLXGENE_DISCOVER_TOOLS } from '@aipoch/connector-builtins/cellxgene-discover'
import { CHEMBL_TOOLS } from '@aipoch/connector-builtins/chembl'
import { CHEMISTRY_TOOLS } from '@aipoch/connector-builtins/chemistry'
import { CLINICAL_GENOMICS_TOOLS } from '@aipoch/connector-builtins/clinical-genomics'
import { CLINPGX_TOOLS } from '@aipoch/connector-builtins/clinpgx'
import { CLINICAL_TRIALS_TOOLS } from '@aipoch/connector-builtins/clinical-trials'
import { DRUG_REGULATORY_TOOLS } from '@aipoch/connector-builtins/drug-regulatory'
import { createEncoriTools } from '@aipoch/connector-builtins/encori'
import { publishUserFile } from '../user-file-publisher'
import { EXPRESSION_TOOLS } from '@aipoch/connector-builtins/expression'
import { GENES_TOOLS } from '@aipoch/connector-builtins/genes'
import { GENOMES_TOOLS } from '@aipoch/connector-builtins/genomes'
import { GDC_TOOLS } from '@aipoch/connector-builtins/gdc'
import { PDC_TOOLS } from '@aipoch/connector-builtins/pdc'
import { HUMAN_GENETICS_TOOLS } from '@aipoch/connector-builtins/human-genetics'
import { HMMER_TOOLS } from '@aipoch/connector-builtins/hmmer'
import { IEDB_TOOLS } from '@aipoch/connector-builtins/iedb'
import { INTERPROSCAN_TOOLS } from '@aipoch/connector-builtins/interproscan'
import { LITERATURE_TOOLS } from '@aipoch/connector-builtins/literature'
import { MONARCH_TOOLS } from '@aipoch/connector-builtins/monarch'
import { MOLECULE_TOOLS } from '@aipoch/connector-builtins/molecule'
import { OMICS_ARCHIVES_TOOLS } from '@aipoch/connector-builtins/omics-archives'
import { PATHWAY_COMMONS_TOOLS } from '@aipoch/connector-builtins/pathway-commons'
import { PROTEIN_ANNOTATION_TOOLS } from '@aipoch/connector-builtins/protein-annotation'
import { PUBMED_TOOLS } from '@aipoch/connector-builtins/pubmed'
import { REGULATION_TOOLS } from '@aipoch/connector-builtins/regulation'
import { RESEARCH_RESOURCES_TOOLS } from '@aipoch/connector-builtins/research-resources'
import { RNA_TOOLS } from '@aipoch/connector-builtins/rna'
import { STRUCTURES_TOOLS } from '@aipoch/connector-builtins/structures'
import { VARIANTS_TOOLS } from '@aipoch/connector-builtins/variants'
import { ZENODO_TOOLS } from '@aipoch/connector-builtins/zenodo'
import { ZINC_TOOLS } from '@aipoch/connector-builtins/zinc'
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
  ...createEncoriTools((path, write, signal) =>
    publishUserFile(path, write, { exclusive: true, signal })
  ),
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
const registry = createConnectorRegistry(ALL_TOOLS)
export const builtinConnectorRegistry: typeof registry = {
  ...registry,
  validateToolArguments(descriptor, args) {
    try {
      registry.validateToolArguments(descriptor, args)
    } catch (error) {
      if (error instanceof ConnectorArgumentsError) {
        error.message +=
          ` Correct the arguments to match the Input schema in the loaded mcp-${descriptor.connector} Skill, then retry the same method once. ` +
          'Do not retry unchanged or bypass host.mcp.'
      }
      throw error
    }
  }
}
export const {
  connectorIds: ALL_CONNECTOR_IDS,
  getConnectorTools,
  getDescriptor,
  validateToolArguments
} = builtinConnectorRegistry
