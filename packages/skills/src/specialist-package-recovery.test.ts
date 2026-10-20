import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { strToU8 } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { UserSkillSpecialistPackageAdapter } from './specialist-package-adapter'
import { UserSkillRepository } from './user-skill-repository'
import type { SpecialistPackageSkillPlan } from './transaction-contract'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function skillPlan(): SpecialistPackageSkillPlan {
  const bytes = strToU8(
    '---\nname: analysis-tools\ndescription: Analyze data\nversion: 1.0.0\n---\nORIGINAL SKILL CONTENT'
  )
  return {
    id: 'analysis-tools',
    localId: 'personal-analysis-tools',
    version: '1.0.0',
    disposition: 'install',
    contentHash: createHash('sha256').update('SKILL.md\0').update(bytes).update('\0').digest('hex'),
    filesToInstall: [{ path: 'SKILL.md', bytes }]
  }
}
async function fixture(): Promise<{
  storageDir: string
  skillPort: UserSkillSpecialistPackageAdapter
  userSkills: UserSkillRepository
}> {
  const storageDir = await mkdtemp(join(tmpdir(), 'skill-recovery-'))
  roots.push(storageDir)
  return {
    storageDir,
    skillPort: new UserSkillSpecialistPackageAdapter(storageDir),
    userSkills: new UserSkillRepository(storageDir)
  }
}
async function seed(port: UserSkillSpecialistPackageAdapter): Promise<void> {
  await port.prepare('seed', 'first-specialist', [skillPlan()])
  await port.commit('seed')
  await port.recover('seed', 'commit')
}
it.each(['analysis-tools', 'relocated-tools'])(
  'preserves an unreadable owned Skill in %s when another package requests its identity',
  async (directoryName) => {
    const { storageDir, skillPort } = await fixture()
    await seed(skillPort)
    const original = join(storageDir, 'skills', 'personal', 'analysis-tools')
    const directory = join(storageDir, 'skills', 'personal', directoryName)
    if (directory !== original) await rename(original, directory)
    await rm(join(directory, 'SKILL.md'))
    await writeFile(join(directory, 'local-notes.txt'), 'KEEP LOCAL EVIDENCE')
    const sidecar = join(directory, '.specialist-package.json')
    const metadata = await readFile(sidecar, 'utf8')
    expect(await skillPort.snapshot()).toEqual([])

    await expect(
      skillPort.beginMutation('second', 'second-specialist', [skillPlan()])
    ).rejects.toThrow()
    await expect
      .soft(readFile(join(directory, 'local-notes.txt'), 'utf8'))
      .resolves.toBe('KEEP LOCAL EVIDENCE')
    await expect.soft(readFile(sidecar, 'utf8')).resolves.toBe(metadata)
    await expect
      .soft(readFile(join(directory, 'SKILL.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it.each([
  ['journal', true],
  ['staging-created', true],
  ['staging-complete', true],
  ['before-backup', true],
  ['after-backup', true],
  ['after-promotion', true],
  ['after-restore', true],
  ['after-promotion', false]
] as const)(
  'K01 rolls back process exit at %s (existing=%s) without deleting original content',
  async (phase, existing) => {
    const { storageDir, skillPort } = await fixture()
    const plan = skillPlan()
    if (existing) {
      await skillPort.prepare('seed', 'first-specialist', [plan])
      await skillPort.commit('seed')
      await skillPort.recover('seed', 'commit')
    }
    const live = join(storageDir, 'skills', 'personal', 'analysis-tools', 'SKILL.md')
    const original = existing ? await readFile(live, 'utf8') : undefined
    const bundle = join(storageDir, 'adapter.cjs')
    buildSync({
      entryPoints: [join(import.meta.dirname, 'specialist-package-adapter.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs'
    })
    const input = join(storageDir, 'input.json')
    await writeFile(
      input,
      JSON.stringify({
        ...plan,
        disposition: existing ? 'replace-existing' : 'install',
        filesToInstall: plan.filesToInstall.map((file) => ({
          path: file.path,
          bytes: [
            ...strToU8(
              new TextDecoder()
                .decode(file.bytes)
                .replace('ORIGINAL SKILL CONTENT', 'INCOMING CONTENT')
            )
          ]
        }))
      })
    )
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs/promises');
      const path = require('node:path');
      const [root, bundle, phase, input] = process.argv.slice(1);
      const originalWrite = fs.writeFile, originalMkdir = fs.mkdir, originalRename = fs.rename;
      const live = path.join(root, 'skills', 'personal', 'analysis-tools');
      const staging = path.join(root, 'specialist-package-skill-transactions', 'interrupted', 'staging', 'personal-analysis-tools');
      fs.writeFile = async (...args) => {
        await originalWrite(...args);
        if (phase === 'journal' && path.basename(String(args[0])) === 'transaction.json') process.exit(23);
        if (phase === 'staging-complete' && String(args[0]) === path.join(staging, '.specialist-package.json')) process.exit(23);
      };
      fs.mkdir = async (...args) => {
        const result = await originalMkdir(...args);
        if (phase === 'staging-created' && String(args[0]) === staging) process.exit(23);
        return result;
      };
      fs.rename = async (from, to) => {
        if (phase === 'before-backup' && from === live) process.exit(23);
        await originalRename(from, to);
        if (phase === 'after-backup' && from === live) process.exit(23);
        if (phase === 'after-promotion' && from === staging && to === live) process.exit(23);
        if (phase === 'after-restore' && path.basename(path.dirname(from)) === 'backup' && to === live) process.exit(23);
      };
      const { UserSkillSpecialistPackageAdapter } = require(bundle);
      (async () => {
        const plan = JSON.parse(await fs.readFile(input, 'utf8'));
        plan.filesToInstall = plan.filesToInstall.map(file => ({...file, bytes: Uint8Array.from(file.bytes)}));
        const adapter = new UserSkillSpecialistPackageAdapter(root);
        await adapter.prepare('interrupted', 'second-specialist', [plan]);
        await adapter.commit('interrupted');
        if (phase === 'after-restore') await adapter.rollback('interrupted');
      })().then(() => process.exit(24)).catch(error => { console.error(error); process.exit(25); });
    `,
        storageDir,
        bundle,
        phase,
        input
      ],
      { encoding: 'utf8', timeout: 10_000 }
    )
    expect(child.stderr).toBe('')
    expect(child.status).toBe(23)
    if (phase === 'journal') expect(await readFile(live, 'utf8')).toBe(original)
    const restarted = new UserSkillSpecialistPackageAdapter(storageDir)
    for (let attempt = 0; attempt < 2; attempt++) {
      await restarted.recover(undefined, 'rollback')
      if (existing) await expect.soft(readFile(live, 'utf8')).resolves.toBe(original)
      else await expect.soft(readFile(live, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }
)

it.each(['legacy', 'foreign-owner'] as const)(
  'K01 preserves ambiguous %s promotion evidence',
  async (kind) => {
    const { skillPort, storageDir } = await fixture()
    const plan = skillPlan()
    await skillPort.prepare('uncertain', 'first-specialist', [plan])
    await skillPort.commit('uncertain')
    const journalPath = join(
      storageDir,
      'specialist-package-skill-transactions',
      'uncertain',
      'transaction.json'
    )
    const directory = join(storageDir, 'skills', 'personal', 'analysis-tools')
    if (kind === 'legacy') {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'))
      delete journal.version
      for (const skill of journal.skills) {
        delete skill.hadLive
        delete skill.contentHash
      }
      await writeFile(journalPath, JSON.stringify(journal))
    } else {
      const metadataPath = join(directory, '.specialist-package.json')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      await writeFile(
        metadataPath,
        JSON.stringify({ ...metadata, transactionId: 'another-transaction' })
      )
    }
    const journal = await readFile(journalPath, 'utf8')
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect
        .soft(new UserSkillSpecialistPackageAdapter(storageDir).rollback('uncertain'))
        .rejects.toThrow()
      await expect
        .soft(readFile(join(directory, 'SKILL.md'), 'utf8'))
        .resolves.toContain('ORIGINAL SKILL CONTENT')
      await expect.soft(readFile(journalPath, 'utf8')).resolves.toBe(journal)
    }
  }
)

it.each(['2', '', 'next'])(
  'rejects an explicitly invalid edited export version %j',
  async (version) => {
    const { skillPort, userSkills } = await fixture()
    await seed(skillPort)
    await userSkills.updatePersonal('personal-analysis-tools', {
      name: 'analysis-tools',
      description: 'Analyze data',
      body: 'LOCAL SKILL CONTENT',
      metadata: { version }
    })
    await expect(skillPort.exportSnapshot(['personal-analysis-tools'])).rejects.toThrow(
      /invalid version/i
    )
  }
)
it('exports the current edited version instead of its import sidecar version', async () => {
  const { skillPort, userSkills } = await fixture()
  await seed(skillPort)
  await userSkills.updatePersonal('personal-analysis-tools', {
    name: 'analysis-tools',
    description: 'Analyze data',
    body: 'UPDATED SKILL',
    metadata: { version: '2.0.0' }
  })
  expect((await skillPort.exportSnapshot(['personal-analysis-tools']))[0]).toMatchObject({
    version: '2.0.0'
  })
  expect((await skillPort.snapshot())[0]).toMatchObject({ version: '2.0.0' })
})
it.each(['version', 'reference'])(
  'rehashes live %s edits instead of trusting cached metadata',
  async (change) => {
    const { skillPort, userSkills } = await fixture()
    await seed(skillPort)
    const original = (await skillPort.snapshot())[0]
    await userSkills.updatePersonal('personal-analysis-tools', {
      name: 'analysis-tools',
      description: 'Analyze data',
      body: 'ORIGINAL SKILL CONTENT',
      metadata: { version: change === 'version' ? '2.0.0' : '1.0.0' },
      ...(change === 'reference'
        ? {
            references: [
              {
                path: 'evidence.txt',
                dataBase64: Buffer.from('LOCAL REFERENCE').toString('base64')
              }
            ]
          }
        : {})
    })
    expect((await skillPort.snapshot())[0].contentHash).not.toBe(original.contentHash)
  }
)

it('adds a second owner without rewriting identical live content', async () => {
  const { skillPort, userSkills } = await fixture()
  await seed(skillPort)
  const current = (await skillPort.snapshot())[0]
  await skillPort.prepare('reuse', 'second-specialist', [
    { ...skillPlan(), disposition: 'reuse-owned', contentHash: current.contentHash }
  ])
  await skillPort.commit('reuse')
  await skillPort.recover('reuse', 'commit')
  expect(await userSkills.body('personal-analysis-tools')).toContain('ORIGINAL SKILL CONTENT')
  expect((await skillPort.snapshot())[0].ownerIds).toEqual([
    'first-specialist',
    'second-specialist'
  ])
})

it('rejects a live edit between preparation and acquiring the publication lock', async () => {
  const { skillPort, userSkills } = await fixture()
  await seed(skillPort)
  const original = (await skillPort.snapshot())[0]
  const plan = {
    ...skillPlan(),
    disposition: 'reuse-owned' as const,
    contentHash: original.contentHash
  }
  await skillPort.prepare('race', 'second-specialist', [plan])
  await userSkills.updatePersonal('personal-analysis-tools', {
    name: 'analysis-tools',
    description: 'Analyze data',
    body: 'EDIT AFTER PREPARE'
  })
  await expect(skillPort.beginMutation('race', 'second-specialist', [plan])).rejects.toThrow(
    /changed after preview/i
  )
  await skillPort.rollback('race')
  expect(await userSkills.body('personal-analysis-tools')).toContain('EDIT AFTER PREPARE')
})
