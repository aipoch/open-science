export const skillMarketplaceCategories = [
  'Academic Writing',
  'Data Analysis',
  'Evidence Insight',
  'Protocol Design',
  'Other'
] as const

export const skillMarketplaceRepository = 'https://github.com/aipoch/openscience-skill-marketplace'

// Catalogs may describe prereleases, but installation and updates offer stable releases only.
export const skillMarketplaceStableVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type SkillMarketplaceEntry = {
  id: string
  displayName: string
  summary: string
  category: (typeof skillMarketplaceCategories)[number]
  version: string
  authors?: { name: string; url?: string }[]
  publisher: { name: string; url: string }
  source: { repository: string; commit: string; path: string }
  license: string
  evaluation?: {
    kind: 'upstream-self-assessment'
    score: number
    maxScore: number
    reportUrl: string
    evaluatedOn?: string
    evaluatorVersion?: string
    skillVersion?: string
    staticScore?: { score: number; maxScore: number }
    dynamicScore?: { score: number; maxScore: number }
  }
}

export type SkillMarketplaceCatalog = {
  // Transient cache hint; never part of the signed catalog or installed receipts.
  revalidate?: boolean
  // The verified 64-hex catalog revision, independent of CDN/GitHub transport.
  snapshotId: string
  revision: string
  entries: SkillMarketplaceEntry[]
  // App-local projection, never part of the signed publisher catalog.
  installations?: Record<string, SkillMarketplaceInstallation>
}

export type SkillMarketplaceCatalogRequest = {
  forceRefresh?: boolean
  // Reconcile local installations against this verified snapshot without remote discovery.
  snapshotId?: string
}

export type SkillMarketplaceDetailRequest = { snapshotId: string; id: string }
export type SkillMarketplaceInstallation =
  | { kind: 'not-installed' }
  | { kind: 'conflict' }
  | { kind: 'installed'; version: string; canUpdate: boolean; localSkillId?: string }
export type SkillMarketplaceInstallRequest = SkillMarketplaceDetailRequest & {
  // null is an explicit first install, a version is an optimistic update precondition.
  expectedVersion: string | null
}
export type SkillMarketplaceInstallResult =
  | {
      ok: true
      value: {
        id: string
        status: 'imported' | 'unchanged' | 'updated'
        version: string
        refreshFailed?: boolean
      }
    }
  | {
      ok: false
      error: 'network' | 'integrity' | 'snapshot-unavailable' | 'conflict' | 'installation-failed'
    }

// Memory-only installation jobs; these states are not persisted Skill states.
export type SkillMarketplaceBatchRequest = {
  snapshotId: string
  items: { id: string; version: string; expectedVersion: string | null }[]
}
export type SkillMarketplaceBatch = Omit<SkillMarketplaceBatchRequest, 'items'> & {
  id: string
  status: 'running' | 'stopping' | 'completed' | 'stopped'
  items: (SkillMarketplaceBatchRequest['items'][number] & {
    status: 'queued' | 'installing' | 'succeeded' | 'failed' | 'skipped' | 'stopped'
    result?: SkillMarketplaceInstallResult
  })[]
  refreshFailed?: boolean
}
export type SkillMarketplaceBatchStartResult =
  | { ok: true; value: SkillMarketplaceBatch }
  | { ok: false; error: 'invalid-request' | 'busy' | 'snapshot-unavailable' }
export type SkillMarketplaceDetail = {
  entry: SkillMarketplaceEntry
  licenseEvidence: { url: string; sha256: string }[]
  installation?: SkillMarketplaceInstallation
}

// Transport-safe failures; these are transient browsing results, not installed Skill states.
export type SkillMarketplaceResult<T> =
  { ok: true; value: T } | { ok: false; error: 'network' | 'integrity' | 'snapshot-unavailable' }
