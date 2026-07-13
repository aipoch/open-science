import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillRegistry } from '../skills/registry'
import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import {
  APP_ASSET_SUBDIRS,
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
    expect(deny).toEqual(configDenyRules(configDir))
    // Each rule is an absolute-path (`//`) recursive deny for one of the guarded file tools.
    for (const tool of ['Read', 'Edit', 'Glob', 'Grep']) {
      expect(deny.some((rule) => rule.startsWith(`${tool}(//`) && rule.endsWith('/**)'))).toBe(true)
    }
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
