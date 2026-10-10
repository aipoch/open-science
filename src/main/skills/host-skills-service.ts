import { HostSkillsService as Service } from '@aipoch/skills'
import { validateSkillHelper } from './helper-validation'
export type {
  HostSkillsCatalog,
  HostSkillsResult,
  HostSkillSummary,
  HostSkillReadResult,
  HostSkillValidationResult
} from '@aipoch/skills'
export class HostSkillsService extends Service {
  constructor(options: ConstructorParameters<typeof Service>[0]) {
    super({ ...options, validateHelper: validateSkillHelper })
  }
}
