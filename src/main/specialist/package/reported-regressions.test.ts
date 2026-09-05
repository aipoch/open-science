import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { UserSkillSpecialistPackageAdapter } from '../../skills/specialist-package-adapter'
import { UserSkillRepository } from '../../skills/user-skill-repository'
import { SpecialistRepository } from '../repository'
import { MarketplaceRepository, type MarketplaceInstallProvenance } from '../marketplace/repository'
import { MarketplaceService } from '../marketplace/service'
import { SpecialistPackageService } from './service'
import { validateSpecialistZip } from './zip-adapter'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const emptyCatalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: []
}
const archive = (id: string, bundled = true, connectorIds: string[] = []): Uint8Array =>
  zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        schema_version: 1,
        id,
        version: '1.0.0',
        exported_with_app_version: '0.9.2'
      })
    ),
    'specialist.json': strToU8(
      JSON.stringify({
        name: id.toUpperCase().replaceAll('-', '_'),
        description: 'Research helper.',
        system_prompt: 'Help with research.',
        skill_ids: [],
        connector_ids: connectorIds
      })
    ),
    ...(bundled
      ? {
          'skills/analysis-tools/SKILL.md': strToU8(
            '---\nname: analysis-tools\ndescription: Analyze data\nversion: 1.0.0\n---\nORIGINAL SKILL CONTENT'
          )
        }
      : {})
  })
async function fixture(): Promise<{
  storageDir: string
  repository: SpecialistRepository
  skillPort: UserSkillSpecialistPackageAdapter
  userSkills: UserSkillRepository
  liveCatalog: SpecialistPackageCatalogSnapshot
  catalog: () => Promise<SpecialistPackageCatalogSnapshot>
  packages: SpecialistPackageService
}> {
  const storageDir = await mkdtemp(join(tmpdir(), 'specialist-reported-'))
  roots.push(storageDir)
  const repository = new SpecialistRepository(storageDir)
  const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
  const userSkills = new UserSkillRepository(storageDir)
  const liveCatalog = { ...emptyCatalog }
  const catalog = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
    ...liveCatalog,
    skills: (await skillPort.snapshot()).map((skill) => ({
      ...skill,
      name: skill.id.replace(/^personal-/, ''),
      builtin: false,
      mainEnabled: false
    }))
  })
  const packages = new SpecialistPackageService({ storageDir, repository, skillPort, catalog })
  return { storageDir, repository, skillPort, userSkills, liveCatalog, catalog, packages }
}
const provenance = (digest = 'c'.repeat(64)): MarketplaceInstallProvenance => ({
  sourceId: 'official',
  specialistId: 'first-specialist',
  publisher: 'Example',
  version: '1.0.0',
  releasePath: 'releases/first-specialist/1.0.0.json',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  installedArchiveDigest: digest,
  upstreamCommit: 'd'.repeat(40),
  selectedSkillIds: ['analysis-tools'],
  selectedConnectorIds: [],
  installedAt: '2026-09-05T00:00:00.000Z'
})

describe('reported Specialist package regressions', () => {
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
      const { storageDir, skillPort, repository, catalog } = await fixture()
      const plan = validateSpecialistZip(archive('first-specialist'), emptyCatalog).plan!.skills[0]
      if (existing) {
        await skillPort.prepare('seed', 'first-specialist', [plan])
        await skillPort.commit('seed')
        await skillPort.recover('seed', 'commit')
      }
      const live = join(storageDir, 'skills', 'personal', 'analysis-tools', 'SKILL.md')
      const original = existing ? await readFile(live, 'utf8') : undefined
      const bundle = join(storageDir, 'adapter.cjs')
      buildSync({
        entryPoints: [resolve('src/main/skills/specialist-package-adapter.ts')],
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
      const restarted = new SpecialistPackageService({
        storageDir,
        repository,
        catalog,
        skillPort: new UserSkillSpecialistPackageAdapter(storageDir)
      })
      for (let attempt = 0; attempt < 2; attempt++) {
        await restarted.recover()
        if (existing) await expect.soft(readFile(live, 'utf8')).resolves.toBe(original)
        else await expect.soft(readFile(live, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
  )

  it('K05 requires conflict approval and retains an owned Skill edited through the personal editor', async () => {
    const { packages, userSkills } = await fixture()
    const first = await packages.preview(archive('first-specialist'))
    expect(await packages.install({ candidateToken: first.candidateToken })).toMatchObject({
      status: 'installed'
    })
    await userSkills.updatePersonal('personal-analysis-tools', {
      name: 'analysis-tools',
      description: 'Analyze data',
      body: 'USER LOCAL EDIT MUST SURVIVE'
    })
    expect(await userSkills.body('personal-analysis-tools')).toContain(
      'USER LOCAL EDIT MUST SURVIVE'
    )
    const second = await packages.preview(archive('second-specialist'))
    expect.soft(second.summary?.skills[0].disposition).toBe('conflict')
    expect.soft(second.installable).toBe(false)
    const result = await packages.install({ candidateToken: second.candidateToken })
    expect
      .soft(result)
      .toMatchObject({ status: 'failed', code: 'skill-conflict-resolution-required' })
    expect
      .soft(await userSkills.body('personal-analysis-tools'))
      .toContain('USER LOCAL EDIT MUST SURVIVE')
  })

  it.each([1, 2])(
    'K02 preserves Main isolation and provenance across %s committed cleanup failures',
    async (failures) => {
      const { packages, repository, skillPort, storageDir, userSkills } = await fixture()
      const marketRepository = new MarketplaceRepository(storageDir)
      const disabled = new Set<string>()
      const market = new MarketplaceService({
        repository: marketRepository,
        packages,
        fetch: vi.fn() as never,
        getDisabledSkillIds: async () => [...disabled],
        setSkillsMainEnabled: async (ids, enabled) => {
          for (const id of ids) {
            if (enabled) disabled.delete(id)
            else disabled.add(id)
          }
        },
        getInstalledSpecialists: async () =>
          (await repository.getAll()).specialists.map((item) => ({
            id: item.id,
            origin: item.origin,
            archiveDigest: item.importBaseline?.archiveDigest
          }))
      })
      const bytes = archive('first-specialist')
      const preview = await packages.preview(bytes, undefined, { origin: 'marketplace' })
      expect(preview.installable).toBe(true)
      // Match existing market tests: seed the already-reviewed candidate, bypassing only network/trust setup.
      Reflect.set(
        market,
        'installCandidates',
        new Map([
          [
            preview.candidateToken,
            {
              expiresAt: Date.now() + 60_000,
              sourceId: 'official',
              packageCandidateToken: preview.candidateToken,
              newSkillIds: packages.candidateNewSkillIds(preview.candidateToken),
              provenance: provenance(createHash('sha256').update(bytes).digest('hex'))
            }
          ]
        ])
      )
      const recover = skillPort.recover.bind(skillPort)
      let injected = 0
      vi.spyOn(skillPort, 'recover').mockImplementation(async (id, outcome) => {
        if (id && outcome === 'commit' && injected < failures) {
          injected += 1
          throw new Error('Transient committed cleanup failure')
        }
        return recover(id, outcome)
      })
      const result = await market.install({ candidateToken: preview.candidateToken })
      expect(injected).toBeGreaterThan(0)
      expect((await repository.getAll()).specialists).toHaveLength(1)
      expect(await userSkills.list()).toHaveLength(1)
      // Either an installed result or the existing recovery-failed result can preserve the obligation.
      if (result.status === 'failed') expect(result.code).toBe('recovery-failed')
      expect.soft([...disabled]).toEqual(['personal-analysis-tools'])
      const pending = await marketRepository.getAll()
      expect.soft(pending.pendingInstallations.length + pending.installations.length).toBe(1)
      // Retry through the market public boundary, including after a previous recovery attempt failed.
      await market.recover()
      await expect(
        readFile(join(storageDir, 'specialist-package-transaction.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await market.recover()
      await market.recover()
      expect.soft((await marketRepository.getAll()).installations).toHaveLength(1)
      expect.soft([...disabled]).toEqual(['personal-analysis-tools'])
    }
  )

  it('K03 refuses installation when an approved connector disappears after preview', async () => {
    const { packages, liveCatalog, repository } = await fixture()
    liveCatalog.connectorIds = ['demo']
    const preview = await packages.preview(archive('first-specialist', false, ['demo']))
    expect(preview.installable).toBe(true)
    expect(preview.summary?.connectorIds).toEqual(['demo'])
    liveCatalog.connectorIds = []
    const result = await packages.install({ candidateToken: preview.candidateToken })
    expect.soft(result).toMatchObject({ status: 'failed', code: 'stale-candidate' })
    expect.soft((await repository.getAll()).specialists).toEqual([])
  })

  it('K04 confirms exporting without a missing owned Skill is valid at the service boundary', async () => {
    const { packages, storageDir } = await fixture()
    const preview = await packages.preview(archive('first-specialist'))
    expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
      status: 'installed'
    })
    await rm(join(storageDir, 'skills/personal/analysis-tools'), { recursive: true })
    const exportPreview = await packages.previewExport('first-specialist')
    expect(exportPreview.canExport).toBe(false)
    expect(exportPreview.skills).toContainEqual(
      expect.objectContaining({ selected: true, kind: 'owned' })
    )
    const result = await packages.export({
      specialistId: exportPreview.specialistId,
      expectedRevision: exportPreview.expectedRevision,
      includedSkillIds: []
    })
    expect(result.archiveBytes.byteLength).toBeGreaterThan(0)
    expect((await packages.previewExport('first-specialist', [])).canExport).toBe(true)
    expect(
      (await packages.previewExport('first-specialist', ['personal-analysis-tools'])).canExport
    ).toBe(false)
  })

  it('K06 preserves corrupt recovery obligations during an unrelated cache write', async () => {
    const { storageDir } = await fixture()
    const repository = new MarketplaceRepository(storageDir)
    await repository.beginInstallation({
      provenance: provenance(),
      newlyDisabledSkillIds: ['personal-analysis-tools']
    })
    const file = join(storageDir, 'specialist-marketplace.json')
    const document = JSON.parse(await readFile(file, 'utf8'))
    expect(document.pendingInstallations).toHaveLength(1)
    document.pendingInstallations[0].newlyDisabledSkillIds = 'corrupted-array'
    await writeFile(file, JSON.stringify(document))
    const restarted = new MarketplaceRepository(storageDir)
    // A fail-closed repository may reject; either way no cache update may erase the obligation.
    await restarted.getAll().catch(() => undefined)
    await restarted
      .cacheRoot('unrelated-source', strToU8('{}'), strToU8('{}'), '2026-09-05T00:00:00.000Z')
      .catch(() => undefined)
    const after = JSON.parse(await readFile(file, 'utf8'))
    expect(after.pendingInstallations).toEqual(document.pendingInstallations)
  })
  it.each(['version', 'reference', 'unchanged'] as const)(
    'K05 compares actual %s content and checks edits inside the commit lock',
    async (change) => {
      const { packages, userSkills, skillPort } = await fixture()
      const first = await packages.preview(archive('first-specialist'))
      expect(await packages.install({ candidateToken: first.candidateToken })).toMatchObject({
        status: 'installed'
      })
      if (change !== 'unchanged')
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
      const second = await packages.preview(archive('second-specialist'))
      expect(second.summary?.skills[0].disposition).toBe(
        change === 'unchanged' ? 'reuse-owned' : 'conflict'
      )
      if (change !== 'unchanged') {
        expect(await packages.install({ candidateToken: second.candidateToken })).toMatchObject({
          status: 'failed',
          code: 'skill-conflict-resolution-required'
        })
        return
      }
      const prepare = skillPort.prepare.bind(skillPort)
      vi.spyOn(skillPort, 'prepare').mockImplementation(async (...args) => {
        await prepare(...args)
        await userSkills.updatePersonal('personal-analysis-tools', {
          name: 'analysis-tools',
          description: 'Analyze data',
          body: 'EDIT AFTER PREPARE'
        })
      })
      expect(await packages.install({ candidateToken: second.candidateToken })).toMatchObject({
        status: 'failed'
      })
      expect(await userSkills.body('personal-analysis-tools')).toContain('EDIT AFTER PREPARE')
    }
  )

  it('K05 still reuses identical content without a conflict', async () => {
    const { packages, userSkills, skillPort } = await fixture()
    for (const id of ['first-specialist', 'second-specialist']) {
      const preview = await packages.preview(archive(id))
      expect(preview.installable).toBe(true)
      expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
        status: 'installed'
      })
    }
    expect(await userSkills.body('personal-analysis-tools')).toContain('ORIGINAL SKILL CONTENT')
    expect((await skillPort.snapshot())[0].ownerIds).toEqual([
      'first-specialist',
      'second-specialist'
    ])
  })

  it.each(['alias', 'unrelated', 'initially-missing'] as const)(
    'K03 only invalidates relevant capability changes: %s',
    async (change) => {
      const { packages, liveCatalog } = await fixture()
      liveCatalog.connectorIds = change === 'initially-missing' ? [] : ['first', 'second']
      liveCatalog.connectorAliases = { first: 'demo' }
      const preview = await packages.preview(archive('first-specialist', false, ['demo']))
      expect(preview.installable).toBe(true)
      if (change === 'alias') liveCatalog.connectorAliases = { second: 'demo' }
      else liveCatalog.connectorIds = [...liveCatalog.connectorIds, 'unrelated']
      const result = await packages.install({ candidateToken: preview.candidateToken })
      expect(result).toMatchObject(
        change === 'alias' ? { status: 'failed', code: 'stale-candidate' } : { status: 'installed' }
      )
    }
  )

  it('K03 rejects removal of a referenced unbundled Skill', async () => {
    const { packages, userSkills } = await fixture()
    const skillId = await userSkills.createPersonal({
      name: 'analysis-tools',
      description: 'Analyze data',
      body: 'Local'
    })
    const bytes = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          schema_version: 1,
          id: 'first-specialist',
          version: '1.0.0',
          exported_with_app_version: '0.9.2'
        })
      ),
      'specialist.json': strToU8(
        JSON.stringify({
          name: 'FIRST_SPECIALIST',
          description: 'Research helper.',
          system_prompt: 'Help.',
          skill_ids: ['analysis-tools'],
          connector_ids: []
        })
      )
    })
    const preview = await packages.preview(bytes)
    expect(preview.installable).toBe(true)
    await userSkills.delete(skillId)
    expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
      status: 'failed',
      code: 'stale-candidate'
    })
  })

  it.each(['unknown-version', 'pending', 'nested-provenance', 'invalid-json'] as const)(
    'K06 write-protects %s and resumes after explicit repair',
    async (damage) => {
      const { storageDir } = await fixture()
      const repository = new MarketplaceRepository(storageDir)
      await repository.beginInstallation({
        provenance: provenance(),
        newlyDisabledSkillIds: ['personal-analysis-tools']
      })
      const file = join(storageDir, 'specialist-marketplace.json')
      const healthy = await readFile(file, 'utf8')
      const document = JSON.parse(healthy)
      if (damage === 'unknown-version') document.version = 99
      if (damage === 'pending') document.pendingInstallations[0].newlyDisabledSkillIds = 'broken'
      if (damage === 'nested-provenance')
        document.pendingInstallations[0].provenance.futureField = 'must survive'
      const corrupt = damage === 'invalid-json' ? '{incomplete' : JSON.stringify(document)
      await writeFile(file, corrupt)
      await expect.soft(repository.getAll()).rejects.toThrow()
      await expect
        .soft(
          repository.cacheRoot(
            'unrelated',
            strToU8('{}'),
            strToU8('{}'),
            '2026-09-05T00:00:00.000Z'
          )
        )
        .rejects.toThrow()
      expect.soft(await readFile(file, 'utf8')).toBe(corrupt)
      await writeFile(file, healthy)
      await repository.completeInstallation(provenance())
      const recovered = await repository.getAll()
      expect(recovered.pendingInstallations).toEqual([])
      expect(recovered.installations).toHaveLength(1)
    }
  )
  it.each(['legacy', 'foreign-owner'] as const)(
    'K01 preserves ambiguous %s promotion evidence',
    async (kind) => {
      const { skillPort, storageDir } = await fixture()
      const plan = validateSpecialistZip(archive('first-specialist'), emptyCatalog).plan!.skills[0]
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
})
