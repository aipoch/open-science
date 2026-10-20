import { CONNECTOR_CATALOG as providers } from '@aipoch/connector-builtins/catalog'

// Settings sections and application capabilities are host presentation policy.
const directory = new Set([
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
          'Use when the user provides or wants to inspect a chemical structure — validating or normalizing a SMILES or MDL molfile, computing a molecular formula / weight / heavy-atom count, or turning a structure into a previewable 2D depiction. The paired viewer also renders MDL reaction (.rxn) files. Self-contained: pass a SMILES or molfile directly, no other connector required. Sourced from OpenChemLib (offline, in-app).'
      }
    : {}),
  group: directory.has(provider.id) ? ('directory' as const) : ('featured' as const)
}))
