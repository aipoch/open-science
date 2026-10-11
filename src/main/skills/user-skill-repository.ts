import { MarketplaceSkillRepository as Repository } from '../skill-marketplace/installation'
import { validateSkillHelper } from './helper-validation'
export {
  SkillReleaseInstallConflict as MarketplaceInstallConflict,
  parseUserSkillId,
  SAFE_SKILL_DIRECTORY_NAME,
  SAFE_SKILL_NAME,
  assertUsableSkillName,
  frontmatterBlock,
  isReservedSkillName,
  normalizeSkillName
} from '@aipoch/skills'
export type { ImportOutcome } from '@aipoch/skills'
export class UserSkillRepository extends Repository {
  constructor(...args: ConstructorParameters<typeof Repository>) {
    super(args[0], { ...args[1], validateHelper: validateSkillHelper })
  }
}
