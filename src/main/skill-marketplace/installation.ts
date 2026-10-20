import { UserSkillRepository as Repository, type BundledSkill } from '@aipoch/skills'
import type { SkillReleaseUpdateGuard } from '@aipoch/skills/document'
import type { MarketplacePackage } from './package'
import type { SkillReleasePolicy } from '@aipoch/skills/sources'
import { marketplaceContentDigest, marketplaceReceiptSchema } from './package'

// The historical receipt namespace and wire digest belong to this source, not the Skill repository.
export const marketplaceReleasePolicy: SkillReleasePolicy = {
  metadataKey: 'marketplace',
  parseRelease: (value) =>
    marketplaceReceiptSchema.omit({ installedContentSha256: true }).parse(value),
  parseReceipt: (value) => marketplaceReceiptSchema.parse(value),
  contentDigest: marketplaceContentDigest,
  isNewerVersion: (offered, installed) => {
    const schema = marketplaceReceiptSchema.shape.version
    if (!schema.safeParse(offered).success || !schema.safeParse(installed).success) return false
    const left = offered.split('+')[0].split('.').map(BigInt)
    const right = installed.split('+')[0].split('.').map(BigInt)
    const different = left.findIndex((value, index) => value !== right[index])
    return different >= 0 && left[different] > right[different]
  },
  diffLabel: 'Marketplace'
}

/** Adapts the official source to the repository without adding a filesystem writer. */
export class MarketplaceSkillRepository extends Repository {
  marketplaceInstallation(
    id: string,
    version: string,
    reservedNames: readonly string[],
    localSkills?: readonly BundledSkill[]
  ): ReturnType<Repository['releaseInstallation']> {
    return this.releaseInstallation(
      marketplaceReleasePolicy,
      id,
      version,
      reservedNames,
      localSkills
    )
  }
  installMarketplace(
    pkg: MarketplacePackage,
    expectedVersion: string | null,
    reservedNames: readonly string[],
    updateToken?: string,
    impact?: SkillReleaseUpdateGuard,
    withImpactLock?: <T>(operation: () => Promise<T>) => Promise<T>
  ): ReturnType<Repository['installRelease']> {
    return this.installRelease(
      marketplaceReleasePolicy,
      pkg,
      expectedVersion,
      reservedNames,
      updateToken,
      impact,
      withImpactLock
    )
  }
  previewMarketplaceUpdate(
    pkg: MarketplacePackage,
    reservedNames: readonly string[],
    impact?: SkillReleaseUpdateGuard
  ): ReturnType<Repository['previewReleaseUpdate']> {
    return this.previewReleaseUpdate(marketplaceReleasePolicy, pkg, reservedNames, impact)
  }
}
