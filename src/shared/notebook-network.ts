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

export type NotebookNetworkSettings = Readonly<{
  allowedDomains: readonly string[]
  disabledOpenScienceDomainGroups: readonly OpenScienceDomainGroupId[]
  disabledOpenScienceDomains: readonly string[]
}>

export type NotebookNetworkPolicy = Readonly<{
  allowedDomains: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons: Readonly<Record<string, string>>
}>

export type NotebookNetworkStatusReason =
  | 'linuxBubblewrapMissing'
  | 'macSeatbeltUnavailable'
  | 'runtimeFailure'
  | 'trustBundleInvalid'
  | 'windowsHostMissing'
  | 'windowsGatewayPortUnavailable'
  | 'windowsLoopbackMissing'
  | 'windowsNetworkFenceMissing'
  | 'windowsOwnershipMissing'
  | 'windowsProfileMissing'

export type NotebookNetworkStatus =
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'ready'; warnings: readonly NotebookNetworkStatusReason[] }>
  | Readonly<{
      kind: 'setupRequired'
      platform: 'linux' | 'win32'
      reasons: readonly NotebookNetworkStatusReason[]
    }>
  | Readonly<{ kind: 'unsupported'; platform: NodeJS.Platform }>
  | Readonly<{ kind: 'error'; reason: NotebookNetworkStatusReason }>

export const DEFAULT_NOTEBOOK_NETWORK_SETTINGS: NotebookNetworkSettings = Object.freeze({
  allowedDomains: [],
  disabledOpenScienceDomainGroups: [],
  disabledOpenScienceDomains: []
})

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

const uniqueSorted = <Value extends string>(values: readonly Value[]): Value[] =>
  [...new Set(values)].sort()

const isOpenScienceDomainGroupId = (value: unknown): value is OpenScienceDomainGroupId =>
  typeof value === 'string' && (OPEN_SCIENCE_DOMAIN_GROUP_IDS as readonly string[]).includes(value)

const isIpv4Literal = (hostname: string): boolean => {
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  )
}

const isReservedHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  isIpv4Literal(hostname) ||
  hostname.includes(':')

export type DomainValidationResult =
  | Readonly<{ ok: true; hostname: string }>
  | Readonly<{ ok: false; reason: 'empty' | 'format' | 'reserved' }>

export const domainPatternMatches = (pattern: string, hostname: string): boolean => {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2)
    if (!suffix.includes('*')) return hostname !== suffix && hostname.endsWith(`.${suffix}`)
    const suffixExpression = suffix
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]+')
    return new RegExp(`^(?:[^.]+\\.)+${suffixExpression}$`).test(hostname)
  }
  if (pattern.includes('*')) {
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]+')
    return new RegExp(`^${expression}$`).test(hostname)
  }
  return pattern === hostname
}

export const notebookNetworkSettingsAllowDomain = (
  settings: NotebookNetworkSettings,
  hostname: string
): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return buildNotebookNetworkPolicy(settings).allowedDomains.some((pattern) =>
    domainPatternMatches(pattern, normalized)
  )
}

export const validateCustomAllowedDomain = (value: string): DomainValidationResult => {
  if (!value) return { ok: false, reason: 'empty' }
  if (value !== value.trim() || /[\s/:\\?#*@]/.test(value) || value.includes('*')) {
    return { ok: false, reason: 'format' }
  }

  let hostname: string
  try {
    hostname = new URL(`http://${value}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return { ok: false, reason: 'format' }
  }

  if (
    !hostname ||
    hostname.length > 253 ||
    hostname
      .split('.')
      .some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label)) ||
    hostname.split('.').some((label) => label.startsWith('-') || label.endsWith('-'))
  ) {
    return { ok: false, reason: 'format' }
  }
  if (isReservedHostname(hostname)) return { ok: false, reason: 'reserved' }
  if (!hostname.includes('.')) return { ok: false, reason: 'format' }
  return { ok: true, hostname }
}

const normalizeAllowedDomains = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return uniqueSorted(
    value.flatMap((entry) => {
      if (typeof entry !== 'string') return []
      const result = validateCustomAllowedDomain(entry)
      return result.ok ? [result.hostname] : []
    })
  )
}

export const normalizeNotebookNetworkSettings = (value: unknown): NotebookNetworkSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_NOTEBOOK_NETWORK_SETTINGS
  }
  const record = value as Record<string, unknown>
  const disabledGroups = Array.isArray(record.disabledOpenScienceDomainGroups)
    ? uniqueSorted(
        record.disabledOpenScienceDomainGroups.filter(
          (value): value is OpenScienceDomainGroupId =>
            isOpenScienceDomainGroupId(value) &&
            !OPEN_SCIENCE_DOMAIN_GROUPS.find((group) => group.id === value)?.locked
        )
      )
    : []
  const builtInDomains = new Set(
    OPEN_SCIENCE_DOMAIN_GROUPS.filter((group) => !group.locked).flatMap((group) => group.domains)
  )
  const disabledDomains = Array.isArray(record.disabledOpenScienceDomains)
    ? uniqueSorted(
        record.disabledOpenScienceDomains.filter(
          (domain): domain is string => typeof domain === 'string' && builtInDomains.has(domain)
        )
      )
    : []

  return {
    allowedDomains: normalizeAllowedDomains(record.allowedDomains),
    disabledOpenScienceDomainGroups: disabledGroups,
    disabledOpenScienceDomains: disabledDomains
  }
}

export const buildNotebookNetworkPolicy = (
  settings: NotebookNetworkSettings
): NotebookNetworkPolicy => {
  const disabledGroups = new Set(settings.disabledOpenScienceDomainGroups)
  const disabledDomains = new Set(settings.disabledOpenScienceDomains)
  const builtIn = OPEN_SCIENCE_DOMAIN_GROUPS.filter(
    (group) => group.locked || !disabledGroups.has(group.id)
  )
    .flatMap((group) => group.domains)
    .filter(
      (domain) =>
        OPEN_SCIENCE_DOMAIN_GROUPS.find((group) => group.domains.includes(domain))?.locked ||
        !disabledDomains.has(domain)
    )

  return {
    allowedDomains: uniqueSorted([...builtIn, ...settings.allowedDomains]),
    deniedDomains: [],
    deniedDomainReasons: {}
  }
}
