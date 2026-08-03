import { describe, expect, it } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { validateSpecialistPackage } from './validator'

const encoder = new TextEncoder()
const packageFiles = (
  manifest: unknown,
  specialist: unknown,
  extra: Array<{ path: string; bytes: Uint8Array }> = []
): Array<{ path: string; bytes: Uint8Array }> => [
  { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
  { path: 'specialist.json', bytes: encoder.encode(JSON.stringify(specialist)) },
  ...extra
]

const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

const validManifest = {
  schema_version: 1,
  id: 'rna-reviewer',
  version: '1.2.3',
  exported_with_app_version: '0.9.2',
  requires_app: '>=0.9.0 <1.0.0'
}

const validSpecialist = {
  name: 'RNA Reviewer',
  displayName: 'RNA Reviewer',
  description: 'Reviews RNA-seq experiments.',
  systemPrompt: 'Private identity instructions that must never appear in diagnostics.'
}

describe('validateSpecialistPackage', () => {
  it('accepts only application metadata in manifest and author content in specialist.json', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist),
      catalog,
      'zip'
    )

    expect(result.preview).toEqual({
      summary: {
        id: 'rna-reviewer',
        version: '1.2.3',
        name: 'RNA Reviewer',
        description: 'Reviews RNA-seq experiments.',
        source: 'zip',
        requiresApp: '>=0.9.0 <1.0.0',
        bundledSkillIds: [],
        requiredSkillIds: [],
        builtinSkillIds: [],
        connectorIds: [],
        skills: []
      },
      diagnostics: [],
      installable: true
    })
    expect(result.plan?.manifest).toEqual(validManifest)
    expect(result.plan?.payload).toEqual(validSpecialist)
    expect(result.plan?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(result.plan)).toBe(true)
    expect(JSON.stringify(result.preview)).not.toContain(validSpecialist.systemPrompt)
  })

  it('requires the complete current schema and rejects legacy dependency declarations', () => {
    const result = validateSpecialistPackage(
      packageFiles(
        {
          schema_version: undefined,
          id: 'rna-reviewer',
          version: '1.2.3',
          skills: { builtin: [], required: [], bundled: [] }
        },
        validSpecialist
      ),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'manifest.schema-version-unsupported',
        'manifest.exported-app-version-invalid',
        'manifest.requires-app-invalid',
        'manifest.field-forbidden'
      ])
    )
  })

  it.each([
    ['iconKey', 'specialist.presentation-field-forbidden'],
    ['colorKey', 'specialist.presentation-field-forbidden'],
    ['capabilityMode', 'specialist.capability-field-forbidden'],
    ['fullAccess', 'specialist.capability-field-forbidden'],
    ['selectedCapabilities', 'specialist.capability-field-forbidden'],
    ['enabled', 'specialist.enabled-field-forbidden']
  ])('clearly rejects application-owned specialist field %s', (field, code) => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, { ...validSpecialist, [field]: {} }),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(expect.objectContaining({ code }))
  })

  it('aggregates schema errors without exposing untrusted values', () => {
    const result = validateSpecialistPackage(
      packageFiles(
        {
          schema_version: 99,
          id: '../unsafe',
          version: 'latest',
          exported_with_app_version: 'now',
          requires_app: 42,
          skills: { bundled: [] }
        },
        {
          id: 'forbidden',
          name: 42,
          description: [],
          systemPrompt: { secret: 'must-not-leak' },
          connectorConfig: { token: 'credential-value' }
        }
      ),
      catalog,
      'zip'
    )

    expect(result.plan).toBeUndefined()
    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'manifest.schema-version-unsupported',
        'manifest.id-invalid',
        'manifest.version-invalid',
        'manifest.exported-app-version-invalid',
        'manifest.requires-app-invalid',
        'manifest.field-forbidden',
        'specialist.identity-field-forbidden',
        'specialist.field-forbidden',
        'specialist.name-invalid',
        'specialist.description-invalid',
        'specialist.system-prompt-invalid'
      ])
    )
    expect(JSON.stringify(result.preview)).not.toMatch(/must-not-leak|credential-value/)
  })

  it('discovers bundled Skills from canonical directories and defaults their version to 0.1.0', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist, [
        {
          path: 'skills/analysis-tools/SKILL.md',
          bytes: encoder.encode(
            '---\nname: analysis-tools\ndescription: Analyze data\n---\nUse the bundled tools.'
          )
        },
        { path: 'skills/analysis-tools/scripts/run.sh', bytes: encoder.encode('exit 99') },
        { path: 'skills/analysis-tools/references/guide.md', bytes: encoder.encode('Guide') },
        { path: 'README.txt', bytes: encoder.encode('Import guide') }
      ]),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.preview.summary?.bundledSkillIds).toEqual(['analysis-tools'])
    expect(result.preview.summary?.skills).toEqual([
      expect.objectContaining({
        id: 'analysis-tools',
        version: '0.1.0',
        disposition: 'install',
        files: ['SKILL.md', 'references/guide.md', 'scripts/run.sh']
      })
    ])
    expect(result.plan?.skills[0]).toMatchObject({
      id: 'analysis-tools',
      version: '0.1.0',
      disposition: 'install'
    })
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'skill.executable-content-present',
        relatedId: 'analysis-tools'
      })
    )
  })

  it('uses a valid SKILL.md frontmatter version when supplied', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist, [
        {
          path: 'skills/analysis-tools/SKILL.md',
          bytes: encoder.encode('---\nname: analysis-tools\nversion: 2.3.4\n---\nBody')
        }
      ]),
      catalog,
      'zip'
    )

    expect(result.preview.summary?.skills[0]?.version).toBe('2.3.4')
  })

  it.each([
    {
      path: 'skills/Analysis/SKILL.md',
      body: '---\nname: Analysis\n---\nBody',
      code: 'skill.id-invalid'
    },
    {
      path: 'skills/analysis/SKILL.md',
      body: '---\nname: another-name\n---\nBody',
      code: 'skill.name-mismatch'
    },
    {
      path: 'skills/analysis/notes.md',
      body: 'notes',
      code: 'skill.document-missing'
    }
  ])('rejects a noncanonical bundled Skill: $code', ({ path, body, code }) => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist, [{ path, bytes: encoder.encode(body) }]),
      catalog,
      'zip'
    )
    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(expect.objectContaining({ code }))
  })

  it('rejects README.md and accepts README.txt as the only package guidance file', () => {
    const rejected = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist, [
        { path: 'README.md', bytes: encoder.encode('old guide') }
      ]),
      catalog,
      'zip'
    )
    const accepted = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist, [
        { path: 'README.txt', bytes: encoder.encode('new guide') }
      ]),
      catalog,
      'zip'
    )

    expect(rejected.preview.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'package.top-level-content-forbidden', path: 'README.md' })
    )
    expect(accepted.preview.installable).toBe(true)
  })

  it('blocks incompatible applications, protected identities, and duplicate public names', () => {
    const result = validateSpecialistPackage(
      packageFiles(
        { ...validManifest, id: 'reviewer', requires_app: '>=1.0.0 <2.0.0' },
        validSpecialist
      ),
      { ...catalog, specialists: [{ id: 'another', name: 'rna reviewer' }] },
      'zip'
    )

    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'compatibility.app-incompatible',
        'specialist.id-protected',
        'specialist.name-duplicate'
      ])
    )
  })

  it('blocks an installed bundled Skill with different content', () => {
    const skill = {
      path: 'skills/analysis/SKILL.md',
      bytes: encoder.encode('---\nname: analysis\n---\nBody')
    }
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist, [skill]),
      {
        ...catalog,
        skills: [{ id: 'analysis', version: '0.1.0', builtin: false, contentHash: 'different' }]
      },
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'skill.existing-conflict', relatedId: 'analysis' })
    )
  })
})
