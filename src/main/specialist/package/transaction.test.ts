import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SpecialistPackageValidationPlan } from '../../../shared/specialist-package'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../../shared/specialist'
import { SpecialistRepository } from '../repository'
import { SpecialistPackageTransaction } from './transaction'

const encoder = new TextEncoder()
let storageDir: string
let repository: SpecialistRepository

const plan = (): SpecialistPackageValidationPlan => ({
  specialistId: 'imported-specialist',
  packageVersion: '1.0.0',
  source: 'zip',
  contentHash: 'a'.repeat(64),
  manifest: {
    schema_version: 1,
    id: 'imported-specialist',
    version: '1.0.0',
    exported_with_app_version: '0.9.2'
  },
  payload: {
    name: 'IMPORTED_SPECIALIST',
    displayName: 'Imported Specialist',
    description: 'Imported description.',
    systemPrompt: 'Imported instructions.'
  },
  skillIds: ['bundled-analysis'],
  connectorIds: [],
  skills: [
    {
      id: 'bundled-analysis',
      version: '0.1.0',
      disposition: 'install',
      files: ['SKILL.md'],
      contentHash: 'b'.repeat(64),
      filesToInstall: [{ path: 'SKILL.md', bytes: encoder.encode('Bundled skill') }]
    }
  ]
})

const planWithCapabilities = (): SpecialistPackageValidationPlan => ({
  ...plan(),
  skillIds: ['bundled-analysis', 'existing-analysis'],
  connectorIds: ['reference-library']
})

beforeEach(async () => {
  storageDir = join(tmpdir(), `specialist-transaction-${randomUUID()}`)
  await mkdir(storageDir, { recursive: true })
  repository = new SpecialistRepository(storageDir)
})

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true })
})

describe('SpecialistPackageTransaction imported setup lifecycle', () => {
  it('persists a new import disabled and pending with inferred bundled Skills selected', async () => {
    const installed = await new SpecialistPackageTransaction(storageDir, repository).install(
      plan(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest'
    )

    expect(installed).toMatchObject({
      enabled: false,
      setupPending: true,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: {
        skillIds: ['bundled-analysis'],
        connectorIds: [],
        connectorTools: []
      }
    })
    expect(installed.iconKey).toBeUndefined()
    expect(installed.colorKey).toBeUndefined()
    await expect(repository.getAll()).resolves.toMatchObject({
      specialists: [{ id: 'imported-specialist', enabled: false, setupPending: true }]
    })
  })

  it('persists declared capabilities together with Skills discovered from the package', async () => {
    const installed = await new SpecialistPackageTransaction(storageDir, repository).install(
      planWithCapabilities(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest'
    )

    expect(installed).toMatchObject({
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: ['bundled-analysis', 'existing-analysis'],
        connectorIds: ['reference-library'],
        connectorTools: []
      }
    })
  })

  it('returns an overwritten Specialist to disabled pending setup and replaces local capabilities', async () => {
    await repository.insert({
      id: 'imported-specialist',
      name: 'IMPORTED_SPECIALIST',
      displayName: 'Previously configured',
      description: 'Old description.',
      systemPrompt: 'Old instructions.',
      iconKey: 'dna',
      colorKey: 'blue',
      enabled: true,
      setupPending: false,
      capabilityMode: 'full',
      fullAccess: { ...emptyFullAccessConfig(), excludedSkillIds: ['old-skill'] },
      selectedCapabilities: {
        ...emptySelectedConfig(),
        connectorIds: ['old-connector']
      },
      revision: 4,
      packageVersion: '0.9.0',
      origin: 'imported',
      ownedSkillIds: ['previously-owned']
    })

    const overwritten = await new SpecialistPackageTransaction(storageDir, repository).install(
      plan(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest',
      { expectedRevision: 4 }
    )

    expect(overwritten).toMatchObject({
      enabled: false,
      setupPending: true,
      revision: 5,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: {
        skillIds: ['bundled-analysis'],
        connectorIds: [],
        connectorTools: []
      },
      ownedSkillIds: ['previously-owned', 'bundled-analysis']
    })
    expect(overwritten.iconKey).toBeUndefined()
    expect(overwritten.colorKey).toBeUndefined()
  })
})
