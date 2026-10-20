import { MarketplaceSkillRepository as Repository } from '../skill-marketplace/installation'
import { validateSkillHelper } from './helper-validation'

export class UserSkillRepository extends Repository {
  constructor(...args: ConstructorParameters<typeof Repository>) {
    super(args[0], { ...args[1], validateHelper: validateSkillHelper })
  }
}
