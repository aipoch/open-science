import bundledSkillManifest from '../../../resources/skills/manifest.json'

const APPLICATION_REQUIRED_SKILL_IDS = new Set(
  bundledSkillManifest.skills.flatMap((skill) =>
    'activationPolicy' in skill && skill.activationPolicy === 'always-on' ? [skill.id] : []
  )
)

const isApplicationRequiredSkillId = (id: string): boolean => APPLICATION_REQUIRED_SKILL_IDS.has(id)

export { APPLICATION_REQUIRED_SKILL_IDS, isApplicationRequiredSkillId }
export { isSkillEffectivelyEnabled, trustedSkillActivationPolicy } from '@aipoch/skills/document'
