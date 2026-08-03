import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpecialistPackageSkillPlan } from '../../shared/specialist-package'
import { UserSkillRepository } from './user-skill-repository'
import {
  SPECIALIST_PACKAGE_SKILL_METADATA,
  UserSkillSpecialistPackageAdapter
} from './specialist-package-adapter'
import { zipSync, strToU8 } from 'fflate'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const plan = (id = 'analysis-tools'): SpecialistPackageSkillPlan => ({
  id,
  version: '1.2.3',
  versionRange: '^1.2.0',
  disposition: 'install',
  files: ['SKILL.md', 'scripts/run.sh'],
  contentHash: 'a'.repeat(64),
  filesToInstall: [
    {
      path: 'SKILL.md',
      bytes: new TextEncoder().encode(
        '---\nname: analysis-tools\ndescription: Analyze data\n---\nUse this Skill.'
      )
    },
    { path: 'scripts/run.sh', bytes: new TextEncoder().encode('exit 99') }
  ]
})

describe('UserSkillSpecialistPackageAdapter', () => {
  it('rejects reuse-owned when live ownership metadata becomes inconsistent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-skill-adapter-'))
    roots.push(root)
    const adapter = new UserSkillSpecialistPackageAdapter(root)

    await adapter.prepare('tx-seed', 'research-synth', [plan()])
    await adapter.commit('tx-seed')
    await adapter.recover('tx-seed', 'commit')
    await writeFile(
      join(root, 'skills', 'imported', 'analysis-tools', SPECIALIST_PACKAGE_SKILL_METADATA),
      JSON.stringify({
        id: 'analysis-tools',
        version: '1.2.3',
        contentHash: 'a'.repeat(64),
        standalone: true,
        ownerIds: ['research-synth']
      })
    )

    await expect(
      adapter.beginMutation('tx-reuse', 'research-synth', [
        { ...plan(), disposition: 'reuse-owned' }
      ])
    ).rejects.toThrow(/changed after preview/i)
  })

  it('serializes package promotion with ordinary ZIP imports of the same Skill ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-skill-adapter-'))
    roots.push(root)
    const adapter = new UserSkillSpecialistPackageAdapter(root)
    const repository = new UserSkillRepository(root)
    const packagePlan = plan()

    await adapter.prepare('tx-zip-race', 'research-synth', [packagePlan])
    await adapter.beginMutation('tx-zip-race', 'research-synth', [packagePlan])

    const ordinaryImport = repository.importFromZip(
      Buffer.from(
        zipSync({
          'SKILL.md': strToU8(
            '---\nname: analysis-tools\ndescription: A different standalone Skill\n---\nStandalone.'
          )
        })
      )
    )
    let importSettled = false
    void ordinaryImport.finally(() => {
      importSettled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(importSettled).toBe(false)

    await adapter.commit('tx-zip-race')
    await adapter.recover('tx-zip-race', 'commit')
    await adapter.endMutation('tx-zip-race')

    await expect(ordinaryImport).resolves.toMatchObject({
      status: 'imported',
      id: 'imported-analysis-tools-2'
    })
    await expect(repository.body('analysis-tools')).resolves.toContain('Use this Skill.')
    await expect(repository.body('imported-analysis-tools-2')).resolves.toContain('Standalone.')
  })

  it('keeps prepared Skill trees invisible until commit and exposes their package identity afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-skill-adapter-'))
    roots.push(root)
    const adapter = new UserSkillSpecialistPackageAdapter(root)
    const repository = new UserSkillRepository(root)

    await adapter.prepare('tx-1', 'research-synth', [plan()])
    await expect(repository.list()).resolves.toEqual([])

    await adapter.commit('tx-1')
    await adapter.recover('tx-1', 'commit')

    await expect(repository.list()).resolves.toEqual([
      expect.objectContaining({ id: 'analysis-tools', source: 'imported' })
    ])
    await expect(repository.body('analysis-tools')).resolves.toContain('Use this Skill.')
    await expect(repository.delete('analysis-tools')).rejects.toThrow(/Specialist-owned/)
    await expect(adapter.snapshot()).resolves.toEqual([
      {
        id: 'analysis-tools',
        version: '1.2.3',
        contentHash: 'a'.repeat(64),
        standalone: false,
        ownerIds: ['research-synth']
      }
    ])
  })

  it('removes a newly promoted Skill when the package coordinator rolls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-skill-adapter-'))
    roots.push(root)
    const adapter = new UserSkillSpecialistPackageAdapter(root)
    const repository = new UserSkillRepository(root)

    await adapter.prepare('tx-rollback', 'research-synth', [plan()])
    await adapter.commit('tx-rollback')
    await expect(repository.list()).resolves.toHaveLength(1)

    await adapter.rollback('tx-rollback')

    await expect(repository.list()).resolves.toEqual([])
    await expect(adapter.snapshot()).resolves.toEqual([])
  })

  it('restores deleted and ownership-edited Skills when restart recovery rolls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-skill-adapter-'))
    roots.push(root)
    const adapter = new UserSkillSpecialistPackageAdapter(root)

    await adapter.prepare('seed-recovery', 'research-synth', [plan('delete-me'), plan('retain-me')])
    await adapter.commit('seed-recovery')
    await adapter.recover('seed-recovery', 'commit')
    await adapter.prepareDeletion(
      'interrupted-delete',
      'research-synth',
      ['delete-me', 'retain-me'],
      ['delete-me']
    )
    await adapter.commit('interrupted-delete')
    await expect(adapter.snapshot()).resolves.toEqual([
      expect.objectContaining({ id: 'retain-me', standalone: true, ownerIds: [] })
    ])

    const restarted = new UserSkillSpecialistPackageAdapter(root)
    await restarted.recover('interrupted-delete', 'rollback')

    await expect(restarted.snapshot()).resolves.toEqual([
      expect.objectContaining({ id: 'delete-me', standalone: false, ownerIds: ['research-synth'] }),
      expect.objectContaining({ id: 'retain-me', standalone: false, ownerIds: ['research-synth'] })
    ])
  })
})
