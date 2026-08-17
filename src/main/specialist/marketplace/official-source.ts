import type { OfficialMarketplaceSourceConfig } from './service'

export const OFFICIAL_MARKETPLACE_SOURCE: OfficialMarketplaceSourceConfig = {
  id: 'openscience-official',
  name: 'OpenScience Specialist Marketplace',
  repositoryUrl: 'https://github.com/aipoch/openscience-specialist-marketplace',
  ref: 'published',
  metadataBaseUrls: [
    'https://statics.aipoch.com/open-science/specialist-marketplace/v1/',
    'https://raw.githubusercontent.com/aipoch/openscience-specialist-marketplace/published/'
  ],
  artifactBaseUrls: ['https://statics.aipoch.com/open-science/specialist-marketplace/v1/'],
  trustedKeys: {
    'openscience-marketplace-2026-08':
      'MCowBQYDK2VwAyEAKOudx9NtRJakg0xAQFzVdz/5+T/X/xG0F6pCwUu8SQk='
  }
}
