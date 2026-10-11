import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpecialistPackageCatalogSnapshot } from '@aipoch/specialists'
import { BuiltinSpecialistRegistry } from '@aipoch/specialists/node'
import { toUnpackedSpecialistResourcePath } from './builtin-resource-path'

const shippedRoot = join(import.meta.dirname, '..', '..', '..', 'resources', 'specialists')
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

describe('BuiltinSpecialistRegistry', () => {
  it('gates every shipped contribution without migrating legacy Specialists or Reviewer', async () => {
    const result = await new BuiltinSpecialistRegistry(catalog, shippedRoot).load()

    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(result.entries.some((entry) => entry.id === 'reviewer')).toBe(false)
  })
})

describe('builtin Specialist resource paths', () => {
  it('rewrites packaged app.asar paths and leaves development paths unchanged', () => {
    expect(
      toUnpackedSpecialistResourcePath(
        '/Applications/Open-Science.app/Contents/Resources/app.asar/resources/specialists'
      )
    ).toBe(
      '/Applications/Open-Science.app/Contents/Resources/app.asar.unpacked/resources/specialists'
    )
    expect(toUnpackedSpecialistResourcePath('/repo/resources/specialists')).toBe(
      '/repo/resources/specialists'
    )
  })
})
