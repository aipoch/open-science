import { CONNECTOR_CATALOG as providers } from '@aipoch/connector-builtins/catalog'

// Application setup belongs to the host, not the standalone provider package. These
// notes describe access scope; they neither inspect secrets nor assert dataset approval.
const ncbiAccessGuidance =
  'NCBI E-utilities public queries can run without an API key at the anonymous rate limit. For higher throughput, obtain an optional NCBI API key: https://support.nlm.nih.gov/kbArticle/?pn=KA-05317. Configure it in Settings > Credentials > Literature access; do not require it for other public sources in this Connector.'

const accessGuidance: Readonly<Record<string, string>> = {
  literature:
    'OpenAlex basic queries can run without a key, but cursor paging beyond the first page requires a free, activated API key. Obtain one at https://help.openalex.org/api/authentication/ and configure it in Settings > Credentials > Literature access. This requirement does not apply to arXiv, Crossref or DataCite.',
  'drug-regulatory':
    'These bundled openFDA tools currently use anonymous requests and do not expose an API-key binding. Anonymous quotas may limit queries. For official free-key registration and current limits see https://open.fda.gov/apis/authentication/. Do not invent a credential setting or pass a key in tool arguments; a key requires a Connector implementation that supports it.',
  gdc: 'Public GDC discovery and metadata queries do not establish access to controlled files. Controlled data requires separate authorization through the official GDC/dbGaP process: https://gdc.cancer.gov/access-data/obtaining-access-controlled-data. These tools do not apply for access or download controlled files.',
  tcia: 'These tools discover public TCIA metadata and download requirements, not restricted images. Follow the access instructions and license returned for the selected collection; a collection or series match does not establish download permission. Official portal: https://www.cancerimagingarchive.net/.'
}

// Settings sections and application capabilities are host presentation policy.
const directory = new Set([
  'tcia',
  'kegg',
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
  accessGuidance:
    accessGuidance[provider.id] ??
    (provider.requiresNcbi || provider.id === 'genomes' ? ncbiAccessGuidance : undefined),
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
