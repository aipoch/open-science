import { BundledSkillSpecialistPackageAdapter as Adapter } from '@aipoch/skills'
import { SkillRegistry } from './registry'
export class BundledSkillSpecialistPackageAdapter extends Adapter {
  constructor(registry = new SkillRegistry()) {
    super(registry)
  }
}
