import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillRegistry } from '../skills/registry'
import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import {
  APP_ASSET_SUBDIRS,
  DENIED_BUILTIN_TOOLS,
  MANAGED_BUILTIN_TOOLS,
  configDenyRules,
  provisionAppClaudeConfigDir
} from './claude-config-provision'

// The default (no-registry) call path builds a SkillRegistry() that resolves the bundled-skills root via
// electron's app; point it at a nonexistent dir so the registry lists nothing instead of touching a real
// app path in the node test environment.
vi.mock('electron', () => ({
  app: { getAppPath: () => join(tmpdir(), 'os-no-such-app-root') }
}))

let root: string | undefined

// Seeds a bundled-skills root with one "demo" skill + manifest so provisioning has something to copy.
const seedBundle = async (): Promise<string> => {
  const bundle = await mkdtemp(join(tmpdir(), 'bundle-'))
  await mkdir(join(bundle, 'demo'), { recursive: true })
  await writeFile(
    join(bundle, 'demo', 'SKILL.md'),
    ['---', 'name: demo', 'description: d', '---', 'body'].join('\n'),
    'utf8'
  )
  await writeFile(
    join(bundle, 'manifest.json'),
    JSON.stringify({
      version: 1,
      skills: [
        { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    }),
    'utf8'
  )
  return bundle
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('built-in tool deny policy', () => {
  // Pruning-on-removal only re-enables a tool if it is in the module-owned superset. A tool denied
  // now but absent from MANAGED_BUILTIN_TOOLS would stay denied forever once later removed from
  // DENIED_BUILTIN_TOOLS — the exact bug the prune step fixes. Guard the DENIED ⊆ MANAGED invariant.
  it('keeps every denied built-in tool in the managed superset', () => {
    const managed = new Set<string>(MANAGED_BUILTIN_TOOLS)
    for (const tool of DENIED_BUILTIN_TOOLS) {
      expect(managed.has(tool)).toBe(true)
    }
  })
})

describe('provisionAppClaudeConfigDir', () => {
  it('creates the config dir and its app-asset subdirs', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudeConfigDir(configDir)

    expect((await stat(configDir)).isDirectory()).toBe(true)
    const entries = (await readdir(configDir)).sort()
    for (const sub of APP_ASSET_SUBDIRS) {
      expect(entries).toContain(sub)
    }
    await expect(
      readFile(join(configDir, '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse)
    ).resolves.toMatchObject({ name: 'open-science' })
  })

  it('is idempotent', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudeConfigDir(configDir)
    await expect(provisionAppClaudeConfigDir(configDir)).resolves.toBeUndefined()
  })

  it('writes permission deny rules fencing the file tools out of the config dir', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudeConfigDir(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    const deny: string[] = settings.permissions.deny
    expect(deny).toEqual([...configDenyRules(configDir), ...DENIED_BUILTIN_TOOLS])
    // Each rule is an absolute-path (`//`) recursive deny for one of the guarded file tools.
    for (const tool of ['Read', 'Edit', 'Glob', 'Grep']) {
      expect(deny.some((rule) => rule.startsWith(`${tool}(//`) && rule.endsWith('/**)'))).toBe(true)
    }
  })

  it('leaves the built-in web tools enabled in the app user scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudeConfigDir(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.permissions.deny).not.toContain('WebSearch')
    expect(settings.permissions.deny).not.toContain('WebFetch')
  })

  it('prunes a persisted managed built-in deny (WebSearch) on upgrade, keeping unrelated rules', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')
    await mkdir(configDir, { recursive: true })
    // Simulate an install provisioned before this change: WebSearch already persisted alongside an
    // unrelated user deny rule.
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['WebSearch', 'Bash(rm:*)'] } }),
      'utf8'
    )

    await provisionAppClaudeConfigDir(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.permissions.deny).not.toContain('WebSearch')
    expect(settings.permissions.deny).toContain('Bash(rm:*)')
  })

  it('disables Claude Code bundled skills in the app user scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudeConfigDir(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.disableBundledSkills).toBe(true)
  })

  it('merges guard deny rules into a pre-existing settings.json without dropping entries', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] }, model: 'keep-me' }),
      'utf8'
    )

    await provisionAppClaudeConfigDir(configDir)

    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    expect(settings.model).toBe('keep-me')
    expect(settings.disableBundledSkills).toBe(true)
    expect(settings.permissions.deny).toContain('Bash(rm:*)')
    for (const rule of configDenyRules(configDir)) {
      expect(settings.permissions.deny).toContain(rule)
    }
  })

  it('materializes enabled bundled skills, honoring disabledSkillIds', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')
    const registry = new SkillRegistry(await seedBundle())
    const skills = await registry.list()

    await provisionAppClaudeConfigDir(configDir, {
      skills,
      materializer: new ClaudeCodeSkillMaterializer(),
      disabledSkillIds: []
    })
    expect(
      (await readdir(join(configDir, 'skills'))).filter((name) => !name.startsWith('.'))
    ).toEqual(['os-demo'])

    await provisionAppClaudeConfigDir(configDir, {
      skills,
      materializer: new ClaudeCodeSkillMaterializer(),
      disabledSkillIds: ['demo']
    })
    expect(
      (await readdir(join(configDir, 'skills'))).filter((name) => !name.startsWith('.'))
    ).toEqual([])
  })
})
