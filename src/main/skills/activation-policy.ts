import type { SkillActivationPolicy, SkillSource } from '../../shared/settings'
import bundledSkillManifest from '../../../resources/skills/manifest.json'

const APPLICATION_REQUIRED_SKILL_IDS = new Set(
  bundledSkillManifest.skills.flatMap((skill) =>
    'activationPolicy' in skill && skill.activationPolicy === 'always-on' ? [skill.id] : []
  )
)

const isApplicationRequiredSkillId = (id: string): boolean => APPLICATION_REQUIRED_SKILL_IDS.has(id)

const trustedSkillActivationPolicy = (
  source: SkillSource,
  declared: SkillActivationPolicy | undefined
): SkillActivationPolicy =>
  source === 'featured' && declared === 'always-on' ? 'always-on' : 'user-controlled'

const isSkillEffectivelyEnabled = (
  skill: { id: string; source: SkillSource; activationPolicy?: SkillActivationPolicy },
  disabledIds: ReadonlySet<string>
): boolean =>
  trustedSkillActivationPolicy(skill.source, skill.activationPolicy) === 'always-on' ||
  !disabledIds.has(skill.id)

export {
  APPLICATION_REQUIRED_SKILL_IDS,
  isApplicationRequiredSkillId,
  isSkillEffectivelyEnabled,
  trustedSkillActivationPolicy
}
