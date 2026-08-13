import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf8').replace(/^cipher:/, '')
  }
}))

import { SkillRegistry } from '../skills/registry'
import type { FetchLike } from '../skills/github-import'
import type { UserSkillRepository } from '../skills/user-skill-repository'
import { SettingsRepository } from './repository'
import { SkillCatalogModule } from './skill-catalog'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const createCatalog = async (includeInternal = false): Promise<SkillCatalogModule> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'settings-skill-catalog-'))
  const bundleRoot = await mkdtemp(join(tmpdir(), 'settings-skill-bundle-'))
  roots.push(storageRoot, bundleRoot)
  await mkdir(join(bundleRoot, 'demo'), { recursive: true })
  await writeFile(
    join(bundleRoot, 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill.\n---\n\ndemo body\n'
  )
  if (includeInternal) {
    await mkdir(join(bundleRoot, 'skill-creator'), { recursive: true })
    await writeFile(
      join(bundleRoot, 'skill-creator', 'SKILL.md'),
      '---\nname: skill-creator\ndescription: Create Skills.\n---\n\ninternal body\n'
    )
  }
  await writeFile(
    join(bundleRoot, 'manifest.json'),
    JSON.stringify({
      version: 1,
      skills: [
        { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' },
        ...(includeInternal
          ? [
              {
                id: 'skill-creator',
                name: 'Skill Creator',
                source: 'featured',
                exposure: 'internal',
                updatedAt: '2026-08-09T00:00:00.000Z'
              }
            ]
          : [])
      ]
    })
  )
  return new SkillCatalogModule({
    repository: new SettingsRepository(storageRoot),
    storageRoot,
    skillRegistry: new SkillRegistry(bundleRoot),
    userClaudeDir: join(storageRoot, 'user-claude'),
    userCodexDir: join(storageRoot, 'user-codex'),
    userAgentsDir: join(storageRoot, 'user-agents')
  })
}

describe('SkillCatalogModule', () => {
  it('keeps only the newest visible Skill when manually placed packages share a name', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'settings-skill-catalog-'))
    roots.push(storageRoot)
    const shared = {
      name: 'shared',
      displayName: 'Shared',
      description: '',
      sourceDir: storageRoot
    }
    const skillRegistry = {
      list: async () => [
        {
          ...shared,
          id: 'shared',
          source: 'featured' as const,
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    } as unknown as SkillRegistry
    const userSkills = {
      list: async () => [
        {
          ...shared,
          id: 'personal-shared',
          source: 'personal' as const,
          updatedAt: '2026-02-01T00:00:00.000Z'
        },
        {
          ...shared,
          id: 'imported-shared',
          source: 'imported' as const,
          updatedAt: '2026-03-01T00:00:00.000Z'
        }
      ]
    } as unknown as UserSkillRepository
    const catalog = new SkillCatalogModule({
      repository: new SettingsRepository(storageRoot),
      storageRoot,
      skillRegistry,
      userSkills
    })

    expect((await catalog.listHostSkills()).map((skill) => skill.id)).toEqual(['imported-shared'])
  })

  it('suffixes an import that collides with a Featured Skill name', async () => {
    const catalog = await createCatalog()
    const dataBase64 = Buffer.from(
      zipSync({ 'SKILL.md': strToU8('---\nname: Demo\ndescription: Imported\n---\nbody') })
    ).toString('base64')

    const result = await catalog.importSkillZip({ dataBase64 })

    expect(result.id).toBe('imported-demo-2')
    expect(result.skills.map((skill) => skill.id)).toEqual(['demo', 'imported-demo-2'])
  })

  it('keeps internal bundled Skills runtime-visible but out of Settings and Specialist catalogs', async () => {
    const catalog = await createCatalog(true)
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'settings-skill-runtime-'))
    roots.push(runtimeRoot)

    expect((await catalog.listHostSkills()).map((skill) => skill.id)).toContain('skill-creator')
    expect((await catalog.listSkills()).map((skill) => skill.id)).not.toContain('skill-creator')
    expect((await catalog.listSpecialistSkillCatalog()).map((skill) => skill.id)).not.toContain(
      'skill-creator'
    )

    await catalog.materializeSkills(runtimeRoot, ['skill-creator'])
    await expect(
      readFile(join(runtimeRoot, 'skills', 'os-skill-creator', 'SKILL.md'), 'utf8')
    ).resolves.toContain('internal body')
    await chmod(join(runtimeRoot, 'skills', 'os-demo'), 0o755)
    await chmod(join(runtimeRoot, 'skills', 'os-skill-creator'), 0o755)
  })

  it('verifies before replacing a saved token and keeps the old token on failure', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'settings-github-token-'))
    roots.push(storageRoot)
    const repository = new SettingsRepository(storageRoot)
    const oldRef = `plain:${Buffer.from('old-token').toString('base64')}`
    await repository.setGitHubToken(oldRef, 'old…oken')
    const requests: Array<Record<string, string> | undefined> = []
    const githubFetch: FetchLike = async (_url, init) => {
      requests.push(init?.headers)
      return {
        ok: false,
        status: 401,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    const catalog = new SkillCatalogModule({ repository, storageRoot, githubFetch })

    await expect(catalog.saveGitHubToken('new-token')).rejects.toThrow('GitHub rejected this token')

    expect(requests[0]?.Authorization).toBe('Bearer new-token')
    expect(await repository.getSettings()).toMatchObject({
      githubTokenRef: oldRef,
      githubTokenMask: 'old…oken'
    })
  })

  it.each([
    {
      remaining: null,
      expected:
        'GitHub forbids this token from accessing the API. Check its permissions and organization access, then try again.'
    },
    {
      remaining: '0',
      expected: 'GitHub token verification was rate-limited. Wait a moment and try again.'
    }
  ])('classifies token verification 403 responses from rate-limit metadata', async (testCase) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'settings-github-token-'))
    roots.push(storageRoot)
    const repository = new SettingsRepository(storageRoot)
    const githubFetch: FetchLike = async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: {
        get: (name) => (name === 'x-ratelimit-remaining' ? testCase.remaining : null)
      }
    })
    const catalog = new SkillCatalogModule({ repository, storageRoot, githubFetch })

    await expect(catalog.saveGitHubToken('new-token')).rejects.toThrow(testCase.expected)
  })

  it('encrypts a verified token and uses it for import, preview, scan, and search', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'settings-github-token-'))
    roots.push(storageRoot)
    const repository = new SettingsRepository(storageRoot)
    const requests: Array<{ url: string; headers?: Record<string, string> }> = []
    const githubFetch: FetchLike = async (url, init) => {
      requests.push({ url, headers: init?.headers })
      return {
        ok: true,
        status: 200,
        json: async () => (url.includes('/search/repositories') ? { items: [] } : {}),
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    const userSkills = {
      list: async () => [],
      importFromGitHub: async (_url: string, fetcher: FetchLike) => {
        await fetcher('https://api.github.com/repos/acme/skills')
        return { status: 'imported' as const, id: 'imported-demo' }
      },
      previewGitHubSkill: async (_url: string, fetcher: FetchLike) => {
        await fetcher('https://raw.githubusercontent.com/acme/skills/main/SKILL.md')
        return {
          name: 'Demo',
          description: 'Demo skill',
          metadata: {},
          body: '# Demo',
          files: ['SKILL.md']
        }
      },
      scanRepo: async (_repo: string, fetcher: FetchLike) => {
        await fetcher('https://api.github.com/repos/acme/skills/git/trees/main')
        return []
      }
    } as unknown as UserSkillRepository
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      githubFetch,
      userSkills,
      skillRegistry: { list: async () => [] } as unknown as SkillRegistry
    })

    const tokenStatus = await catalog.saveGitHubToken('github_pat_verified')
    expect(tokenStatus).toMatchObject({ configured: true })
    expect(tokenStatus.mask).not.toContain('github_pat_verified')
    const stored = await repository.getSettings()
    expect(stored.githubTokenRef).toMatch(/^enc:/)
    expect(stored.githubTokenRef).not.toContain('github_pat_verified')

    await catalog.importSkill({ url: 'https://github.com/acme/skills/tree/main/demo' })
    await catalog.previewGitHubSkill({ url: 'https://github.com/acme/skills/tree/main/demo' })
    await catalog.scanRepoSkills({ repo: 'acme/skills' })
    await catalog.scanRepoSkills({ repo: 'presentation skills' })

    expect(requests).toHaveLength(5)
    expect(
      requests.every((request) => request.headers?.Authorization === 'Bearer github_pat_verified')
    ).toBe(true)
  })

  it('exposes the stable compatibility identity for builtin Specialist dependencies', async () => {
    const catalog = await createCatalog()

    expect((await catalog.listSpecialistSkillCatalog())[0]?.compatibility).toMatch(
      /^sha256:[a-f0-9]{64}$/
    )
  })

  it('owns catalog projection, enablement, detail, and personal CRUD', async () => {
    const catalog = await createCatalog()

    expect(await catalog.listSkills()).toEqual([
      expect.objectContaining({ id: 'demo', description: 'A demo skill.', enabled: true })
    ])
    expect((await catalog.setSkillEnabled({ id: 'demo', enabled: false }))[0].enabled).toBe(false)
    expect(await catalog.listSpecialistSkillCatalog()).toEqual([
      {
        id: 'demo',
        frameworkName: 'demo',
        displayName: 'Demo',
        source: 'featured',
        mainEnabled: false,
        available: true,
        compatibility: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    ])
    expect((await catalog.getSkillDetail('demo')).body).toContain('demo body')

    const runtimeRoot = await mkdtemp(join(tmpdir(), 'settings-skill-runtime-'))
    roots.push(runtimeRoot)
    await catalog.materializeSkills(runtimeRoot, ['demo'])
    await expect(
      readFile(join(runtimeRoot, 'skills', 'os-demo', 'SKILL.md'), 'utf8')
    ).rejects.toThrow()
    await catalog.materializeSkills(runtimeRoot, ['demo'], new Set(['demo']))
    await expect(
      readFile(join(runtimeRoot, 'skills', 'os-demo', 'SKILL.md'), 'utf8')
    ).resolves.toContain('demo body')
    expect((await catalog.listSkills())[0].enabled).toBe(false)
    await chmod(join(runtimeRoot, 'skills', 'os-demo'), 0o755)
    await expect(
      catalog.codexSkillCatalog(join(tmpdir(), 'untrusted-codex-home'), async () => {
        throw new Error('untrusted homes must not resolve catalog extensions')
      })
    ).resolves.toEqual([])
    expect(
      (await catalog.createSkill({ name: 'my-skill', description: 'Mine.', body: '# Mine' })).map(
        (skill) => skill.id
      )
    ).toEqual(['demo', 'personal-my-skill'])
    expect(
      (
        await catalog.updateSkill({
          id: 'personal-my-skill',
          description: 'Edited.',
          body: '# Edited'
        })
      ).find((skill) => skill.id === 'personal-my-skill')
    ).toMatchObject({ description: 'Edited.' })
    await expect(
      catalog.updateSkill({
        id: 'personal-my-skill',
        name: 'Renamed Skill',
        description: 'Edited.',
        body: '# Edited'
      } as never)
    ).rejects.toThrow('Skill name is immutable.')
    expect(
      (await catalog.deleteSkill({ id: 'personal-my-skill' })).map((skill) => skill.id)
    ).toEqual(['demo'])
  })

  it('reads authorized Connector descriptions from generated frontmatter and rejects invalid docs', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'settings-connector-catalog-'))
    const bundleRoot = await mkdtemp(join(tmpdir(), 'settings-connector-bundle-'))
    roots.push(storageRoot, bundleRoot)
    await writeFile(join(bundleRoot, 'manifest.json'), JSON.stringify({ version: 1, skills: [] }))
    const skillsRoot = join(storageRoot, 'codex', 'skills')
    const docs = new Map([
      [
        'mcp-xt',
        '---\nname: mcp-xt\ndescription: Use XT records.\nsource: connector\n---\n\n# XT\n'
      ],
      [
        'mcp-wrong-name',
        '---\nname: mcp-another\ndescription: Wrong identity.\nsource: connector\n---\n'
      ],
      ['mcp-missing-description', '---\nname: mcp-missing-description\nsource: connector\n---\n'],
      [
        'mcp-wrong-source',
        '---\nname: mcp-wrong-source\ndescription: Wrong source.\nsource: featured\n---\n'
      ]
    ])
    await Promise.all(
      [...docs].map(async ([name, contents]) => {
        await mkdir(join(skillsRoot, name), { recursive: true })
        await writeFile(join(skillsRoot, name, 'SKILL.md'), contents)
      })
    )
    const catalog = new SkillCatalogModule({
      repository: new SettingsRepository(storageRoot),
      storageRoot,
      skillRegistry: new SkillRegistry(bundleRoot)
    })

    await expect(
      catalog.codexSkillCatalog(
        join(storageRoot, 'codex'),
        [...docs.keys()].map((name) => ({ directory: name, name, source: 'connector' as const }))
      )
    ).resolves.toEqual([
      {
        name: 'mcp-xt',
        description: 'Use XT records.',
        path: join(skillsRoot, 'mcp-xt', 'SKILL.md'),
        source: 'connector'
      }
    ])
  })

  it('exports a personal Skill as a portable ZIP archive', async () => {
    const catalog = await createCatalog()
    await catalog.createSkill({
      name: 'my-skill',
      description: 'Mine.',
      body: '# Mine',
      references: [
        { path: 'example.txt', dataBase64: Buffer.from('example reference').toString('base64') }
      ]
    })

    const exported = await catalog.buildSkillExport('personal-my-skill')
    const files = unzipSync(exported.archiveBytes)

    expect(exported.fileName).toBe('my-skill.zip')
    expect(strFromU8(files['SKILL.md'])).toContain('# Mine')
    expect(strFromU8(files['references/example.txt'])).toBe('example reference')
    expect((await catalog.buildSkillExport('personal-my-skill')).archiveBytes).toEqual(
      exported.archiveBytes
    )
  })

  it('omits imported-Skill provenance from the exported ZIP archive', async () => {
    const catalog = await createCatalog()
    const importedZip = zipSync({
      'SKILL.md': strToU8(
        ['---', 'name: Imported Skill', 'description: Imported.', '---', '', '# Imported'].join(
          '\n'
        )
      )
    })
    const imported = await catalog.importSkillZip({
      dataBase64: Buffer.from(importedZip).toString('base64')
    })

    const exported = await catalog.buildSkillExport(imported.id)
    const files = unzipSync(exported.archiveBytes)

    expect(Object.keys(files)).toEqual(['SKILL.md'])
    expect(strFromU8(files['SKILL.md'])).toContain('name: imported-skill')
  })

  it('refuses to export built-in and unknown Skills', async () => {
    const catalog = await createCatalog()

    await expect(catalog.buildSkillExport('demo')).rejects.toThrow(
      'Built-in Skills cannot be exported.'
    )
    await expect(catalog.buildSkillExport('missing')).rejects.toThrow('Unknown skill: missing')
  })

  it('owns active-framework agent-home discovery and batch import', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'settings-agent-home-catalog-'))
    const bundleRoot = await mkdtemp(join(tmpdir(), 'settings-agent-home-bundle-'))
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'settings-agent-home-claude-'))
    const userAgentsDir = await mkdtemp(join(tmpdir(), 'settings-agent-home-agents-'))
    roots.push(storageRoot, bundleRoot, userClaudeDir, userAgentsDir)
    await writeFile(join(bundleRoot, 'manifest.json'), JSON.stringify({ version: 1, skills: [] }))
    const seed = async (home: string, slug: string): Promise<void> => {
      await mkdir(join(home, 'skills', slug), { recursive: true })
      await writeFile(
        join(home, 'skills', slug, 'SKILL.md'),
        `---\nname: ${slug}\ndescription: Test ${slug}\n---\nBody\n`
      )
    }
    await seed(userAgentsDir, 'shared')
    await seed(userClaudeDir, 'claude-only')
    const repository = new SettingsRepository(storageRoot)
    await repository.setAgentFramework('claude-code')
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      userClaudeDir,
      userAgentsDir,
      userCodexDir: join(storageRoot, 'user-codex'),
      skillRegistry: new SkillRegistry(bundleRoot)
    })

    expect(
      (await catalog.listAgentHomeSkills()).map(({ source, slug }) => ({ source, slug }))
    ).toEqual([
      { source: 'agents', slug: 'shared' },
      { source: 'claude', slug: 'claude-only' }
    ])
    expect(
      (
        await catalog.importAgentHomeSkills({
          skills: [{ source: 'agents', slug: 'shared' }]
        })
      ).results
    ).toEqual([{ source: 'agents', slug: 'shared', status: 'imported', id: 'imported-shared' }])

    const preview = await catalog.previewAgentHomeSkill({ source: 'claude', slug: 'claude-only' })
    expect(preview.sourceLabel).toBe('~/.claude/skills/claude-only')
    expect(JSON.stringify(preview)).not.toContain(userClaudeDir)

    expect(
      (
        await catalog.importAgentHomeSkills({
          skills: [{ source: 'agents', slug: '../escape' }]
        })
      ).results
    ).toEqual([
      {
        source: 'agents',
        slug: '../escape',
        error: 'Refusing to import installed skill with unsafe slug: ../escape'
      }
    ])
  })
})
