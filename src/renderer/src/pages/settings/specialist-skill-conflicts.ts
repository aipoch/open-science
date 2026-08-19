import type {
  SpecialistPackageSkillConflictResolution,
  SpecialistPackageSkillPreview
} from '../../../../shared/specialist-package'

export type SkillConflictResolutionMap = Record<
  string,
  SpecialistPackageSkillConflictResolution['resolution']
>

export const specialistSkillConflicts = (
  skills: readonly SpecialistPackageSkillPreview[] | undefined
): readonly SpecialistPackageSkillPreview[] =>
  (skills ?? []).filter((skill) => skill.disposition === 'conflict' && skill.conflict)

export const skillConflictResolutionList = (
  conflicts: readonly SpecialistPackageSkillPreview[],
  resolutions: SkillConflictResolutionMap
): SpecialistPackageSkillConflictResolution[] =>
  conflicts.flatMap((skill) => {
    const resolution = resolutions[skill.id]
    return resolution ? [{ skillId: skill.id, resolution }] : []
  })
