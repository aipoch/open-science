import {
  RegisteredSkillHelperCatalog as Catalog,
  validateSkillHelperPackage as validatePackage,
  validateRegisteredSkillPackages as validatePackages
} from '@aipoch/skills'
import { validateSkillHelper } from './helper-validation'

export class RegisteredSkillHelperCatalog extends Catalog {
  constructor(options: ConstructorParameters<typeof Catalog>[0]) {
    super({ ...options, validateHelper: validateSkillHelper })
  }
}
export const validateSkillHelperPackage: typeof validatePackage = (root, storageRoot) =>
  validatePackage(root, storageRoot, validateSkillHelper)
export const validateRegisteredSkillPackages: typeof validatePackages = (packages, storageRoot) =>
  validatePackages(packages, storageRoot, validateSkillHelper)
