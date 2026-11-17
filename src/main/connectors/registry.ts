import { createRequire } from 'node:module'

import { ConnectorArgumentsError, createConnectorRegistry } from '@aipoch/connector-core'
import type { ConnectorRegistry, ToolDescriptor } from '@aipoch/connector-core'
import { publishUserFile } from '../user-file-publisher'
import { MOLECULE_PREVIEW_TOOL } from './molecule-preview-tool'

const nodeRequire = createRequire(import.meta.url)

type BuiltinModule = Record<string, unknown>
type LazyLoader = () => readonly ToolDescriptor[]

// Keep the historical descriptor-derived order without importing every builtin package during
// startup. New bundled connectors must be added here together with their lazy loader below.
const ALL_CONNECTOR_IDS = [
  'research-datasets',
  'drug-regulatory',
  'ctd',
  'biodbnet',
  'chea3',
  'cellosaurus',
  'europepmc',
  'tcia',
  'kegg',
  'rxnorm',
  'dailymed',
  'biosamples',
  'wikipathways',
  'alliance',
  'biomart',
  'biorxiv',
  'cancer-models',
  'cellguide',
  'cellxgene-discover',
  'chembl',
  'chemistry',
  'clinical-genomics',
  'clinical-trials',
  'encori',
  'expression',
  'genes',
  'genomes',
  'gdc',
  'pdc',
  'human-genetics',
  'hmmer',
  'iedb',
  'interproscan',
  'literature',
  'monarch',
  'orphadata',
  'molecule',
  'omics-archives',
  'pathway-commons',
  'protein-annotation',
  'pubmed',
  'regulation',
  'research-resources',
  'rna',
  'structures',
  'variants',
  'zenodo',
  'zinc'
] as const

const packageTools = (specifier: string, exportName: string): LazyLoader => {
  let tools: readonly ToolDescriptor[] | undefined
  return () => {
    tools ??= (nodeRequire(specifier) as BuiltinModule)[exportName] as readonly ToolDescriptor[]
    return tools
  }
}

const encoriTools: LazyLoader = () => {
  const { createEncoriTools } = nodeRequire('@aipoch/connector-builtins/encori') as {
    createEncoriTools: (
      publish: (
        path: string,
        write: (content: string) => Promise<void>,
        signal?: AbortSignal
      ) => Promise<unknown>
    ) => readonly ToolDescriptor[]
  }
  return createEncoriTools((path, write, signal) =>
    publishUserFile(path, write, { exclusive: true, signal })
  )
}

const moleculeTools: LazyLoader = () => {
  const { MOLECULE_TOOLS } = nodeRequire('@aipoch/connector-builtins/molecule') as {
    MOLECULE_TOOLS: readonly ToolDescriptor[]
  }
  return [...MOLECULE_TOOLS, MOLECULE_PREVIEW_TOOL]
}

const lazyLoaders = new Map<string, LazyLoader>([
  [
    'research-datasets',
    packageTools('@aipoch/connector-builtins/research-datasets', 'RESEARCH_DATASET_TOOLS')
  ],
  [
    'molecular-data',
    packageTools('@aipoch/connector-builtins/molecular-data', 'MOLECULAR_DATA_TOOLS')
  ],
  ['europepmc', packageTools('@aipoch/connector-builtins/literature-europepmc', 'EUROPEPMC_TOOLS')],
  ['tcia', packageTools('@aipoch/connector-builtins/tcia', 'TCIA_TOOLS')],
  ['kegg', packageTools('@aipoch/connector-builtins/kegg', 'KEGG_TOOLS')],
  ['rxnorm', packageTools('@aipoch/connector-builtins/rxnorm', 'RXNORM_TOOLS')],
  ['dailymed', packageTools('@aipoch/connector-builtins/dailymed', 'DAILYMED_TOOLS')],
  ['biosamples', packageTools('@aipoch/connector-builtins/biosamples', 'BIOSAMPLES_TOOLS')],
  ['wikipathways', packageTools('@aipoch/connector-builtins/wikipathways', 'WIKIPATHWAYS_TOOLS')],
  ['alliance', packageTools('@aipoch/connector-builtins/alliance', 'ALLIANCE_TOOLS')],
  ['biomart', packageTools('@aipoch/connector-builtins/biomart', 'BIOMART_TOOLS')],
  ['biorxiv', packageTools('@aipoch/connector-builtins/biorxiv', 'BIORXIV_TOOLS')],
  [
    'cancer-models',
    packageTools('@aipoch/connector-builtins/cancer-models', 'CANCER_MODELS_TOOLS')
  ],
  ['cellosaurus', packageTools('@aipoch/connector-builtins/cellosaurus', 'CELLOSAURUS_TOOLS')],
  ['cellguide', packageTools('@aipoch/connector-builtins/cellguide', 'CELLGUIDE_TOOLS')],
  [
    'cellxgene-discover',
    packageTools('@aipoch/connector-builtins/cellxgene-discover', 'CELLXGENE_DISCOVER_TOOLS')
  ],
  ['chembl', packageTools('@aipoch/connector-builtins/chembl', 'CHEMBL_TOOLS')],
  ['chemistry', packageTools('@aipoch/connector-builtins/chemistry', 'CHEMISTRY_TOOLS')],
  [
    'clinical-genomics',
    packageTools('@aipoch/connector-builtins/clinical-genomics', 'CLINICAL_GENOMICS_TOOLS')
  ],
  ['clinpgx', packageTools('@aipoch/connector-builtins/clinpgx', 'CLINPGX_TOOLS')],
  [
    'clinical-trials',
    packageTools('@aipoch/connector-builtins/clinical-trials', 'CLINICAL_TRIALS_TOOLS')
  ],
  [
    'drug-regulatory',
    packageTools('@aipoch/connector-builtins/drug-regulatory', 'DRUG_REGULATORY_TOOLS')
  ],
  ['encori', encoriTools],
  ['expression', packageTools('@aipoch/connector-builtins/expression', 'EXPRESSION_TOOLS')],
  ['genes', packageTools('@aipoch/connector-builtins/genes', 'GENES_TOOLS')],
  ['genomes', packageTools('@aipoch/connector-builtins/genomes', 'GENOMES_TOOLS')],
  ['gdc', packageTools('@aipoch/connector-builtins/gdc', 'GDC_TOOLS')],
  ['pdc', packageTools('@aipoch/connector-builtins/pdc', 'PDC_TOOLS')],
  [
    'human-genetics',
    packageTools('@aipoch/connector-builtins/human-genetics', 'HUMAN_GENETICS_TOOLS')
  ],
  ['hmmer', packageTools('@aipoch/connector-builtins/hmmer', 'HMMER_TOOLS')],
  ['iedb', packageTools('@aipoch/connector-builtins/iedb', 'IEDB_TOOLS')],
  ['interproscan', packageTools('@aipoch/connector-builtins/interproscan', 'INTERPROSCAN_TOOLS')],
  ['literature', packageTools('@aipoch/connector-builtins/literature', 'LITERATURE_TOOLS')],
  ['orphadata', packageTools('@aipoch/connector-builtins/orphadata', 'ORPHADATA_TOOLS')],
  ['monarch', packageTools('@aipoch/connector-builtins/monarch', 'MONARCH_TOOLS')],
  ['molecule', moleculeTools],
  [
    'omics-archives',
    packageTools('@aipoch/connector-builtins/omics-archives', 'OMICS_ARCHIVES_TOOLS')
  ],
  [
    'pathway-commons',
    packageTools('@aipoch/connector-builtins/pathway-commons', 'PATHWAY_COMMONS_TOOLS')
  ],
  [
    'protein-annotation',
    packageTools('@aipoch/connector-builtins/protein-annotation', 'PROTEIN_ANNOTATION_TOOLS')
  ],
  ['pubmed', packageTools('@aipoch/connector-builtins/pubmed', 'PUBMED_TOOLS')],
  ['regulation', packageTools('@aipoch/connector-builtins/regulation', 'REGULATION_TOOLS')],
  [
    'research-resources',
    packageTools('@aipoch/connector-builtins/research-resources', 'RESEARCH_RESOURCES_TOOLS')
  ],
  ['rna', packageTools('@aipoch/connector-builtins/rna', 'RNA_TOOLS')],
  ['structures', packageTools('@aipoch/connector-builtins/structures', 'STRUCTURES_TOOLS')],
  ['variants', packageTools('@aipoch/connector-builtins/variants', 'VARIANTS_TOOLS')],
  ['zenodo', packageTools('@aipoch/connector-builtins/zenodo', 'ZENODO_TOOLS')],
  ['zinc', packageTools('@aipoch/connector-builtins/zinc', 'ZINC_TOOLS')]
])

const combineLoaders = (...loaders: readonly LazyLoader[]): LazyLoader => {
  let tools: readonly ToolDescriptor[] | undefined
  return () => {
    tools ??= loaders.flatMap((loader) => loader())
    return tools
  }
}

const researchDatasetTools = lazyLoaders.get('research-datasets')!
lazyLoaders.set(
  'drug-regulatory',
  combineLoaders(researchDatasetTools, lazyLoaders.get('drug-regulatory')!)
)
lazyLoaders.set('ctd', researchDatasetTools)
const molecularDataTools = lazyLoaders.get('molecular-data')!
lazyLoaders.set('biodbnet', molecularDataTools)
lazyLoaders.set('chea3', molecularDataTools)
lazyLoaders.set('cellosaurus', combineLoaders(molecularDataTools, lazyLoaders.get('cellosaurus')!))
const clinicalGenomicsTools = lazyLoaders.get('clinical-genomics')!
lazyLoaders.set(
  'clinical-genomics',
  combineLoaders(clinicalGenomicsTools, lazyLoaders.get('clinpgx')!)
)

const registries = new Map<string, ConnectorRegistry>()
const descriptorOwners = new Map<ToolDescriptor, ConnectorRegistry>()

const registryFor = (connector: string): ConnectorRegistry | undefined => {
  const loader = lazyLoaders.get(connector)
  if (!loader) return undefined
  let registry = registries.get(connector)
  if (!registry) {
    registry = createConnectorRegistry(loader())
    registries.set(connector, registry)
    for (const tool of registry.getConnectorTools(connector)) descriptorOwners.set(tool, registry)
  }
  return registry
}

const registry = {
  connectorIds: ALL_CONNECTOR_IDS as readonly string[],
  getConnectorTools: (connector: string): ToolDescriptor[] =>
    registryFor(connector)?.getConnectorTools(connector) ?? [],
  getDescriptor: (connector: string, method: string): ToolDescriptor | undefined =>
    registryFor(connector)?.getDescriptor(connector, method),
  validateToolArguments: (descriptor: ToolDescriptor, args: Record<string, unknown>): void => {
    const owner = descriptorOwners.get(descriptor)
    if (!owner)
      throw new Error(`unregistered tool descriptor: ${descriptor.connector}/${descriptor.id}`)
    owner.validateToolArguments(descriptor, args)
  }
}

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

export const { connectorIds, getConnectorTools, getDescriptor, validateToolArguments } =
  builtinConnectorRegistry

export { connectorIds as ALL_CONNECTOR_IDS }
