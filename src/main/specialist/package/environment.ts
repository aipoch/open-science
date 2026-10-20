import { createLogger } from '@aipoch/diagnostics/node'
import { parseSkillDocument } from '@aipoch/skills/document'
import {
  specialistExportFileName,
  type SpecialistArchives,
  type SpecialistArchiveOptions,
  type SpecialistDomain
} from '@aipoch/specialists/node'
import { SettingsRepository } from '../../settings/repository'

export const specialistPackageEnvironment = (
  settings: Pick<SettingsRepository, 'getSettings' | 'setSkillsEnabled'>
): Pick<
  SpecialistArchiveOptions,
  | 'parseSkillDocument'
  | 'skillSettings'
  | 'disableNewSkills'
  | 'overwriteDiagnostic'
  | 'preservePresentation'
> => ({
  parseSkillDocument,
  skillSettings: {
    disabledSkillIds: async () => (await settings.getSettings()).disabledSkillIds ?? [],
    setSkillsEnabled: async (ids, enabled) => {
      await settings.setSkillsEnabled([...ids], enabled)
    }
  },
  disableNewSkills: true,
  preservePresentation: (origin) => origin === 'marketplace',
  overwriteDiagnostic: (existing, origin) =>
    existing.origin === 'marketplace' && origin !== 'marketplace'
      ? {
          severity: 'error',
          code: 'specialist.overwrite-marketplace-managed',
          message:
            'Marketplace-managed Specialists can only be updated from their Marketplace source.',
          relatedId: existing.id
        }
      : undefined
})

type HostSpecialistPackageOptions = Omit<SpecialistArchiveOptions, 'skillSettings'> & {
  storageDir: string
  domain: SpecialistDomain
  skillSettings?: Pick<SettingsRepository, 'getSettings' | 'setSkillsEnabled'>
}
export const createHostSpecialistPackages = (
  options: HostSpecialistPackageOptions
): SpecialistArchives => {
  const { skillSettings, domain, storageDir, ...rest } = options
  return domain.createArchives({
    ...specialistPackageEnvironment(skillSettings ?? new SettingsRepository(storageDir)),
    logger: createLogger('specialist.package.service'),
    exportFileName: (...args: Parameters<typeof specialistExportFileName>) =>
      `open-science-${specialistExportFileName(...args)}`,
    ...rest
  })
}
