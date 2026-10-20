import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as publicNode from '@aipoch/specialists/node'
const { createSpecialistDomain } = publicNode
for (const internal of [
  'SpecialistRepository',
  'SpecialistPackageTransaction',
  'SpecialistService',
  'SpecialistPackageService',
  'createSpecialistService',
  'sanitizeStoredSpecialist'
])
  assert.equal(internal in publicNode, false, internal)
const root = await mkdtemp(join(tmpdir(), 'specialists-consumer-data-'))
const catalog = {
  appVersion: '1.0.0',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: []
}
try {
  const domain = createSpecialistDomain({ storageDir: root })
  const archives = domain.createArchives({ catalog: async () => catalog })
  assert.throws(
    () => domain.createArchives({ catalog: async () => catalog }),
    /already been composed/
  )
  const profile = await domain.catalog.create({
    name: 'Research Analyst',
    description: 'Summarize evidence.',
    systemPrompt: 'Use the supplied evidence.'
  })
  const exported = await archives.export({
    specialistId: profile.id,
    expectedRevision: profile.revision,
    includedSkillIds: []
  })
  const target = createSpecialistDomain({ storageDir: join(root, 'target') })
  const imports = target.createArchives({ catalog: async () => catalog })
  const preview = await imports.preview(exported.archiveBytes)
  assert.equal(preview.installable, true)
  const result = await imports.install({ candidateToken: preview.candidateToken })
  assert.equal(result.status, 'installed')
  assert.equal(result.specialist.setupPending, true)
  const restarted = createSpecialistDomain({ storageDir: join(root, 'target') })
  await restarted.createArchives({ catalog: async () => catalog }).recover()
  const found = await restarted.catalog.getById(profile.id)
  assert.equal(found.name, profile.name)
  const ready = await restarted.catalog.update({
    id: found.id,
    revision: found.revision,
    completeSetup: true
  })
  assert.equal(ready.enabled, true)
  const disk = JSON.parse(await readFile(join(root, 'target', 'specialists.json'), 'utf8'))
  assert.equal(disk.version, 2)
  await restarted.catalog.delete(ready.id, ready.revision)
  assert.equal((await restarted.catalog.list()).length, 0)
  await assert.rejects(import('@aipoch/specialists/src/repository'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  })
  console.log('PASS: clean consumer catalog, archive round trip, restart, setup and deletion')
} finally {
  await rm(root, { recursive: true, force: true })
}
