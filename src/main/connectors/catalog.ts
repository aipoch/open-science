import { CONNECTOR_CATALOG as providers } from '@aipoch/connector-builtins/catalog'

// Settings sections and application capabilities are host presentation policy.
const directory = new Set([
  'rxnorm',
  'dailymed',
  'biosamples',
  'wikipathways',
  'orphadata',
  'pdc',
  'iedb',
  'monarch',
  'alliance',
  'pubmed',
  'clinical-trials',
  'chembl',
  'biorxiv',
  'gdc',
  'cellosaurus'
])
export const CONNECTOR_CATALOG = providers.map((provider) => ({
  ...provider,
  ...(provider.id === 'molecule'
    ? {
        displayName: 'Molecule Viewer',
        description:
          'Validate and preview 2D molecular structures and reactions (OpenChemLib). Backs the .mol/.sdf/.smi/.smiles/.rxn artifact viewer.',
        useWhen:
          'Use when the user provides or wants to inspect a chemical structure — validating or normalizing a SMILES or MDL molfile, computing a molecular formula / weight / heavy-atom count, or turning a structure into a previewable 2D depiction. The paired viewer also renders MDL reaction (.rxn) files.'
      }
    : {}),
  group: directory.has(provider.id) ? ('directory' as const) : ('featured' as const)
}))

// Explicit opt-outs win even if an imported settings document contains conflicting choices.
export function isBundledConnectorEnabled(
  id: string,
  settings?: { disabledConnectorIds?: string[]; enabledConnectorIds?: string[] }
): boolean {
  if (settings?.disabledConnectorIds?.includes(id)) return false
  if (settings?.enabledConnectorIds?.includes(id)) return true
  return CONNECTOR_CATALOG.find((entry) => entry.id === id)?.defaultEnabled !== false
}
