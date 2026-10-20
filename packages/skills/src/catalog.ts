import type { BundledSkill } from './registry'
import { isReservedSkillName } from './skill-name'
import { createLogger } from './diagnostics'
const log = createLogger('skills')
export function mergeSkillCatalog(
  featured: readonly BundledSkill[],
  user: readonly BundledSkill[]
): BundledSkill[] {
  const bundledNames = new Set(featured.map((skill) => skill.name))
  const bundledIds = new Set(featured.map((skill) => skill.id))
  const userIdCounts = new Map<string, number>()
  for (const skill of user) userIdCounts.set(skill.id, (userIdCounts.get(skill.id) ?? 0) + 1)
  const eligibleUserSkills = user.filter((skill) => {
    const reason = isReservedSkillName(skill.name)
      ? 'reserved prefix (os- or mcp-)'
      : bundledNames.has(skill.name)
        ? 'bundled Skill name'
        : bundledIds.has(skill.id)
          ? 'bundled Skill id'
          : (userIdCounts.get(skill.id) ?? 0) > 1
            ? 'duplicate user Skill id'
            : undefined
    if (!reason) return true
    log.warn('skipping user Skill with protected identity', {
      source: skill.source,
      id: skill.id,
      name: skill.name,
      reason
    })
    return false
  })
  const newestByName = new Map<string, BundledSkill>()
  for (const skill of [...featured, ...eligibleUserSkills]) {
    const existing = newestByName.get(skill.name)
    if (!existing || isNewerSkill(skill, existing)) newestByName.set(skill.name, skill)
  }
  return [...newestByName.values()]
}

function isNewerSkill(candidate: BundledSkill, existing: BundledSkill): boolean {
  const candidateTime = Date.parse(candidate.updatedAt)
  const existingTime = Date.parse(existing.updatedAt)
  if (candidateTime !== existingTime) return candidateTime > existingTime
  return candidate.id.localeCompare(existing.id) > 0
}
