const SKILL_NAME_MAX_LENGTH = 64
const SAFE_SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED_SKILL_NAME_PREFIXES = ['os-', 'mcp-'] as const

const isReservedSkillName = (name: string): boolean =>
  RESERVED_SKILL_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))

const isUsableSkillName = (name: string): boolean =>
  SAFE_SKILL_NAME.test(name) && !isReservedSkillName(name)

const assertUsableSkillName = (name: string): void => {
  if (!name) throw new Error('Skill name is required.')
  if (!SAFE_SKILL_NAME.test(name) || name.length > SKILL_NAME_MAX_LENGTH) {
    throw new Error('Skill name must use up to 64 lowercase letters, numbers, and single hyphens.')
  }
  if (!isUsableSkillName(name)) {
    throw new Error(`Skill name may not start with ${RESERVED_SKILL_NAME_PREFIXES.join(' or ')}.`)
  }
}

const normalizeSkillName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_NAME_MAX_LENGTH)

export {
  SAFE_SKILL_NAME,
  SKILL_NAME_MAX_LENGTH,
  assertUsableSkillName,
  isReservedSkillName,
  isUsableSkillName,
  normalizeSkillName
}
