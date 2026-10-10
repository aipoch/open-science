import { SkillMarketplaceService as Service } from '@aipoch/skills/sources'
import { netFetchWithManualRedirect } from '../network-fetch'
export class SkillMarketplaceService extends Service {
  constructor(fetch: typeof globalThis.fetch = netFetchWithManualRedirect) {
    super(fetch)
  }
}
