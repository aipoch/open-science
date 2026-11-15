import { AUTOMATIC_PACKAGE_MIRROR_DOMAINS } from './mirror'

export type NotebookNetworkMode = 'relaxed' | 'strict'
export type NotebookWhitelistGroup = Readonly<{ id: string; name: string }>
export type NotebookStrictWhitelistEntry =
  import('@aipoch/notebook-network-sandbox/network-address').StrictNetworkRule &
    Readonly<{
      id: string
      groupId?: string
      origin: 'builtin' | 'manual'
    }>

export const OPEN_SCIENCE_DOMAIN_GROUP_IDS = [
  'packageRegistries',
  'nih',
  'genomics',
  'proteomics',
  'literature',
  'clinical'
] as const

export type OpenScienceDomainGroupId = (typeof OPEN_SCIENCE_DOMAIN_GROUP_IDS)[number]

export type OpenScienceDomainGroup = Readonly<{
  id: OpenScienceDomainGroupId
  domains: readonly string[]
  locked?: boolean
}>

export const OPEN_SCIENCE_DOMAIN_GROUPS: readonly OpenScienceDomainGroup[] = Object.freeze([
  {
    id: 'packageRegistries',
    locked: true,
    domains: [
      'pypi.org',
      '*.pypi.org',
      'files.pythonhosted.org',
      'conda.anaconda.org',
      'repo.anaconda.com',
      'anaconda.org',
      '*.anaconda.org',
      '*.conda.io',
      ...AUTOMATIC_PACKAGE_MIRROR_DOMAINS,
      'cran.r-project.org',
      'cloud.r-project.org',
      'bioconductor.org',
      'www.bioconductor.org',
      'registry.npmjs.org',
      'github.com',
      '*.github.com',
      '*.githubusercontent.com'
    ]
  },
  {
    id: 'nih',
    domains: ['*.ncbi.nlm.nih.gov', '*.nih.gov', 'cactus.nci.nih.gov']
  },
  {
    id: 'genomics',
    domains: [
      'rest.ensembl.org',
      'grch37.rest.ensembl.org',
      '*.ensembl.org',
      'reactome.org',
      '*.reactome.org',
      'rest.kegg.jp',
      '*.kegg.jp',
      'cellguide.cellxgene.cziscience.com',
      'gnomad.broadinstitute.org',
      'gtexportal.org',
      'jaspar.elixir.no',
      'www.encodeproject.org',
      'mygene.info',
      'rfam.org',
      'www.cbioportal.org',
      'sparql.rhea-db.org',
      'bindingdb.org',
      'www.bindingdb.org',
      'r12.finngen.fi',
      'pheweb.jp',
      'api.genome.ucsc.edu',
      'unibind.uio.no'
    ]
  },
  {
    id: 'proteomics',
    domains: [
      'rest.uniprot.org',
      '*.uniprot.org',
      'string-db.org',
      '*.string-db.org',
      '*.ebi.ac.uk',
      'search.foldseek.com',
      'rcsb.org',
      '*.rcsb.org',
      '*.proteinatlas.org'
    ]
  },
  {
    id: 'literature',
    domains: [
      'api.semanticscholar.org',
      'api.biorxiv.org',
      'www.biorxiv.org',
      'api.crossref.org',
      'doi.org',
      'api.openalex.org',
      'arxiv.org',
      '*.arxiv.org'
    ]
  },
  {
    id: 'clinical',
    domains: [
      'api.fda.gov',
      'clinicaltrials.gov',
      '*.clinicaltrials.gov',
      'api.clinpgx.org',
      'api.platform.opentargets.org',
      'cancer.sanger.ac.uk',
      'actionability.clinicalgenome.org',
      'search.clinicalgenome.org',
      'erepo.genome.network',
      'civicdb.org',
      'api.grants.gov',
      'www.antibodyregistry.org',
      'cartblanche22.docking.org',
      'files.docking.org'
    ]
  }
])

export type TrustedPrivateDestination = Readonly<{
  id?: string
  hostname: string
  port: number
  protocol?: 'http' | 'https'
  approvedAddresses: readonly string[]
  /** Present only for rules derived by the trusted backend from a global grant. */
  managedGrantId?: string
  source?: 'global-destination-grant'
}>

export type PrivateDestinationRequest = Readonly<{
  hostname: string
  port: number
  protocol?: 'http' | 'https'
}>
export type PrivateDestinationReview =
  | Readonly<{ ok: true; destination: TrustedPrivateDestination }>
  | Readonly<{ ok: false; reason: 'invalid' | 'ineligible' | 'dns' }>

export type NotebookNetworkSettings = Readonly<{
  mode?: NotebookNetworkMode
  strictWhitelistVersion?: 1
  strictWhitelist?: readonly NotebookStrictWhitelistEntry[]
  strictWhitelistGroups?: readonly NotebookWhitelistGroup[]
  destinationGrants?: readonly import('./network-destination-grants').NetworkDestinationGrant[]
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  disabledOpenScienceDomainGroups: readonly OpenScienceDomainGroupId[]
  disabledOpenScienceDomains: readonly string[]
}>

export type NotebookNetworkPolicy = Readonly<{
  mode?: NotebookNetworkMode
  strictWhitelist?: readonly NotebookStrictWhitelistEntry[]
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  askDomains: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons: Readonly<Record<string, string>>
}>

export {
  normalizeNetworkHostname,
  formatNetworkHostname,
  isNetworkIpLiteral,
  requiresNetworkException
} from '@aipoch/notebook-network-sandbox/network-address'

export const trustedDestinationId = (rule: TrustedPrivateDestination): string =>
  rule.id ??
  rule.managedGrantId ??
  `manual:${rule.protocol ?? 'https'}://${rule.hostname}:${rule.port}`
