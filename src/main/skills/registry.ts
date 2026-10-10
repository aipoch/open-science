import { SkillRegistry as Registry } from '@aipoch/skills'
import { resolveBundledSkillsRoot } from './resource-path'
export type { BundledSkill } from '@aipoch/skills'
export class SkillRegistry extends Registry {
  constructor(rootDir?: string) {
    super(rootDir ?? resolveBundledSkillsRoot)
  }
}
