import type { SkillActivationPolicy, SkillSource } from './types'

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

export { isSkillEffectivelyEnabled, trustedSkillActivationPolicy }
