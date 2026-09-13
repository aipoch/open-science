export const skillMarketplaceCategories = [
  'Academic Writing',
  'Data Analysis',
  'Evidence Insight',
  'Protocol Design',
  'Other'
] as const

export const skillMarketplaceRepository = 'https://github.com/aipoch/openscience-skill-marketplace'

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
  snapshotId: string
  revision: string
  entries: SkillMarketplaceEntry[]
}

export type SkillMarketplaceDetailRequest = { snapshotId: string; id: string }
export type SkillMarketplaceInstallation =
  | { kind: 'not-installed' }
  | { kind: 'conflict' }
  | { kind: 'installed'; version: string; canUpdate: boolean }
export type SkillMarketplaceInstallRequest = SkillMarketplaceDetailRequest & {
  // null is an explicit first install, a version is an optimistic update precondition.
  expectedVersion: string | null
}
export type SkillMarketplaceInstallResult =
  | {
      ok: true
      value: { id: string; status: 'imported' | 'unchanged' | 'updated'; version: string }
    }
  | {
      ok: false
      error: 'network' | 'integrity' | 'snapshot-unavailable' | 'conflict' | 'installation-failed'
    }
export type SkillMarketplaceDetail = {
  entry: SkillMarketplaceEntry
  licenseEvidence: { url: string; sha256: string }[]
  installation?: SkillMarketplaceInstallation
}

// Transport-safe failures; these are transient browsing results, not installed Skill states.
export type SkillMarketplaceResult<T> =
  { ok: true; value: T } | { ok: false; error: 'network' | 'integrity' | 'snapshot-unavailable' }
