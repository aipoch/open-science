type SpecialistSkillCatalogEntry = {
  id: string
  source: string
  compatibility?: string
}

export const composeBuiltinSkillCatalog = (
  appVersion: string,
  skills: readonly SpecialistSkillCatalogEntry[]
): Array<{ id: string; appVersion: string; compatibility: string }> =>
  skills
    .filter((skill) => skill.source === 'featured')
    .map((skill) => {
      if (!skill.compatibility) {
        throw new Error(`Builtin Skill ${skill.id} has no content compatibility identity.`)
      }
      return { id: skill.id, appVersion, compatibility: skill.compatibility }
    })
