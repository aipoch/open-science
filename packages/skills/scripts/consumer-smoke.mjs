const hiddenImplementation = '@aipoch/skills/dist/skill-mutation-owner'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentHomeSkillCatalog,
  SkillAuthoringService,
  UserSkillRepository,
  UserSkillSpecialistPackageAdapter,
  SkillReleaseInstallConflict
} from '@aipoch/skills'
import { parseSkillDocument } from '@aipoch/skills/document'
import { buildSkillExportArchive } from '@aipoch/skills/sources'
import { ClaudeCodeSkillMaterializer, loadSkillDocumentContent } from '@aipoch/skills/projection'

const require = createRequire(import.meta.url)
assert.equal(require('@aipoch/skills').UserSkillRepository, UserSkillRepository)
assert.equal(require('@aipoch/skills').SkillReleaseInstallConflict, SkillReleaseInstallConflict)
assert.throws(() => require(hiddenImplementation), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
})
const root = await mkdtemp(join(tmpdir(), 'skill-consumer-'))
try {
  const repository = new UserSkillRepository(root)
  const input = { name: 'example', description: 'Example document', body: 'First version' }
  const id = await repository.createPersonal(input)
  assert.equal(id, 'personal-example')
  assert.match(await repository.body(id), /First version/)
  const [skill] = await repository.list()
  assert.equal(skill.name, 'example')
  const archive = await buildSkillExportArchive(skill)
  assert.ok(archive.archiveBytes.byteLength > 0)
  const second = new UserSkillRepository(join(root, 'second'))
  const imported = await second.importFromZip(Buffer.from(archive.archiveBytes))
  assert.equal(imported.status, 'imported')
  assert.equal((await second.list())[0].name, 'example')
  const discovered = new AgentHomeSkillCatalog(second)
  const sources = [{ source: 'agents', dir: join(root, 'skills', 'personal') }]
  assert.equal((await discovered.list(sources))[0].name, 'example')
  const preview = await discovered.previewAgentHomeSkill(sources, {
    source: 'agents',
    slug: 'example'
  })
  assert.match(preview.body, /First version/)
  assert.equal(
    (await discovered.importAgentHomeSkills(sources, [{ source: 'agents', slug: 'example' }]))[0]
      .status,
    'imported'
  )
  // Public participants and CJS/ESM repository instances must serialize against one owner.
  const participant = new UserSkillSpecialistPackageAdapter(root)
  await participant.beginMutation('consumer-check', 'specialist', [])
  let settled = false
  const cjsRepository = new (require('@aipoch/skills').UserSkillRepository)(root)
  const update = cjsRepository.updatePersonal(id, { ...input, body: 'Second version' }).then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  await participant.endMutation('consumer-check')
  await update
  assert.match(await repository.body(id), /Second version/)
  await assert.rejects(repository.updatePersonal(id, { ...input, body: 'Stale' }, 'stale-etag'))
  const configDir = join(root, 'runtime', '.claude')
  await new ClaudeCodeSkillMaterializer().sync(configDir, await repository.list())
  const document = await loadSkillDocumentContent(
    { root: join(root, 'runtime'), skillsDirectory: join(root, 'runtime', '.claude', 'skills') },
    'example'
  )
  assert.match(document, /Second version/)
  const projected = await readFile(join(configDir, 'skills', `os-${id}`, 'SKILL.md'), 'utf8')
  assert.equal(parseSkillDocument(projected).name, 'example')
  await repository.delete(id)
  assert.deepEqual(await repository.list(), [])
  const authoring = new SkillAuthoringService({
    storageRoot: root,
    catalog: {
      list: () => repository.list(),
      withSkillRead: (id, read) => repository.withSkillReadLock(id, read),
      publishPersonalDirectory: (...args) => repository.publishPersonalDirectory(...args),
      deletePublished: (id) => repository.delete(id)
    }
  })
  await authoring.edit({
    name: 'authored',
    path: 'SKILL.md',
    content: '---\nname: authored\ndescription: Authored document\n---\npublic authoring witness'
  })
  assert.equal((await authoring.validate({ name: 'authored' })).valid, true)
  await authoring.publish({ name: 'authored' })
  assert.match(
    (await authoring.read({ name: 'personal-authored' })).content,
    /public authoring witness/
  )
  await authoring.runMutationExclusive(async () => {
    const target = await authoring.resolveDeletion('personal-authored')
    await authoring.delete(target.id)
  })
  assert.deepEqual(await repository.list(), [])
  const files = [
    {
      relativePath: 'SKILL.md',
      content: Buffer.from(
        '---\nname: released\ndescription: Release\n---\ninstalled from a local channel'
      )
    }
  ]
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Plain JavaScript runs in the clean consumer without a TypeScript loader.
  const digest = (files) => createHash('sha256').update(JSON.stringify(files)).digest('hex')
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Plain JavaScript validates the public runtime contract.
  const parse = (value) => {
    assert.equal(value.id, 'released')
    assert.equal(value.version, 'edition-one')
    assert.equal(typeof value.contentSha256, 'string')
    assert.equal(typeof value.descriptorSha256, 'string')
    return value
  }
  const policy = {
    metadataKey: 'local-publisher',
    diffLabel: 'Incoming',
    parseRelease: parse,
    parseReceipt: (value) => {
      parse(value)
      assert.equal(typeof value.installedContentSha256, 'string')
      return value
    },
    contentDigest: digest,
    isNewerVersion: () => false
  }
  const release = {
    files,
    receipt: {
      id: 'released',
      version: 'edition-one',
      contentSha256: digest(files),
      descriptorSha256: 'local-descriptor'
    }
  }
  assert.equal((await repository.installRelease(policy, release, null, [])).status, 'imported')
  assert.equal(
    (await new UserSkillRepository(root).releaseInstallation(policy, 'released', 'edition-one', []))
      .kind,
    'installed'
  )
  await repository.delete('imported-released')
  console.log(
    'Public CJS/ESM identity, shared locking, create/read/update/archive/import/projection/delete passed.'
  )
} finally {
  // Projection files are read-only on POSIX. The materializer owns making them removable.
  await new ClaudeCodeSkillMaterializer().sync(join(root, 'runtime', '.claude'), [])
  await rm(root, { recursive: true, force: true })
}
