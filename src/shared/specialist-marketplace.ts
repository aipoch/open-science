import type {
  SpecialistPackageCandidatePreview,
  SpecialistPackageInstallRequest,
  SpecialistPackageInstallResult
} from './specialist-package'

export const SPECIALIST_MARKETPLACE_IPC = {
  LIST: 'specialist:marketplace-list',
  INSPECT_GITHUB_SOURCE: 'specialist:marketplace-source-inspect-github',
  ADD_SOURCE: 'specialist:marketplace-source-add',
  REMOVE_SOURCE: 'specialist:marketplace-source-remove',
  GET_RELEASE: 'specialist:marketplace-release-get',
  PREPARE_INSTALL: 'specialist:marketplace-install-prepare',
  CANCEL_CANDIDATE: 'specialist:marketplace-candidate-cancel',
  DOWNLOAD_PROGRESS: 'specialist:marketplace-download-progress',
  INSTALL: 'specialist:marketplace-install'
} as const

export type MarketplaceSourceView = {
  id: string
  kind: 'official' | 'github'
  name: string
  repositoryUrl: string
  ref: string
  trust: 'official' | 'user-approved'
  keyId: string
  keyFingerprint: string
  removable: boolean
  lastRefreshedAt?: string
  usingCachedMetadata?: boolean
}

export type MarketplacePublisher = {
  id: string
  name: string
  url?: string
}

export type MarketplaceSpecialistListing = {
  sourceId: string
  sourceName: string
  sourceTrust: MarketplaceSourceView['trust']
  id: string
  displayName: string
  summary: string
  author?: string
  publisher: MarketplacePublisher
  version: string
  installedVersion?: string
  updateAvailable?: boolean
}

export type MarketplaceSourceFailure = {
  sourceId: string
  sourceName: string
  code: 'network' | 'schema' | 'verification' | 'unavailable'
  message: string
}

export type MarketplaceSnapshot = {
  sources: readonly MarketplaceSourceView[]
  specialists: readonly MarketplaceSpecialistListing[]
  failures: readonly MarketplaceSourceFailure[]
}

// Optional renderer intent: a user-initiated refresh bypasses the cached-root TTL so the button
// always reaches the network. Automatic (view-entry) refreshes omit it and reuse fresh cache.
export type ListMarketplaceRequest = { forceRefresh?: boolean }

export type InspectGitHubMarketplaceSourceRequest = { repositoryUrl: string }

export type MarketplaceSourceCandidate = {
  candidateToken: string
  repositoryUrl: string
  ref: string
  marketplaceId: string
  name: string
  keyId: string
  keyFingerprint: string
  specialistCount: number
}

export type AddMarketplaceSourceRequest = { candidateToken: string }
export type RemoveMarketplaceSourceRequest = { sourceId: string }

export type MarketplaceSkill = {
  id: string
  name: string
  displayName: string
  description: string
  fileCount: number
  uncompressedBytes: number
}

export type MarketplaceConnectorReference = {
  id: string
  required: boolean
  defaultSelected: boolean
}

export type MarketplaceSpecialistRelease = {
  sourceId: string
  specialistId: string
  displayName: string
  summary: string
  author?: string
  publisher: MarketplacePublisher
  version: string
  repository: string
  commit: string
  license: string
  compressedBytes: number
  uncompressedBytes: number
  fileCount: number
  defaultSkillIds: readonly string[]
  defaultConnectorIds: readonly string[]
  skills: readonly MarketplaceSkill[]
  connectors: readonly MarketplaceConnectorReference[]
}

export type GetMarketplaceReleaseRequest = {
  sourceId: string
  specialistId: string
  version: string
}

export type PrepareMarketplaceInstallRequest = GetMarketplaceReleaseRequest & {
  selectedSkillIds: readonly string[]
  selectedConnectorIds: readonly string[]
}

export type MarketplaceDownloadProgress = GetMarketplaceReleaseRequest & {
  transferred: number
  total: number
  percent: number
}

export type MarketplaceInstallPreview = {
  release: MarketplaceSpecialistRelease
  package: SpecialistPackageCandidatePreview
}

export type MarketplaceInstallRequest = SpecialistPackageInstallRequest
export type CancelMarketplaceCandidateRequest = { candidateToken: string }

export type MarketplaceInstallResult = SpecialistPackageInstallResult & {
  provenanceLinked?: boolean
}
