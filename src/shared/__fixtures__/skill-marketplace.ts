import type {
  SkillMarketplaceCatalog,
  SkillMarketplaceDetail,
  SkillMarketplaceEntry
} from '../skill-marketplace'

// Renderer tests only. Production data always comes through the verified main-process owner.
export const marketplaceEntry: SkillMarketplaceEntry = {
  id: 'abstract-trimmer',
  displayName: 'Abstract Trimmer',
  summary: 'Reduce abstract word count.',
  version: '1.0.0',
  category: 'Academic Writing',
  authors: [{ name: 'AIPOCH' }],
  publisher: { name: 'AIPOCH', url: 'https://aipoch.com/agent-skills' },
  source: {
    repository: 'https://github.com/aipoch/medical-research-skills',
    commit: 'a'.repeat(40),
    path: 'scientific-skills/Academic Writing/abstract-trimmer'
  },
  license: 'MIT',
  evaluation: {
    kind: 'upstream-self-assessment',
    score: 85,
    maxScore: 100,
    reportUrl:
      'https://github.com/aipoch/medical-research-skills/blob/' + 'a'.repeat(40) + '/report.json',
    dynamicScore: { score: 83.6, maxScore: 100 }
  }
}
export const marketplaceCatalog: SkillMarketplaceCatalog = {
  snapshotId: 'b'.repeat(64),
  revision: 'c'.repeat(64),
  entries: [marketplaceEntry]
}
export const marketplaceDetail: SkillMarketplaceDetail = {
  entry: marketplaceEntry,
  licenseEvidence: [
    {
      url: 'https://github.com/aipoch/medical-research-skills/blob/' + 'a'.repeat(40) + '/LICENSE',
      sha256: 'd'.repeat(64)
    }
  ]
}
