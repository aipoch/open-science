import { cp, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../shared/specialist-package'
import { BuiltinSpecialistRegistry } from './builtin-registry'
import { toUnpackedSpecialistResourcePath } from './builtin-resource-path'

const fixtureRoot = join(import.meta.dirname, 'package', 'test-fixtures', 'valid')
const shippedRoot = join(import.meta.dirname, '..', '..', '..', 'resources', 'specialists')
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

describe('BuiltinSpecialistRegistry', () => {
  it('registers a conforming directory as a readonly builtin without duplicating package identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'builtin-specialists-'))
    await cp(fixtureRoot, join(root, 'contribution-one'), { recursive: true })
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({ version: 1, specialists: ['contribution-one'] }),
      'utf8'
    )

    const result = await new BuiltinSpecialistRegistry(catalog, root).load()

    expect(result.diagnostics).toEqual([])
    expect(result.entries).toEqual([
      {
        kind: 'builtin',
        readonly: true,
        id: 'fixture-specialist',
        version: '1.0.0',
        name: 'Fixture Specialist',
        description: 'A valid adapter fixture.',
        systemPrompt: 'Fixture prompt that must stay out of previews and diagnostics.',
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      }
    ])
    expect(result.entries.some((entry) => entry.id === 'reviewer')).toBe(false)
  })

  it('gates every shipped contribution without migrating legacy Specialists or Reviewer', async () => {
    const result = await new BuiltinSpecialistRegistry(catalog, shippedRoot).load()

    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(result.entries.some((entry) => entry.id === 'reviewer')).toBe(false)
  })

  it('reports concrete diagnostics and omits an invalid builtin instead of partially loading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'builtin-specialists-invalid-'))
    await cp(fixtureRoot, join(root, 'broken'), { recursive: true })
    await writeFile(join(root, 'broken', 'manifest.json'), '{"id":"broken"}', 'utf8')
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({ version: 1, specialists: ['broken'] }),
      'utf8'
    )

    const result = await new BuiltinSpecialistRegistry(catalog, root).load()

    expect(result.entries).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: expect.stringMatching(/^manifest\./) })
      ])
    )
  })
})

describe('builtin Specialist resource paths', () => {
  it('rewrites packaged app.asar paths and leaves development paths unchanged', () => {
    expect(
      toUnpackedSpecialistResourcePath(
        '/Applications/Open Science.app/Contents/Resources/app.asar/resources/specialists'
      )
    ).toBe(
      '/Applications/Open Science.app/Contents/Resources/app.asar.unpacked/resources/specialists'
    )
    expect(toUnpackedSpecialistResourcePath('/repo/resources/specialists')).toBe(
      '/repo/resources/specialists'
    )
  })
})
