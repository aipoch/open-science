import type {
  SkillMarketplaceUpdatePreview as PackageUpdatePreview,
  SkillMarketplaceDetail as PackageDetail
} from '@aipoch/skills/document'

// Host usage relationships and display names do not belong to the Skill repository.
export type SkillMarketplaceUpdateImpact = {
  mainEnabled: boolean
  specialists: { id: string; name: string }[]
}
export type SkillMarketplaceUpdatePreview = PackageUpdatePreview & SkillMarketplaceUpdateImpact
export type SkillMarketplaceDetail = Omit<PackageDetail, 'updatePreview'> & {
  updatePreview?: SkillMarketplaceUpdatePreview
}
