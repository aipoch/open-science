import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { createSpecialistDomain } from './domain'
import { validateSpecialistZip } from './package/zip-adapter'
import { fixtureSkillParser, fakeSkillParticipant } from '../test/fixtures'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const catalog = {
  appVersion: '1.0.0',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: []
}
const archive = (): Uint8Array =>
  zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        schema_version: 1,
        id: 'example',
        version: '1.0.0',
        exported_with_app_version: '1.0.0'
      })
    ),
    'specialist.json': strToU8(
      JSON.stringify({
        name: 'Example Specialist',
        description: 'Example profile',
        system_prompt: 'Review evidence.',
        skill_ids: [],
        connector_ids: []
      })
    ),
    'skills/analysis/SKILL.md': strToU8(
      '---\nname: analysis\nversion: 1.0.0\n---\nReview evidence.'
    )
  })
it('rejects bundled Skills when the independent consumer has not supplied a parser', () => {
  const preview = validateSpecialistZip(archive(), catalog).preview
  expect(preview.installable).toBe(false)
  expect(preview.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'skill.parser-required', severity: 'error' })
  )
})
it('fails bundled installation without a file participant instead of reporting an empty success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'specialist-participant-'))
  roots.push(root)
  const domain = createSpecialistDomain({ storageDir: join(root, 'new-data-directory') })
  const packages = domain.createArchives({
    catalog: async () => catalog,
    parseSkillDocument: fixtureSkillParser
  })
  const preview = await packages.preview(archive())
  expect(preview.installable).toBe(true)
  expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
    status: 'failed',
    code: 'commit-failed'
  })
  expect(await domain.catalog.list()).toEqual([])
  expect(() => domain.createArchives({ catalog: async () => catalog })).toThrow(
    'already been composed'
  )
})

it('preserves committed recovery evidence until the Skill participant is available again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'specialist-recovery-participant-'))
  roots.push(root)
  let settled = false
  const participant = {
    ...fakeSkillParticipant,
    recover: async (id: string | undefined) => {
      if (id) {
        if (!settled) throw new Error('participant unavailable')
      }
    }
  }
  const domain = createSpecialistDomain({ storageDir: root })
  const packages = domain.createArchives({
    catalog: async () => catalog,
    parseSkillDocument: fixtureSkillParser,
    skillPort: participant
  })
  const preview = await packages.preview(archive())
  expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
    status: 'failed',
    code: 'recovery-failed'
  })
  const journal = join(root, 'specialist-package-transaction.json')
  const evidence = await readFile(journal, 'utf8')
  const missing = createSpecialistDomain({ storageDir: root })
  await expect(missing.createArchives({ catalog: async () => catalog }).recover()).rejects.toThrow(
    'recovery failed'
  )
  expect(await readFile(journal, 'utf8')).toBe(evidence)
  settled = true
  const restored = createSpecialistDomain({ storageDir: root })
  await restored.createArchives({ catalog: async () => catalog, skillPort: participant }).recover()
  await expect(readFile(journal)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await restored.catalog.getById('example')).toBeDefined()
})

it.each([false, true])(
  'blocks every catalog mutation with pending recovery (archives composed: %s)',
  async (compose) => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-catalog-recovery-'))
    roots.push(root)
    const original = createSpecialistDomain({ storageDir: root })
    const profile = await original.catalog.create({ name: 'Existing Profile' })
    const documentPath = join(root, 'specialists.json')
    const originalBytes = await readFile(documentPath, 'utf8')
    // An unreadable recovery obligation must remain untouched until its owner can settle it.
    const journalPath = join(root, 'specialist-package-transaction.json')
    await writeFile(journalPath, '{interrupted')
    const restarted = createSpecialistDomain({ storageDir: root })
    if (compose) {
      const archives = restarted.createArchives({ catalog: async () => catalog })
      await expect(archives.recover()).rejects.toThrow('recovery failed')
    }
    const mutations = [
      () => restarted.catalog.create({ name: 'New Profile' }),
      () =>
        restarted.catalog.update({
          id: profile.id,
          revision: profile.revision,
          description: 'Changed'
        }),
      () => restarted.catalog.setEnabled(profile.id, false),
      () => restarted.catalog.delete(profile.id, profile.revision),
      () => restarted.catalog.changeOrigin(profile.id, profile.revision, 'imported'),
      () => restarted.catalog.attachSkill(profile.id, 'analysis', profile.revision)
    ]
    for (const mutate of mutations) await expect(mutate()).rejects.toThrow('recovery failed')
    expect(await readFile(documentPath, 'utf8')).toBe(originalBytes)
    expect(await readFile(journalPath, 'utf8')).toBe('{interrupted')
  }
)
