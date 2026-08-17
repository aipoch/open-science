import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { filterMarketplaceSpecialistZip, validateSpecialistZip } from './zip-adapter'

const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.16.0',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: []
}

describe('Marketplace Specialist ZIP filtering', () => {
  it('safely filters a verified archive above the generic file cap before ordinary validation', () => {
    const files: Record<string, Uint8Array> = {
      'manifest.json': strToU8(
        JSON.stringify({
          schema_version: 1,
          id: 'example-specialist',
          version: '1.0.0',
          exported_with_app_version: '0.16.0'
        })
      ),
      'specialist.json': strToU8(
        JSON.stringify({
          name: 'EXAMPLE_SPECIALIST',
          description: 'Example',
          system_prompt: 'Use selected Skills.',
          skill_ids: ['selected-skill', 'large-unselected-skill'],
          connector_ids: []
        })
      ),
      'skills/selected-skill/SKILL.md': strToU8(
        '---\nname: selected-skill\ndescription: Selected\n---\nUse this Skill.'
      ),
      'skills/large-unselected-skill/SKILL.md': strToU8(
        '---\nname: large-unselected-skill\ndescription: Large\n---\nDo not install.'
      )
    }
    for (let index = 0; index < 2_000; index += 1) {
      files[`skills/large-unselected-skill/references/${index}.txt`] = new Uint8Array()
    }
    const fullArchive = zipSync(files)

    expect(validateSpecialistZip(fullArchive, catalog).preview.installable).toBe(false)

    const filtered = filterMarketplaceSpecialistZip(fullArchive, ['selected-skill'], [])
    const validation = validateSpecialistZip(filtered, catalog)
    const archive = unzipSync(filtered)
    const specialist = JSON.parse(strFromU8(archive['specialist.json']))

    expect(validation.preview.installable).toBe(true)
    expect(specialist.skill_ids).toEqual(['selected-skill'])
    expect(specialist.connector_ids).toEqual([])
    expect(Object.keys(archive)).toContain('skills/selected-skill/SKILL.md')
    expect(Object.keys(archive).some((path) => path.includes('large-unselected-skill'))).toBe(false)
  })
})
