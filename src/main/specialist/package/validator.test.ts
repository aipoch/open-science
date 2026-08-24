import { describe, expect, it } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { validateSpecialistPackage } from './validator'

const encoder = new TextEncoder()
const overlongSkillName = 'a'.repeat(65)
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
  exported_with_app_version: '0.9.2'
}

const validSpecialistJson = {
  name: 'RNA Reviewer',
  display_name: 'RNA Reviewer',
  description: 'Reviews RNA-seq experiments.',
  system_prompt: 'Private identity instructions that must never appear in diagnostics.',
  skill_ids: [],
  connector_ids: []
}

const validSpecialist = {
  name: validSpecialistJson.name,
  displayName: validSpecialistJson.display_name,
  description: validSpecialistJson.description,
  systemPrompt: validSpecialistJson.system_prompt,
  skillIds: [],
  connectorIds: []
}

describe('validateSpecialistPackage', () => {
  it('accepts only application metadata in manifest and author content in specialist.json', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson),
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
    expect(JSON.stringify(result.preview)).not.toContain(validSpecialistJson.system_prompt)
  })

  it('rejects legacy camelCase Specialist package fields', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialist),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.plan).toBeUndefined()
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'specialist.field-forbidden', path: 'specialist.json' })
    )
  })

  it('rejects duplicate Skill and Connector names', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, {
        ...validSpecialistJson,
        skill_ids: ['document-reader', 'document-reader'],
        connector_ids: ['reference-library', 'reference-library']
      }),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['specialist.skillIds-duplicate', 'specialist.connectorIds-duplicate'])
    )
  })

  it('requires both capability arrays even when they are empty', () => {
    const missingArrays = {
      name: validSpecialistJson.name,
      display_name: validSpecialistJson.display_name,
      description: validSpecialistJson.description,
      system_prompt: validSpecialistJson.system_prompt
    }
    const result = validateSpecialistPackage(
      packageFiles(validManifest, missingArrays),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['specialist.skillIds-invalid', 'specialist.connectorIds-invalid'])
    )
  })

  it('accepts Skill and Connector name arrays in the user-editable Specialist payload', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, {
        ...validSpecialistJson,
        skill_ids: ['document-reader'],
        connector_ids: ['reference-library']
      }),
      {
        ...catalog,
        builtinSkills: [
          {
            id: 'document-reader',
            appVersion: '0.9.2',
            compatibility: 'sha256:document-reader'
          }
        ],
        skills: [{ id: 'document-reader', builtin: true }],
        connectorIds: ['reference-library']
      },
      'zip'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.plan?.payload).toMatchObject({
      skillIds: ['document-reader'],
      connectorIds: ['reference-library']
    })
    expect(result.plan?.skillIds).toEqual(['document-reader'])
    expect(result.plan?.connectorIds).toEqual(['reference-library'])
  })

  it('resolves portable and legacy Connector names to the local Connector id', () => {
    const localConnectorId = '550e8400-e29b-41d4-a716-446655440000'
    const result = validateSpecialistPackage(
      packageFiles(validManifest, {
        ...validSpecialistJson,
        connector_ids: [
          'Example Connector',
          'installed-uuid',
          'example-connector',
          localConnectorId
        ]
      }),
      {
        ...catalog,
        connectorIds: [localConnectorId],
        connectorAliases: {
          [localConnectorId]: 'example-connector',
          'Example Connector': localConnectorId,
          'installed-uuid': localConnectorId
        }
      },
      'zip'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.plan?.connectorIds).toEqual([localConnectorId])
  })

  it('resolves portable Skill and Connector names to local installation ids', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, {
        ...validSpecialistJson,
        skill_ids: ['paper-review'],
        connector_ids: ['pubmed-private']
      }),
      {
        ...catalog,
        skills: [
          {
            id: 'imported-paper-review',
            name: 'paper-review',
            builtin: false
          }
        ],
        connectorIds: ['550e8400-e29b-41d4-a716-446655440000'],
        connectorAliases: {
          '550e8400-e29b-41d4-a716-446655440000': 'pubmed-private'
        }
      },
      'zip'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.plan?.payload).toMatchObject({
      skillIds: ['paper-review'],
      connectorIds: ['pubmed-private']
    })
    expect(result.plan?.skillIds).toEqual(['imported-paper-review'])
    expect(result.plan?.connectorIds).toEqual(['550e8400-e29b-41d4-a716-446655440000'])
  })

  it('resolves legacy local Skill ids while preferring portable names', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, {
        ...validSpecialistJson,
        skill_ids: ['personal-paper-review', 'shared-reference']
      }),
      {
        ...catalog,
        skills: [
          {
            id: 'personal-paper-review',
            name: 'paper-review',
            builtin: false
          },
          {
            id: 'imported-shared-reference',
            name: 'shared-reference',
            builtin: false
          },
          {
            id: 'shared-reference',
            name: 'different-name',
            builtin: false
          }
        ]
      },
      'zip'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.plan?.skillIds).toEqual(['personal-paper-review', 'imported-shared-reference'])
  })

  it('changes the package content identity when bundled Skill bytes change', () => {
    const bundled = (body: string): ReturnType<typeof validateSpecialistPackage> =>
      validateSpecialistPackage(
        packageFiles(validManifest, validSpecialistJson, [
          {
            path: 'skills/analysis-tools/SKILL.md',
            bytes: encoder.encode(
              `---\nname: analysis-tools\ndescription: Analyze data\nversion: 1.0.0\n---\n${body}`
            )
          }
        ]),
        catalog,
        'zip'
      )

    expect(bundled('First behavior.').plan?.contentHash).not.toBe(
      bundled('Changed behavior.').plan?.contentHash
    )
  })

  it('excludes package version from the package content identity', () => {
    const first = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson),
      catalog,
      'zip'
    )
    const bumped = validateSpecialistPackage(
      packageFiles({ ...validManifest, version: '1.2.4' }, validSpecialistJson),
      catalog,
      'zip'
    )

    expect(first.plan?.contentHash).toBe(bumped.plan?.contentHash)
  })

  it('rejects malformed capability arrays', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, {
        ...validSpecialistJson,
        skill_ids: ['missing-skill', 42, ''],
        connector_ids: 'not-an-array'
      }),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.plan).toBeUndefined()
    expect(result.preview.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'specialist.skillIds-entry-invalid'
        }),
        expect.objectContaining({
          severity: 'error',
          code: 'specialist.connectorIds-invalid'
        })
      ])
    )
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
        validSpecialistJson
      ),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'manifest.schema-version-unsupported',
        'manifest.exported-app-version-invalid',
        'manifest.field-forbidden'
      ])
    )
  })

  it('rejects camelCase specialist.json fields in schema v1', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, {
        name: 'RNA Reviewer',
        description: 'Reviews RNA-seq experiments.',
        systemPrompt: 'Legacy camelCase content.'
      }),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['specialist.field-forbidden', 'specialist.system-prompt-invalid'])
    )
  })

  it.each([
    ['icon_key', 'specialist.presentation-field-forbidden'],
    ['color_key', 'specialist.presentation-field-forbidden'],
    ['capability_mode', 'specialist.capability-field-forbidden'],
    ['full_access', 'specialist.capability-field-forbidden'],
    ['selected_capabilities', 'specialist.capability-field-forbidden'],
    ['enabled', 'specialist.enabled-field-forbidden']
  ])('clearly rejects application-owned specialist field %s', (field, code) => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, { ...validSpecialistJson, [field]: {} }),
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
          skills: { bundled: [] }
        },
        {
          id: 'forbidden',
          name: 42,
          description: [],
          system_prompt: { secret: 'must-not-leak' },
          skill_ids: [],
          connector_ids: [],
          connector_config: { token: 'credential-value' }
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
      packageFiles(validManifest, validSpecialistJson, [
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
      localId: 'personal-analysis-tools',
      version: '0.1.0',
      disposition: 'install'
    })
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'skill.executable-content-present',
        relatedId: 'analysis-tools'
      })
    )
    expect(result.plan?.skillIds).toEqual(['personal-analysis-tools'])
  })

  it('keeps valid bundled Skill IDs selected when another bundled Skill cannot be parsed', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson, [
        {
          path: 'skills/analysis-tools/SKILL.md',
          bytes: encoder.encode('---\nname: analysis-tools\n---\nBody')
        },
        {
          path: 'skills/broken/SKILL.md',
          bytes: encoder.encode('not valid skill frontmatter')
        }
      ]),
      catalog,
      'zip'
    )

    expect(result.preview.installable).toBe(true)
    expect(result.plan?.skillIds).toEqual(['personal-analysis-tools'])
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'skill.name-mismatch',
        relatedId: 'broken'
      })
    )
  })

  it('uses a valid SKILL.md frontmatter version when supplied', () => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson, [
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
      path: 'skills/foo--bar/SKILL.md',
      body: '---\nname: foo--bar\n---\nBody',
      code: 'skill.id-invalid'
    },
    {
      path: `skills/${overlongSkillName}/SKILL.md`,
      body: `---\nname: ${overlongSkillName}\n---\nBody`,
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
  ])('warns and skips a Skill that cannot be parsed: $code', ({ path, body, code }) => {
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson, [{ path, bytes: encoder.encode(body) }]),
      catalog,
      'zip'
    )
    expect(result.preview.installable).toBe(true)
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', code })
    )
  })

  it('rejects README.md and accepts README.txt as the only package guidance file', () => {
    const rejected = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson, [
        { path: 'README.md', bytes: encoder.encode('old guide') }
      ]),
      catalog,
      'zip'
    )
    const accepted = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson, [
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

  it('blocks protected identities and duplicate public names', () => {
    const result = validateSpecialistPackage(
      packageFiles({ ...validManifest, id: 'reviewer' }, validSpecialistJson),
      { ...catalog, specialists: [{ id: 'another', name: 'rna reviewer' }] },
      'zip'
    )

    expect(result.preview.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['specialist.id-protected', 'specialist.name-duplicate'])
    )
  })

  it('returns a resolvable decision for an installed bundled Skill with different content', () => {
    const skill = {
      path: 'skills/analysis/SKILL.md',
      bytes: encoder.encode('---\nname: analysis\n---\nBody')
    }
    const result = validateSpecialistPackage(
      packageFiles(validManifest, validSpecialistJson, [skill]),
      {
        ...catalog,
        skills: [
          {
            id: 'analysis',
            version: '0.1.0',
            builtin: false,
            contentHash: 'different',
            mainEnabled: true,
            specialistIds: ['another']
          }
        ],
        specialists: [{ id: 'another', name: 'Another Specialist' }]
      },
      'zip'
    )

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'skill.existing-conflict',
        relatedId: 'analysis'
      })
    )
    expect(result.plan?.skills[0]).toMatchObject({
      disposition: 'conflict',
      conflict: {
        localId: 'analysis',
        installedVersion: '0.1.0',
        installedContentHash: 'different',
        mainEnabled: true,
        specialists: [{ id: 'another', name: 'Another Specialist' }]
      }
    })
  })
})
