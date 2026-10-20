export type SkillActivationPolicy = 'always-on' | 'user-controlled'

export type SkillSource = 'featured' | 'imported' | 'personal'

export type AgentHomeSkillRef = {
  source: AgentHomeSkillSource
  slug: string
}

export type AgentHomeSkillSource = 'agents' | 'claude' | 'codex'

export type SkillReplacementPreview = {
  targetId: string
  sourceLabel?: string
  added: string[]
  modified: string[]
  removed: string[]
  comparisonUnavailable?: boolean
}

export const GITHUB_REPOSITORY_SEARCH_TOO_LONG_MESSAGE =
  'GitHub search is limited to 256 characters. Shorten the keywords or paste an owner/repo reference.'

export type GitHubRepositorySearchView = {
  fullName: string
  description: string | null
  url: string
  stars: number
}

export type SkillBundlePreview = {
  replacement?: SkillReplacementPreview
  subPath: string
  name: string
  description: string
  metadata: Record<string, string>
  body: string
  previewError?: string
  files: string[]
  alreadyImported: boolean
  replaceableId?: string
  // Present only for candidates discovered from a public GitHub repo. The approval dialog uses it
  // to load the same lazy candidate preview as Settings; the main process still owns import URLs.
  githubUrl?: string
}

export type SkillBundlePreviewResult = {
  previews: SkillBundlePreview[]
  skipped: SkippedSkill[]
}

export type SkippedSkill = {
  source: string
  reason: string
}

export type SkillReference = {
  path: string
  dataBase64?: string
}

export type AgentHomeSkillView = {
  source: AgentHomeSkillSource
  slug: string
  name: string
  description: string
  alreadyImported: boolean
}
export type AgentHomeSkillImportResult =
  | (AgentHomeSkillRef & {
      status: 'imported' | 'unchanged' | 'updated'
      id: string
      error?: undefined
    })
  | (Partial<AgentHomeSkillRef> & { status?: undefined; id?: undefined; error: string })

export type SkillPackageFileInfo = { path: string; sizeBytes: number }
export type SkillReferenceInfo = { path: string; sizeBytes: number }
